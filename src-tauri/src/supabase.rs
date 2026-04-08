use crate::db::{self, Db, OfflineOrder};
use chrono::Utc;
use log::{error, info, warn};
use reqwest::Client;
use serde_json::{json, Value};
use std::time::Duration;
use tokio::time;

const POLL_INTERVAL_SECS: u64 = 10;
const VENOAPP_API: &str = "https://www.venoapp.com/api/bridge";

/// Exchange a bridge code (e.g. "ABCD-EF23") for a restaurant_id.
/// Returns (restaurant_id, restaurant_name) on success.
pub async fn resolve_bridge_code(code: &str) -> Result<(String, String), String> {
    let client = Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .post(VENOAPP_API)
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({ "code": code }))
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    if resp.status().as_u16() == 404 {
        return Err("Invalid bridge code — please check and try again.".into());
    }

    if !resp.status().is_success() {
        return Err(format!("Server error: {}", resp.status()));
    }

    let data: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;

    if let Some(err) = data.get("error") {
        return Err(err.as_str().unwrap_or("Unknown error").to_string());
    }

    let restaurant_id = data["restaurant_id"].as_str().ok_or("Missing restaurant_id")?.to_string();
    let name = data["name"].as_str().unwrap_or("Your Restaurant").to_string();

    Ok((restaurant_id, name))
}

/// Push the WebSocket auth token and hub LAN IP to Supabase.
/// The PWA uses the IP to connect directly when venobridge.local mDNS fails
/// (Windows / Android browsers don't resolve .local hostnames).
/// Fetch the platform logo URL from Supabase branding settings.
pub async fn fetch_logo_url(supabase_url: &str, anon_key: &str) -> Option<String> {
    let client = Client::builder().timeout(Duration::from_secs(8)).build().ok()?;
    let url = format!("{}/rest/v1/platform_settings?key=eq.branding&select=value", supabase_url);
    let resp = client
        .get(&url)
        .header("apikey", anon_key)
        .header("Authorization", format!("Bearer {}", anon_key))
        .send().await.ok()?;
    let rows: Vec<serde_json::Value> = resp.json().await.ok()?;
    rows.first()?.get("value")?.get("logo_url")?.as_str().map(|s| s.to_string())
}

pub async fn push_connection_info(bridge_code: &str, token: &str, supabase_url: &str, anon_key: &str) -> Result<(), String> {
    let hub_ip = get_local_ip();

    let client = Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let rpc_url = format!("{}/rest/v1/rpc/set_bridge_connection", supabase_url);
    let resp = client
        .post(&rpc_url)
        .header("apikey", anon_key)
        .header("Authorization", format!("Bearer {}", anon_key))
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({
            "p_bridge_code": bridge_code,
            "p_token":       token,
            "p_hub_ip":      hub_ip,
        }))
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {}: {}", status, text));
    }

    Ok(())
}

pub fn get_local_ip() -> String {
    use std::net::UdpSocket;
    // Connect to an external address to let the OS pick the right interface.
    // No packets are actually sent.
    if let Ok(sock) = UdpSocket::bind("0.0.0.0:0") {
        if sock.connect("8.8.8.8:80").is_ok() {
            if let Ok(addr) = sock.local_addr() {
                return addr.ip().to_string();
            }
        }
    }
    "unknown".to_string()
}

pub async fn start_sync_loop(db: Db) {
    let client = Client::builder()
        .timeout(Duration::from_secs(15))
        .danger_accept_invalid_certs(false)
        .build()
        .expect("Failed to build reqwest client");

    let mut interval = time::interval(Duration::from_secs(POLL_INTERVAL_SECS));

    loop {
        interval.tick().await;

        // Read config from DB every iteration so hot-changes are picked up
        let supabase_url = db::config_get(&db, "supabase_url");
        let supabase_key = db::config_get(&db, "supabase_anon_key");

        let (url, key) = match (supabase_url, supabase_key) {
            (Some(u), Some(k)) if !u.is_empty() && !k.is_empty() => (u, k),
            _ => {
                // Not configured yet
                continue;
            }
        };

        // Check internet by pinging the Supabase host
        if !is_online(&client, &url).await {
            continue;
        }

        // Sync pending orders
        let pending = match db::pending_offline_orders(&db) {
            Ok(p)  => p,
            Err(e) => {
                error!("[Supabase] Failed to read pending orders: {}", e);
                continue;
            }
        };

        if pending.is_empty() {
            continue;
        }

        info!("[Supabase] Syncing {} pending order(s)…", pending.len());

        for order in &pending {
            if let Err(e) = sync_order(&client, &url, &key, order).await {
                warn!("[Supabase] Failed to sync order {}: {}", order.client_id, e);
            } else {
                let now = Utc::now().to_rfc3339();
                db::mark_order_synced(&db, &order.client_id, &now).ok();
                info!("[Supabase] Synced order {}", order.client_id);
            }
        }
    }
}

async fn is_online(client: &Client, supabase_url: &str) -> bool {
    // Lightweight health check — just HEAD the rest endpoint
    let health = format!("{}/rest/v1/", supabase_url);
    match client.head(&health).send().await {
        Ok(resp) => resp.status().is_success() || resp.status().as_u16() == 401,
        Err(_)   => false,
    }
}

async fn sync_order(
    client: &Client,
    supabase_url: &str,
    anon_key: &str,
    order: &OfflineOrder,
) -> Result<(), String> {
    // Deserialize stored JSON
    let order_data: Value = serde_json::from_str(&order.order_data)
        .map_err(|e| format!("order_data JSON parse: {}", e))?;

    let order_items: Value = serde_json::from_str(&order.order_items)
        .map_err(|e| format!("order_items JSON parse: {}", e))?;

    // Build order body — merge with required fields, use client_id as idempotency key
    let mut body = order_data.clone();
    let obj = body.as_object_mut().ok_or("order_data is not an object")?;
    obj.insert("client_id".into(), json!(order.client_id));
    obj.insert("restaurant_id".into(), json!(order.restaurant_id));
    if let Some(ref tid) = order.table_id {
        obj.insert("table_id".into(), json!(tid));
    }
    obj.insert("created_at".into(), json!(order.created_at));
    obj.insert("status".into(), json!("pending"));

    let orders_url = format!("{}/rest/v1/orders", supabase_url);

    let resp = client
        .post(&orders_url)
        .header("apikey", anon_key)
        .header("Authorization", format!("Bearer {}", anon_key))
        .header("Content-Type", "application/json")
        .header("Prefer", "resolution=merge-duplicates,return=representation")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("POST orders: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("POST orders HTTP {}: {}", status, text));
    }

    // Get the returned order id
    let returned: Value = resp
        .json()
        .await
        .map_err(|e| format!("orders response JSON: {}", e))?;

    let order_id = returned
        .get(0)
        .and_then(|o| o.get("id"))
        .and_then(|id| id.as_str())
        .unwrap_or("")
        .to_string();

    if order_id.is_empty() || order_items.as_array().map(|a| a.is_empty()).unwrap_or(true) {
        return Ok(());
    }

    // Post order items
    let items_url = format!("{}/rest/v1/order_items", supabase_url);

    let items_with_order_id: Vec<Value> = order_items
        .as_array()
        .unwrap()
        .iter()
        .map(|item| {
            let mut i = item.clone();
            if let Some(obj) = i.as_object_mut() {
                obj.insert("order_id".into(), json!(order_id));
            }
            i
        })
        .collect();

    let items_resp = client
        .post(&items_url)
        .header("apikey", anon_key)
        .header("Authorization", format!("Bearer {}", anon_key))
        .header("Content-Type", "application/json")
        .header("Prefer", "resolution=merge-duplicates")
        .json(&items_with_order_id)
        .send()
        .await
        .map_err(|e| format!("POST order_items: {}", e))?;

    if !items_resp.status().is_success() {
        let status = items_resp.status();
        let text = items_resp.text().await.unwrap_or_default();
        warn!("[Supabase] POST order_items HTTP {}: {}", status, text);
        // Non-fatal — order itself was synced
    }

    Ok(())
}

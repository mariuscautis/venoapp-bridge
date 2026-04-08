use crate::db::{self, Db, OfflineOrder};
use chrono::Utc;
use log::{error, info, warn};
use reqwest::Client;
use serde_json::{json, Value};
use std::time::Duration;
use tokio::time;

const POLL_INTERVAL_SECS: u64 = 10;

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

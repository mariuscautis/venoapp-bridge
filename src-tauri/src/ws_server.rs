use crate::db::{self, Db, OfflineOrder};
use crate::printer::{self, ReceiptPayload};
use chrono::Utc;
use futures_util::{SinkExt, StreamExt};
use log::{error, info, warn};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::{Mutex, RwLock};
use tokio::time::{timeout, Duration};
use tokio_tungstenite::tungstenite::Message;

// ── Peer registry ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct PeerInfo {
    pub id:         u64,
    pub ip:         String,
    pub user_agent: String,
    pub connected_at: String,
}

type PeerMap = Arc<RwLock<HashMap<u64, (tokio::sync::mpsc::UnboundedSender<Message>, PeerInfo)>>>;

static PEER_MAP: Lazy<PeerMap> = Lazy::new(|| Arc::new(RwLock::new(HashMap::new())));
static PEER_COUNTER: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(1);

// ── Message types ─────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct WsMessage {
    #[serde(rename = "type")]
    pub msg_type:   String,
    pub payload:    Option<Value>,
    pub token:      Option<String>,
    pub user_agent: Option<String>,
    pub version:    Option<String>,
}

// ── Public API ────────────────────────────────────────────────────────────────

pub async fn connected_count() -> usize {
    PEER_MAP.read().await.len()
}

pub async fn connected_devices() -> Vec<PeerInfo> {
    PEER_MAP.read().await.values().map(|(_, info)| info.clone()).collect()
}

// ── Token helpers ─────────────────────────────────────────────────────────────

/// Get or create the shared auth token stored in SQLite.
pub fn get_or_create_token(db: &Db) -> String {
    if let Some(t) = db::config_get(db, "ws_auth_token") {
        if !t.is_empty() {
            return t;
        }
    }
    // Generate a 32-char hex token
    let token: String = (0..32)
        .map(|_| format!("{:x}", rand_byte()))
        .collect();
    db::config_set(db, "ws_auth_token", &token).ok();
    token
}

fn rand_byte() -> u8 {
    use std::time::{SystemTime, UNIX_EPOCH};
    // Simple non-crypto random sufficient for a LAN token
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(42);
    // Mix with a counter to avoid same-nanosecond collisions
    static CTR: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let c = CTR.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    ((nanos ^ (c * 2654435761)) & 0xFF) as u8
}

// ── Broadcast ─────────────────────────────────────────────────────────────────

async fn broadcast(sender_id: u64, msg: Message) {
    let peers = PEER_MAP.read().await;
    for (id, (tx, _)) in peers.iter() {
        if *id != sender_id {
            tx.send(msg.clone()).ok();
        }
    }
}

// ── Main server entry point ───────────────────────────────────────────────────

pub async fn start(db: Db, printer_ip: Arc<Mutex<String>>) {
    let auth_token = get_or_create_token(&db);
    info!("[WS] Auth token ready ({}...)", &auth_token[..6]);

    let addr = "0.0.0.0:3355";
    let listener = match TcpListener::bind(addr).await {
        Ok(l)  => l,
        Err(e) => {
            error!("[WS] Failed to bind on {}: {}", addr, e);
            return;
        }
    };
    info!("[WS] Listening on ws://{}", addr);

    loop {
        match listener.accept().await {
            Ok((stream, peer_addr)) => {
                let db         = db.clone();
                let printer_ip = printer_ip.clone();
                let token      = auth_token.clone();
                let ip         = peer_addr.ip().to_string();
                tokio::spawn(handle_connection(stream, db, printer_ip, token, ip));
            }
            Err(e) => error!("[WS] Accept error: {}", e),
        }
    }
}

// ── Per-connection handler ────────────────────────────────────────────────────

async fn handle_connection(
    stream: tokio::net::TcpStream,
    db: Db,
    printer_ip: Arc<Mutex<String>>,
    auth_token: String,
    peer_ip: String,
) {
    let ws_stream = match tokio_tungstenite::accept_async(stream).await {
        Ok(ws) => ws,
        Err(e) => { warn!("[WS] Handshake error: {}", e); return; }
    };

    let peer_id = PEER_COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let (mut ws_sink, mut ws_source) = ws_stream.split();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Message>();

    // ── Auth: first message must arrive within 3s and carry the correct token ─
    let first_msg = match timeout(Duration::from_secs(3), ws_source.next()).await {
        Ok(Some(Ok(Message::Text(text)))) => text,
        _ => {
            warn!("[WS] Peer {} failed auth (timeout or bad first frame)", peer_ip);
            let _ = ws_sink.send(Message::Text(
                json!({"type":"bridge:auth_failed","reason":"No auth token received"}).to_string()
            )).await;
            return;
        }
    };

    let first: WsMessage = match serde_json::from_str(&first_msg) {
        Ok(m) => m,
        Err(_) => {
            warn!("[WS] Peer {} sent invalid JSON on auth", peer_ip);
            return;
        }
    };

    // Check token — skip auth if no token is stored yet (first-run / DB write failed)
    let token_required = !auth_token.is_empty();
    if token_required && first.token.as_deref() != Some(auth_token.as_str()) {
        warn!("[WS] Peer {} rejected — wrong token (expected: {}…, got: {:?})",
            peer_ip,
            &auth_token[..auth_token.len().min(6)],
            first.token.as_deref().map(|t| &t[..t.len().min(6)])
        );
        let _ = ws_sink.send(Message::Text(
            json!({"type":"bridge:auth_failed","reason":"Invalid token"}).to_string()
        )).await;
        return;
    }

    // Auth passed — extract user agent from first message
    let user_agent = first.user_agent.unwrap_or_else(|| "Unknown".into());
    let peer_info  = PeerInfo {
        id: peer_id,
        ip: peer_ip.clone(),
        user_agent: user_agent.clone(),
        connected_at: Utc::now().to_rfc3339(),
    };

    PEER_MAP.write().await.insert(peer_id, (tx.clone(), peer_info));
    info!("[WS] Peer {} authenticated ({})", peer_ip, user_agent);

    // Send auth success + current connected count
    let count = PEER_MAP.read().await.len();
    tx.send(Message::Text(
        json!({"type":"bridge:auth_ok","connected_devices": count}).to_string()
    )).ok();

    // Also handle first message if it was a ping or order event (after auth)
    if first.msg_type != "bridge:ping" && first.msg_type != "bridge:auth" {
        handle_message(peer_id, &first_msg, &db, &printer_ip).await;
    } else if first.msg_type == "bridge:ping" {
        let pong = json!({"type":"bridge:pong","version":"1.0.0"}).to_string();
        if let Some((ptx, _)) = PEER_MAP.read().await.get(&peer_id) {
            ptx.send(Message::Text(pong)).ok();
        }
    }

    // Pump outbound messages
    let write_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if ws_sink.send(msg).await.is_err() { break; }
        }
    });

    // Process remaining inbound messages
    while let Some(msg_result) = ws_source.next().await {
        match msg_result {
            Ok(Message::Text(text)) => handle_message(peer_id, &text, &db, &printer_ip).await,
            Ok(Message::Ping(data)) => {
                if let Some((ptx, _)) = PEER_MAP.read().await.get(&peer_id) {
                    ptx.send(Message::Pong(data)).ok();
                }
            }
            Ok(Message::Close(_)) | Err(_) => break,
            _ => {}
        }
    }

    PEER_MAP.write().await.remove(&peer_id);
    write_task.abort();
    info!("[WS] Peer {} disconnected", peer_ip);
}

// ── Message routing ───────────────────────────────────────────────────────────

async fn handle_message(peer_id: u64, text: &str, db: &Db, printer_ip: &Arc<Mutex<String>>) {
    let msg: WsMessage = match serde_json::from_str(text) {
        Ok(m)  => m,
        Err(e) => { warn!("[WS] Bad JSON from peer {}: {}", peer_id, e); return; }
    };

    match msg.msg_type.as_str() {
        "bridge:ping" => {
            let pong = json!({"type":"bridge:pong","version":"1.0.0"}).to_string();
            if let Some((tx, _)) = PEER_MAP.read().await.get(&peer_id) {
                tx.send(Message::Text(pong)).ok();
            }
        }

        "bridge:get_status" => {
            let devices = connected_devices().await;
            let payload = json!({
                "connected_devices": devices,
                "duplicate_hub": false,  // always false — if we're running, we ARE the hub
            });
            if let Some((tx, _)) = PEER_MAP.read().await.get(&peer_id) {
                tx.send(Message::Text(
                    json!({"type":"bridge:status","payload": payload}).to_string()
                )).ok();
            }
        }

        "order:insert" => {
            broadcast(peer_id, Message::Text(text.to_owned())).await;
            if let Some(payload) = &msg.payload {
                queue_order_if_offline(db, payload).await;
            }
        }

        "order:update" => {
            broadcast(peer_id, Message::Text(text.to_owned())).await;
        }

        "print:receipt" => {
            if let Some(payload) = &msg.payload {
                let ip = printer_ip.lock().await.clone();
                if ip.is_empty() {
                    warn!("[WS] Print requested but printer IP not configured");
                    return;
                }
                match serde_json::from_value::<ReceiptPayload>(payload.clone()) {
                    Ok(receipt) => {
                        tokio::task::spawn_blocking(move || {
                            if let Err(e) = printer::send_to_printer(&ip, &receipt) {
                                error!("[Printer] {}", e);
                            } else {
                                info!("[Printer] Receipt printed successfully");
                            }
                        });
                    }
                    Err(e) => error!("[WS] Cannot parse receipt payload: {}", e),
                }
            }
        }

        other => warn!("[WS] Unknown message type '{}' from peer {}", other, peer_id),
    }
}

async fn queue_order_if_offline(db: &Db, payload: &Value) {
    let client_id = payload.get("client_id").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    if client_id.is_empty() { return; }

    let restaurant_id = payload.get("restaurant_id").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let table_id      = payload.get("table_id").and_then(|v| v.as_str()).map(|s| s.to_string());
    let order_items   = payload.get("items").cloned().unwrap_or(json!([]));

    let mut order_data = payload.clone();
    if let Some(obj) = order_data.as_object_mut() { obj.remove("items"); }

    let order = OfflineOrder {
        client_id,
        restaurant_id,
        table_id,
        order_data:  order_data.to_string(),
        order_items: order_items.to_string(),
        status:      "pending".to_string(),
        created_at:  Utc::now().to_rfc3339(),
    };

    if let Err(e) = db::insert_offline_order(db, &order) {
        error!("[DB] Failed to queue offline order: {}", e);
    }
}

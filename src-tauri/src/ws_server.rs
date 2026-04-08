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
use tokio_tungstenite::tungstenite::Message;

/// Map of peer_id -> message sender
type PeerMap = Arc<RwLock<HashMap<u64, tokio::sync::mpsc::UnboundedSender<Message>>>>;

static PEER_MAP: Lazy<PeerMap> = Lazy::new(|| Arc::new(RwLock::new(HashMap::new())));
static PEER_COUNTER: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(1);

// ── Message types ─────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct WsMessage {
    #[serde(rename = "type")]
    pub msg_type: String,
    pub payload:  Option<Value>,
    pub version:  Option<String>,
}

// ── Connected device count (exposed to UI) ────────────────────────────────────

pub async fn connected_count() -> usize {
    PEER_MAP.read().await.len()
}

// ── Broadcast to all peers except the sender ─────────────────────────────────

async fn broadcast(sender_id: u64, msg: Message) {
    let peers = PEER_MAP.read().await;
    for (id, tx) in peers.iter() {
        if *id != sender_id {
            tx.send(msg.clone()).ok();
        }
    }
}

// ── Main server entry point ───────────────────────────────────────────────────

pub async fn start(db: Db, printer_ip: Arc<Mutex<String>>) {
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
                info!("[WS] New connection from {}", peer_addr);
                let db = db.clone();
                let printer_ip = printer_ip.clone();
                tokio::spawn(handle_connection(stream, db, printer_ip));
            }
            Err(e) => {
                error!("[WS] Accept error: {}", e);
            }
        }
    }
}

async fn handle_connection(
    stream: tokio::net::TcpStream,
    db: Db,
    printer_ip: Arc<Mutex<String>>,
) {
    let ws_stream = match tokio_tungstenite::accept_async(stream).await {
        Ok(ws) => ws,
        Err(e) => {
            warn!("[WS] Handshake error: {}", e);
            return;
        }
    };

    let peer_id = PEER_COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let (mut ws_sink, mut ws_source) = ws_stream.split();

    // Per-peer outbound channel
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Message>();
    PEER_MAP.write().await.insert(peer_id, tx);

    // Pump outbound messages
    let write_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if ws_sink.send(msg).await.is_err() {
                break;
            }
        }
    });

    // Process inbound messages
    while let Some(msg_result) = ws_source.next().await {
        match msg_result {
            Ok(Message::Text(text)) => {
                handle_message(peer_id, &text, &db, &printer_ip).await;
            }
            Ok(Message::Ping(data)) => {
                // Pong is handled automatically by tungstenite, but just in case:
                if let Some(tx) = PEER_MAP.read().await.get(&peer_id) {
                    tx.send(Message::Pong(data)).ok();
                }
            }
            Ok(Message::Close(_)) | Err(_) => break,
            _ => {}
        }
    }

    // Cleanup
    PEER_MAP.write().await.remove(&peer_id);
    write_task.abort();
    info!("[WS] Peer {} disconnected", peer_id);
}

async fn handle_message(
    peer_id: u64,
    text: &str,
    db: &Db,
    printer_ip: &Arc<Mutex<String>>,
) {
    let msg: WsMessage = match serde_json::from_str(text) {
        Ok(m)  => m,
        Err(e) => {
            warn!("[WS] Bad JSON from peer {}: {}", peer_id, e);
            return;
        }
    };

    match msg.msg_type.as_str() {
        // ── Heartbeat ───────────────────────────────────────────────────────
        "bridge:ping" => {
            let pong = json!({ "type": "bridge:pong", "version": "1.0.0" }).to_string();
            if let Some(tx) = PEER_MAP.read().await.get(&peer_id) {
                tx.send(Message::Text(pong)).ok();
            }
        }

        // ── Order events — broadcast + maybe queue offline ──────────────────
        "order:insert" => {
            // Broadcast to all other peers
            broadcast(peer_id, Message::Text(text.to_owned())).await;

            // Queue for offline sync if needed
            if let Some(payload) = &msg.payload {
                queue_order_if_offline(db, payload, "order:insert").await;
            }
        }

        "order:update" => {
            broadcast(peer_id, Message::Text(text.to_owned())).await;
        }

        // ── Print job ───────────────────────────────────────────────────────
        "print:receipt" => {
            if let Some(payload) = &msg.payload {
                let ip = printer_ip.lock().await.clone();
                if ip.is_empty() {
                    warn!("[WS] Print requested but printer IP not configured");
                    return;
                }

                match serde_json::from_value::<ReceiptPayload>(payload.clone()) {
                    Ok(receipt) => {
                        let ip_clone = ip.clone();
                        tokio::task::spawn_blocking(move || {
                            if let Err(e) = printer::send_to_printer(&ip_clone, &receipt) {
                                error!("[Printer] {}", e);
                            } else {
                                info!("[Printer] Receipt printed successfully");
                            }
                        });
                    }
                    Err(e) => {
                        error!("[WS] Cannot parse receipt payload: {}", e);
                    }
                }
            }
        }

        other => {
            warn!("[WS] Unknown message type from peer {}: {}", peer_id, other);
        }
    }
}

async fn queue_order_if_offline(db: &Db, payload: &Value, _event_type: &str) {
    // We queue every order that arrives — Supabase sync loop skips if already online
    // and upserts with client_id for dedup.
    let client_id = payload
        .get("client_id")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();

    if client_id.is_empty() {
        return; // no idempotency key — skip
    }

    let restaurant_id = payload
        .get("restaurant_id")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();

    let table_id = payload
        .get("table_id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let order_items = payload
        .get("items")
        .cloned()
        .unwrap_or(json!([]));

    // Strip items from order_data to avoid duplication
    let mut order_data = payload.clone();
    if let Some(obj) = order_data.as_object_mut() {
        obj.remove("items");
    }

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

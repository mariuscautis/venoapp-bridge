// Android entry point — Tauri requires a [lib] target for mobile builds.
// All application logic lives in main.rs; this file satisfies the library target.

mod db;
mod mdns;
mod printer;
mod supabase;
mod ws_server;

use db::Db;
use log::{info, warn};
use once_cell::sync::OnceCell;
use printer::check_printer_online;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
#[cfg(not(target_os = "android"))]
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle,
};
use tauri::{Manager, State};
use tokio::sync::Mutex;

pub struct AppState {
    pub db:            Db,
    pub printer_ip:    Arc<Mutex<String>>,
    pub duplicate_hub: Arc<Mutex<bool>>,
}

static RUNTIME: OnceCell<tokio::runtime::Runtime> = OnceCell::new();

#[derive(Debug, Serialize, Deserialize)]
pub struct BridgeConfig {
    pub bridge_code:       String,
    pub restaurant_id:     String,
    pub restaurant_name:   String,
    pub printer_ip:        String,
    pub supabase_url:      String,
    pub supabase_anon_key: String,
    pub setup_complete:    bool,
}

#[tauri::command]
fn get_config(state: State<AppState>) -> BridgeConfig {
    let db = &state.db;
    BridgeConfig {
        bridge_code:       db::config_get(db, "bridge_code").unwrap_or_default(),
        restaurant_id:     db::config_get(db, "restaurant_id").unwrap_or_default(),
        restaurant_name:   db::config_get(db, "restaurant_name").unwrap_or_default(),
        printer_ip:        db::config_get(db, "printer_ip").unwrap_or_default(),
        supabase_url:      db::config_get(db, "supabase_url").unwrap_or_default(),
        supabase_anon_key: db::config_get(db, "supabase_anon_key").unwrap_or_default(),
        setup_complete:    db::config_get(db, "setup_complete")
            .map(|v| v == "true")
            .unwrap_or(false),
    }
}

#[tauri::command]
fn save_config(state: State<AppState>, config: BridgeConfig) -> Result<(), String> {
    let db = &state.db;
    db::config_set(db, "bridge_code",       &config.bridge_code).map_err(|e| e.to_string())?;
    db::config_set(db, "restaurant_id",     &config.restaurant_id).map_err(|e| e.to_string())?;
    db::config_set(db, "restaurant_name",   &config.restaurant_name).map_err(|e| e.to_string())?;
    db::config_set(db, "printer_ip",        &config.printer_ip).map_err(|e| e.to_string())?;
    db::config_set(db, "supabase_url",      &config.supabase_url).map_err(|e| e.to_string())?;
    db::config_set(db, "supabase_anon_key", &config.supabase_anon_key).map_err(|e| e.to_string())?;
    db::config_set(db, "setup_complete", if config.setup_complete { "true" } else { "false" })
        .map_err(|e| e.to_string())?;
    let ip   = config.printer_ip.clone();
    let pip  = state.printer_ip.clone();
    // Push WS token to Supabase so the PWA can authenticate
    let token        = ws_server::get_or_create_token(&state.db);
    let bridge_code  = config.bridge_code.clone();
    let supabase_url = config.supabase_url.clone();
    let anon_key     = config.supabase_anon_key.clone();
    RUNTIME.get().unwrap().spawn(async move {
        *pip.lock().await = ip;
        if !bridge_code.is_empty() && !supabase_url.is_empty() && !anon_key.is_empty() {
            if let Err(e) = supabase::push_connection_info(&bridge_code, &token, &supabase_url, &anon_key).await {
                warn!("[Config] Failed to push connection info to Supabase: {}", e);
            } else {
                info!("[Config] Connection info (token + IP) pushed to Supabase");
            }
        }
    });
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct BridgeStatus {
    pub connected_devices: usize,
    pub printer_online:    bool,
    pub pending_orders:    usize,
    pub internet_ok:       bool,
    pub duplicate_hub:     bool,
}

#[tauri::command]
async fn get_status(state: State<'_, AppState>) -> Result<BridgeStatus, String> {
    let connected_devices = ws_server::connected_count().await;
    let printer_ip        = state.printer_ip.lock().await.clone();
    let printer_online    = tokio::task::spawn_blocking(move || check_printer_online(&printer_ip))
        .await.unwrap_or(false);
    let pending_orders = db::pending_order_count(&state.db);
    let internet_ok = tokio::task::spawn_blocking(|| {
        use std::net::TcpStream;
        use std::time::Duration;
        TcpStream::connect_timeout(&"8.8.8.8:53".parse().unwrap(), Duration::from_secs(2)).is_ok()
    }).await.unwrap_or(false);
    let duplicate_hub = *state.duplicate_hub.lock().await;
    Ok(BridgeStatus { connected_devices, printer_online, pending_orders, internet_ok, duplicate_hub })
}

#[tauri::command]
async fn get_connected_devices() -> Vec<ws_server::PeerInfo> {
    ws_server::connected_devices().await
}

#[tauri::command]
async fn resolve_bridge_code(code: String) -> Result<serde_json::Value, String> {
    let (restaurant_id, name) = supabase::resolve_bridge_code(&code).await?;
    Ok(serde_json::json!({ "restaurant_id": restaurant_id, "name": name }))
}

#[tauri::command]
fn test_print(state: State<AppState>) -> Result<(), String> {
    use chrono::Utc;
    use printer::ReceiptPayload;
    let ip = db::config_get(&state.db, "printer_ip").unwrap_or_default();
    if ip.is_empty() { return Err("Printer IP not configured".into()); }
    let test_receipt = ReceiptPayload {
        venue_name:   "VenoApp Test".into(),
        order_type:   "dine-in".into(),
        table_number: Some("1".into()),
        items: vec![printer::ReceiptItem { name: "Test Item".into(), quantity: 1.0, price: 9.99 }],
        subtotal:    9.99,
        tax_rate:    0.20,
        tax_label:   Some("VAT".into()),
        tax_amount:  2.00,
        total:       11.99,
        currency:    Some("GBP".into()),
        locale:      Some("en-GB".into()),
        vat_number:  None,
        tax_id:      None,
        footer_text: Some("Thank you for testing VenoApp Bridge!".into()),
        timestamp:   Some(Utc::now().to_rfc3339()),
    };
    printer::send_to_printer(&ip, &test_receipt)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "android")]
    android_logger::init_once(
        android_logger::Config::default().with_max_level(log::LevelFilter::Info),
    );
    #[cfg(not(target_os = "android"))]
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("Tokio runtime failed");
    RUNTIME.set(runtime).expect("Runtime already set");

    let mut builder = tauri::Builder::default();

    #[cfg(not(target_os = "android"))]
    {
        builder = builder.plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ));
    }

    builder
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir().expect("Cannot resolve app data dir");
            let db = db::open(data_dir).expect("Failed to open SQLite DB");

            if db::config_get(&db, "supabase_url").is_none() {
                db::config_set(&db, "supabase_url", "https://rfquwezkkdyvjftveilf.supabase.co").ok();
            }
            if db::config_get(&db, "supabase_anon_key").is_none() {
                db::config_set(&db, "supabase_anon_key", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJmcXV3ZXpra2R5dmpmdHZlaWxmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQyNTAxMzEsImV4cCI6MjA3OTgyNjEzMX0.sIOvuPu8AoL2QRtTPEMFcHVWv3lY_pyMIWgsZ7uyyxc").ok();
            }

            let printer_ip_str = db::config_get(&db, "printer_ip").unwrap_or_default();
            let printer_ip = Arc::new(Mutex::new(printer_ip_str));
            let duplicate_hub = Arc::new(Mutex::new(false));
            app.manage(AppState {
                db: db.clone(),
                printer_ip: printer_ip.clone(),
                duplicate_hub: duplicate_hub.clone(),
            });

            #[cfg(not(target_os = "android"))]
            setup_tray(app.handle())?;

            let rt = RUNTIME.get().unwrap();

            // Check for a pre-existing hub on the LAN before starting our own.
            // Connect attempt to venobridge.local:3355; if it succeeds another hub
            // is already running — set the flag so the UI can warn the user.
            let dup_flag = duplicate_hub.clone();
            rt.spawn(async move {
                let already_running = tokio::time::timeout(
                    tokio::time::Duration::from_secs(2),
                    tokio::net::TcpStream::connect("venobridge.local:3355"),
                ).await.map(|r| r.is_ok()).unwrap_or(false);
                if already_running {
                    warn!("[Main] Another VenoApp Bridge detected on LAN — duplicate hub warning set");
                    *dup_flag.lock().await = true;
                }
            });

            let db_ws = db.clone();
            let pip_ws = printer_ip.clone();
            rt.spawn(async move { ws_server::start(db_ws, pip_ws).await; });
            let db_sync = db.clone();
            rt.spawn(async move { supabase::start_sync_loop(db_sync).await; });
            rt.spawn(async move { mdns::start_mdns("VenoApp Bridge"); });

            #[cfg(not(target_os = "android"))]
            {
                let setup_done = db::config_get(&db, "setup_complete").map(|v| v == "true").unwrap_or(false);
                if !setup_done {
                    if let Some(win) = app.get_webview_window("main") {
                        win.show().ok();
                        win.set_focus().ok();
                    }
                }
                use tauri_plugin_autostart::ManagerExt;
                app.autolaunch().enable().ok();
            }

            info!("[Main] VenoApp Bridge started");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_config, save_config, get_status, test_print, resolve_bridge_code, get_connected_devices])
        .run(tauri::generate_context!())
        .expect("Error running Tauri application");
}

#[cfg(not(target_os = "android"))]
fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let show_item = MenuItemBuilder::with_id("show", "Show").build(app)?;
    let quit_item = MenuItemBuilder::with_id("quit", "Quit VenoApp Bridge").build(app)?;
    let menu = MenuBuilder::new(app).items(&[&show_item, &quit_item]).build()?;
    TrayIconBuilder::new()
        .menu(&menu)
        .tooltip("VenoApp Bridge — running")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => { if let Some(win) = app.get_webview_window("main") { win.show().ok(); win.set_focus().ok(); } }
            "quit" => { info!("[Tray] Quit"); app.exit(0); }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                let app = tray.app_handle();
                if let Some(win) = app.get_webview_window("main") {
                    if win.is_visible().unwrap_or(false) { win.hide().ok(); }
                    else { win.show().ok(); win.set_focus().ok(); }
                }
            }
        })
        .build(app)?;
    Ok(())
}

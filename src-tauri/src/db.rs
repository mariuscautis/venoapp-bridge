use rusqlite::{Connection, Result, params};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

pub type Db = Arc<Mutex<Connection>>;

pub fn open(data_dir: PathBuf) -> Result<Db> {
    std::fs::create_dir_all(&data_dir).ok();
    let db_path = data_dir.join("venobridge.db");
    let conn = Connection::open(db_path)?;

    // Enable WAL mode for better concurrent access
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")?;

    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS config (
            key   TEXT PRIMARY KEY,
            value TEXT
        );

        CREATE TABLE IF NOT EXISTS offline_orders (
            client_id       TEXT PRIMARY KEY,
            restaurant_id   TEXT NOT NULL,
            table_id        TEXT,
            order_data      TEXT NOT NULL,
            order_items     TEXT NOT NULL,
            status          TEXT DEFAULT 'pending',
            created_at      TEXT NOT NULL,
            synced_at       TEXT
        );

        CREATE TABLE IF NOT EXISTS offline_payments (
            payment_id      TEXT PRIMARY KEY,
            order_ids       TEXT NOT NULL,
            payment_method  TEXT,
            table_id        TEXT,
            status          TEXT DEFAULT 'pending',
            created_at      TEXT NOT NULL
        );
        "#,
    )?;

    Ok(Arc::new(Mutex::new(conn)))
}

// ── Config helpers ─────────────────────────────────────────────────────────────

pub fn config_get(db: &Db, key: &str) -> Option<String> {
    let conn = db.lock().unwrap();
    conn.query_row(
        "SELECT value FROM config WHERE key = ?1",
        params![key],
        |row| row.get(0),
    )
    .ok()
}

pub fn config_set(db: &Db, key: &str, value: &str) -> Result<()> {
    let conn = db.lock().unwrap();
    conn.execute(
        "INSERT INTO config (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

// ── Offline orders ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct OfflineOrder {
    pub client_id:     String,
    pub restaurant_id: String,
    pub table_id:      Option<String>,
    pub order_data:    String,
    pub order_items:   String,
    pub status:        String,
    pub created_at:    String,
}

pub fn insert_offline_order(db: &Db, order: &OfflineOrder) -> Result<()> {
    let conn = db.lock().unwrap();
    conn.execute(
        r#"INSERT INTO offline_orders
           (client_id, restaurant_id, table_id, order_data, order_items, status, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
           ON CONFLICT(client_id) DO NOTHING"#,
        params![
            order.client_id,
            order.restaurant_id,
            order.table_id,
            order.order_data,
            order.order_items,
            order.status,
            order.created_at,
        ],
    )?;
    Ok(())
}

pub fn pending_offline_orders(db: &Db) -> Result<Vec<OfflineOrder>> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT client_id, restaurant_id, table_id, order_data, order_items, status, created_at
         FROM offline_orders WHERE status = 'pending' ORDER BY created_at ASC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(OfflineOrder {
            client_id:     row.get(0)?,
            restaurant_id: row.get(1)?,
            table_id:      row.get(2)?,
            order_data:    row.get(3)?,
            order_items:   row.get(4)?,
            status:        row.get(5)?,
            created_at:    row.get(6)?,
        })
    })?;
    rows.collect()
}

pub fn mark_order_synced(db: &Db, client_id: &str, synced_at: &str) -> Result<()> {
    let conn = db.lock().unwrap();
    conn.execute(
        "UPDATE offline_orders SET status = 'synced', synced_at = ?1 WHERE client_id = ?2",
        params![synced_at, client_id],
    )?;
    Ok(())
}

pub fn pending_order_count(db: &Db) -> usize {
    let conn = db.lock().unwrap();
    conn.query_row(
        "SELECT COUNT(*) FROM offline_orders WHERE status = 'pending'",
        [],
        |row| row.get::<_, i64>(0),
    )
    .unwrap_or(0) as usize
}

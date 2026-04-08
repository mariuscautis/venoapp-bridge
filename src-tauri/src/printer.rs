use chrono::DateTime;
use serde::Deserialize;
use std::io::Write;
use std::net::TcpStream;
use std::time::Duration;

// ── ESC/POS constants ────────────────────────────────────────────────────────

const ESC: u8 = 0x1B;
const GS:  u8 = 0x1D;

fn cmd_init()           -> Vec<u8> { vec![ESC, b'@'] }
fn cmd_align_center()   -> Vec<u8> { vec![ESC, b'a', 1] }
fn cmd_align_left()     -> Vec<u8> { vec![ESC, b'a', 0] }
fn cmd_bold_on()        -> Vec<u8> { vec![ESC, b'E', 1] }
fn cmd_bold_off()       -> Vec<u8> { vec![ESC, b'E', 0] }
fn cmd_double_width_on()  -> Vec<u8> { vec![GS,  b'!', 0x11] }
fn cmd_double_width_off() -> Vec<u8> { vec![GS,  b'!', 0x00] }
fn cmd_feed(n: u8)      -> Vec<u8> { vec![ESC, b'd', n] }
fn cmd_cut()            -> Vec<u8> { vec![GS,  b'V', 1] }   // partial cut
fn cmd_lf()             -> Vec<u8> { vec![b'\n'] }

const LINE_WIDTH: usize = 42; // characters for 80mm paper at standard font

fn separator() -> Vec<u8> {
    let mut v = "-".repeat(LINE_WIDTH).into_bytes();
    v.push(b'\n');
    v
}

fn right_align_price(label: &str, price: &str) -> Vec<u8> {
    let total_len = LINE_WIDTH;
    let spaces = total_len.saturating_sub(label.len() + price.len());
    format!("{}{}{}\n", label, " ".repeat(spaces), price).into_bytes()
}

// ── Receipt payload ──────────────────────────────────────────────────────────

#[derive(Debug, Deserialize, Clone)]
pub struct ReceiptItem {
    pub name:     String,
    pub quantity: f64,
    pub price:    f64,
}

#[derive(Debug, Deserialize, Clone)]
pub struct ReceiptPayload {
    pub venue_name:   String,
    pub order_type:   String,          // "dine-in" | "takeaway" | "delivery"
    pub table_number: Option<String>,
    pub items:        Vec<ReceiptItem>,
    pub subtotal:     f64,
    pub tax_rate:     f64,
    pub tax_label:    Option<String>,  // "VAT" | "TVA" | "IVA" | "MwSt"
    pub tax_amount:   f64,
    pub total:        f64,
    pub currency:     Option<String>,  // "EUR" | "GBP" | "USD" | "RON"
    pub locale:       Option<String>,
    pub vat_number:   Option<String>,
    pub tax_id:       Option<String>,
    pub footer_text:  Option<String>,
    pub timestamp:    Option<String>,
}

fn currency_symbol(currency: Option<&str>) -> &str {
    match currency {
        Some("GBP") => "£",
        Some("USD") => "$",
        Some("EUR") => "€",
        Some("RON") => "lei ",
        _           => "£",
    }
}

fn format_price(sym: &str, amount: f64) -> String {
    if sym == "lei " {
        format!("{}{:.2}", sym, amount)
    } else {
        format!("{}{:.2}", sym, amount)
    }
}

fn format_order_type(order_type: &str) -> &str {
    match order_type {
        "dine-in"  => "Dine-In",
        "takeaway" => "Takeaway",
        "delivery" => "Delivery",
        other      => other,
    }
}

pub fn build_receipt_bytes(receipt: &ReceiptPayload) -> Vec<u8> {
    let mut data: Vec<u8> = Vec::new();
    let sym = currency_symbol(receipt.currency.as_deref());
    let tax_label = receipt.tax_label.as_deref().unwrap_or("VAT");

    // Init
    data.extend(cmd_init());

    // ── Header: venue name ─────────────────────────────────────────────────
    data.extend(cmd_align_center());
    data.extend(cmd_bold_on());
    data.extend(cmd_double_width_on());
    data.extend(format!("{}\n", receipt.venue_name).into_bytes());
    data.extend(cmd_double_width_off());
    data.extend(cmd_bold_off());
    data.extend(cmd_lf());

    data.extend(cmd_align_left());
    data.extend(separator());

    // ── Order info ─────────────────────────────────────────────────────────
    data.extend(format!("Type: {}\n", format_order_type(&receipt.order_type)).into_bytes());

    if receipt.order_type == "dine-in" {
        if let Some(ref table) = receipt.table_number {
            data.extend(format!("Table: {}\n", table).into_bytes());
        }
    }

    // Timestamp
    let time_str = receipt.timestamp.as_deref().unwrap_or("");
    if !time_str.is_empty() {
        if let Ok(dt) = DateTime::parse_from_rfc3339(time_str) {
            let locale = receipt.locale.as_deref().unwrap_or("en-GB");
            let fmt = if locale.starts_with("en") {
                dt.format("%d/%m/%Y %H:%M").to_string()
            } else {
                dt.format("%d.%m.%Y %H:%M").to_string()
            };
            data.extend(format!("Date: {}\n", fmt).into_bytes());
        } else {
            data.extend(format!("Date: {}\n", time_str).into_bytes());
        }
    }

    data.extend(separator());

    // ── Items ───────────────────────────────────────────────────────────────
    for item in &receipt.items {
        let qty = if item.quantity == item.quantity.floor() {
            format!("{}x", item.quantity as i64)
        } else {
            format!("{:.1}x", item.quantity)
        };
        let label = format!("{} {}", item.name, qty);
        let price = format_price(sym, item.price * item.quantity);
        data.extend(right_align_price(&label, &price));
    }

    data.extend(separator());

    // ── Totals ──────────────────────────────────────────────────────────────
    data.extend(right_align_price("Subtotal", &format_price(sym, receipt.subtotal)));

    if receipt.tax_amount > 0.0 {
        let tax_line = format!("{} ({:.0}%)", tax_label, receipt.tax_rate * 100.0);
        data.extend(right_align_price(&tax_line, &format_price(sym, receipt.tax_amount)));
    }

    // Total — bold + slightly larger
    data.extend(cmd_bold_on());
    data.extend(right_align_price("TOTAL", &format_price(sym, receipt.total)));
    data.extend(cmd_bold_off());

    data.extend(separator());

    // ── Footer ──────────────────────────────────────────────────────────────
    data.extend(cmd_align_center());

    if let Some(ref vat_no) = receipt.vat_number {
        if !vat_no.is_empty() {
            data.extend(format!("VAT No: {}\n", vat_no).into_bytes());
        }
    }

    if let Some(ref tax_id) = receipt.tax_id {
        if !tax_id.is_empty() {
            data.extend(format!("Tax ID: {}\n", tax_id).into_bytes());
        }
    }

    if let Some(ref footer) = receipt.footer_text {
        if !footer.is_empty() {
            data.extend(cmd_lf());
            data.extend(footer.as_bytes().to_vec());
            data.extend(cmd_lf());
        }
    }

    // Feed + cut
    data.extend(cmd_feed(3));
    data.extend(cmd_cut());

    data
}

// ── TCP send ─────────────────────────────────────────────────────────────────

pub fn send_to_printer(printer_ip: &str, receipt: &ReceiptPayload) -> Result<(), String> {
    let addr = format!("{}:9100", printer_ip);
    let mut stream = TcpStream::connect_timeout(
        &addr.parse().map_err(|e| format!("Invalid IP: {}", e))?,
        Duration::from_secs(5),
    )
    .map_err(|e| format!("Cannot connect to printer at {}: {}", addr, e))?;

    stream
        .set_write_timeout(Some(Duration::from_secs(10)))
        .ok();

    let bytes = build_receipt_bytes(receipt);
    stream
        .write_all(&bytes)
        .map_err(|e| format!("Print write error: {}", e))?;

    stream.flush().map_err(|e| format!("Print flush error: {}", e))?;
    Ok(())
}

/// Quick TCP probe — returns true if the printer TCP port is reachable.
pub fn check_printer_online(printer_ip: &str) -> bool {
    if printer_ip.is_empty() {
        return false;
    }
    let addr = format!("{}:9100", printer_ip);
    match addr.parse() {
        Ok(addr) => TcpStream::connect_timeout(&addr, Duration::from_secs(2)).is_ok(),
        Err(_)   => false,
    }
}

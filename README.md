# VenoApp Bridge

A Tauri v2 companion app for the VenoApp restaurant POS web app.  
Runs silently in the system tray and acts as a local bridge between POS devices.

## What it does

| Feature | Detail |
|---------|--------|
| **WebSocket server** | Listens on `ws://0.0.0.0:3355` — broadcasts order events to all connected POS devices on the LAN |
| **mDNS broadcast** | Announces itself as `_venobridge._tcp.local.` so the PWA can discover it via `ws://venobridge.local:3355` |
| **Offline queue** | Stores incoming orders in SQLite when internet is down; syncs to Supabase when it comes back (polls every 10 s) |
| **ESC/POS printing** | Accepts `print:receipt` WebSocket messages and sends formatted ESC/POS bytes to a thermal printer via TCP (port 9100) |
| **System tray** | Runs silently in the background; left-click to toggle window, right-click for menu |
| **Auto-start** | Registers itself to launch on boot via `tauri-plugin-autostart` |

## Platforms

- **Linux** — primary target (system tray via AppIndicator/StatusNotifier)
- **Android** — APK build (foreground-service model; mDNS works on Android 12+)

## Development

### Prerequisites

```bash
# Rust toolchain
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Node (via nvm recommended)
nvm install 20

# Tauri CLI
cargo install tauri-cli --version "^2.0"

# Linux deps (Debian/Ubuntu)
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
     librsvg2-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev
```

### Run in development

```bash
npm install
cargo tauri dev
```

### Build for Linux

```bash
npm install
cargo tauri build
# Output: src-tauri/target/release/bundle/
```

### Build for Android

```bash
cargo tauri android init    # first time only
cargo tauri android build
```

## WebSocket protocol

All messages are JSON. The bridge relays order events to all other connected clients.

| Message type | Direction | Description |
|---|---|---|
| `bridge:ping` | Client → Bridge | Heartbeat |
| `bridge:pong` | Bridge → Client | Heartbeat response |
| `order:insert` | Client → Bridge → All | New order created |
| `order:update` | Client → Bridge → All | Order status changed |
| `print:receipt` | Client → Bridge | Print a receipt |

### order:insert payload

```json
{
  "type": "order:insert",
  "payload": {
    "client_id": "uuid-v4",
    "restaurant_id": "rest_abc",
    "table_id": "table-uuid",
    "items": [{ "name": "Burger", "quantity": 2, "price": 9.99 }],
    ...
  }
}
```

### print:receipt payload

```json
{
  "type": "print:receipt",
  "payload": {
    "venue_name": "My Restaurant",
    "order_type": "dine-in",
    "table_number": "4",
    "items": [{ "name": "Burger", "quantity": 1, "price": 9.99 }],
    "subtotal": 9.99,
    "tax_rate": 0.20,
    "tax_label": "VAT",
    "tax_amount": 2.00,
    "total": 11.99,
    "currency": "GBP",
    "locale": "en-GB",
    "vat_number": "GB123456789",
    "footer_text": "Thank you!",
    "timestamp": "2026-04-08T12:00:00Z"
  }
}
```

## Using the PWA hook

Copy `src/hooks/useVenoBridge.js` into your VenoApp PWA project:

```jsx
import { useVenoBridge } from "@/hooks/useVenoBridge";

function CheckoutButton({ order }) {
  const { isConnected, sendOrderEvent, sendPrintJob } = useVenoBridge();

  const handleCheckout = async () => {
    const sent = sendOrderEvent("order:insert", order);
    if (!sent) {
      // Bridge not found — fall back to direct Supabase insert
      await supabase.from("orders").insert(order);
    }
  };
}
```

## SQLite schema

Located at `$APP_DATA/venobridge.db`:

- `config` — key/value store (supabase credentials, printer IP, etc.)
- `offline_orders` — queued orders pending Supabase sync
- `offline_payments` — queued payments pending sync

## Configuration keys

| Key | Description |
|---|---|
| `restaurant_id` | Restaurant identifier |
| `printer_ip` | IP address of ESC/POS thermal printer |
| `supabase_url` | Supabase project URL |
| `supabase_anon_key` | Supabase anon/public key |
| `setup_complete` | `"true"` once the setup form has been saved |

#!/usr/bin/env node
'use strict';

const http       = require('http');
const fs         = require('fs');
const path       = require('path');
const os         = require('os');
const { exec }   = require('child_process');
const WebSocket  = require('ws');

// ── Config ─────────────────────────────────────────────────────────────────────
const CONFIG_PATH = path.join(
  process.env.APPDATA || path.join(os.homedir(), '.config'),
  'VenoApp Bridge', 'config.json'
);

const SUPABASE_URL = 'https://rfquwezkkdyvjftveilf.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJmcXV3ZXpra2R5dmpmdHZlaWxmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQyNTAxMzEsImV4cCI6MjA3OTgyNjEzMX0.sIOvuPu8AoL2QRtTPEMFcHVWv3lY_pyMIWgsZ7uyyxc';

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch { return {}; }
}

function saveConfig(data) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2));
}

// ── Token ──────────────────────────────────────────────────────────────────────
function getOrCreateToken(cfg) {
  if (cfg.ws_auth_token) return cfg.ws_auth_token;
  const token = require('crypto').randomBytes(16).toString('hex');
  cfg.ws_auth_token = token;
  saveConfig(cfg);
  return token;
}

// ── Local IP ───────────────────────────────────────────────────────────────────
function getLocalIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

// ── Supabase push ──────────────────────────────────────────────────────────────
async function pushToSupabase(cfg, token, ip) {
  if (!cfg.bridge_code || !token) return;
  const code = cfg.bridge_code.replace(/-/g, '').toUpperCase();
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/set_bridge_connection`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_bridge_code: code, p_token: token, p_hub_ip: ip }),
    });
    if (!res.ok) console.error('[Supabase] Push failed:', res.status);
    else console.log('[Supabase] Connection info pushed');
  } catch (e) {
    console.error('[Supabase] Push error:', e.message);
  }
}

// ── Resolve bridge code ────────────────────────────────────────────────────────
async function resolveBridgeCode(code) {
  const clean = code.replace(/-/g, '').toUpperCase();
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/restaurants?bridge_code=eq.${clean}&select=id,name`,
    { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
  );
  const rows = await res.json();
  if (!rows.length) throw new Error('Restaurant not found for code: ' + code);
  return rows[0];
}

// ── Connected peers ────────────────────────────────────────────────────────────
const peers = new Map(); // id → { ws, ip, userAgent, connectedAt }
let peerCounter = 1;

// ── HTTP server (config UI + API) ──────────────────────────────────────────────
function createHttpServer(wss, cfg, token) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost`);

    // CORS for local requests
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // Status API
    if (url.pathname === '/api/status') {
      const ip = getLocalIp();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        bridge_code:       cfg.bridge_code || '',
        restaurant_name:   cfg.restaurant_name || '',
        printer_ip:        cfg.printer_ip || '',
        setup_complete:    !!cfg.setup_complete,
        hub_ip:            ip,
        ws_token:          token ? token.slice(0, 8) + '...' : '',
        connected_devices: peers.size,
      }));
      return;
    }

    // Save config API
    if (url.pathname === '/api/save' && req.method === 'POST') {
      let body = '';
      req.on('data', d => body += d);
      req.on('end', async () => {
        try {
          const data = JSON.parse(body);
          // Resolve bridge code
          const row = await resolveBridgeCode(data.bridge_code);
          cfg.bridge_code      = data.bridge_code;
          cfg.restaurant_id    = row.id;
          cfg.restaurant_name  = row.name;
          cfg.printer_ip       = data.printer_ip || '';
          cfg.setup_complete   = true;
          saveConfig(cfg);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, restaurant_name: row.name }));
          // Push to Supabase
          const ip = getLocalIp();
          pushToSupabase(cfg, token, ip);
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return;
    }

    // Setup UI
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getSetupHtml(cfg));
  });
}

// ── Setup HTML UI ──────────────────────────────────────────────────────────────
function getSetupHtml(cfg) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>VenoApp Bridge</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f1117;color:#e2e8f0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
  .card{background:#1a1d27;border:1px solid #2a2d3e;border-radius:12px;padding:32px;width:100%;max-width:440px}
  .logo{width:40px;height:40px;background:#6262bd;border-radius:10px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:20px;color:#fff;margin-bottom:16px}
  h1{font-size:20px;font-weight:700;margin-bottom:4px}
  .sub{color:#94a3b8;font-size:14px;margin-bottom:24px}
  label{display:block;font-size:13px;color:#94a3b8;margin-bottom:6px;margin-top:16px}
  input{width:100%;padding:10px 12px;background:#0f1117;border:1px solid #2a2d3e;border-radius:7px;color:#e2e8f0;font-size:14px;outline:none}
  input:focus{border-color:#6262bd}
  .hint{font-size:11px;color:#64748b;margin-top:4px}
  button{width:100%;padding:12px;background:#6262bd;color:#fff;border:none;border-radius:7px;font-size:14px;font-weight:600;cursor:pointer;margin-top:20px}
  button:hover{background:#7474d4}
  button:disabled{opacity:0.6;cursor:default}
  .msg{margin-top:12px;padding:10px 14px;border-radius:6px;font-size:13px}
  .err{background:#3b1a1a;color:#f87171;border:1px solid #ef444444}
  .ok{background:#0f291e;color:#4ade80;border:1px solid #22c55e44}
  .status-grid{margin-top:20px;border-top:1px solid #2a2d3e;padding-top:20px;display:grid;gap:10px}
  .row{display:flex;justify-content:space-between;font-size:14px}
  .dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:8px}
  .green{background:#22c55e} .brand{background:#6262bd} .muted{background:#64748b}
  .val{font-weight:600;font-family:monospace;font-size:13px}
</style>
</head>
<body>
<div class="card">
  <div class="logo">V</div>
  <h1>VenoApp Bridge</h1>
  <p class="sub" id="subtitle">${cfg.setup_complete ? `Running · ${cfg.restaurant_name || ''}` : 'Setup required'}</p>

  <div id="form-section" ${cfg.setup_complete ? 'style="display:none"' : ''}>
    <label>Restaurant Code</label>
    <input id="code" placeholder="XXXX-XXXX" value="${cfg.bridge_code || ''}" maxlength="9" style="text-transform:uppercase;letter-spacing:0.1em;font-weight:600;font-size:16px">
    <div class="hint">Found in VenoApp → Settings → Offline Hub</div>

    <label>Printer IP Address</label>
    <input id="printer" placeholder="192.168.1.100" value="${cfg.printer_ip || ''}">

    <button id="saveBtn" onclick="save()">Save &amp; Start</button>
    <div id="msg"></div>
  </div>

  <div id="status-section" ${!cfg.setup_complete ? 'style="display:none"' : ''}>
    <div class="status-grid" id="status-grid">
      <div class="row"><span><span class="dot green"></span>Status</span><span class="val" style="color:#22c55e">Bridge Active</span></div>
    </div>
    <button style="margin-top:16px;background:transparent;border:1px solid #2a2d3e;color:#94a3b8" onclick="document.getElementById('form-section').style.display='';document.getElementById('saveBtn').textContent='Update Settings'">Edit Settings</button>
  </div>
</div>

<script>
  // Auto-format code input
  document.getElementById('code').addEventListener('input', function() {
    let v = this.value.toUpperCase().replace(/[^A-Z0-9]/g,'');
    if(v.length>4) v=v.slice(0,4)+'-'+v.slice(4,8);
    this.value=v;
  });

  async function save() {
    const btn  = document.getElementById('saveBtn');
    const msg  = document.getElementById('msg');
    const code = document.getElementById('code').value.trim();
    const printer = document.getElementById('printer').value.trim();
    btn.disabled=true; btn.textContent='Saving...'; msg.innerHTML='';
    try {
      const r = await fetch('/api/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({bridge_code:code,printer_ip:printer})});
      const d = await r.json();
      if(d.ok){
        msg.className='msg ok'; msg.textContent='Connected to '+d.restaurant_name+'. Bridge is now active.';
        setTimeout(()=>location.reload(),1500);
      } else {
        msg.className='msg err'; msg.textContent=d.error||'Unknown error';
        btn.disabled=false; btn.textContent='Save & Start';
      }
    } catch(e){
      msg.className='msg err'; msg.textContent=e.message;
      btn.disabled=false; btn.textContent='Save & Start';
    }
  }

  // Poll status every 3s
  async function pollStatus() {
    try {
      const r = await fetch('/api/status');
      const d = await r.json();
      const grid = document.getElementById('status-grid');
      if(grid && d.setup_complete) {
        grid.innerHTML =
          '<div class="row"><span><span class="dot green"></span>Connected Devices</span><span class="val" style="color:#22c55e">'+d.connected_devices+'</span></div>'+
          '<div class="row"><span><span class="dot brand"></span>Hub IP</span><span class="val" style="color:#94a3b8">'+d.hub_ip+'</span></div>'+
          '<div class="row"><span><span class="dot muted"></span>Auth Token</span><span class="val" style="color:#94a3b8">'+d.ws_token+'</span></div>';
        document.getElementById('subtitle').textContent='Running · '+d.restaurant_name;
        document.getElementById('status-section').style.display='';
      }
    } catch {}
  }
  setInterval(pollStatus, 3000);
  pollStatus();
</script>
</body>
</html>`;
}

// ── WebSocket server ───────────────────────────────────────────────────────────
function createWsServer(server, token) {
  const wss = new WebSocket.Server({ server });

  wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress || 'unknown';
    const id = peerCounter++;
    let authenticated = false;

    const authTimeout = setTimeout(() => {
      if (!authenticated) { ws.close(); }
    }, 3000);

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); }
      catch { return; }

      if (!authenticated) {
        // First message must be bridge:auth with correct token
        if (msg.type === 'bridge:auth') {
          if (!token || msg.token === token) {
            authenticated = true;
            clearTimeout(authTimeout);
            const userAgent = msg.user_agent || 'Unknown';
            peers.set(id, { ws, ip, userAgent, connectedAt: new Date().toISOString() });
            console.log(`[WS] Peer ${ip} authenticated`);
            ws.send(JSON.stringify({ type: 'bridge:auth_ok', connected_devices: peers.size }));
          } else {
            ws.send(JSON.stringify({ type: 'bridge:auth_failed', reason: 'Invalid token' }));
            ws.close();
          }
        }
        return;
      }

      // Authenticated messages
      switch (msg.type) {
        case 'bridge:ping':
          ws.send(JSON.stringify({ type: 'bridge:pong', version: '1.0.0' }));
          break;
        case 'bridge:get_status':
          ws.send(JSON.stringify({
            type: 'bridge:status',
            payload: { connected_devices: [...peers.values()].map(p => ({ ip: p.ip, user_agent: p.userAgent, connected_at: p.connectedAt })) }
          }));
          break;
        case 'order:insert':
        case 'order:update':
          broadcast(id, raw.toString());
          break;
        default:
          console.log(`[WS] Unknown message type: ${msg.type}`);
      }
    });

    ws.on('close', () => {
      peers.delete(id);
      console.log(`[WS] Peer ${ip} disconnected`);
    });

    ws.on('error', () => peers.delete(id));
  });

  return wss;
}

function broadcast(senderId, text) {
  for (const [id, peer] of peers) {
    if (id !== senderId && peer.ws.readyState === WebSocket.OPEN) {
      peer.ws.send(text);
    }
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  const cfg   = loadConfig();
  const token = getOrCreateToken(cfg);
  const ip    = getLocalIp();

  const server = createHttpServer(null, cfg, token);
  const wss    = createWsServer(server, token);

  server.listen(3355, '0.0.0.0', () => {
    console.log('[Bridge] VenoApp Bridge running on port 3355');
    console.log('[Bridge] Config UI: http://localhost:3355');
    console.log('[Bridge] Hub IP:', ip);

    // Push to Supabase on startup if configured
    if (cfg.setup_complete) {
      pushToSupabase(cfg, token, ip);
    }

    // Open browser on first run
    if (!cfg.setup_complete) {
      const url = 'http://localhost:3355';
      const cmd = process.platform === 'win32' ? `start "" "${url}"` : `open "${url}"`;
      exec(cmd, (err) => { if (err) console.log('[Bridge] Open browser manually:', url); });
    }
  });

  // Push connection info to Supabase every 30s to keep IP fresh
  setInterval(() => {
    if (cfg.setup_complete) pushToSupabase(cfg, token, ip);
  }, 30000);

  // Keep process alive
  process.on('SIGINT', () => { console.log('\n[Bridge] Stopping...'); process.exit(0); });
  process.on('SIGTERM', () => process.exit(0));
}

main().catch(e => { console.error('[Bridge] Fatal error:', e); process.exit(1); });

#!/usr/bin/env node
'use strict';

const http     = require('http');
const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const { exec } = require('child_process');
const WebSocket = require('ws');

// ── Config ─────────────────────────────────────────────────────────────────────
const CONFIG_PATH = path.join(
  process.env.APPDATA || path.join(os.homedir(), '.config'),
  'VenoApp Bridge', 'config.json'
);

const SUPABASE_URL = 'https://rfquwezkkdyvjftveilf.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJmcXV3ZXpra2R5dmpmdHZlaWxmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQyNTAxMzEsImV4cCI6MjA3OTgyNjEzMX0.sIOvuPu8AoL2QRtTPEMFcHVWv3lY_pyMIWgsZ7uyyxc';

// Mutable config — always read/write through these functions
let _cfg = {};

function loadConfig() {
  try { _cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch { _cfg = {}; }
  return _cfg;
}

function saveConfig(data) {
  _cfg = data;
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2));
}

function cfg() { return _cfg; }

// ── Token ──────────────────────────────────────────────────────────────────────
function getOrCreateToken() {
  if (_cfg.ws_auth_token) return _cfg.ws_auth_token;
  const token = require('crypto').randomBytes(16).toString('hex');
  _cfg.ws_auth_token = token;
  saveConfig(_cfg);
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

// ── Supabase ───────────────────────────────────────────────────────────────────
async function pushToSupabase() {
  const c = cfg();
  if (!c.bridge_code || !c.ws_auth_token) return;
  const code = c.bridge_code.replace(/-/g, '').toUpperCase();
  const ip   = getLocalIp();
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/set_bridge_connection`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_bridge_code: code, p_token: c.ws_auth_token, p_hub_ip: ip }),
    });
    if (res.ok) console.log('[Supabase] Connection info pushed — token:', c.ws_auth_token.slice(0,8) + '...', 'ip:', ip);
    else console.error('[Supabase] Push failed:', res.status, await res.text());
  } catch (e) {
    console.error('[Supabase] Push error:', e.message);
  }
}

async function fetchLogoUrl() {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/platform_settings?key=eq.branding&select=value`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await res.json();
    return rows?.[0]?.value?.logo_url || '';
  } catch { return ''; }
}

async function resolveBridgeCode(code) {
  const clean = code.replace(/-/g, '').toUpperCase();
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/restaurants?bridge_code=eq.${clean}&select=id,name`,
    { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
  );
  const rows = await res.json();
  if (!rows.length) throw new Error('Restaurant not found for that code');
  return rows[0];
}

// ── Connected peers ────────────────────────────────────────────────────────────
const peers = new Map();
let peerCounter = 1;

function broadcast(senderId, text) {
  for (const [id, peer] of peers) {
    if (id !== senderId && peer.ws.readyState === WebSocket.OPEN) {
      peer.ws.send(text);
    }
  }
}

// ── WebSocket handler ──────────────────────────────────────────────────────────
function setupWs(server, tokenRef) {
  const wss = new WebSocket.Server({ server });

  wss.on('connection', (ws, req) => {
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
    const id = peerCounter++;
    let authenticated = false;

    console.log(`[WS] New connection from ${ip}`);

    const authTimeout = setTimeout(() => {
      if (!authenticated) {
        console.log(`[WS] Auth timeout for ${ip}`);
        ws.close();
      }
    }, 5000);

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); }
      catch { return; }

      if (!authenticated) {
        if (msg.type === 'bridge:auth') {
          const token = tokenRef.value;
          if (!token || msg.token === token) {
            authenticated = true;
            clearTimeout(authTimeout);
            const userAgent = msg.user_agent || 'Unknown';
            peers.set(id, { ws, ip, userAgent, connectedAt: new Date().toISOString() });
            console.log(`[WS] Peer ${ip} authenticated. Total peers: ${peers.size}`);
            ws.send(JSON.stringify({ type: 'bridge:auth_ok', connected_devices: peers.size }));
          } else {
            console.log(`[WS] Peer ${ip} rejected — wrong token. Expected: ${token.slice(0,8)}... Got: ${(msg.token||'').slice(0,8)}...`);
            ws.send(JSON.stringify({ type: 'bridge:auth_failed', reason: 'Invalid token' }));
            ws.close();
          }
        }
        return;
      }

      switch (msg.type) {
        case 'bridge:ping':
          ws.send(JSON.stringify({ type: 'bridge:pong', version: '1.0.0' }));
          break;
        case 'bridge:get_status':
          ws.send(JSON.stringify({
            type: 'bridge:status',
            payload: {
              connected_devices: [...peers.values()].map(p => ({
                ip: p.ip, user_agent: p.userAgent, connected_at: p.connectedAt
              })),
              duplicate_hub: false,
            }
          }));
          break;
        case 'order:insert':
        case 'order:update':
          broadcast(id, raw.toString());
          break;
        default:
          console.log(`[WS] Unknown type: ${msg.type}`);
      }
    });

    ws.on('close', () => {
      peers.delete(id);
      console.log(`[WS] Peer ${ip} disconnected. Total peers: ${peers.size}`);
    });

    ws.on('error', (e) => {
      console.error(`[WS] Error from ${ip}:`, e.message);
      peers.delete(id);
    });
  });

  return wss;
}

// ── Setup HTML ─────────────────────────────────────────────────────────────────
function getSetupHtml(logoUrl) {
  const c = cfg();
  const logoHtml = logoUrl
    ? `<img src="${logoUrl}" style="width:40px;height:40px;object-fit:contain;border-radius:10px" alt="Logo">`
    : `<div style="width:40px;height:40px;background:#6262bd;border-radius:10px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:20px;color:#fff">V</div>`;

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
  .header{display:flex;align-items:center;gap:12px;margin-bottom:20px}
  h1{font-size:20px;font-weight:700}
  .sub{color:#94a3b8;font-size:13px;margin-top:2px}
  label{display:block;font-size:13px;color:#94a3b8;margin-bottom:6px;margin-top:16px}
  input{width:100%;padding:10px 12px;background:#0f1117;border:1px solid #2a2d3e;border-radius:7px;color:#e2e8f0;font-size:14px;outline:none}
  input:focus{border-color:#6262bd}
  .hint{font-size:11px;color:#64748b;margin-top:4px}
  button{width:100%;padding:12px;background:#6262bd;color:#fff;border:none;border-radius:7px;font-size:14px;font-weight:600;cursor:pointer;margin-top:20px}
  button:hover{background:#7474d4}
  button:disabled{opacity:0.6;cursor:default}
  .msg{margin-top:12px;padding:10px 14px;border-radius:6px;font-size:13px}
  .err{background:#3b1a1a;color:#f87171;border:1px solid #ef444433}
  .ok{background:#0f291e;color:#4ade80;border:1px solid #22c55e33}
  .status-grid{margin-top:4px;display:grid;gap:10px}
  .row{display:flex;justify-content:space-between;align-items:center;font-size:13px;padding:8px 0;border-bottom:1px solid #2a2d3e}
  .row:last-child{border-bottom:none}
  .lbl{display:flex;align-items:center;gap:8px;color:#94a3b8}
  .dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
  .val{font-weight:600;font-family:monospace;font-size:12px}
  .section-title{font-size:11px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:12px;margin-top:20px}
  .edit-btn{background:transparent;border:1px solid #2a2d3e;color:#94a3b8;margin-top:16px;font-weight:400}
  .edit-btn:hover{background:#2a2d3e}
</style>
</head>
<body>
<div class="card">
  <div class="header">
    ${logoHtml}
    <div>
      <h1>VenoApp Bridge</h1>
      <div class="sub" id="subtitle">${c.setup_complete ? `Running · ${c.restaurant_name || ''}` : 'Setup required'}</div>
    </div>
  </div>

  <div id="form-section" ${c.setup_complete ? 'style="display:none"' : ''}>
    <label style="margin-top:0">Restaurant Code</label>
    <input id="code" placeholder="XXXX-XXXX" value="${c.bridge_code || ''}" maxlength="9" style="text-transform:uppercase;letter-spacing:0.1em;font-weight:600;font-size:16px">
    <div class="hint">Found in VenoApp → Settings → Offline Hub</div>

    <label>Printer IP Address <span style="color:#64748b;font-weight:400">(optional)</span></label>
    <input id="printer" placeholder="192.168.1.100" value="${c.printer_ip || ''}">

    <button id="saveBtn" onclick="save()">Save &amp; Start</button>
    <div id="msg"></div>
  </div>

  <div id="status-section" ${!c.setup_complete ? 'style="display:none"' : ''}>
    <div class="section-title">Live Status</div>
    <div class="status-grid" id="status-grid">
      <div class="row"><span class="lbl"><span class="dot" style="background:#22c55e"></span>Status</span><span class="val" style="color:#22c55e">Bridge Active</span></div>
    </div>
    <button class="edit-btn" onclick="document.getElementById('form-section').style.display='';document.getElementById('saveBtn').textContent='Update &amp; Restart'">Edit Settings</button>
  </div>
</div>

<script>
  document.getElementById('code').addEventListener('input', function() {
    let v = this.value.toUpperCase().replace(/[^A-Z0-9]/g,'');
    if(v.length>4) v=v.slice(0,4)+'-'+v.slice(4,8);
    this.value=v;
  });

  async function save() {
    const btn=document.getElementById('saveBtn'), msg=document.getElementById('msg');
    const code=document.getElementById('code').value.trim();
    const printer=document.getElementById('printer').value.trim();
    if(!code){msg.className='msg err';msg.textContent='Please enter your restaurant code.';return;}
    btn.disabled=true; btn.textContent='Saving...'; msg.innerHTML='';
    try {
      const r=await fetch('/api/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({bridge_code:code,printer_ip:printer})});
      const d=await r.json();
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

  async function pollStatus() {
    try {
      const d=await(await fetch('/api/status')).json();
      if(!d.setup_complete) return;
      document.getElementById('status-section').style.display='';
      document.getElementById('subtitle').textContent='Running · '+d.restaurant_name;
      document.getElementById('status-grid').innerHTML=
        row('#22c55e','Connected Devices',d.connected_devices,'color:#22c55e')+
        row('#6262bd','Hub IP',d.hub_ip,'color:#94a3b8')+
        row('#64748b','Auth Token',d.ws_token,'color:#64748b');
    } catch {}
  }

  function row(dotColor,label,val,valStyle){
    return '<div class="row"><span class="lbl"><span class="dot" style="background:'+dotColor+'"></span>'+label+'</span><span class="val" style="'+valStyle+'">'+val+'</span></div>';
  }

  setInterval(pollStatus,3000);
  pollStatus();
</script>
</body>
</html>`;
}

// ── HTTP server ────────────────────────────────────────────────────────────────
function createServer(tokenRef, logoUrlRef) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (url.pathname === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        bridge_code:       cfg().bridge_code || '',
        restaurant_name:   cfg().restaurant_name || '',
        printer_ip:        cfg().printer_ip || '',
        setup_complete:    !!cfg().setup_complete,
        hub_ip:            getLocalIp(),
        ws_token:          tokenRef.value ? tokenRef.value.slice(0,8) + '...' : '',
        connected_devices: peers.size,
      }));
      return;
    }

    if (url.pathname === '/api/save' && req.method === 'POST') {
      let body = '';
      req.on('data', d => body += d);
      req.on('end', async () => {
        try {
          const data = JSON.parse(body);
          const row  = await resolveBridgeCode(data.bridge_code);
          const updated = {
            ..._cfg,
            bridge_code:     data.bridge_code,
            restaurant_id:   row.id,
            restaurant_name: row.name,
            printer_ip:      data.printer_ip || '',
            setup_complete:  true,
          };
          saveConfig(updated);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, restaurant_name: row.name }));
          // Push token + IP to Supabase immediately
          await pushToSupabase();
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return;
    }

    // Default: serve setup UI
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getSetupHtml(logoUrlRef.value));
  });

  return server;
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  loadConfig();

  const tokenRef   = { value: getOrCreateToken() };
  const logoUrlRef = { value: '' };

  // Fetch logo in background
  fetchLogoUrl().then(url => {
    if (url) { logoUrlRef.value = url; console.log('[Bridge] Logo loaded:', url); }
  });

  const server = createServer(tokenRef, logoUrlRef);
  setupWs(server, tokenRef);

  server.listen(3355, '0.0.0.0', async () => {
    const ip = getLocalIp();
    console.log('');
    console.log('  ██╗   ██╗███████╗███╗   ██╗ ██████╗ ');
    console.log('  ██║   ██║██╔════╝████╗  ██║██╔═══██╗');
    console.log('  ██║   ██║█████╗  ██╔██╗ ██║██║   ██║');
    console.log('  ╚██╗ ██╔╝██╔══╝  ██║╚██╗██║██║   ██║');
    console.log('   ╚████╔╝ ███████╗██║ ╚████║╚██████╔╝');
    console.log('    ╚═══╝  ╚══════╝╚═╝  ╚═══╝ ╚═════╝ ');
    console.log('');
    console.log(`  VenoApp Bridge running`);
    console.log(`  Config UI  : http://localhost:3355`);
    console.log(`  WebSocket  : ws://${ip}:3355`);
    console.log(`  Auth token : ${tokenRef.value.slice(0,8)}...`);
    console.log('');

    if (cfg().setup_complete) {
      console.log(`[Bridge] Configured for: ${cfg().restaurant_name}`);
      await pushToSupabase();
    } else {
      console.log('[Bridge] Not yet configured — opening setup page...');
      const url = 'http://localhost:3355';
      const cmd = process.platform === 'win32' ? `start "" "${url}"` : `open "${url}"`;
      exec(cmd);
    }
  });

  // Re-push to Supabase every 30s to keep IP/token fresh
  setInterval(pushToSupabase, 30_000);

  process.on('SIGINT',  () => { console.log('\n[Bridge] Stopped.'); process.exit(0); });
  process.on('SIGTERM', () => process.exit(0));
}

main().catch(e => { console.error('[Bridge] Fatal:', e); process.exit(1); });

#!/usr/bin/env node
'use strict';

const https    = require('https');
const http     = require('http');
const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const crypto   = require('crypto');
const { exec } = require('child_process');
const WebSocket = require('ws');

// ── Config ─────────────────────────────────────────────────────────────────────
const CONFIG_DIR  = path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'VenoApp Bridge');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const CERT_PATH   = path.join(CONFIG_DIR, 'cert.pem');
const KEY_PATH    = path.join(CONFIG_DIR, 'key.pem');

const SUPABASE_URL = 'https://rfquwezkkdyvjftveilf.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJmcXV3ZXpra2R5dmpmdHZlaWxmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQyNTAxMzEsImV4cCI6MjA3OTgyNjEzMX0.sIOvuPu8AoL2QRtTPEMFcHVWv3lY_pyMIWgsZ7uyyxc';

let _cfg = {};

function loadConfig() {
  try { _cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch { _cfg = {}; }
  return _cfg;
}

function saveConfig(data) {
  _cfg = data;
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2));
}

function cfg() { return _cfg; }

function getOrCreateToken() {
  if (_cfg.ws_auth_token) return _cfg.ws_auth_token;
  const token = crypto.randomBytes(16).toString('hex');
  _cfg.ws_auth_token = token;
  saveConfig(_cfg);
  return token;
}

function getLocalIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

// ── Self-signed TLS cert (generated once via selfsigned package) ───────────────
function ensureCert(ip) {
  if (fs.existsSync(CERT_PATH) && fs.existsSync(KEY_PATH)) {
    console.log('[TLS] Using existing certificate');
    return true;
  }
  try {
    const selfsigned = require('selfsigned');
    const attrs = [{ name: 'commonName', value: 'venoapp-bridge' }];
    const opts  = {
      keySize: 2048,
      days: 3650,
      algorithm: 'sha256',
      extensions: [{
        name: 'subjectAltName',
        altNames: [
          { type: 7, ip: ip },
          { type: 7, ip: '127.0.0.1' },
        ],
      }],
    };
    const pems = selfsigned.generate(attrs, opts);
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CERT_PATH, pems.cert);
    fs.writeFileSync(KEY_PATH,  pems.private);
    console.log('[TLS] Generated self-signed certificate');
    return true;
  } catch (e) {
    console.warn('[TLS] Could not generate cert:', e.message);
    console.warn('[TLS] Running on plain HTTP — staff devices may not connect from the VenoApp PWA.');
    return false;
  }
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
    if (res.ok) console.log(`[Supabase] Pushed — token: ${c.ws_auth_token.slice(0,8)}... ip: ${ip}`);
    else console.error('[Supabase] Push failed:', res.status, await res.text());
  } catch (e) { console.error('[Supabase] Push error:', e.message); }
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
    if (id !== senderId && peer.ws.readyState === WebSocket.OPEN) peer.ws.send(text);
  }
}

// ── WebSocket ──────────────────────────────────────────────────────────────────
function setupWs(server, tokenRef) {
  const wss = new WebSocket.Server({ server });
  wss.on('connection', (ws, req) => {
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
    const id = peerCounter++;
    let authed = false;

    const authTimeout = setTimeout(() => { if (!authed) ws.close(); }, 5000);

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (!authed) {
        if (msg.type === 'bridge:auth') {
          const token = tokenRef.value;
          if (!token || msg.token === token) {
            authed = true;
            clearTimeout(authTimeout);
            peers.set(id, { ws, ip, userAgent: msg.user_agent || 'Unknown', connectedAt: new Date().toISOString() });
            console.log(`[WS] ${ip} authenticated. Peers: ${peers.size}`);
            ws.send(JSON.stringify({ type: 'bridge:auth_ok', connected_devices: peers.size }));
          } else {
            console.log(`[WS] ${ip} rejected — token mismatch`);
            ws.send(JSON.stringify({ type: 'bridge:auth_failed', reason: 'Invalid token' }));
            ws.close();
          }
        }
        return;
      }

      switch (msg.type) {
        case 'bridge:ping':
          ws.send(JSON.stringify({ type: 'bridge:pong' }));
          break;
        case 'bridge:get_status':
          ws.send(JSON.stringify({
            type: 'bridge:status',
            payload: {
              connected_devices: [...peers.values()].map(p => ({ ip: p.ip, user_agent: p.userAgent, connected_at: p.connectedAt })),
              duplicate_hub: false,
            }
          }));
          break;
        case 'order:insert':
        case 'order:update':
          broadcast(id, raw.toString());
          break;
      }
    });

    ws.on('close', () => { peers.delete(id); console.log(`[WS] ${ip} disconnected. Peers: ${peers.size}`); });
    ws.on('error', () => peers.delete(id));
  });
}

// ── HTTP handler ───────────────────────────────────────────────────────────────
function makeHandler(tokenRef, logoUrlRef) {
  return async (req, res) => {
    const url = new URL(req.url, 'https://localhost');

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (url.pathname === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        setup_complete:    !!cfg().setup_complete,
        restaurant_name:   cfg().restaurant_name || '',
        hub_ip:            getLocalIp(),
        ws_token:          tokenRef.value ? tokenRef.value.slice(0, 8) + '...' : '',
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
          const row = await resolveBridgeCode(data.bridge_code);
          saveConfig({ ..._cfg, bridge_code: data.bridge_code, restaurant_id: row.id, restaurant_name: row.name, printer_ip: data.printer_ip || '', setup_complete: true });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, restaurant_name: row.name }));
          await pushToSupabase();
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getHtml(logoUrlRef.value));
  };
}

// ── HTML ───────────────────────────────────────────────────────────────────────
function getHtml(logoUrl) {
  const c = cfg();
  const logoHtml = logoUrl
    ? `<img src="${logoUrl}" style="width:40px;height:40px;object-fit:contain;border-radius:10px" alt="">`
    : `<div style="width:40px;height:40px;background:#6262bd;border-radius:10px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:20px;color:#fff">V</div>`;

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>VenoApp Bridge</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f1117;color:#e2e8f0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.card{background:#1a1d27;border:1px solid #2a2d3e;border-radius:12px;padding:32px;width:100%;max-width:440px}
.hdr{display:flex;align-items:center;gap:12px;margin-bottom:20px}
h1{font-size:20px;font-weight:700}.sub{color:#94a3b8;font-size:13px;margin-top:2px}
label{display:block;font-size:13px;color:#94a3b8;margin-bottom:6px;margin-top:16px}
input{width:100%;padding:10px 12px;background:#0f1117;border:1px solid #2a2d3e;border-radius:7px;color:#e2e8f0;font-size:14px;outline:none}
input:focus{border-color:#6262bd}
.hint{font-size:11px;color:#64748b;margin-top:4px}
.btn{width:100%;padding:12px;background:#6262bd;color:#fff;border:none;border-radius:7px;font-size:14px;font-weight:600;cursor:pointer;margin-top:20px}
.btn:hover{background:#7474d4}.btn:disabled{opacity:.6;cursor:default}
.btn-sec{background:transparent;border:1px solid #2a2d3e;color:#94a3b8;font-weight:400}
.btn-sec:hover{background:#2a2d3e}
.msg{margin-top:12px;padding:10px 14px;border-radius:6px;font-size:13px}
.err{background:#3b1a1a;color:#f87171}.ok{background:#0f291e;color:#4ade80}
.sec-title{font-size:11px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:.05em;margin-bottom:12px;margin-top:20px}
.row{display:flex;justify-content:space-between;align-items:center;font-size:13px;padding:8px 0;border-bottom:1px solid #2a2d3e}
.row:last-child{border-bottom:none}
.lbl{display:flex;align-items:center;gap:8px;color:#94a3b8}
.dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.val{font-weight:600;font-family:monospace;font-size:12px}
.notice{margin-top:16px;padding:12px;background:#1e2433;border:1px solid #2a2d3e;border-radius:8px;font-size:12px;color:#94a3b8;line-height:1.6}
.notice a{color:#6262bd}
</style></head><body>
<div class="card">
  <div class="hdr">${logoHtml}<div><h1>VenoApp Bridge</h1><div class="sub" id="sub">${c.setup_complete ? 'Running · ' + (c.restaurant_name||'') : 'Setup required'}</div></div></div>

  <div id="form" ${c.setup_complete ? 'style="display:none"' : ''}>
    <label style="margin-top:0">Restaurant Code</label>
    <input id="code" placeholder="XXXX-XXXX" value="${c.bridge_code||''}" maxlength="9" style="text-transform:uppercase;letter-spacing:.1em;font-weight:600;font-size:16px">
    <div class="hint">Found in VenoApp → Settings → Offline Hub</div>
    <label>Printer IP <span style="color:#64748b;font-weight:400">(optional)</span></label>
    <input id="printer" placeholder="192.168.1.100" value="${c.printer_ip||''}">
    <button class="btn" id="saveBtn" onclick="save()">Save &amp; Start</button>
    <div id="msg"></div>
  </div>

  <div id="status" ${!c.setup_complete ? 'style="display:none"' : ''}>
    <div class="sec-title">Live Status</div>
    <div id="grid">
      <div class="row"><span class="lbl"><span class="dot" style="background:#22c55e"></span>Status</span><span class="val" style="color:#22c55e">Bridge Active</span></div>
    </div>
    <div class="notice">
      <strong style="color:#e2e8f0">First-time setup for each staff device</strong><br>
      Each device needs to trust the Bridge certificate once before it can connect.<br><br>
      On each staff device, tap the button below, click <strong>Advanced → Proceed</strong> when the browser warns you, then come back to VenoApp. Only needed once per device.
      <a href="https://${getLocalIp()}:3355" target="_blank" style="display:block;margin-top:12px;padding:10px 0;background:#6262bd;color:#fff;text-align:center;border-radius:7px;font-weight:600;font-size:13px;text-decoration:none">Trust Certificate on This Device</a>
    </div>
    <button class="btn btn-sec" style="margin-top:16px" onclick="document.getElementById('form').style.display='';document.getElementById('saveBtn').textContent='Update &amp; Restart'">Edit Settings</button>
  </div>
</div>
<script>
document.getElementById('code').addEventListener('input',function(){
  let v=this.value.toUpperCase().replace(/[^A-Z0-9]/g,'');
  if(v.length>4)v=v.slice(0,4)+'-'+v.slice(4,8);
  this.value=v;
});
async function save(){
  const btn=document.getElementById('saveBtn'),msg=document.getElementById('msg');
  const code=document.getElementById('code').value.trim();
  const printer=document.getElementById('printer').value.trim();
  if(!code){msg.className='msg err';msg.textContent='Please enter your restaurant code.';return;}
  btn.disabled=true;btn.textContent='Saving...';msg.innerHTML='';
  try{
    const r=await fetch('/api/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({bridge_code:code,printer_ip:printer})});
    const d=await r.json();
    if(d.ok){msg.className='msg ok';msg.textContent='Connected to '+d.restaurant_name+'.';setTimeout(()=>location.reload(),1200);}
    else{msg.className='msg err';msg.textContent=d.error||'Unknown error';btn.disabled=false;btn.textContent='Save & Start';}
  }catch(e){msg.className='msg err';msg.textContent=e.message;btn.disabled=false;btn.textContent='Save & Start';}
}
async function poll(){
  try{
    const d=await(await fetch('/api/status')).json();
    if(!d.setup_complete)return;
    document.getElementById('status').style.display='';
    document.getElementById('sub').textContent='Running · '+d.restaurant_name;
    document.getElementById('grid').innerHTML=
      row('#22c55e','Connected Devices',d.connected_devices,'#22c55e')+
      row('#6262bd','Hub IP',d.hub_ip,'#94a3b8')+
      row('#64748b','Auth Token',d.ws_token,'#64748b');
  }catch{}
}
function row(dot,lbl,val,col){return '<div class="row"><span class="lbl"><span class="dot" style="background:'+dot+'"></span>'+lbl+'</span><span class="val" style="color:'+col+'">'+val+'</span></div>';}
setInterval(poll,3000);poll();
</script></body></html>`;
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  loadConfig();
  const tokenRef  = { value: getOrCreateToken() };
  const logoUrlRef = { value: '' };
  const ip = getLocalIp();

  fetchLogoUrl().then(url => { if (url) logoUrlRef.value = url; });

  const handler = makeHandler(tokenRef, logoUrlRef);
  const hasCert = ensureCert(ip);

  let server;
  if (hasCert) {
    const tlsOpts = { key: fs.readFileSync(KEY_PATH), cert: fs.readFileSync(CERT_PATH) };
    server = https.createServer(tlsOpts, handler);
    console.log('[Bridge] TLS enabled — serving wss://');
  } else {
    server = http.createServer(handler);
    console.log('[Bridge] No TLS — serving ws:// (mixed-content may block staff devices)');
  }

  setupWs(server, tokenRef);

  server.listen(3355, '0.0.0.0', async () => {
    const proto = hasCert ? 'https' : 'http';
    const wsProto = hasCert ? 'wss' : 'ws';
    console.log('');
    console.log('  VenoApp Bridge running');
    console.log(`  Config UI : ${proto}://localhost:3355`);
    console.log(`  WebSocket : ${wsProto}://${ip}:3355`);
    console.log(`  Token     : ${tokenRef.value.slice(0,8)}...`);
    console.log('');

    if (cfg().setup_complete) {
      console.log(`[Bridge] Restaurant: ${cfg().restaurant_name}`);
      await pushToSupabase();
    } else if (require.main === module) {
      // Only auto-open browser when run directly (not from Electron)
      const url = `${proto}://localhost:3355`;
      exec(process.platform === 'win32' ? `start "" "${url}"` : `open "${url}"`);
    }
  });

  setInterval(pushToSupabase, 30_000);
  process.on('SIGINT',  () => { console.log('\n[Bridge] Stopped.'); process.exit(0); });
  process.on('SIGTERM', () => process.exit(0));
}

// Export for Electron — called by bridge-electron/main.js
module.exports = { start: main, getConfig: cfg };

// Run directly when invoked as a standalone script
if (require.main === module) {
  main().catch(e => { console.error('[Bridge] Fatal:', e); process.exit(1); });
}

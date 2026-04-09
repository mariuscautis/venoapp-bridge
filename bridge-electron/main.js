'use strict';

const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog } = require('electron');
const path = require('path');
const fs   = require('fs');

// ── Single instance lock ───────────────────────────────────────────────────────
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

// ── State ──────────────────────────────────────────────────────────────────────
let win      = null;
let tray     = null;
let quitting = false;

// ── Load Bridge server module ──────────────────────────────────────────────────
const bridge = require('./server.js');

// ── Create window ──────────────────────────────────────────────────────────────
function createWindow() {
  win = new BrowserWindow({
    width:  480,
    height: 700,
    minWidth:  420,
    minHeight: 560,
    resizable: true,
    title: 'VenoApp Bridge',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    show: false,
    backgroundColor: '#0f1117',
  });

  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'ui.html'));

  win.webContents.once('did-finish-load', () => {
    win.show();
    win.focus();
  });

  win.on('close', (e) => {
    if (!quitting) { e.preventDefault(); win.hide(); }
  });
}

// ── System tray ────────────────────────────────────────────────────────────────
function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'icon.png')));
  tray.setToolTip('VenoApp Bridge — running');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show VenoApp Bridge', click: () => { win.show(); win.focus(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('double-click', () => { win.show(); win.focus(); });
}

// ── IPC handlers (renderer ↔ main) ────────────────────────────────────────────
function setupIpc() {
  ipcMain.handle('get-status', () => {
    const cfg = bridge.getConfig();
    return {
      setup_complete:    !!cfg.setup_complete,
      restaurant_name:   cfg.restaurant_name || '',
      bridge_code:       cfg.bridge_code || '',
      printer_ip:        cfg.printer_ip || '',
      hub_ip:            bridge.getLocalIp(),
      ws_token:          bridge.getToken() ? bridge.getToken().slice(0, 8) + '...' : '',
      connected_devices: bridge.getPeerCount(),
      logo_url:          bridge.getLogoUrl(),
    };
  });

  ipcMain.handle('save-config', async (_e, data) => {
    return bridge.saveAndConnect(data.bridge_code, data.printer_ip);
  });
}

// ── App ready ──────────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  app.setLoginItemSettings({ openAtLogin: true });
  setupIpc();

  try {
    await bridge.start();
  } catch (e) {
    if (e.code === 'EADDRINUSE') {
      dialog.showErrorBox('Port In Use', 'Port 3355 is already in use.\n\nClose any previous VenoApp Bridge instance and try again.');
    } else {
      dialog.showErrorBox('Startup Error', e.message);
    }
    app.quit();
    return;
  }

  createWindow();
  createTray();
});

app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });
app.on('window-all-closed', () => { /* stay in tray */ });
app.on('before-quit', () => { quitting = true; });
app.on('activate', () => { if (win) { win.show(); win.focus(); } });

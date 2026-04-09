'use strict';

const { app, BrowserWindow, Tray, Menu, nativeImage, shell } = require('electron');
const path = require('path');

// ── Single instance lock ───────────────────────────────────────────────────────
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// ── State ──────────────────────────────────────────────────────────────────────
let win   = null;
let tray  = null;
let quitting = false;

// ── Start the Bridge server ────────────────────────────────────────────────────
const bridge = require('./server.js');

// ── Create window ──────────────────────────────────────────────────────────────
function createWindow() {
  win = new BrowserWindow({
    width:  480,
    height: 680,
    minWidth:  400,
    minHeight: 500,
    resizable: true,
    title: 'VenoApp Bridge',
    icon: path.join(__dirname, '..', 'src-tauri', 'icons', 'icon.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
    show: false,
    backgroundColor: '#0f1117',
  });

  // Remove default menu bar
  win.setMenuBarVisibility(false);

  // Load the Bridge UI served by the local server
  // Use http:// so Electron doesn't reject the self-signed cert
  win.loadURL('http://localhost:3355');

  win.once('ready-to-show', () => {
    const cfg = bridge.getConfig();
    if (!cfg.setup_complete) {
      // First run — show window for setup
      win.show();
      win.focus();
    }
    // If already configured, stay hidden in tray
  });

  // Hide to tray on close instead of quitting
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
}

// ── System tray ────────────────────────────────────────────────────────────────
function createTray() {
  const iconPath = path.join(__dirname, '..', 'src-tauri', 'icons', '32x32.png');
  const icon = nativeImage.createFromPath(iconPath);
  tray = new Tray(icon);

  const menu = Menu.buildFromTemplate([
    {
      label: 'Show VenoApp Bridge',
      click: () => { win.show(); win.focus(); },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => { quitting = true; app.quit(); },
    },
  ]);

  tray.setToolTip('VenoApp Bridge — running');
  tray.setContextMenu(menu);

  tray.on('double-click', () => { win.show(); win.focus(); });
}

// ── Second instance → show existing window ────────────────────────────────────
app.on('second-instance', () => {
  if (win) { win.show(); win.focus(); }
});

// ── App ready ──────────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  // Auto-start on Windows login
  app.setLoginItemSettings({ openAtLogin: true });

  // Start the server, then load UI
  await bridge.start();

  createWindow();
  createTray();
});

// Don't quit when all windows are closed — stay in tray
app.on('window-all-closed', (e) => {
  if (process.platform !== 'darwin') {
    // do nothing — keep running in tray
  }
});

app.on('before-quit', () => { quitting = true; });

app.on('activate', () => {
  // macOS dock click
  if (win) { win.show(); win.focus(); }
});

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

function showPortInUseError() {
  const { dialog } = require('electron');
  dialog.showErrorBox(
    'VenoApp Bridge — Port In Use',
    'Port 3355 is already in use by another process.\n\nPlease close any previous version of VenoApp Bridge running in the taskbar or Task Manager, then relaunch.'
  );
  app.quit();
}

// ── Create window ──────────────────────────────────────────────────────────────
function createWindow() {
  win = new BrowserWindow({
    width:  480,
    height: 680,
    minWidth:  400,
    minHeight: 500,
    resizable: true,
    title: 'VenoApp Bridge',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
    show: false,
    backgroundColor: '#0f1117',
  });

  // Remove default menu bar
  win.setMenuBarVisibility(false);

  win.webContents.on('did-fail-load', (_e, code, desc) => {
    // Server not ready yet — retry after a short delay
    if (code === -102 || code === -6 || desc === 'ERR_CONNECTION_REFUSED') {
      setTimeout(() => { if (win) win.loadURL('http://localhost:3355'); }, 1000);
    }
  });

  win.webContents.once('did-finish-load', () => {
    // Show window once page has actually loaded
    win.show();
    win.focus();
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
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'icon.png')));

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

  // Create window and tray first so they exist during server start
  createWindow();
  createTray();

  // Start the server
  try {
    await bridge.start();
  } catch (e) {
    if (e.code === 'EADDRINUSE') { showPortInUseError(); return; }
    const { dialog } = require('electron');
    dialog.showErrorBox('VenoApp Bridge — Startup Error', e.message);
    app.quit();
    return;
  }

  // Small delay to ensure server is fully ready, then load UI
  setTimeout(() => {
    if (win) win.loadURL('http://localhost:3355');
  }, 500);
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

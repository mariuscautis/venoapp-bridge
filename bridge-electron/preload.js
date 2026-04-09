'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  getStatus:  ()       => ipcRenderer.invoke('get-status'),
  saveConfig: (data)   => ipcRenderer.invoke('save-config', data),
});

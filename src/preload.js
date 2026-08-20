'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Minimal, explicitly enumerated bridge for the setup window.
 * No Node APIs and no generic ipcRenderer access are exposed to page scripts.
 */
contextBridge.exposeInMainWorld('leantimeSetup', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setServer: (url) => ipcRenderer.invoke('config:setServer', String(url)),
});

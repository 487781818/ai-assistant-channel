const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('oc', {
  getSettings: () => ipcRenderer.invoke('settings-get'),
  setEnabled: (v) => ipcRenderer.invoke('settings-set-enabled', v),
  setPcEnabled: (v) => ipcRenderer.invoke('settings-set-pc-enabled', v),
  regenToken: () => ipcRenderer.invoke('settings-regen'),
  getAudit: () => ipcRenderer.invoke('channel-audit'),
  showBrowser: (id) => ipcRenderer.invoke('browser-show', id),
  hideBrowsers: () => ipcRenderer.invoke('browser-hide'),
});

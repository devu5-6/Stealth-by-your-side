const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getEnv: () => ipcRenderer.invoke('get-env'),
  captureScreen: () => ipcRenderer.invoke('capture-screen'),
  onTriggerScreenCapture: (callback) => ipcRenderer.on('trigger-screen-capture', () => callback()),
  toggleProtection: (enable) => ipcRenderer.send('toggle-protection', enable),
  setOpacity: (val) => ipcRenderer.send('set-opacity', val),
  minimize: () => ipcRenderer.send('minimize-window'),
  close: () => ipcRenderer.send('close-window'),
});
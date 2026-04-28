const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlayApi', {
  onCommand(handler) {
    const listener = (_event, message) => handler(message);
    ipcRenderer.on('overlay:command', listener);
    return () => ipcRenderer.removeListener('overlay:command', listener);
  },
  sendEvent(message) {
    ipcRenderer.send('overlay:event', message);
  },
});

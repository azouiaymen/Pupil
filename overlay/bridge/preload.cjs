const { contextBridge, ipcRenderer } = require('electron');

// Expose a minimal, explicit API surface to the untrusted renderer context.
// Keeping this bridge small reduces security risk and protocol ambiguity.
contextBridge.exposeInMainWorld('overlayApi', {
  onCommand(handler) {
    // Returns an unsubscribe function so consumers can detach listeners safely.
    const listener = (_event, message) => handler(message);
    ipcRenderer.on('overlay:command', listener);
    return () => ipcRenderer.removeListener('overlay:command', listener);
  },
  sendEvent(message) {
    // Renderer -> main process event channel for ready/interaction/error envelopes.
    ipcRenderer.send('overlay:event', message);
  },
  setInteractive(active) {
    // Main process owns native click-through state; renderer only sends intent.
    ipcRenderer.send('overlay:interactivity', { active: Boolean(active) });
  },
});

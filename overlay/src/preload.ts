import { contextBridge, ipcRenderer } from 'electron';

type OverlayCommandEnvelope = {
  protocolVersion: number;
  command: 'indicate' | 'hideAll' | 'ping';
  payload: Record<string, unknown>;
};

type OverlayEventEnvelope = {
  protocolVersion: number;
  event: 'ready' | 'error' | 'interaction';
  payload: Record<string, unknown>;
};

contextBridge.exposeInMainWorld('overlayApi', {
  onCommand: (handler: (message: OverlayCommandEnvelope) => void) => {
    const listener = (_event: unknown, message: OverlayCommandEnvelope) => handler(message);
    ipcRenderer.on('overlay:command', listener);
    return () => ipcRenderer.removeListener('overlay:command', listener);
  },
  sendEvent: (message: OverlayEventEnvelope) => ipcRenderer.send('overlay:event', message),
});

const { app, BrowserWindow, ipcMain, screen } = require('electron');
const net = require('net');
const path = require('path');

const PROTOCOL_VERSION = 1;
let mainWindow = null;
let rendererReady = false;
const pendingCommands = [];
let virtualOrigin = { x: 0, y: 0 };
let pipeServer = null;
const pipePath = process.env.PUPIL_OVERLAY_PIPE || '\\\\.\\pipe\\pupil-overlay-ipc-default';

function getVirtualBounds() {
  const displays = screen.getAllDisplays();
  return displays.reduce(
    (acc, display) => ({
      x: Math.min(acc.x, display.bounds.x),
      y: Math.min(acc.y, display.bounds.y),
      right: Math.max(acc.right, display.bounds.x + display.bounds.width),
      bottom: Math.max(acc.bottom, display.bounds.y + display.bounds.height),
    }),
    {
      x: Number.POSITIVE_INFINITY,
      y: Number.POSITIVE_INFINITY,
      right: Number.NEGATIVE_INFINITY,
      bottom: Number.NEGATIVE_INFINITY,
    }
  );
}

function writeEvent(event, payload = {}) {
  process.stdout.write(
    JSON.stringify({ protocolVersion: PROTOCOL_VERSION, event, payload }) + '\n'
  );
}

function sendError(message) {
  writeEvent('error', { message });
}

function getOverlayHwnd() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return 0;
  }
  try {
    const nativeHandle = mainWindow.getNativeWindowHandle();
    if (!nativeHandle || nativeHandle.length === 0) {
      return 0;
    }
    // On Windows, HWND is represented in the low 32 bits.
    return nativeHandle.readUInt32LE(0);
  } catch (error) {
    return 0;
  }
}

function createWindow() {
  const bounds = getVirtualBounds();
  virtualOrigin = { x: bounds.x, y: bounds.y };
  mainWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.right - bounds.x,
    height: bounds.bottom - bounds.y,
    transparent: true,
    frame: false,
    hasShadow: false,
    alwaysOnTop: true,
    focusable: false,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.setIgnoreMouseEvents(true, { forward: true });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function remapToWindowSpace(commandEnvelope) {
  if (commandEnvelope.command !== 'indicate') {
    return commandEnvelope;
  }
  const payload = commandEnvelope.payload || {};
  const indicator = payload.indicator;
  if (!indicator || typeof indicator !== 'object') {
    return commandEnvelope;
  }
  const bounds = indicator.bounds;
  if (!bounds || typeof bounds !== 'object') {
    return commandEnvelope;
  }
  const mapped = {
    ...commandEnvelope,
    payload: {
      ...payload,
      indicator: {
        ...indicator,
        bounds: {
          ...bounds,
          x: Number(bounds.x) - virtualOrigin.x,
          y: Number(bounds.y) - virtualOrigin.y,
        },
      },
    },
  };
  return mapped;
}

function dispatchToRenderer(commandEnvelope) {
  const mappedCommand = remapToWindowSpace(commandEnvelope);
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error('Overlay window is not available.');
  }
  if (!rendererReady) {
    pendingCommands.push(mappedCommand);
    return;
  }
  mainWindow.webContents.send('overlay:command', mappedCommand);
}

function flushPendingCommands() {
  if (!rendererReady || !mainWindow || mainWindow.isDestroyed()) return;
  while (pendingCommands.length > 0) {
    const cmd = pendingCommands.shift();
    if (!cmd) break;
    mainWindow.webContents.send('overlay:command', cmd);
  }
}

function validateCommand(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Command must be an object.');
  }
  if (raw.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error('Unsupported protocol version.');
  }
  if (!['indicate', 'hideAll', 'ping'].includes(raw.command)) {
    throw new Error(`Unsupported command: ${String(raw.command)}`);
  }
  if (raw.payload !== undefined && typeof raw.payload !== 'object') {
    throw new Error('payload must be an object.');
  }
  return {
    protocolVersion: PROTOCOL_VERSION,
    command: raw.command,
    payload: raw.payload || {},
  };
}

function startPipeServer() {
  if (pipeServer) {
    return;
  }
  pipeServer = net.createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';

    socket.on('data', (chunk) => {
      const textChunk = String(chunk);
      buffer += textChunk;

      let newlineIdx = buffer.indexOf('\n');
      while (newlineIdx !== -1) {
        const rawLine = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        const trimmed = rawLine.trim();
        if (trimmed) {
          try {
            const envelope = validateCommand(JSON.parse(trimmed));
            dispatchToRenderer(envelope);
          } catch (error) {
            sendError(error instanceof Error ? error.message : String(error));
          }
        }
        newlineIdx = buffer.indexOf('\n');
      }
    });

    socket.on('end', () => {
    });

    socket.on('error', (error) => {
    });
  });

  pipeServer.on('error', (error) => {
    sendError(`pipe_server_error: ${String(error)}`);
  });

  pipeServer.listen(pipePath, () => {});
}

app.on('ready', () => {
  createWindow();
  startPipeServer();
});

app.on('window-all-closed', () => {
  if (pipeServer) {
    try {
      pipeServer.close();
    } catch (error) {
    } finally {
      pipeServer = null;
    }
  }
  app.quit();
});

ipcMain.on('overlay:event', (_event, envelope) => {
  if (!envelope || envelope.protocolVersion !== PROTOCOL_VERSION || typeof envelope.event !== 'string') {
    sendError('Invalid renderer event.');
    return;
  }
  if (envelope.event === 'ready') {
    rendererReady = true;
    flushPendingCommands();
    const overlayHwnd = getOverlayHwnd();
    envelope.payload = { ...(envelope.payload || {}), overlayHwnd };
  }
  writeEvent(envelope.event, envelope.payload || {});
});

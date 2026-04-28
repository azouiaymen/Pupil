const { app, BrowserWindow, ipcMain, screen } = require('electron');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const PROTOCOL_VERSION = 2;
const HEARTBEAT_TIMEOUT_MS = 15000;
const PARENT_WATCH_INTERVAL_MS = 2000;
const MAX_PENDING_COMMANDS = 256;
let mainWindow = null;
let rendererReady = false;
const pendingCommands = [];
let virtualOrigin = { x: 0, y: 0 };
let pipeServer = null;
const pipePath = process.env.PUPIL_OVERLAY_PIPE || '\\\\.\\pipe\\pupil-overlay-ipc-default';
let interactive = false;
let lastPingMs = Date.now();
let heartbeatWatchdog = null;
const parentPid = Number.parseInt(process.env.PUPIL_PARENT_PID || '0', 10);
const sessionId = process.env.PUPIL_OVERLAY_SESSION_ID || `session-${Date.now()}`;

function configureRuntimePaths() {
  const runtimeRoot = path.join(os.tmpdir(), 'pupil-overlay-electron');
  const userDataPath = path.join(runtimeRoot, 'user-data');
  const sessionDataPath = path.join(runtimeRoot, 'session-data');
  const gpuCachePath = path.join(runtimeRoot, 'gpu-cache');
  fs.mkdirSync(userDataPath, { recursive: true });
  fs.mkdirSync(sessionDataPath, { recursive: true });
  fs.mkdirSync(gpuCachePath, { recursive: true });

  app.setPath('userData', userDataPath);
  app.setPath('sessionData', sessionDataPath);

  // Reduce noisy/fragile disk cache behavior in constrained environments.
  app.commandLine.appendSwitch('disk-cache-dir', sessionDataPath);
  app.commandLine.appendSwitch('gpu-shader-disk-cache-path', gpuCachePath);
  app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
}
configureRuntimePaths();
const singleInstanceLock = app.requestSingleInstanceLock({ sessionId });
if (!singleInstanceLock) {
  process.exit(0);
}

app.on('second-instance', (_event, commandLine, workingDirectory, additionalData) => {
  sendError(
    `second_instance_rejected: session=${String(additionalData && additionalData.sessionId)} cwd=${String(workingDirectory)}`
  );
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.focus();
  }
});

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

function writeEvent(event, payload = {}, requestId = null) {
  process.stdout.write(
    JSON.stringify({ protocolVersion: PROTOCOL_VERSION, sessionId, requestId, event, payload }) + '\n'
  );
}

function sendError(message, requestId = null) {
  writeEvent('error', { message }, requestId);
}

function sendAck(requestId, payload = {}) {
  if (!requestId) {
    return;
  }
  writeEvent('ack', payload, requestId);
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
  // Default mode: fully click-through. Renderer can opt into interactivity for tooltips only.
  mainWindow.setIgnoreMouseEvents(true, { forward: true });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function setWindowInteractivity(active) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  const nextState = Boolean(active);
  if (interactive === nextState) {
    return;
  }
  interactive = nextState;
  // interactive=true => window receives clicks; interactive=false => full pass-through.
  mainWindow.setIgnoreMouseEvents(!interactive, { forward: true });
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
  if (mappedCommand.command === 'ping') {
    lastPingMs = Date.now();
  }
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error('Overlay window is not available.');
  }
  if (!rendererReady) {
    if (pendingCommands.length >= MAX_PENDING_COMMANDS) {
      pendingCommands.shift();
      sendError(`pending_queue_overflow: dropped oldest command (max=${MAX_PENDING_COMMANDS})`, mappedCommand.requestId || null);
    }
    pendingCommands.push(mappedCommand);
    return;
  }
  mainWindow.webContents.send('overlay:command', mappedCommand);
}

function isParentAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return true;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (_error) {
    return false;
  }
}

function startHeartbeatWatchdog() {
  if (heartbeatWatchdog) {
    return;
  }
  heartbeatWatchdog = setInterval(() => {
    if (!isParentAlive(parentPid)) {
      sendError(`parent_dead: parent pid ${parentPid} is gone`);
      app.quit();
      return;
    }
    if (Date.now() - lastPingMs <= HEARTBEAT_TIMEOUT_MS) {
      return;
    }
    sendError('heartbeat_timeout: parent runtime appears disconnected');
    app.quit();
  }, PARENT_WATCH_INTERVAL_MS);
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
  if (typeof raw.sessionId !== 'string' || raw.sessionId !== sessionId) {
    throw new Error('Invalid or stale sessionId.');
  }
  if (typeof raw.requestId !== 'string' || raw.requestId.length === 0) {
    throw new Error('requestId must be a non-empty string.');
  }
  if (!['indicate', 'hideAll', 'ping', 'shutdown'].includes(raw.command)) {
    throw new Error(`Unsupported command: ${String(raw.command)}`);
  }
  if (raw.payload !== undefined && typeof raw.payload !== 'object') {
    throw new Error('payload must be an object.');
  }
  return {
    protocolVersion: PROTOCOL_VERSION,
    sessionId,
    requestId: raw.requestId,
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
          let parsed = null;
          let envelope = null;
          try {
            parsed = JSON.parse(trimmed);
            envelope = validateCommand(parsed);
            if (envelope.command === 'shutdown') {
              sendAck(envelope.requestId, { command: envelope.command });
              app.quit();
              continue;
            }
            dispatchToRenderer(envelope);
            sendAck(envelope.requestId, { command: envelope.command, queued: !rendererReady });
          } catch (error) {
            const requestId =
              envelope && typeof envelope.requestId === 'string'
                ? envelope.requestId
                : parsed && typeof parsed.requestId === 'string'
                  ? parsed.requestId
                  : null;
            sendError(error instanceof Error ? error.message : String(error), requestId);
          }
        }
        newlineIdx = buffer.indexOf('\n');
      }
    });

    socket.on('end', () => {});

    socket.on('error', (error) => {
      sendError(`pipe_socket_error: ${String(error)}`);
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
  startHeartbeatWatchdog();
});

app.on('window-all-closed', () => {
  if (heartbeatWatchdog) {
    clearInterval(heartbeatWatchdog);
    heartbeatWatchdog = null;
  }
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
  if (
    !envelope ||
    envelope.protocolVersion !== PROTOCOL_VERSION ||
    typeof envelope.event !== 'string'
  ) {
    sendError('Invalid renderer event.');
    return;
  }
  const requestId = typeof envelope.requestId === 'string' ? envelope.requestId : null;
  if (envelope.event === 'ready') {
    rendererReady = true;
    flushPendingCommands();
    const overlayHwnd = getOverlayHwnd();
    envelope.payload = { ...(envelope.payload || {}), overlayHwnd };
  }
  writeEvent(envelope.event, envelope.payload || {}, requestId);
});

ipcMain.on('overlay:interactivity', (_event, payload) => {
  const nextActive = payload && typeof payload.active === 'boolean' ? payload.active : false;
  setWindowInteractivity(nextActive);
});

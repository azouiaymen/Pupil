'use strict';

const { app, BrowserWindow, ipcMain, screen } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { IpcServer } = require('../ipc/server.cjs');
const { SidecarManager } = require('../sidecar/manager.cjs');
const { normalizeIndicator } = require('./state.cjs');
const { OVERLAY_PROTOCOL_VERSION } = require('../common/protocol.cjs');
const { daemonPipePath, runtimeRoot } = require('../common/paths.cjs');

// =============================================================================
// Constants
// =============================================================================

const MAX_PENDING_RENDERER_COMMANDS = 256;
const RENDERER_HEARTBEAT_INTERVAL_MS = 4000;
const AWAIT_RESOLUTION_TIMEOUT_MS = 180000;
const INDICATE_ACK_TIMEOUT_MS = 4000;

// Lightweight stderr logger (stdout is reserved for IPC events to other clients).
const logger = {
  info: (...args) => process.stderr.write(`[daemon] ${args.join(' ')}\n`),
  warn: (...args) => process.stderr.write(`[daemon][warn] ${args.join(' ')}\n`),
  error: (...args) => process.stderr.write(`[daemon][error] ${args.join(' ')}\n`),
};

// =============================================================================
// State
// =============================================================================

let mainWindow = null;
let rendererReady = false;
const pendingRendererCommands = [];
let virtualOrigin = { x: 0, y: 0 };
let interactive = false;

const indicators = new Map();
const indicateAckWaiters = new Map();
const indicateResolutionWaiters = new Map();

let sidecar = null;
let ipcServer = null;
const sessionId = `session-${crypto.randomBytes(6).toString('hex')}`;

// =============================================================================
// Runtime configuration (Electron paths must be set before app is ready)
// =============================================================================

function configureRuntimePaths() {
  // Keep all Electron writable paths in a controlled temp root so the daemon
  // can run in constrained or ephemeral environments without polluting user
  // profiles. Mirrors the previous standalone overlay bridge behavior.
  const root = path.join(runtimeRoot(), 'electron');
  const userDataPath = path.join(root, 'user-data');
  const sessionDataPath = path.join(root, 'session-data');
  const gpuCachePath = path.join(root, 'gpu-cache');
  fs.mkdirSync(userDataPath, { recursive: true });
  fs.mkdirSync(sessionDataPath, { recursive: true });
  fs.mkdirSync(gpuCachePath, { recursive: true });
  app.setPath('userData', userDataPath);
  app.setPath('sessionData', sessionDataPath);
  app.commandLine.appendSwitch('disk-cache-dir', sessionDataPath);
  app.commandLine.appendSwitch('gpu-shader-disk-cache-path', gpuCachePath);
  app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
}

configureRuntimePaths();

// Single-instance: shim spawns the daemon with --start; second launches no-op.
const singleInstanceLock = app.requestSingleInstanceLock({ sessionId });
if (!singleInstanceLock) {
  app.quit();
  return;
}

// =============================================================================
// Overlay window + renderer command channel
// =============================================================================

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

function getOverlayHwnd() {
  if (!mainWindow || mainWindow.isDestroyed()) return 0;
  try {
    const handle = mainWindow.getNativeWindowHandle();
    if (!handle || handle.length === 0) return 0;
    return handle.readUInt32LE(0);
  } catch (_e) {
    return 0;
  }
}

function createOverlayWindow() {
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
      preload: path.join(__dirname, '..', 'overlay', 'preload.cjs'),
    },
  });
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.setIgnoreMouseEvents(true, { forward: true });
  mainWindow.loadFile(path.join(__dirname, '..', 'overlay', 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
    rendererReady = false;
  });
}

function setWindowInteractivity(active) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const next = Boolean(active);
  if (interactive === next) return;
  interactive = next;
  mainWindow.setIgnoreMouseEvents(!interactive, { forward: true });
}

// Renderer expects bounds in window-local (virtual desktop relative) coordinates.
function remapBoundsToWindowSpace(envelope) {
  if (envelope.command !== 'indicate') return envelope;
  const indicator = envelope.payload && envelope.payload.indicator;
  if (!indicator || !indicator.bounds) return envelope;
  return {
    ...envelope,
    payload: {
      ...envelope.payload,
      indicator: {
        ...indicator,
        bounds: {
          ...indicator.bounds,
          x: Number(indicator.bounds.x) - virtualOrigin.x,
          y: Number(indicator.bounds.y) - virtualOrigin.y,
        },
      },
    },
  };
}

function dispatchToRenderer(envelope) {
  const mapped = remapBoundsToWindowSpace(envelope);
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error('Overlay window is not available.');
  }
  if (!rendererReady) {
    if (pendingRendererCommands.length >= MAX_PENDING_RENDERER_COMMANDS) {
      pendingRendererCommands.shift();
      logger.warn('renderer pending queue overflow; dropping oldest command.');
    }
    pendingRendererCommands.push(mapped);
    return;
  }
  mainWindow.webContents.send('overlay:command', mapped);
}

function flushPendingCommands() {
  if (!rendererReady || !mainWindow || mainWindow.isDestroyed()) return;
  while (pendingRendererCommands.length > 0) {
    const cmd = pendingRendererCommands.shift();
    if (!cmd) break;
    mainWindow.webContents.send('overlay:command', cmd);
  }
}

function sendRendererCommand(command, payload) {
  // Build the command envelope (renderer validates protocolVersion).
  const requestId = `cmd-${crypto.randomBytes(6).toString('hex')}`;
  const envelope = {
    protocolVersion: OVERLAY_PROTOCOL_VERSION,
    sessionId,
    requestId,
    command,
    payload: payload || {},
  };
  dispatchToRenderer(envelope);
  return requestId;
}

// =============================================================================
// Renderer event ingest
// =============================================================================

ipcMain.on('overlay:event', (_event, envelope) => {
  if (!envelope || envelope.protocolVersion !== OVERLAY_PROTOCOL_VERSION || typeof envelope.event !== 'string') {
    logger.warn('ignored invalid renderer event');
    return;
  }
  const event = envelope.event;
  if (event === 'ready') {
    rendererReady = true;
    flushPendingCommands();
    rehydrateIndicators();
    return;
  }
  if (event === 'interaction') {
    handleInteraction(envelope.payload || {});
    return;
  }
  if (event === 'error') {
    logger.warn('renderer error:', JSON.stringify(envelope.payload || {}));
    return;
  }
});

ipcMain.on('overlay:interactivity', (_event, payload) => {
  setWindowInteractivity(payload && payload.active === true);
});

function handleInteraction(payload) {
  const indicatorId = payload.indicatorId;
  if (typeof indicatorId !== 'string' || indicatorId.length === 0) return;

  if (payload.type === 'pong') return;

  // Both `indicator_resolved` and `indicator_closed` evict the indicator from
  // daemon state; they only differ in how the await waiter resolves.
  if (payload.type === 'indicator_resolved' || payload.type === 'indicator_closed') {
    indicators.delete(indicatorId);
  }

  if (payload.type === 'indicator_resolved') {
    const result = payload.result;
    if (result === 'done' || result === 'skipped') {
      const waiter = indicateResolutionWaiters.get(indicatorId);
      if (waiter) {
        clearTimeout(waiter.timer);
        indicateResolutionWaiters.delete(indicatorId);
        waiter.resolve(result);
      }
    }
  }
}

function rehydrateIndicators() {
  // Replay current indicators after renderer reload so visible state survives.
  if (!rendererReady) return;
  if (indicators.size === 0) return;
  try {
    sendRendererCommand('hideAll', {});
    for (const indicator of indicators.values()) {
      sendRendererCommand('indicate', { indicator });
    }
  } catch (err) {
    logger.warn('rehydrate failed:', err.message);
  }
}

// =============================================================================
// Public RPC handlers (called by shim through IpcServer)
// =============================================================================

async function handlePerceive(params) {
  const requested = Number.isFinite(params && params.overlayHwnd) ? params.overlayHwnd : 0;
  const effectiveHwnd = requested || getOverlayHwnd();
  const result = await sidecar.call('perceive', { excludeHwnd: effectiveHwnd });
  if (!Array.isArray(result)) {
    throw new Error('Sidecar returned non-array perceive result.');
  }
  if (params && params.includeDiagnostics) {
    return [
      ...result,
      {
        type: '__perceive_diagnostics',
        overlayHwndRequested: requested,
        overlayHwndEffective: effectiveHwnd,
        nodesCount: result.length,
      },
    ];
  }
  return result;
}

async function handleIndicate(params) {
  const normalized = normalizeIndicator(params && params.indicator !== undefined ? params.indicator : params);
  if (!normalized.id) {
    normalized.id = `ind-${crypto.randomBytes(6).toString('hex')}`;
  }
  const indicatorId = normalized.id;
  const append = Boolean(normalized.append);
  const awaitFlag = Boolean(normalized.await);

  if (!append) {
    indicators.clear();
    sendRendererCommand('hideAll', {});
  }
  indicators.set(indicatorId, normalized);
  sendRendererCommand('indicate', { indicator: normalized });

  if (!awaitFlag) {
    return { ok: true, indicator: normalized, result: null };
  }

  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      indicateResolutionWaiters.delete(indicatorId);
      reject(new Error(`Timed out waiting for indicator response: ${indicatorId}`));
    }, AWAIT_RESOLUTION_TIMEOUT_MS);
    indicateResolutionWaiters.set(indicatorId, { resolve, reject, timer });
  });
  return { ok: true, indicator: normalized, result };
}

function handleStatus() {
  return {
    daemonPid: process.pid,
    sessionId,
    rendererReady,
    overlayHwnd: getOverlayHwnd(),
    indicators: Array.from(indicators.keys()),
    sidecarReady: Boolean(sidecar && sidecar._isReady),
  };
}

function handleShutdown() {
  setImmediate(() => {
    try { app.quit(); } catch (_e) {}
  });
  return { ok: true };
}

// =============================================================================
// Lifecycle
// =============================================================================

app.whenReady().then(async () => {
  createOverlayWindow();

  sidecar = new SidecarManager({ logger });
  sidecar.on('ready', (payload) => logger.info('sidecar ready pid=' + payload.pid));
  sidecar.on('exit', ({ code, signal }) => logger.warn(`sidecar exited code=${code} signal=${signal}`));
  sidecar.on('error', (err) => logger.error('sidecar error:', err.message));
  sidecar.start();
  // Don't block window startup on the sidecar; perceive() awaits readiness on demand.

  ipcServer = new IpcServer({
    pipePath: daemonPipePath(),
    logger,
    handlers: {
      perceive: handlePerceive,
      indicate: handleIndicate,
      status: handleStatus,
      shutdown: handleShutdown,
    },
  });
  await ipcServer.listen();

  // Periodic ping keeps renderer liveness visible to the watchdog upstream.
  setInterval(() => {
    if (rendererReady) sendRendererCommand('ping', {});
  }, RENDERER_HEARTBEAT_INTERVAL_MS).unref();
});

app.on('window-all-closed', () => {
  // Daemon stays alive even if overlay window is closed; shims may reconnect.
});

app.on('before-quit', () => {
  if (ipcServer) {
    try { ipcServer.broadcast('daemon_quitting', { sessionId }); } catch (_e) {}
    ipcServer.close();
  }
  if (sidecar) sidecar.stop();
});

// Soak unhandled errors so a stray async failure cannot turn into a daemon-wide crash.
process.on('uncaughtException', (err) => logger.error('uncaughtException:', err.stack || err.message));
process.on('unhandledRejection', (err) => logger.error('unhandledRejection:', err && err.message));

// Silence unused warning for INDICATE_ACK_TIMEOUT_MS (reserved for future ack wiring).
void INDICATE_ACK_TIMEOUT_MS;
void indicateAckWaiters;

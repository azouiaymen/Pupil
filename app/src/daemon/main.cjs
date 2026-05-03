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
const input = require('./input.cjs');

// =============================================================================
// Constants
// =============================================================================

const MAX_PENDING_RENDERER_COMMANDS = 256;
const RENDERER_HEARTBEAT_INTERVAL_MS = 4000;
const AWAIT_RESOLUTION_TIMEOUT_MS = 180000;
const INDICATE_ACK_TIMEOUT_MS = 4000;
const POST_RESOLUTION_PERCEIVE_DELAY_MS = 250;

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
    // Focusable so the renderer can capture Tab / Escape via DOM keydown when
    // an indicator is up. Click-through is preserved by setIgnoreMouseEvents below.
    focusable: true,
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

// PerMonitorV2 sidecar emits UIA rects in physical screen pixels; Electron
// display.bounds and virtualOrigin are DIP. Convert once so remap, storage,
// and overlay CSS share one space with the BrowserWindow placement.
function physicalCoordsToDipInPlace(indicator) {
  const c = indicator.coords;
  if (!c) return;
  if (process.platform !== 'win32') return;
  if (typeof screen.screenToDipRect !== 'function') {
    logger.warn('screen.screenToDipRect missing; leaving coords unchanged (possible DPI mismatch).');
    return;
  }
  try {
    const rect = {
      x: Math.round(Number(c.x)),
      y: Math.round(Number(c.y)),
      width: Math.round(Number(c.w)),
      height: Math.round(Number(c.h)),
    };
    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    const dip = screen.screenToDipRect(win, rect);
    indicator.coords = {
      ...c,
      x: Math.round(dip.x),
      y: Math.round(dip.y),
      w: Math.round(dip.width),
      h: Math.round(dip.height),
    };
  } catch (err) {
    logger.warn('physicalCoordsToDip failed:', err.message);
  }
}

// Renderer expects coords in window-local coordinates (virtual desktop relative
// to the overlay window top-left). Subtract the same union-min origin used when
// createOverlayWindow() positioned the BrowserWindow — not getContentBounds(),
// which can disagree with UIA space on frameless transparent Windows overlays.
function remapCoordsToWindowSpace(envelope) {
  if (envelope.command !== 'indicate') return envelope;
  const indicator = envelope.payload && envelope.payload.indicator;
  if (!indicator || !indicator.coords) return envelope;
  return {
    ...envelope,
    payload: {
      ...envelope.payload,
      indicator: {
        ...indicator,
        coords: {
          ...indicator.coords,
          x: Number(indicator.coords.x) - virtualOrigin.x,
          y: Number(indicator.coords.y) - virtualOrigin.y,
        },
      },
    },
  };
}

function dispatchToRenderer(envelope) {
  const mapped = remapCoordsToWindowSpace(envelope);
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

  if (payload.type === 'indicator_resolved') {
    void resolveIndicatorFromRenderer(indicatorId, payload).catch((err) => {
      logger.warn('indicator resolve failed:', err && (err.stack || err.message));
    });
    return;
  }

  if (payload.type === 'indicator_closed') {
    indicators.delete(indicatorId);
  }
}

// Renderer-driven resolution: may include an OS-level action (click/input) and a
// keepVisible flag that controls whether the daemon should keep the indicator
// in its map (so rehydrate after a renderer reload still shows it as in-flight)
// or evict it immediately (X close). Skip uses the same in-flight path as Next/Accept.
async function resolveIndicatorFromRenderer(indicatorId, payload) {
  const indicator = indicators.get(indicatorId);
  const result = payload.result === 'done' || payload.result === 'skipped' ? payload.result : null;
  const ALLOWED_ACTIONS = new Set(['click', 'input']);
  const action = ALLOWED_ACTIONS.has(payload.action) ? payload.action : null;
  const keepVisible = payload.keepVisible === true;

  let actionError = null;
  // Only `click` requires coords. `input` may omit coords (blur overlay then chords
  // to previous foreground); with coords, Accept clicks the bbox center first
  // (renderer sends clickPoint at bbox center; daemon falls back to coords center).
  const requiresCoords = action === 'click';
  const canRun = action && indicator && (!requiresCoords || indicator.coords);
  if (canRun) {
    try {
      if (indicator.coords) {
        let cx;
        let cy;
        const cp = payload.clickPoint;
        if (cp && typeof cp.x === 'number' && typeof cp.y === 'number' && Number.isFinite(cp.x) && Number.isFinite(cp.y)) {
          let p = { x: cp.x, y: cp.y };
          if (process.platform === 'win32' && typeof screen.dipToScreenPoint === 'function') {
            p = screen.dipToScreenPoint(p);
          }
          cx = p.x;
          cy = p.y;
        } else {
          // Stored coords are DIP after handleIndicate; nut-js needs physical pixels.
          // Center of bbox (same as renderer's measureBboxScreenCenter intent).
          cx = indicator.coords.x + indicator.coords.w / 2;
          cy = indicator.coords.y + indicator.coords.h / 2;
          if (process.platform === 'win32' && typeof screen.dipToScreenPoint === 'function') {
            const p = screen.dipToScreenPoint({ x: cx, y: cy });
            cx = p.x;
            cy = p.y;
          }
        }
        await input.clickAt(cx, cy);
      }
      if (action === 'input') {
        // Without a focus click, the overlay (which we focus()'d for Tab/Escape)
        // still owns the OS keyboard focus. Blur it so Windows hands focus back
        // to the previously-foreground window before the chord fires; runInput
        // uses pressShortcut which has its own settle delay.
        if (!indicator.coords && mainWindow && !mainWindow.isDestroyed()) {
          try {
            mainWindow.blur();
          } catch (_e) {}
        }
        const v = indicator.value && typeof indicator.value === 'object' ? indicator.value : {};
        await input.runInput({
          clip: typeof v.clip === 'string' ? v.clip : undefined,
          chords: Array.isArray(v.chords) ? v.chords : [],
        });
      }
    } catch (err) {
      actionError = err;
      logger.warn(`action '${action}' failed:`, err.message);
    }
  } else if (action && requiresCoords && (!indicator || !indicator.coords)) {
    actionError = new Error(`Cannot perform '${action}': indicator ${indicatorId} has no coords.`);
    logger.warn(actionError.message);
  } else if (action && !indicator) {
    actionError = new Error(`Cannot perform '${action}': indicator ${indicatorId} not found in daemon state.`);
    logger.warn(actionError.message);
  }

  if (!keepVisible) {
    indicators.delete(indicatorId);
  }

  const waiter = indicateResolutionWaiters.get(indicatorId);
  if (waiter && result) {
    clearTimeout(waiter.timer);
    indicateResolutionWaiters.delete(indicatorId);
    if (actionError) {
      waiter.reject(actionError);
    } else {
      waiter.resolve(result);
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

async function handlePerceive(_params) {
  const effectiveHwnd = getOverlayHwnd();
  const result = await sidecar.call('perceive', { excludeHwnd: effectiveHwnd });
  if (!Array.isArray(result)) {
    throw new Error('Sidecar returned non-array perceive result.');
  }
  return result;
}

async function handleIndicate(params) {
  const normalized = normalizeIndicator(params && typeof params === 'object' && !Array.isArray(params) ? params : {});
  if (!normalized.id) {
    normalized.id = `ind-${crypto.randomBytes(6).toString('hex')}`;
  }
  const indicatorId = normalized.id;

  physicalCoordsToDipInPlace(normalized);

  indicators.clear();
  sendRendererCommand('hideAll', {});
  indicators.set(indicatorId, normalized);
  sendRendererCommand('indicate', { indicator: normalized });
  // Pull keyboard focus to the overlay so the renderer's Tab / Escape handlers fire
  // for the just-shown indicator. focus() is a no-op if the window is gone.
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.focus();
    } catch (_e) {}
  }

  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      indicateResolutionWaiters.delete(indicatorId);
      reject(new Error(`Timed out waiting for indicator response: ${indicatorId}`));
    }, AWAIT_RESOLUTION_TIMEOUT_MS);
    indicateResolutionWaiters.set(indicatorId, { resolve, reject, timer });
  });

  await new Promise((r) => setTimeout(r, POST_RESOLUTION_PERCEIVE_DELAY_MS));
  let perceiveNodes = [];
  try {
    perceiveNodes = await handlePerceive({});
  } catch (err) {
    logger.warn('post-indicate perceive failed:', err && err.message ? err.message : err);
    perceiveNodes = [];
  }
  return { result, perceive: perceiveNodes };
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

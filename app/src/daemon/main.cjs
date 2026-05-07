'use strict';

const { app, BrowserWindow, globalShortcut, ipcMain, screen } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { IpcServer } = require('../ipc/server.cjs');
const { SidecarManager } = require('../sidecar/manager.cjs');
const { normalizeIndicator, parseCoordsString } = require('./state.cjs');
const { OVERLAY_PROTOCOL_VERSION, AWAIT_RESOLUTION_TIMEOUT_MS } = require('../common/protocol.cjs');
const { daemonPipePath, runtimeRoot } = require('../common/paths.cjs');
const input = require('./input.cjs');

// =============================================================================
// Constants
// =============================================================================

const MAX_PENDING_RENDERER_COMMANDS = 256;
const RENDERER_HEARTBEAT_INTERVAL_MS = 4000;
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
let loggedTestFocusBbox = false;

/** When set (e.g. from perceive), every indicate uses this bbox for card/connector styling so all types can be compared on one control. */
function applyTestFocusBboxIfConfigured(indicator) {
  const raw = process.env.PUPIL_TEST_FOCUS_BBOX;
  if (typeof raw !== 'string' || !raw.trim()) return;
  try {
    indicator.coords = parseCoordsString(raw.trim());
    physicalCoordsToDipInPlace(indicator);
    if (!loggedTestFocusBbox) {
      loggedTestFocusBbox = true;
      logger.info('PUPIL_TEST_FOCUS_BBOX is set; overlay highlight uses that rect for every indicate type.');
    }
  } catch (err) {
    logger.warn('PUPIL_TEST_FOCUS_BBOX ignored:', err.message);
  }
}

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

/** Primary display bounds in overlay window-local DIP (union origin subtracted). */
function getPrimaryDisplayWindowRect() {
  const primary = screen.getPrimaryDisplay();
  const b = primary && primary.bounds ? primary.bounds : null;
  if (!b) return null;
  return {
    x: Math.round(Number(b.x) - virtualOrigin.x),
    y: Math.round(Number(b.y) - virtualOrigin.y),
    w: Math.round(Number(b.width)),
    h: Math.round(Number(b.height)),
  };
}

/** Each monitor's work area in overlay window-local DIP (excludes taskbar where applicable). */
function getAllDisplayWorkAreaRects() {
  const displays = screen.getAllDisplays();
  return displays.map((d) => {
    const b = d.workArea || d.bounds;
    return {
      x: Math.round(Number(b.x) - virtualOrigin.x),
      y: Math.round(Number(b.y) - virtualOrigin.y),
      w: Math.round(Number(b.width)),
      h: Math.round(Number(b.height)),
    };
  });
}

function sendLayoutToRenderer() {
  const primaryRect = getPrimaryDisplayWindowRect();
  if (!primaryRect) return;
  try {
    const displays = getAllDisplayWorkAreaRects();
    sendRendererCommand('setLayout', { primaryRect, displays });
  } catch (_e) {
    // Overlay window not ready yet; queued indicate will follow a later setLayout from ready/display events.
  }
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
    // Non-activating: target window keeps OS keyboard focus. Tab / Shift+Tab /
    // Escape are intercepted via globalShortcut (see armKeys), not via DOM
    // keydown. Click-through is still toggled by setIgnoreMouseEvents below.
    focusable: false,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'overlay', 'preload.cjs'),
    },
  });
  keepOverlayOnTop();
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.setIgnoreMouseEvents(true, { forward: true });
  mainWindow.on('show', () => keepOverlayOnTop());
  mainWindow.on('restore', () => keepOverlayOnTop());
  mainWindow.loadFile(path.join(__dirname, '..', 'overlay', 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
    rendererReady = false;
  });
}

function keepOverlayOnTop() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    // Re-assert topmost whenever z-order may have changed.
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
    if (typeof mainWindow.moveTop === 'function') {
      mainWindow.moveTop();
    }
  } catch (err) {
    logger.warn('keepOverlayOnTop failed:', err && err.message ? err.message : err);
  }
}

function setWindowInteractivity(active) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const next = Boolean(active);
  if (interactive === next) return;
  interactive = next;
  mainWindow.setIgnoreMouseEvents(!interactive, { forward: true });
}

// =============================================================================
// Global keyboard shortcuts (Tab / Shift+Tab / Escape) for indicate cards
// =============================================================================
//
// Electron's globalShortcut wraps Win32 RegisterHotKey, which intercepts the
// keystroke before it reaches the focused application — exactly what we need
// so the user's File menu (or any popover) keeps focus while still being able
// to drive the overlay card with the keyboard. Single-key Tab / Esc binds are
// known to be flaky on some Windows configurations, so we degrade to mouse
// Skip / Accept silently if register() returns false.

let keysArmed = false;
let loggedRegisterFailure = { Tab: false, 'Shift+Tab': false, Escape: false };

const SHORTCUT_KIND_BY_ACCELERATOR = {
  Tab: 'tab',
  'Shift+Tab': 'shift+tab',
  Escape: 'escape',
};

function dispatchTriggerKey(kind) {
  try {
    sendRendererCommand('triggerKey', { kind });
  } catch (err) {
    logger.warn('triggerKey dispatch failed:', err && err.message ? err.message : err);
  }
}

function armKeys() {
  if (keysArmed) return;
  keysArmed = true;
  for (const accel of Object.keys(SHORTCUT_KIND_BY_ACCELERATOR)) {
    const kind = SHORTCUT_KIND_BY_ACCELERATOR[accel];
    let ok = false;
    try {
      ok = globalShortcut.register(accel, () => dispatchTriggerKey(kind));
    } catch (err) {
      logger.warn(`globalShortcut.register('${accel}') threw:`, err && err.message ? err.message : err);
      ok = false;
    }
    if (!ok && !loggedRegisterFailure[accel]) {
      loggedRegisterFailure[accel] = true;
      logger.warn(`globalShortcut.register('${accel}') returned false; mouse Skip/Accept still works.`);
    }
  }
}

function disarmKeys() {
  if (!keysArmed) return;
  keysArmed = false;
  for (const accel of Object.keys(SHORTCUT_KIND_BY_ACCELERATOR)) {
    try {
      globalShortcut.unregister(accel);
    } catch (err) {
      logger.warn(`globalShortcut.unregister('${accel}') threw:`, err && err.message ? err.message : err);
    }
  }
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
    sendLayoutToRenderer();
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

/** When a new indicate replaces the overlay, prior callers still await resolution; resolve them as skipped (no OS action). */
function autoSkipPendingResolutions(reason) {
  const label = typeof reason === 'string' && reason.length > 0 ? reason : 'unknown';
  // Disarm before re-arming on the next handleIndicate so we never leak an
  // intercept across cards; armKeys() in handleIndicate takes over immediately.
  disarmKeys();
  for (const [id, waiter] of [...indicateResolutionWaiters.entries()]) {
    if (!waiter) continue;
    clearTimeout(waiter.timer);
    indicateResolutionWaiters.delete(id);
    logger.info(`auto-skipped indicator ${id} (${label})`);
    waiter.resolve('skipped');
  }
}

// Renderer-driven resolution: may include an OS-level action (click/input) and a
// keepVisible flag that controls whether the daemon should keep the indicator
// in its map (so rehydrate after a renderer reload still shows it as in-flight)
// or evict it immediately (X close). Skip uses the same in-flight path as Next/Accept.
async function resolveIndicatorFromRenderer(indicatorId, payload) {
  // Stop intercepting Tab/Esc as soon as the user resolves the card so the
  // spinner phase (waiting for the next indicate) does not eat keystrokes
  // meant for the user's real foreground app.
  disarmKeys();
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
        // Defensive: the overlay is non-activating (focusable: false) so it
        // should never own keyboard focus, but blur() before chord-only input
        // is a cheap safety net for any platform/edge case where it might.
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
      sendRendererCommand('indicate', {
        indicator,
        awaitResolutionTimeoutMs: AWAIT_RESOLUTION_TIMEOUT_MS,
      });
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
  applyTestFocusBboxIfConfigured(normalized);

  autoSkipPendingResolutions('replaced_by_new_indicate');
  indicators.clear();
  sendRendererCommand('hideAll', {});
  indicators.set(indicatorId, normalized);
  sendRendererCommand('indicate', {
    indicator: normalized,
    awaitResolutionTimeoutMs: AWAIT_RESOLUTION_TIMEOUT_MS,
  });
  // Arm Electron's globalShortcut so Tab / Shift+Tab / Escape are routed to
  // the renderer's resolution path even though the overlay window is
  // non-activating and never owns OS keyboard focus.
  armKeys();

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

  const onDisplayLayoutChange = () => {
    sendLayoutToRenderer();
  };
  screen.on('display-metrics-changed', onDisplayLayoutChange);
  screen.on('display-added', onDisplayLayoutChange);
  screen.on('display-removed', onDisplayLayoutChange);
  app.on('browser-window-created', (_event, win) => {
    if (mainWindow && win === mainWindow) return;
    setImmediate(() => keepOverlayOnTop());
  });
  app.on('browser-window-focus', (_event, win) => {
    if (mainWindow && win === mainWindow) return;
    keepOverlayOnTop();
  });

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
  try { globalShortcut.unregisterAll(); } catch (_e) {}
});

app.on('will-quit', () => {
  // Electron docs recommend unregisterAll on quit; idempotent with before-quit.
  try { globalShortcut.unregisterAll(); } catch (_e) {}
});

// Soak unhandled errors so a stray async failure cannot turn into a daemon-wide crash.
process.on('uncaughtException', (err) => logger.error('uncaughtException:', err.stack || err.message));
process.on('unhandledRejection', (err) => logger.error('unhandledRejection:', err && err.message));

// Silence unused warning for INDICATE_ACK_TIMEOUT_MS (reserved for future ack wiring).
void INDICATE_ACK_TIMEOUT_MS;
void indicateAckWaiters;

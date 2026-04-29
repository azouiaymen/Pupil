'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const { EventEmitter } = require('events');
const crypto = require('crypto');

const { sidecarExecutablePath } = require('../common/paths.cjs');
const { createLineParser, encodeLine } = require('../common/jsonl.cjs');
const { SIDECAR_PROTOCOL_VERSION } = require('../common/protocol.cjs');

// Caps for the supervisor. Keeping them small avoids hiding genuine failures
// behind endless restart loops.
const MAX_RESTART_ATTEMPTS = 3;
const RESTART_BACKOFF_MS = 750;
const READY_TIMEOUT_MS = 8000;
const REQUEST_TIMEOUT_MS = 15000;
const MAX_PENDING_REQUESTS = 64;

// Wraps the pupil-core.exe sidecar. Spawns and supervises the process,
// exposes a promise-based `call(method, params)` API, and emits 'ready',
// 'exit', 'error' so the daemon can surface diagnostics.
class SidecarManager extends EventEmitter {
  constructor({ executablePath = sidecarExecutablePath(), logger } = {}) {
    super();
    this._executablePath = executablePath;
    this._logger = logger || console;
    this._child = null;
    this._restartAttempts = 0;
    this._readyResolvers = [];
    this._pending = new Map();
    this._stopRequested = false;
    this._feedStdout = null;
    this._restartTimer = null;
  }

  // Verifies the bundled executable exists. We avoid spawning if the EXE is
  // missing because spawn errors on Windows surface late and confusingly.
  ensureAvailable() {
    if (!fs.existsSync(this._executablePath)) {
      throw new Error(`pupil-core.exe not found at ${this._executablePath}. Run scripts/build-sidecar.ps1.`);
    }
  }

  start() {
    this.ensureAvailable();
    this._stopRequested = false;
    this._spawn();
  }

  stop() {
    this._stopRequested = true;
    if (this._restartTimer) {
      clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }
    this._failPending(new Error('Sidecar stopped.'));
    if (this._child) {
      try {
        this._writeLine({ id: 'shutdown', method: 'shutdown' });
      } catch (_e) {}
      try {
        this._child.kill();
      } catch (_e) {}
    }
  }

  // Returns a promise that resolves when the sidecar emits its `ready` event.
  // If already ready, resolves immediately on next tick.
  whenReady() {
    if (this._isReady) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this._readyResolvers.indexOf(entry);
        if (idx !== -1) this._readyResolvers.splice(idx, 1);
        reject(new Error('Sidecar ready timeout.'));
      }, READY_TIMEOUT_MS);
      const entry = { resolve, reject, timer };
      this._readyResolvers.push(entry);
    });
  }

  async call(method, params) {
    if (!this._child || this._child.exitCode !== null) {
      this._spawn();
    }
    await this.whenReady();
    if (this._pending.size >= MAX_PENDING_REQUESTS) {
      throw new Error('Sidecar request queue full.');
    }
    const id = `r-${crypto.randomBytes(6).toString('hex')}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this._pending.delete(id)) {
          reject(new Error(`Sidecar method '${method}' timed out.`));
        }
      }, REQUEST_TIMEOUT_MS);
      this._pending.set(id, { resolve, reject, timer });
      try {
        this._writeLine({ id, method, params });
      } catch (err) {
        this._pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  _spawn() {
    if (this._child && this._child.exitCode === null) return;
    this._isReady = false;

    const child = spawn(this._executablePath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this._child = child;

    this._feedStdout = createLineParser(
      (msg) => this._handleEnvelope(msg),
      (err, raw) => this._logger.warn('sidecar parse error:', err.message, raw)
    );

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this._feedStdout(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => this._logger.warn('sidecar stderr:', chunk.trim()));

    child.on('error', (err) => {
      this._logger.error('sidecar spawn error:', err);
      this.emit('error', err);
    });

    child.on('exit', (code, signal) => {
      this._isReady = false;
      this._failPending(new Error(`Sidecar exited (code=${code}, signal=${signal}).`));
      this._readyResolvers.splice(0).forEach(({ reject, timer }) => {
        clearTimeout(timer);
        reject(new Error('Sidecar exited before ready.'));
      });
      this.emit('exit', { code, signal });
      if (this._stopRequested) return;
      if (this._restartAttempts >= MAX_RESTART_ATTEMPTS) {
        this._logger.error('Sidecar exceeded restart budget.');
        return;
      }
      this._restartAttempts += 1;
      this._restartTimer = setTimeout(() => this._spawn(), RESTART_BACKOFF_MS);
    });
  }

  _handleEnvelope(message) {
    if (!message || typeof message !== 'object') return;
    if (message.event === 'ready') {
      const payload = message.payload || {};
      if (payload.protocolVersion && String(payload.protocolVersion) !== SIDECAR_PROTOCOL_VERSION) {
        this._logger.warn(
          `sidecar protocol mismatch: expected ${SIDECAR_PROTOCOL_VERSION}, got ${payload.protocolVersion}`
        );
      }
      this._isReady = true;
      this._restartAttempts = 0;
      this._readyResolvers.splice(0).forEach(({ resolve, timer }) => {
        clearTimeout(timer);
        resolve();
      });
      this.emit('ready', payload);
      return;
    }
    if (typeof message.id === 'string' && this._pending.has(message.id)) {
      const { resolve, reject, timer } = this._pending.get(message.id);
      this._pending.delete(message.id);
      clearTimeout(timer);
      if (message.error) {
        const err = new Error(message.error.message || 'Sidecar error');
        err.code = message.error.code;
        reject(err);
      } else {
        resolve(message.result);
      }
    }
  }

  _failPending(err) {
    for (const { reject, timer } of this._pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    this._pending.clear();
  }

  _writeLine(message) {
    if (!this._child || !this._child.stdin.writable) {
      throw new Error('Sidecar stdin not writable.');
    }
    this._child.stdin.write(encodeLine(message));
  }
}

module.exports = { SidecarManager };

'use strict';

const net = require('net');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const { createLineParser, encodeLine } = require('../common/jsonl.cjs');
const { SHIM_PROTOCOL_VERSION } = require('../common/protocol.cjs');

// Client-side of the daemon <-> shim named-pipe channel. Connects with a few
// retries because the daemon may still be booting when the shim launches it.
const DEFAULT_CONNECT_RETRIES = 40;
const DEFAULT_CONNECT_RETRY_MS = 250;
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const MAX_PENDING = 128;

class IpcClient extends EventEmitter {
  constructor({ pipePath, logger, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
    super();
    this._pipePath = pipePath;
    this._logger = logger || console;
    this._requestTimeoutMs = requestTimeoutMs;
    this._socket = null;
    this._pending = new Map();
    this._helloPayload = null;
    this._handshake = null;
    this._closed = false;
  }

  async connect({ retries = DEFAULT_CONNECT_RETRIES, retryDelayMs = DEFAULT_CONNECT_RETRY_MS } = {}) {
    let lastError = null;
    for (let attempt = 0; attempt < retries && !this._closed; attempt += 1) {
      try {
        await this._connectOnce();
        return this._helloPayload;
      } catch (err) {
        lastError = err;
        await new Promise((r) => setTimeout(r, retryDelayMs));
      }
    }
    throw new Error(
      `Failed to connect to daemon at ${this._pipePath}: ${lastError && lastError.message}`
    );
  }

  close() {
    this._closed = true;
    this._failPending(new Error('IPC client closed.'));
    if (this._socket) {
      try { this._socket.end(); } catch (_e) {}
      this._socket = null;
    }
  }

  // Send a JSON-RPC style request. Resolves with `result`, rejects on error or timeout.
  async call(method, params, options) {
    if (!this._socket) {
      throw new Error('IPC client not connected.');
    }
    if (this._pending.size >= MAX_PENDING) {
      throw new Error('IPC client request queue full.');
    }
    const timeoutMs =
      options &&
      typeof options === 'object' &&
      typeof options.timeoutMs === 'number' &&
      Number.isFinite(options.timeoutMs) &&
      options.timeoutMs > 0
        ? options.timeoutMs
        : this._requestTimeoutMs;
    const id = `c-${crypto.randomBytes(6).toString('hex')}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this._pending.delete(id)) {
          reject(new Error(`Daemon method '${method}' timed out.`));
        }
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      try {
        this._socket.write(encodeLine({ id, method, params }));
      } catch (err) {
        this._pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  _connectOnce() {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this._pipePath);
      socket.setEncoding('utf8');

      let handshakeResolved = false;

      const feed = createLineParser(
        (msg) => this._dispatch(msg, () => {
          if (!handshakeResolved && msg && msg.event === 'hello') {
            this._helloPayload = msg.payload || {};
            if (this._helloPayload.protocolVersion !== SHIM_PROTOCOL_VERSION) {
              const err = new Error(
                `Daemon protocol mismatch (expected ${SHIM_PROTOCOL_VERSION}, got ${this._helloPayload.protocolVersion}).`
              );
              handshakeResolved = true;
              try { socket.end(); } catch (_e) {}
              reject(err);
              return;
            }
            handshakeResolved = true;
            resolve();
          }
        }),
        (err, raw) => this._logger.warn('ipc client parse error:', err.message, raw)
      );

      socket.on('data', (chunk) => feed(chunk));
      socket.on('error', (err) => {
        if (!handshakeResolved) {
          reject(err);
          return;
        }
        this._logger.warn('ipc client socket error:', err.message);
      });
      socket.on('close', () => {
        if (!handshakeResolved) {
          reject(new Error('Socket closed before handshake.'));
          return;
        }
        this._failPending(new Error('IPC client socket closed.'));
        this.emit('close');
      });

      this._socket = socket;
    });
  }

  _dispatch(message, afterHandshake) {
    afterHandshake();
    if (!message || typeof message !== 'object') return;
    if (typeof message.id === 'string' && this._pending.has(message.id)) {
      const { resolve, reject, timer } = this._pending.get(message.id);
      this._pending.delete(message.id);
      clearTimeout(timer);
      if (message.error) {
        const err = new Error(message.error.message || 'Daemon error');
        err.code = message.error.code;
        reject(err);
      } else {
        resolve(message.result);
      }
      return;
    }
    if (typeof message.event === 'string') {
      this.emit('event', message.event, message.payload || {});
    }
  }

  _failPending(err) {
    for (const { reject, timer } of this._pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    this._pending.clear();
  }
}

module.exports = { IpcClient };

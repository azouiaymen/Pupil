'use strict';

const net = require('net');
const { EventEmitter } = require('events');

const { createLineParser, encodeLine } = require('../common/jsonl.cjs');
const { SHIM_PROTOCOL_VERSION } = require('../common/protocol.cjs');

// Server-side of the daemon <-> shim named-pipe channel.
// One pipe path is shared; the daemon listens, the shim is the client.
// Messages are JSON-RPC style:
//   request:  { id, method, params }
//   response: { id, result } | { id, error: { code, message } }
//   event:    { event, payload }
// A short handshake establishes protocol version on connect.
class IpcServer extends EventEmitter {
  constructor({ pipePath, logger, handlers, allowMultipleClients = true } = {}) {
    super();
    this._pipePath = pipePath;
    this._logger = logger || console;
    this._handlers = handlers || {};
    this._allowMultipleClients = allowMultipleClients;
    this._server = null;
    this._sockets = new Set();
  }

  async listen() {
    await new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this._onConnection(socket));
      server.on('error', (err) => {
        this._logger.error('ipc server error:', err.message);
        reject(err);
      });
      server.listen(this._pipePath, () => {
        this._server = server;
        this._logger.info(`ipc server listening on ${this._pipePath}`);
        resolve();
      });
    });
  }

  close() {
    for (const socket of this._sockets) {
      try { socket.end(); } catch (_e) {}
    }
    this._sockets.clear();
    if (this._server) {
      try { this._server.close(); } catch (_e) {}
      this._server = null;
    }
  }

  // Broadcast an event to every connected shim. Used for crash/lifecycle notices.
  broadcast(event, payload) {
    const line = encodeLine({ event, payload });
    for (const socket of this._sockets) {
      try { socket.write(line); } catch (_e) {}
    }
  }

  _onConnection(socket) {
    if (!this._allowMultipleClients && this._sockets.size > 0) {
      try {
        socket.write(encodeLine({ event: 'error', payload: { code: 'busy', message: 'Daemon already serves another client.' } }));
        socket.end();
      } catch (_e) {}
      return;
    }
    socket.setEncoding('utf8');
    this._sockets.add(socket);
    this._logger.info('ipc client connected');

    const send = (message) => {
      try {
        socket.write(encodeLine(message));
      } catch (err) {
        this._logger.warn('ipc write failed:', err.message);
      }
    };

    const feed = createLineParser(
      (msg) => this._dispatch(msg, send),
      (err, raw) => {
        this._logger.warn('ipc parse error:', err.message, raw);
        send({ id: null, error: { code: 'invalid_json', message: err.message } });
      }
    );

    socket.on('data', (chunk) => feed(chunk));
    socket.on('error', (err) => this._logger.warn('ipc socket error:', err.message));
    socket.on('close', () => {
      this._sockets.delete(socket);
      this._logger.info('ipc client disconnected');
    });

    send({
      event: 'hello',
      payload: { protocolVersion: SHIM_PROTOCOL_VERSION, daemonPid: process.pid },
    });
  }

  async _dispatch(message, send) {
    if (!message || typeof message !== 'object') {
      send({ id: null, error: { code: 'invalid_envelope', message: 'Envelope must be a JSON object.' } });
      return;
    }
    const { id, method, params } = message;
    if (typeof method !== 'string') {
      send({ id: id || null, error: { code: 'missing_method', message: 'Envelope must include method.' } });
      return;
    }
    const handler = this._handlers[method];
    if (!handler) {
      send({ id: id || null, error: { code: 'unknown_method', message: `No handler for method '${method}'.` } });
      return;
    }
    try {
      const result = await handler(params || {});
      send({ id, result: result === undefined ? null : result });
    } catch (err) {
      send({
        id: id || null,
        error: { code: err.code || 'handler_failed', message: err.message || String(err) },
      });
    }
  }
}

module.exports = { IpcServer };

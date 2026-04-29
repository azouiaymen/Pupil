'use strict';

const os = require('os');
const path = require('path');
const crypto = require('crypto');

// Centralizes filesystem and named-pipe path conventions so daemon and shim
// agree without environment-variable handshakes for the common case.

const PIPE_PREFIX = '\\\\.\\pipe\\';

// Per-user pipe name keeps overlapping sessions on multi-user machines from
// stomping each other while still being deterministic for the shim.
function defaultDaemonPipeName() {
  const userKey = (process.env.USERNAME || os.userInfo().username || 'default').toLowerCase();
  const hash = crypto.createHash('sha1').update(userKey).digest('hex').slice(0, 12);
  return `pupil-mcp-daemon-${hash}`;
}

function daemonPipePath() {
  return PIPE_PREFIX + (process.env.PUPIL_DAEMON_PIPE || defaultDaemonPipeName());
}

// Internal pipe used between daemon (server) and overlay window state. The
// renderer never opens this pipe directly; only the daemon does.
function overlayPipePath(sessionId) {
  return `${PIPE_PREFIX}pupil-overlay-${sessionId}`;
}

function vendorRoot() {
  // Resolves to <package>/vendor regardless of whether the caller starts from
  // src/, bin/, or an installed copy.
  return path.resolve(__dirname, '..', '..', 'vendor');
}

function sidecarExecutablePath() {
  return path.join(vendorRoot(), 'win32-x64', 'pupil-core.exe');
}

function runtimeRoot() {
  return path.join(os.tmpdir(), 'pupil-mcp-runtime');
}

module.exports = {
  daemonPipePath,
  overlayPipePath,
  sidecarExecutablePath,
  vendorRoot,
  runtimeRoot,
};

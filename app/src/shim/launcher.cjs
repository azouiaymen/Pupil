'use strict';

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// Resolves the path to the bundled Electron binary inside this package.
// Doing the require here (instead of at module load) lets the shim survive a
// future packaging where electron is moved to optionalDependencies.
function resolveElectronBinary() {
  const electron = require('electron');
  if (typeof electron !== 'string') {
    throw new Error('Could not resolve Electron binary path.');
  }
  if (!fs.existsSync(electron)) {
    throw new Error(`Electron binary missing at ${electron}. Try reinstalling the package.`);
  }
  return electron;
}

function daemonEntryPath() {
  const entry = path.resolve(__dirname, '..', 'daemon', 'main.cjs');
  if (!fs.existsSync(entry)) {
    throw new Error(`Daemon entry missing at ${entry}.`);
  }
  return entry;
}

// Spawns the Electron daemon detached so it survives the shim process exit.
// stdio is fully ignored: the daemon's only output channel is its named pipe,
// and Cursor's stdio belongs to the shim alone.
function spawnDaemon({ logger } = {}) {
  const electronBinary = resolveElectronBinary();
  const entry = daemonEntryPath();
  const appRoot = path.resolve(__dirname, '..', '..');
  if (logger) logger.info(`spawning daemon: ${electronBinary} ${entry}`);
  const env = { ...process.env };
  // Some MCP hosts set this for Node child processes; if inherited, Electron
  // does not bootstrap the app runtime and behaves like plain Node.
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBinary, [entry], {
    cwd: appRoot,
    env,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return child.pid;
}

module.exports = { spawnDaemon, resolveElectronBinary, daemonEntryPath };

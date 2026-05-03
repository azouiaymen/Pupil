'use strict';

// Protocol versions are kept in one file so the shim, daemon, sidecar manager
// and overlay renderer can validate compatibility without crossing trust
// boundaries blindly.

// Shim <-> daemon JSON-RPC envelope.
const SHIM_PROTOCOL_VERSION = 1;

// Daemon <-> overlay renderer command envelope. v7: compact indicator model
// — flat fields type / coords ("x,y,w,h") / desc / value; value for `input` is
// { clip?: string, chords: string[][] } (nut-js Key chord steps; optional clip
// primes clipboard before chords, then restores prior text/plain in finally).
const OVERLAY_PROTOCOL_VERSION = 7;

// Daemon <-> sidecar JSON stdio envelope.
const SIDECAR_PROTOCOL_VERSION = '1';

const INDICATOR_TYPES = Object.freeze([
  'info',
  'warning',
  'wait',
  'action',
  'click',
  'input',
  'danger',
]);

const SHIM_METHODS = Object.freeze({
  PERCEIVE: 'perceive',
  INDICATE: 'indicate',
  STATUS: 'status',
  SHUTDOWN: 'shutdown',
});

module.exports = {
  SHIM_PROTOCOL_VERSION,
  OVERLAY_PROTOCOL_VERSION,
  SIDECAR_PROTOCOL_VERSION,
  INDICATOR_TYPES,
  SHIM_METHODS,
};

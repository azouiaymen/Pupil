'use strict';

const { INDICATOR_TYPES } = require('../common/protocol.cjs');

function parseCoordsString(s) {
  if (typeof s !== 'string' || !s.trim()) {
    throw new Error('coords must be a non-empty comma-separated string "x,y,w,h".');
  }
  const parts = s.split(',').map((p) => p.trim());
  if (parts.length !== 4) {
    throw new Error('coords must contain exactly four integers: x,y,w,h.');
  }
  const nums = parts.map((p, i) => {
    const n = Number.parseInt(p, 10);
    if (!Number.isFinite(n)) {
      throw new Error(`coords part ${i + 1} is not a valid integer.`);
    }
    return n;
  });
  const [x, y, w, h] = nums;
  if (w <= 0 || h <= 0) {
    throw new Error('coords w and h must be positive.');
  }
  return { x, y, w, h };
}

function isChordList(v) {
  if (!Array.isArray(v) || v.length === 0) return false;
  return v.every(
    (chord) =>
      Array.isArray(chord) &&
      chord.length > 0 &&
      chord.every((k) => typeof k === 'string' && k.trim().length > 0)
  );
}

// Validates the flat wire shape from MCP: { type, coords?, desc?, value? }.
function normalizeIndicator(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('indicator payload must be a non-array object.');
  }
  for (const k of Object.keys(payload)) {
    if (!['type', 'coords', 'desc', 'value'].includes(k)) {
      throw new Error(`Unknown field '${k}'. Use only type, coords, desc, value.`);
    }
  }

  const rawType = payload.type;
  if (typeof rawType !== 'string' || !INDICATOR_TYPES.includes(rawType)) {
    throw new Error(`type must be one of: ${INDICATOR_TYPES.join(', ')}.`);
  }
  const normalized = { type: rawType };

  if (payload.coords !== undefined && payload.coords !== null) {
    if (typeof payload.coords !== 'string') {
      throw new Error('coords must be a string "x,y,w,h" when provided.');
    }
    normalized.coords = parseCoordsString(payload.coords);
  }

  if (payload.desc !== undefined && payload.desc !== null) {
    if (typeof payload.desc !== 'string' || payload.desc.trim().length === 0) {
      throw new Error('desc must be a non-empty string when provided.');
    }
    normalized.desc = payload.desc;
  }

  if (payload.value !== undefined && payload.value !== null) {
    if (rawType === 'input') {
      const v = payload.value;
      if (typeof v !== 'object' || Array.isArray(v)) {
        throw new Error("type='input' requires value as an object { clip?, chords }.");
      }
      const keys = Object.keys(v);
      for (const k of keys) {
        if (k !== 'clip' && k !== 'chords') {
          throw new Error(`type='input' value: unknown key '${k}' (only clip, chords allowed).`);
        }
      }
      if (!isChordList(v.chords)) {
        throw new Error(
          "type='input' requires value.chords as a non-empty array of chord arrays (e.g. [['LeftControl','A'],['Backspace']])."
        );
      }
      if (v.clip !== undefined) {
        if (typeof v.clip !== 'string' || v.clip.length === 0) {
          throw new Error("type='input' value.clip must be a non-empty string when provided.");
        }
      }
      const out = { chords: v.chords.map((chord) => chord.slice()) };
      if (v.clip !== undefined) {
        out.clip = v.clip;
      }
      normalized.value = out;
    } else {
      throw new Error(`value is not allowed for type='${rawType}'.`);
    }
  }

  if (rawType === 'input' && (!normalized.value || !normalized.value.chords || normalized.value.chords.length === 0)) {
    throw new Error("type='input' requires value with non-empty chords.");
  }

  if (rawType === 'click') {
    if (!normalized.coords) {
      throw new Error(`type='${rawType}' requires coords.`);
    }
  }

  return normalized;
}

module.exports = { normalizeIndicator, parseCoordsString };

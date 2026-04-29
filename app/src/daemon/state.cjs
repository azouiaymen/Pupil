'use strict';

const { INDICATOR_TYPES } = require('../common/protocol.cjs');

// Validates and normalizes raw indicator payloads from MCP callers.
// Mirrors the previous Python normalize_indicator() so renderer behavior is unchanged.
function coerceInt(value, field) {
  if (typeof value === 'boolean' || typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${field} must be a number.`);
  }
  return Math.trunc(value);
}

function normalizeIndicator(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('indicator must be an object.');
  }
  const rawType = payload.type;
  if (typeof rawType !== 'string' || !INDICATOR_TYPES.includes(rawType)) {
    throw new Error(`type must be one of: ${INDICATOR_TYPES.join(', ')}.`);
  }
  const normalized = { type: rawType };

  if (payload.bounds !== undefined && payload.bounds !== null) {
    if (typeof payload.bounds !== 'object' || Array.isArray(payload.bounds)) {
      throw new Error('bounds must be an object when provided.');
    }
    const x = coerceInt(payload.bounds.x, 'bounds.x');
    const y = coerceInt(payload.bounds.y, 'bounds.y');
    const width = coerceInt(payload.bounds.width, 'bounds.width');
    const height = coerceInt(payload.bounds.height, 'bounds.height');
    if (width <= 0 || height <= 0) {
      throw new Error('bounds.width and bounds.height must be positive.');
    }
    normalized.bounds = { x, y, width, height };
  }
  if (payload.title !== undefined && payload.title !== null) {
    if (typeof payload.title !== 'string') throw new Error('title must be a string when provided.');
    normalized.title = payload.title;
  }
  if (payload.text !== undefined && payload.text !== null) {
    if (typeof payload.text !== 'string') throw new Error('text must be a string when provided.');
    normalized.text = payload.text;
  }
  const append = payload.append === undefined ? false : payload.append;
  if (typeof append !== 'boolean') throw new Error('append must be a boolean when provided.');
  normalized.append = append;

  const awaitFlag = payload.await === undefined ? false : payload.await;
  if (typeof awaitFlag !== 'boolean') throw new Error('await must be a boolean when provided.');
  normalized.await = awaitFlag;

  if (payload.id !== undefined && payload.id !== null) {
    if (typeof payload.id !== 'string' || payload.id.trim().length === 0) {
      throw new Error('id must be a non-empty string when provided.');
    }
    normalized.id = payload.id;
  }
  return normalized;
}

module.exports = { normalizeIndicator };

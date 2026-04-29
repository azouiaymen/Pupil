'use strict';

// Minimal newline-delimited JSON line splitter shared by the IPC client/server
// and the sidecar manager. Reusing one implementation avoids subtle differences
// in how partial chunks are buffered between transports.

function createLineParser(onLine, onError) {
  let buffer = '';
  return function feed(chunk) {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let newlineIdx = buffer.indexOf('\n');
    while (newlineIdx !== -1) {
      const rawLine = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);
      const trimmed = rawLine.trim();
      if (trimmed) {
        try {
          onLine(JSON.parse(trimmed));
        } catch (err) {
          if (typeof onError === 'function') {
            onError(err, trimmed);
          }
        }
      }
      newlineIdx = buffer.indexOf('\n');
    }
  };
}

function encodeLine(message) {
  // We always append the trailing newline ourselves so all consumers can rely
  // on a single, unambiguous frame boundary.
  return JSON.stringify(message) + '\n';
}

module.exports = {
  createLineParser,
  encodeLine,
};

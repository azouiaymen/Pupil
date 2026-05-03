'use strict';

// Thin wrapper around @nut-tree-fork/nut-js used by the daemon to perform
// real OS-level mouse clicks and keyboard input on behalf of "Accept" buttons
// for `click` and `input` indicators.
//
// nut-js is loaded lazily so that perceive/indicate paths still work even if
// the native binding fails to load (in that case Accept will reject with a
// helpful error and the renderer's spinner will surface as a renderer-side
// failure, but the rest of the daemon stays up).

const { clipboard } = require('electron');

const RECOVER_DELAY_MS = 50;
// Short pause after moving the cursor before issuing a click. Some controls
// only register hover/focus on the next frame, so an immediate leftClick can
// land before the target's hit-test is ready and silently miss.
const CLICK_POST_MOVE_MS = 50;
// nut-js `mouse.move(straightTo(...))`: mouseSpeed is px/s (2000 px / ~33 ms).
const MOUSE_SPEED_PX_PER_SEC = 60000;
// Pause between chord steps in pressShortcut so the target has time to
// observe the previous chord (e.g. selection state from Ctrl+A) before the
// next one fires.
const SHORTCUT_STEP_DELAY_MS = 50;

let nut = null;
let loadError = null;

function ensureNut() {
  if (nut) return nut;
  if (loadError) throw loadError;
  try {
    // Avoid the autoConfig/screen-reading bits by importing the lean entry.
    nut = require('@nut-tree-fork/nut-js');
    nut.mouse.config.autoDelayMs = 0;
    nut.mouse.config.mouseSpeed = MOUSE_SPEED_PX_PER_SEC;
    nut.keyboard.config.autoDelayMs = 4;
  } catch (err) {
    loadError = new Error(
      `Failed to load @nut-tree-fork/nut-js: ${err && err.message ? err.message : err}. ` +
        'Run pnpm install (and pnpm rebuild) under app/.'
    );
    throw loadError;
  }
  return nut;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function clickAt(x, y) {
  const n = ensureNut();
  // Move first so the click lands on the right pixel even when the cursor was
  // far away (avoids the trailing-cursor surprise some users see with leftClick alone).
  await n.mouse.move(n.straightTo(new n.Point(Math.round(x), Math.round(y))));
  await delay(CLICK_POST_MOVE_MS);
  await n.mouse.leftClick();
}

// Run a sequence of keyboard chord steps. `steps` is an array of chord arrays;
// each chord is an array of nut-js Key enum names. Modifiers come first; the
// trigger key is last. Press order matches the chord; release happens in
// reverse so modifiers are held while the trigger fires (standard chord
// pattern). Steps run sequentially with a small delay between them so combos
// like [['LeftControl','A'],['Backspace']] (select-all then delete) settle
// between each chord.
async function pressShortcut(steps) {
  const n = ensureNut();
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error('pressShortcut requires a non-empty list of chord steps.');
  }
  const Key = n.Key;
  if (!Key) {
    throw new Error('nut-js Key enum unavailable.');
  }
  const resolvedSteps = steps.map((chord, idx) => {
    if (!Array.isArray(chord) || chord.length === 0) {
      throw new Error(`pressShortcut step ${idx} must be a non-empty chord array.`);
    }
    return chord.map((name) => {
      const code = Key[name];
      if (code === undefined) {
        throw new Error(`Unknown nut-js Key: '${name}'.`);
      }
      return code;
    });
  });
  await delay(RECOVER_DELAY_MS);
  for (let s = 0; s < resolvedSteps.length; s += 1) {
    const chord = resolvedSteps[s];
    for (const code of chord) {
      await n.keyboard.pressKey(code);
    }
    for (let i = chord.length - 1; i >= 0; i -= 1) {
      await n.keyboard.releaseKey(chord[i]);
    }
    if (s < resolvedSteps.length - 1) {
      await delay(SHORTCUT_STEP_DELAY_MS);
    }
  }
}

// Optional `clip`: save plain-text clipboard, write `clip`, run `chords`, then
// restore prior text in `finally` so failures do not leak the payload.
async function runInput({ clip, chords }) {
  if (!Array.isArray(chords) || chords.length === 0) {
    throw new Error('runInput requires non-empty chords.');
  }
  let saved = '';
  let didWrite = false;
  try {
    if (typeof clip === 'string' && clip.length > 0) {
      try {
        saved = clipboard.readText();
      } catch (_e) {
        saved = '';
      }
      clipboard.writeText(clip);
      didWrite = true;
    }
    await pressShortcut(chords);
  } finally {
    if (didWrite) {
      try {
        clipboard.writeText(saved);
      } catch (_e) {
        /* ignore restore failure */
      }
    }
  }
}

module.exports = {
  clickAt,
  runInput,
  pressShortcut,
};

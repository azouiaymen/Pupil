'use strict';

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const { IpcClient } = require('../ipc/client.cjs');
const { spawnDaemon } = require('./launcher.cjs');
const { perceiveToCompactCsv, INDICATE_PERCEIVE_NAME_MAX_CHARS } = require('./postprocess.cjs');
const { daemonPipePath } = require('../common/paths.cjs');
const { INDICATOR_TYPES, AWAIT_RESOLUTION_TIMEOUT_MS } = require('../common/protocol.cjs');

// Stderr is the only safe channel; stdout belongs to the MCP transport.
const logger = {
  info: (...a) => process.stderr.write(`[shim] ${a.join(' ')}\n`),
  warn: (...a) => process.stderr.write(`[shim][warn] ${a.join(' ')}\n`),
  error: (...a) => process.stderr.write(`[shim][error] ${a.join(' ')}\n`),
};

let ipcClient = null;
let connecting = null;

// Eager connect: after tools are registered and before MCP stdio attaches, we
// connect to an existing daemon or spawn one. First tool calls then avoid
// cold-start latency (Electron + named pipe).
async function ensureDaemonConnection() {
  if (ipcClient) return ipcClient;
  if (connecting) return connecting;
  connecting = (async () => {
    const pipePath = daemonPipePath();
    const client = new IpcClient({ pipePath, logger });
    try {
      await client.connect({ retries: 4, retryDelayMs: 250 });
      logger.info('connected to existing daemon');
      ipcClient = client;
      return client;
    } catch (_e) {
      logger.info('daemon not running; spawning it');
      try {
        spawnDaemon({ logger });
      } catch (err) {
        throw new Error(`Could not start daemon: ${err.message}`);
      }
      const retryClient = new IpcClient({ pipePath, logger });
      await retryClient.connect();
      logger.info('connected to spawned daemon');
      ipcClient = retryClient;
      return retryClient;
    }
  })();
  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

async function callDaemon(method, params) {
  const client = await ensureDaemonConnection();
  if (method === 'indicate') {
    return client.call(method, params, { timeoutMs: AWAIT_RESOLUTION_TIMEOUT_MS });
  }
  return client.call(method, params);
}

const perceiveInputSchema = z.object({}).strict();

const indicateInputSchema = z
  .object({
    type: z.enum([...INDICATOR_TYPES]),
    coords: z.string().regex(/^-?\d+,-?\d+,\d+,\d+$/).optional(),
    desc: z.string().min(1).optional(),
    value: z.unknown().optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    const t = data.type;
    const isChordList = (v) =>
      Array.isArray(v) &&
      v.length > 0 &&
      v.every(
        (chord) =>
          Array.isArray(chord) &&
          chord.length > 0 &&
          chord.every((k) => typeof k === 'string' && k.trim().length > 0)
      );

    if (t === 'input') {
      if (data.value === undefined || data.value === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "type='input' requires value as { clip?, chords }.",
          path: ['value'],
        });
        return;
      }
      const v = data.value;
      if (typeof v !== 'object' || Array.isArray(v)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "type='input' requires value as an object { clip?, chords }.",
          path: ['value'],
        });
        return;
      }
      const keys = Object.keys(v);
      for (const k of keys) {
        if (k !== 'clip' && k !== 'chords') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `type='input' value: unknown key '${k}' (only clip, chords).`,
            path: ['value', k],
          });
          return;
        }
      }
      if (!isChordList(v.chords)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "type='input' requires value.chords as a non-empty array of chord arrays, e.g. [['LeftControl','A'],['Backspace']].",
          path: ['value', 'chords'],
        });
        return;
      }
      if (v.clip !== undefined && (typeof v.clip !== 'string' || v.clip.length === 0)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "type='input' value.clip must be a non-empty string when provided.",
          path: ['value', 'clip'],
        });
      }
    } else if (data.value !== undefined && data.value !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `value must not be set for type='${t}'.`,
        path: ['value'],
      });
    }
    if ((t === 'click' || t === 'input') && !data.coords) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `type='${t}' requires coords as \"x,y,w,h\".`,
        path: ['coords'],
      });
    }
  });

function jsonText(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
  };
}

async function main() {
  const server = new McpServer(
    { name: 'pupil-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  server.registerTool(
    'perceive',
    {
      description: [
          'Returns an untruncated compact CSV of visible UI elements (Pupil overlay excluded).',
          'Takes no arguments.',
          '',
          'At the start of any Pupil workflow, call this once to get the initial snapshot.',
          'After that, prefer the `perceive` string bundled in the previous `indicate` result JSON (`perceive` field) — you usually do not need a separate `perceive` call between steps.',
          'Call `perceive()` again only when you need a fresh read and you have no post-`indicate` snapshot to use, the UI may have changed outside the loop, you need full (untruncated) control names, or you only need a read without showing an `indicate` card.',
      ].join('\n'),
      inputSchema: perceiveInputSchema,
    },
    async () => {
      const result = await callDaemon('perceive', {});
      return {
        content: [{ type: 'text', text: perceiveToCompactCsv(result) }],
      };
    }
  );

  server.registerTool(
    'indicate',
    {
      description: [
        'Show a bounding box on coords with a tooltip card on the overlay to indicate the next step to the user (replaces any previous card).',
        '',
        'The tooltip includes buttons and blocks until resolved:',
        '- info|warning|wait|action|danger: Next (Tab)',
        '- click|input: Skip (Escape) and Accept (Tab)',
        '- Pressing Accept runs the OS action for click/input; pressing Next acknowledges informational cards.',
        '',
        'Parameters (flat object):',
        '- type (required): one of info|warning|wait|action|click|input|danger.',
        '- coords (format "x,y,w,h"): required for click and input; highly encouraged for almost all cards because highlighting the target helps the user understand exactly what is being referenced. Omit only for rare, general informational cards with no specific UI target.',
        '- desc (optional): extra context only when it adds information not obvious from the highlight; do not repeat a visible control label.',
        '- value (required only for input): { clip?: string, chords: string[][] }.',
        '  - chords: non-empty key-chord steps, executed in order; each inner array is one chord, with modifier keys first (nut-js key names, examples: LeftControl, RightControl, LeftAlt, LeftSuper, Enter, Escape, Tab, A..Z, F1..F12).',
        '  - clip: optional clipboard text set before chords and restored afterward.',
        '',
        'Type guide (purpose / interaction / priority):',
        '- click: performs one OS left-click at the exact center of coords (bbox midpoint); strongly prefer this when a target control is visible in perceive, and prefer it over equivalent keyboard shortcuts.',
        '- input: first performs the same center-click on coords to focus the target window/pane, then runs the provided keyboard sequence (value.chords, with optional value.clip flow).',
        '- wait: tell the user to wait before the next step happens; also use it as pacing/tempo when the latest returned perceive indicates loading, transitions, or unstable UI state before continuing.',
        '- action: ask the user to perform a manual interaction when click/input did not work reliably or the needed interaction is out of scope for these types (e.g., scrolling, drag-and-drop, right/middle click, complex gestures, or unsupported controls).',
        '- warning: indication card for elevated attention (caution/ambiguity).',
        '- danger: indication card for highest attention (high-risk/safety-critical).',
        '- info: indication card for normal attention (neutral guidance/progress/done summary).',
        '',
        'Priority rule:',
        '- Prefer click over input and over keyboard shortcuts when perceive (or prior indicate return) exposes a control that can do the same action.',
        '',
        'Returns:',
        '- JSON text { "result": "done" | "skipped", "perceive": "<compact CSV>" }.',
        '- perceive: post-resolution snapshot (~50ms), same shape as perceive() but with name truncated after ' +
          INDICATE_PERCEIVE_NAME_MAX_CHARS +
          ' chars.',
        '- result=skipped means only this card action did not run (not automatic global task cancel); use returned perceive to continue unless the user explicitly aborts.',
        '- Timeout: this call can time out (aligned to indicate wait timeout). Treat timeout as unresolved/needs recovery (re-check UI and retry or pick a safer next step), not as success.',
      ].join('\n'),
      inputSchema: indicateInputSchema,
    },
    async (args) => {
      const r = await callDaemon('indicate', args);
      const out = {
        result: r && typeof r.result === 'string' ? r.result : 'skipped',
        perceive: Array.isArray(r && r.perceive)
          ? perceiveToCompactCsv(r.perceive, { truncateNameAt: INDICATE_PERCEIVE_NAME_MAX_CHARS })
          : '',
      };
      return jsonText(out);
    }
  );

  await ensureDaemonConnection();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('mcp shim ready');
}

main().catch((err) => {
  logger.error('shim crashed:', err.stack || err.message);
  process.exit(1);
});

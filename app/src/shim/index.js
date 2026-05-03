'use strict';

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const { IpcClient } = require('../ipc/client.cjs');
const { spawnDaemon } = require('./launcher.cjs');
const { perceiveToCompactCsv, INDICATE_PERCEIVE_NAME_MAX_CHARS } = require('./postprocess.cjs');
const { daemonPipePath } = require('../common/paths.cjs');
const { INDICATOR_TYPES } = require('../common/protocol.cjs');

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
    if (t === 'click' && !data.coords) {
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
      description:
        'Capture visible UI elements as compact CSV. Takes no arguments; Pupil overlay is always excluded.',
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
        'Show one overlay card (replaces any previous). Call blocks until resolved: Tab (Next or Accept), Escape (Skip on click/input only), button clicks, or X.',
        'Shape (flat object, minify JSON in tool calls to save tokens):',
        '- type: one of info | warning | wait | action | click | input | danger.',
        '- coords: optional string "x,y,w,h" (integers, w and h positive). Required for click only; optional for input (recommended when targeting a specific control).',
        '- desc: optional extra context only when it adds information the highlight does not (do not repeat the control label).',
        '- value: required for input only: object { clip?: string, chords: string[][] }.',
        '  - chords: non-empty nut-js chord steps (modifiers first per chord; ~50ms between steps). Put every step for one intended outcome in one chords array (one indicate) — do not split a shortcut sequence across multiple indicate calls when one list of chord arrays suffices.',
        '  - clip: optional; when set, daemon saves clipboard text, writes clip, runs chords (often include Ctrl+V), restores prior text in finally.',
        'Prefer type click over input when perceive CSV lists a control (button, link, menu item, etc.) that achieves the same result as a keyboard shortcut; avoid input/chords for actions you can do with click on that target.',
        'Buttons: Next (Tab) for info/warning/wait/action/danger; Skip (Escape) + Accept (Tab) for click/input. Accept runs OS action where applicable.',
        'After Accept/Next the card shows a spinner until the next indicate clears it.',
        'Returns JSON { result, perceive }: result is "done" or "skipped"; perceive is compact CSV like the perceive tool (post-action snapshot, ~50ms after resolution), except the name column is truncated after ' +
          INDICATE_PERCEIVE_NAME_MAX_CHARS +
          ' characters with ... appended when longer — standalone perceive is not truncated. "skipped" means the user skipped that card\'s proposed OS action (Skip/Escape or dismiss without Accept) — not cancellation of the agent\'s overall task: read perceive, infer why (e.g. step already done, manual action, different path), then continue with the next indicate unless the user clearly aborts the whole task.',
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

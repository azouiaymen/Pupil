'use strict';

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const { IpcClient } = require('../ipc/client.cjs');
const { spawnDaemon } = require('./launcher.cjs');
const { perceiveToCompactCsv } = require('./postprocess.cjs');
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

const indicatorShape = {
  type: z.enum(INDICATOR_TYPES),
  bounds: z
    .object({
      x: z.number(),
      y: z.number(),
      width: z.number().positive(),
      height: z.number().positive(),
    })
    .optional(),
  title: z.string().optional(),
  text: z.string().optional(),
  append: z.boolean().optional(),
  await: z.boolean().optional(),
  // Used by type='type': literal text the daemon should send via SendInput
  // after focusing the bounding-box center.
  value: z.string().optional(),
  // Used by type='shortcut': a list of chord steps. Each chord is an array of
  // nut-js Key enum names pressed in order, released in reverse. Steps are
  // executed sequentially with a fixed ~50ms delay between them, so combos
  // like [["LeftControl","A"],["Backspace"]] (select-all then delete) run
  // atomically inside one Accept.
  keys: z.array(z.array(z.string().min(1)).min(1)).min(1).optional(),
  id: z.string().min(1).optional(),
};

const indicateInputSchema = z.object({
  indicator: z.object(indicatorShape),
});

const perceiveInputSchema = z.object({
  overlayHwnd: z.number().int().nonnegative().optional(),
  includeDiagnostics: z.boolean().optional(),
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
        "Capture visible UI elements and return parsed nodes. The runtime overlay handle is auto-injected to avoid perceiving Pupil's own overlay window.",
      inputSchema: perceiveInputSchema,
    },
    async (args) => {
      const result = await callDaemon('perceive', {
        overlayHwnd: args.overlayHwnd || 0,
        includeDiagnostics: args.includeDiagnostics === true,
      });
      return {
        content: [{ type: 'text', text: perceiveToCompactCsv(result) }],
      };
    }
  );

  server.registerTool(
    'indicate',
    {
      description: [
        'Render an overlay indicator with optional bounds and tooltip.',
        'Type semantics:',
        '- click: next required step is a mouse click on a specific target.',
        '- action: generic high-level action that is NOT an immediate click.',
        '- type: user/agent must type text. Provide it via the `value` field.',
        '- shortcut: press one or more keyboard chords in sequence. Provide `keys` as an array of chord steps; each chord is an array of nut-js Key names with modifiers first and the trigger last (e.g. [["LeftControl","A"],["Backspace"]] for select-all then delete). Steps run with a ~50ms delay between them.',
        '- wait: user/agent should wait for loading or async completion.',
        '- warning: risk, irreversible, or potentially destructive operation.',
        '- danger: severe / stop — destructive or safety-critical; highest urgency.',
        '- info: neutral guidance or context.',
        'Buttons (always shown, bottom-right of card):',
        '- info / warning / wait / action / danger: a single "Next" button (Tab key shortcut). Resolves "done"; performs no OS action.',
        '- click: "Skip" + "Accept". Accept performs an OS-level left click at the bounding-box center, then resolves "done". Skip resolves "skipped" without any input.',
        '- type: "Skip" + "Accept". Accept clicks the bounding-box center to focus the field, then types the `value` string, then resolves "done".',
        '- shortcut: "Skip" + "Accept". Accept clicks the bounding-box center (when bounds provided) to focus, then runs each chord step in `keys` in order (with a small delay between steps), then resolves "done". Without bounds, the chord sequence is sent to whatever is currently focused.',
        '- The X (close) button resolves "skipped" and removes the card.',
        'Lifecycle:',
        '- await defaults to true; the call blocks until the user resolves via the buttons or X.',
        '- After Next/Accept fires the resolution, the card stays visible with a loading spinner until the next indicate(append=false) (or hideAll) clears it.',
        '- append=false (default) replaces all current indicators; append=true adds without clearing.',
        '- value is required for type="type" Accept to write anything; it is ignored for other types.',
        '- keys (an array of chord arrays, e.g. [["LeftControl","L"]] or [["LeftControl","A"],["Backspace"]]) is required for type="shortcut" Accept; it is ignored for other types.',
      ].join('\n'),
      inputSchema: indicateInputSchema,
    },
    async (args) => {
      const result = await callDaemon('indicate', { indicator: args.indicator });
      return jsonText(result);
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

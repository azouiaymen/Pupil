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
        '- type: user/agent must type text.',
        '- wait: user/agent should wait for loading or async completion.',
        '- warning: risk, irreversible, or potentially destructive operation.',
        '- info: neutral guidance or context.',
        'Await behavior:',
        '- await=false (default): fire-and-forget; result is null.',
        '- await=true: blocking; tooltip exposes Skip/Done buttons; result is "done" or "skipped".',
        '- Closing the indicator (X) acts like Skip when await=true.',
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

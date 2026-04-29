'use strict';

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const { IpcClient } = require('../ipc/client.cjs');
const { spawnDaemon } = require('./launcher.cjs');
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

// Lazy connect: the MCP transport is established immediately, but the daemon
// is only started/contacted on first tool call. This keeps `pupil-mcp` fast to
// boot for clients that introspect tool lists without invoking them.
async function ensureDaemonConnection() {
  if (ipcClient) return ipcClient;
  if (connecting) return connecting;
  connecting = (async () => {
    const pipePath = daemonPipePath();
    const client = new IpcClient({ pipePath, logger });
    try {
      await client.connect({ retries: 4, retryDelayMs: 200 });
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

const indicateInputShape = {
  indicator: z.object(indicatorShape),
};

const perceiveInputShape = {
  overlayHwnd: z.number().int().nonnegative().optional(),
  includeDiagnostics: z.boolean().optional(),
};

function jsonText(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
  };
}

function csvEscape(value) {
  const text = String(value ?? '');
  if (text.includes('"') || text.includes(',') || text.includes('\n') || text.includes('\r')) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function rectFromNode(node) {
  const rect = node && typeof node === 'object' ? node.rect : null;
  const box = rect && typeof rect === 'object' ? rect : null;
  if (!box) return { x: 0, y: 0, w: 0, h: 0 };
  const rawW = box.w !== undefined ? box.w : box.width;
  const rawH = box.h !== undefined ? box.h : box.height;
  return {
    x: Math.round(Number(box.x) || 0),
    y: Math.round(Number(box.y) || 0),
    w: Math.round(Number(rawW) || 0),
    h: Math.round(Number(rawH) || 0),
  };
}

const TYPE_CODES = Object.freeze({
  TextControl: 'T',
  GroupControl: 'G',
  ButtonControl: 'B',
  PaneControl: 'P',
  MenuItemControl: 'M',
  EditControl: 'E',
  CheckBoxControl: 'K',
  ListItemControl: 'L',
  WindowControl: 'W',
});

const META_CODES = Object.freeze({
  enabled: 'e',
  disabled: 'd',
  focusable: 'f',
  'not-focusable': 'nf',
  focused: 'F',
  'not-focused': 'nF',
  selected: 's',
  unselected: 'u',
  checked: 'c',
  unchecked: 'uc',
  indeterminate: 'i',
  expanded: 'x',
  collapsed: 'cl',
  leaf: 'l',
  offscreen: 'os',
});

function splitNameAndMeta(rawName) {
  const text = String(rawName || '');
  if (!text.endsWith(')')) {
    return { label: text, meta: [] };
  }
  const idx = text.lastIndexOf(' (');
  if (idx <= 0) {
    return { label: text, meta: [] };
  }
  const label = text.slice(0, idx);
  const metaText = text.slice(idx + 2, -1);
  const meta = metaText
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return { label, meta };
}

function compressAriaProps(value) {
  const keyAlias = {
    readonly: 'ro',
    expanded: 'x',
    multiline: 'ml',
    haspopup: 'hp',
    invalid: 'iv',
    required: 'rq',
    selected: 's',
    checked: 'c',
  };
  const boolAlias = { true: '1', false: '0' };
  const parts = String(value || '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((kv) => {
      const [k, v = ''] = kv.split('=');
      const kk = keyAlias[k] || k.slice(0, 3);
      const vv = boolAlias[v] || v;
      return `${kk}:${vv}`;
    });
  return parts.join('.');
}

function compressMeta(metaList) {
  if (!Array.isArray(metaList) || metaList.length === 0) {
    return '';
  }
  const compact = [];
  for (const token of metaList) {
    if (META_CODES[token]) {
      compact.push(META_CODES[token]);
      continue;
    }
    if (token.startsWith('aria_role=')) {
      compact.push(`ar:${token.slice('aria_role='.length)}`);
      continue;
    }
    if (token.startsWith('aria_props=')) {
      compact.push(`ap:${compressAriaProps(token.slice('aria_props='.length))}`);
      continue;
    }
  }
  return compact.join('|');
}

function typeCode(rawType) {
  const type = String(rawType || '');
  return TYPE_CODES[type] || type;
}

function perceiveToCompactCsv(nodes) {
  const lines = [
    '# T=TextControl G=GroupControl B=ButtonControl P=PaneControl M=MenuItemControl E=EditControl K=CheckBoxControl L=ListItemControl W=WindowControl',
    '# meta: e=enabled d=disabled f=focusable nf=not-focusable F=focused nF=not-focused s=selected u=unselected c=checked uc=unchecked i=indeterminate x=expanded cl=collapsed l=leaf os=offscreen ar=aria_role ap=aria_props',
    'id,type,name,x,y,w,h',
  ];
  const list = Array.isArray(nodes) ? nodes : [];
  for (let i = 0; i < list.length; i += 1) {
    const node = list[i] || {};
    const type = typeCode(node.type || node.role || '');
    const { label, meta } = splitNameAndMeta(node.name || node.text || node.label || '');
    const encodedMeta = compressMeta(meta);
    const name = encodedMeta ? `${label} [${encodedMeta}]` : label;
    const { x, y, w, h } = rectFromNode(node);
    lines.push([i, csvEscape(type), csvEscape(name), x, y, w, h].join(','));
  }
  return lines.join('\n');
}

async function main() {
  const server = new McpServer(
    { name: 'pupil-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  server.tool(
    'perceive',
    'Capture visible UI elements and return parsed nodes. The runtime overlay handle is auto-injected to avoid perceiving Pupil\'s own overlay window.',
    perceiveInputShape,
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

  server.tool(
    'indicate',
    [
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
    indicateInputShape,
    async (args) => {
      const result = await callDaemon('indicate', { indicator: args.indicator });
      return jsonText(result);
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('mcp shim ready');
}

main().catch((err) => {
  logger.error('shim crashed:', err.stack || err.message);
  process.exit(1);
});

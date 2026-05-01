'use strict';

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

module.exports = {
  perceiveToCompactCsv,
};

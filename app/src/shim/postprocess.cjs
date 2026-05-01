'use strict';

function escapeControlCharsForCsv(text) {
  return String(text).replace(/[\u0000-\u001F\u007F]/g, (ch) => {
    switch (ch) {
      case '\t':
        return '\\t';
      case '\n':
        return '\\n';
      case '\r':
        return '\\r';
      default: {
        const c = ch.charCodeAt(0);
        return `\\u${c.toString(16).padStart(4, '0')}`;
      }
    }
  });
}

function csvEscape(value) {
  const text = escapeControlCharsForCsv(value ?? '');
  if (text.includes('"') || text.includes(',')) {
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

/** BMP Private Use Area + supplementary PUAs (Unicode Standard). */
function isPrivateUseCodePoint(cp) {
  if (cp >= 0xe000 && cp <= 0xf8ff) {
    return true;
  }
  if (cp >= 0xf0000 && cp <= 0xffffd) {
    return true;
  }
  if (cp >= 0x100000 && cp <= 0x10fffd) {
    return true;
  }
  return false;
}

function stringUsesPrivateUseArea(text) {
  for (const ch of String(text || '')) {
    const cp = ch.codePointAt(0);
    if (isPrivateUseCodePoint(cp)) {
      return true;
    }
  }
  return false;
}

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

/**
 * Compact meta: omit “normal” states; always keep check state (c/uc) when present.
 * Ignored: indeterminate, leaf; aria_role / aria_props tokens.
 */
function compressMeta(metaList) {
  if (!Array.isArray(metaList) || metaList.length === 0) {
    return '';
  }
  let disabled = false;
  let focusable = false;
  let focused = false;
  let selected = false;
  /** @type {'c'|'uc'|null} */
  let check = null;
  let expanded = false;
  let offscreen = false;

  for (const token of metaList) {
    if (!token || typeof token !== 'string') {
      continue;
    }
    if (token.startsWith('aria_role=') || token.startsWith('aria_props=')) {
      continue;
    }
    switch (token) {
      case 'disabled':
        disabled = true;
        break;
      case 'focusable':
        focusable = true;
        break;
      case 'focused':
        focused = true;
        break;
      case 'selected':
        selected = true;
        break;
      case 'checked':
        check = 'c';
        break;
      case 'unchecked':
        check = 'uc';
        break;
      case 'expanded':
        expanded = true;
        break;
      case 'offscreen':
        offscreen = true;
        break;
      default:
        break;
    }
  }

  const parts = [];
  if (disabled) parts.push('d');
  if (focusable) parts.push('f');
  if (focused) parts.push('F');
  if (selected) parts.push('s');
  if (check) parts.push(check);
  if (expanded) parts.push('x');
  if (offscreen) parts.push('os');
  return parts.join('|');
}

function typeCode(rawType) {
  const type = String(rawType || '');
  return TYPE_CODES[type] || type;
}

function perceiveToCompactCsv(nodes) {
  const lines = [
    '# T=TextControl G=GroupControl B=ButtonControl P=PaneControl M=MenuItemControl E=EditControl K=CheckBoxControl L=ListItemControl W=WindowControl',
    '# meta: omit enabled, not-focusable, not-focused, unselected, collapsed, indeterminate. Always c|uc when check state appears. d=disabled f=focusable F=focused s=selected c=checked uc=unchecked x=expanded os=offscreen',
    'id,type,name,x,y,w,h',
  ];
  const list = Array.isArray(nodes) ? nodes : [];
  let rowId = 0;
  for (let i = 0; i < list.length; i += 1) {
    const node = list[i] || {};
    const rawName = String(node.name || node.text || node.label || '');
    const { label, meta } = splitNameAndMeta(rawName);
    const probe = label.trim().length > 0 ? label : rawName;
    if (stringUsesPrivateUseArea(probe)) {
      continue;
    }
    const type = typeCode(node.type || node.role || '');
    const encodedMeta = compressMeta(meta);
    const name = encodedMeta ? `${label} [${encodedMeta}]` : label;
    const { x, y, w, h } = rectFromNode(node);
    lines.push([rowId, csvEscape(type), csvEscape(name), x, y, w, h].join(','));
    rowId += 1;
  }
  return lines.join('\n');
}

module.exports = {
  perceiveToCompactCsv,
};

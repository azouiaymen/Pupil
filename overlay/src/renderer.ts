/**
 * This file will automatically be loaded by webpack and run in the "renderer" context.
 * To learn more about the differences between the "main" and the "renderer" context in
 * Electron, visit:
 *
 * https://electronjs.org/docs/latest/tutorial/process-model
 *
 * By default, Node.js integration in this file is disabled. When enabling Node.js integration
 * in a renderer process, please be aware of potential security implications. You can read
 * more about security risks here:
 *
 * https://electronjs.org/docs/tutorial/security
 *
 * To enable Node.js integration in this file, open up `main.js` and enable the `nodeIntegration`
 * flag:
 *
 * ```
 *  // Create the browser window.
 *  mainWindow = new BrowserWindow({
 *    width: 800,
 *    height: 600,
 *    webPreferences: {
 *      nodeIntegration: true
 *    }
 *  });
 * ```
 */

import './index.css';

type IndicatorType = 'info' | 'warning' | 'wait' | 'action' | 'click' | 'type';
type IndicatorBounds = { x: number; y: number; width: number; height: number };
type Indicator = {
  type: IndicatorType;
  bounds?: IndicatorBounds;
  title?: string;
  text?: string;
};

type CommandEnvelope = {
  protocolVersion: number;
  command: 'indicate' | 'hideAll' | 'ping';
  payload: Record<string, unknown>;
};

type EventEnvelope = {
  protocolVersion: number;
  event: 'ready' | 'error' | 'interaction';
  payload: Record<string, unknown>;
};

declare global {
  interface Window {
    overlayApi: {
      onCommand: (handler: (message: CommandEnvelope) => void) => () => void;
      sendEvent: (message: EventEnvelope) => void;
    };
  }
}

const PROTOCOL_VERSION = 1;
const overlayRoot = document.getElementById('overlay-root');

if (!overlayRoot) {
  throw new Error('Missing #overlay-root element in renderer.');
}

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const toIndicatorTypeClass = (type: IndicatorType): string => `indicator-${type}`;

const render = (indicators: Indicator[]): void => {
  overlayRoot.innerHTML = '';
  for (const indicator of indicators) {
    const card = document.createElement('section');
    card.className = `indicator-card ${toIndicatorTypeClass(indicator.type)}`;

    if (indicator.bounds) {
      const bbox = document.createElement('div');
      bbox.className = `indicator-bbox ${toIndicatorTypeClass(indicator.type)}`;
      bbox.style.left = `${indicator.bounds.x}px`;
      bbox.style.top = `${indicator.bounds.y}px`;
      bbox.style.width = `${indicator.bounds.width}px`;
      bbox.style.height = `${indicator.bounds.height}px`;
      overlayRoot.appendChild(bbox);

      const preferredTop = indicator.bounds.y - 124;
      const fallbackTop = indicator.bounds.y + indicator.bounds.height + 12;
      const maxLeft = window.innerWidth - 340;
      const maxTop = window.innerHeight - 140;

      card.style.left = `${Math.max(12, Math.min(indicator.bounds.x, maxLeft))}px`;
      card.style.top = `${Math.max(12, Math.min(preferredTop > 12 ? preferredTop : fallbackTop, maxTop))}px`;
    } else {
      card.style.left = '24px';
      card.style.top = '24px';
    }

    if (indicator.title) {
      const title = document.createElement('h3');
      title.className = 'indicator-title';
      title.innerHTML = escapeHtml(indicator.title);
      card.appendChild(title);
    }
    if (indicator.text) {
      const text = document.createElement('p');
      text.className = 'indicator-text';
      text.innerHTML = escapeHtml(indicator.text);
      card.appendChild(text);
    }
    overlayRoot.appendChild(card);
  }
};

const indicators: Indicator[] = [];
render(indicators);

window.overlayApi.onCommand((message: CommandEnvelope) => {
  try {
    if (message.protocolVersion !== PROTOCOL_VERSION) {
      window.overlayApi.sendEvent({
        protocolVersion: PROTOCOL_VERSION,
        event: 'error',
        payload: { reason: 'protocol_mismatch', received: message.protocolVersion },
      });
      return;
    }

    if (message.command === 'hideAll') {
      indicators.length = 0;
      render(indicators);
      return;
    }

    if (message.command === 'ping') {
      window.overlayApi.sendEvent({
        protocolVersion: PROTOCOL_VERSION,
        event: 'interaction',
        payload: { type: 'pong' },
      });
      return;
    }

    if (message.command === 'indicate') {
      const indicator = (message.payload?.indicator ?? null) as Indicator | null;
      if (!indicator || typeof indicator.type !== 'string') {
        throw new Error('Missing indicator payload.');
      }
      indicators.push(indicator);
      render(indicators);
      return;
    }
  } catch (error) {
    window.overlayApi.sendEvent({
      protocolVersion: PROTOCOL_VERSION,
      event: 'error',
      payload: {
        reason: 'renderer_command_failed',
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
});

window.overlayApi.sendEvent({
  protocolVersion: PROTOCOL_VERSION,
  event: 'ready',
  payload: {},
});

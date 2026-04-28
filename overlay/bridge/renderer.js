const PROTOCOL_VERSION = 1;
const overlayRoot = document.getElementById('overlay-root');
const indicators = [];

function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function typeClass(type) {
  return `indicator-${type}`;
}

function render() {
  overlayRoot.innerHTML = '';
  for (const indicator of indicators) {
    const card = document.createElement('section');
    card.className = `indicator-card ${typeClass(indicator.type)}`;

    if (indicator.bounds) {
      const bbox = document.createElement('div');
      bbox.className = `indicator-bbox ${typeClass(indicator.type)}`;
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
}

window.overlayApi.onCommand((message) => {
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
      render();
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
      const indicator = message.payload && message.payload.indicator;
      if (!indicator || typeof indicator.type !== 'string') {
        throw new Error('Missing indicator payload.');
      }
      indicators.push(indicator);
      render();
      return;
    }
  } catch (error) {
    window.overlayApi.sendEvent({
      protocolVersion: PROTOCOL_VERSION,
      event: 'error',
      payload: { reason: 'renderer_command_failed', message: String(error) },
    });
  }
});

window.overlayApi.sendEvent({
  protocolVersion: PROTOCOL_VERSION,
  event: 'ready',
  payload: {},
});

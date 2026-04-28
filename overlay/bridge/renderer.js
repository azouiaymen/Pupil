const PROTOCOL_VERSION = 2;
const overlayRoot = document.getElementById('overlay-root');
const indicators = [];
let indicatorSequence = 0;
let interactiveState = false;
const BOUNDS_PADDING_PX = 4;
const CARD_GAP_PX = 24;
const TOOLTIP_ESTIMATED_HEIGHT_PX = 132;

const TYPE_META = {
  info: { icon: 'Info' },
  warning: { icon: 'TriangleAlert' },
  wait: { icon: 'Hourglass' },
  action: { icon: 'Sparkles' },
  click: { icon: 'MousePointerClick' }, // lucide: mouse-pointer-click
  type: { icon: 'TextCursor' },
};

function typeClass(type) {
  return `indicator-${type}`;
}

function createIcon(iconName) {
  const icon = document.createElement('span');
  icon.className = 'indicator-icon';
  const lucide = window.lucide;
  const iconNode = lucide && lucide.icons ? lucide.icons[iconName] : null;
  if (iconNode && lucide && typeof lucide.createElement === 'function') {
    const svg = lucide.createElement(iconNode, { width: 18, height: 18, 'stroke-width': 2 });
    icon.appendChild(svg);
    return icon;
  }
  icon.textContent = '•';
  return icon;
}

function closeIndicator(indicatorId) {
  const index = indicators.findIndex((item) => item._id === indicatorId);
  if (index === -1) {
    return;
  }
  const [removed] = indicators.splice(index, 1);
  render();
  const isAwaiting = Boolean(removed && removed.await);
  window.overlayApi.sendEvent({
    protocolVersion: PROTOCOL_VERSION,
    event: 'interaction',
    payload: {
      type: isAwaiting ? 'indicator_resolved' : 'indicator_closed',
      indicatorId: indicatorId,
      result: isAwaiting ? 'skipped' : undefined,
      indicatorType: removed ? removed.type : undefined,
    },
  });
}

function resolveIndicator(indicatorId, result) {
  const index = indicators.findIndex((item) => item._id === indicatorId);
  if (index === -1) {
    return;
  }
  indicators.splice(index, 1);
  render();
  window.overlayApi.sendEvent({
    protocolVersion: PROTOCOL_VERSION,
    event: 'interaction',
    payload: {
      type: 'indicator_resolved',
      indicatorId,
      result,
    },
  });
}

function syncInteractivity(nextState) {
  const active = Boolean(nextState);
  if (interactiveState === active) {
    return;
  }
  interactiveState = active;
  window.overlayApi.setInteractive(active);
}

function shouldBeInteractive(target) {
  return Boolean(target && target.closest && target.closest('.indicator-card'));
}

function applyCardPosition(card, indicator, preferredTopBase, fallbackTopBase, leftBase) {
  const maxLeft = window.innerWidth - 340;
  const maxTop = window.innerHeight - 140;
  const left = indicator._position ? indicator._position.left : leftBase;
  const top = indicator._position
    ? indicator._position.top
    : preferredTopBase > 12
      ? preferredTopBase
      : fallbackTopBase;
  card.style.left = `${Math.max(12, Math.min(left, maxLeft))}px`;
  card.style.top = `${Math.max(12, Math.min(top, maxTop))}px`;
}

function createConnector(indicator, card) {
  if (!indicator.bounds) {
    return null;
  }
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', `indicator-connector ${typeClass(indicator.type)}`);
  svg.setAttribute('width', `${window.innerWidth}`);
  svg.setAttribute('height', `${window.innerHeight}`);
  svg.setAttribute('viewBox', `0 0 ${window.innerWidth} ${window.innerHeight}`);

  const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  polyline.setAttribute('points', '0,0 0,0 0,0 0,0');
  polyline.setAttribute('class', 'indicator-connector-line');

  const startCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  startCircle.setAttribute('cx', '0');
  startCircle.setAttribute('cy', '0');
  startCircle.setAttribute('r', '4');
  startCircle.setAttribute('class', 'indicator-connector-dot');

  const endCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  endCircle.setAttribute('cx', '0');
  endCircle.setAttribute('cy', '0');
  endCircle.setAttribute('r', '4');
  endCircle.setAttribute('class', 'indicator-connector-dot');

  svg.appendChild(polyline);
  svg.appendChild(startCircle);
  svg.appendChild(endCircle);
  updateConnector(svg, indicator, card);
  return svg;
}

function updateConnector(connector, indicator, card) {
  if (!connector || !indicator.bounds) {
    return;
  }
  const cardLeft = Number.parseFloat(card.style.left || '0');
  const cardTop = Number.parseFloat(card.style.top || '0');
  const cardWidth = card.offsetWidth || 320;
  const cardHeight = card.offsetHeight || TOOLTIP_ESTIMATED_HEIGHT_PX;
  const cardRight = cardLeft + cardWidth;
  const cardBottom = cardTop + cardHeight;

  const targetCenterX = indicator.bounds.x + indicator.bounds.width / 2;
  const targetTopY = indicator.bounds.y - BOUNDS_PADDING_PX;
  const targetBottomY = indicator.bounds.y + indicator.bounds.height + BOUNDS_PADDING_PX;
  const cardIsAboveTarget = cardBottom <= indicator.bounds.y;

  const startX = targetCenterX;
  const startY = cardIsAboveTarget ? targetTopY : targetBottomY;
  const endX = Math.max(cardLeft + 16, Math.min(targetCenterX, cardRight - 16));
  const endY = cardIsAboveTarget ? cardBottom : cardTop;
  const midY = Math.round((startY + endY) / 2);

  connector.setAttribute('width', `${window.innerWidth}`);
  connector.setAttribute('height', `${window.innerHeight}`);
  connector.setAttribute('viewBox', `0 0 ${window.innerWidth} ${window.innerHeight}`);
  const line = connector.querySelector('.indicator-connector-line');
  const dots = connector.querySelectorAll('.indicator-connector-dot');
  if (line) {
    line.setAttribute('points', `${startX},${startY} ${startX},${midY} ${endX},${midY} ${endX},${endY}`);
  }
  if (dots.length >= 2) {
    dots[0].setAttribute('cx', `${startX}`);
    dots[0].setAttribute('cy', `${startY}`);
    dots[1].setAttribute('cx', `${endX}`);
    dots[1].setAttribute('cy', `${endY}`);
  }
}

function bindCardDrag(card, closeButton, indicator, connector) {
  let dragging = false;
  let offsetX = 0;
  let offsetY = 0;

  const onMouseMove = (event) => {
    if (!dragging) {
      return;
    }
    const nextLeft = event.clientX - offsetX;
    const nextTop = event.clientY - offsetY;
    indicator._position = { left: nextLeft, top: nextTop };
    applyCardPosition(card, indicator, nextTop, nextTop, nextLeft);
    updateConnector(connector, indicator, card);
  };

  const onMouseUp = (event) => {
    if (!dragging) {
      return;
    }
    dragging = false;
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
    syncInteractivity(shouldBeInteractive(event.target));
  };

  card.addEventListener('mousedown', (event) => {
    if (
      event.button !== 0 ||
      event.target === closeButton ||
      closeButton.contains(event.target) ||
      event.target.closest('.indicator-action-btn')
    ) {
      return;
    }
    dragging = true;
    syncInteractivity(true);
    const rect = card.getBoundingClientRect();
    offsetX = event.clientX - rect.left;
    offsetY = event.clientY - rect.top;
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    event.preventDefault();
  });
}

function render() {
  overlayRoot.innerHTML = '';
  for (const indicator of indicators) {
    const card = document.createElement('section');
    card.className = `indicator-card ${typeClass(indicator.type)}`;
    card.dataset.id = indicator._id;
    const meta = TYPE_META[indicator.type] || TYPE_META.info;

    if (indicator.bounds) {
      const bbox = document.createElement('div');
      bbox.className = `indicator-bbox ${typeClass(indicator.type)}`;
      bbox.style.left = `${indicator.bounds.x - BOUNDS_PADDING_PX}px`;
      bbox.style.top = `${indicator.bounds.y - BOUNDS_PADDING_PX}px`;
      bbox.style.width = `${indicator.bounds.width + BOUNDS_PADDING_PX * 2}px`;
      bbox.style.height = `${indicator.bounds.height + BOUNDS_PADDING_PX * 2}px`;
      overlayRoot.appendChild(bbox);

      const preferredTop = indicator.bounds.y - (TOOLTIP_ESTIMATED_HEIGHT_PX + CARD_GAP_PX);
      const fallbackTop = indicator.bounds.y + indicator.bounds.height + CARD_GAP_PX;
      applyCardPosition(card, indicator, preferredTop, fallbackTop, indicator.bounds.x);
    } else {
      applyCardPosition(card, indicator, 24, 24, 24);
    }

    const header = document.createElement('header');
    header.className = 'indicator-header';

    const titleWrap = document.createElement('div');
    titleWrap.className = 'indicator-title-wrap';
    titleWrap.appendChild(createIcon(meta.icon));

    if (indicator.title || indicator.text) {
      const title = document.createElement('h3');
      title.className = 'indicator-title';
      title.textContent = indicator.title || indicator.type;
      titleWrap.appendChild(title);
    }

    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'indicator-close';
    closeButton.setAttribute('aria-label', 'Close indicator');
    closeButton.textContent = '×';
    closeButton.addEventListener('click', () => closeIndicator(indicator._id));

    header.appendChild(titleWrap);
    header.appendChild(closeButton);
    card.appendChild(header);
    const connector = createConnector(indicator, card);
    bindCardDrag(card, closeButton, indicator, connector);

    if (indicator.text) {
      const text = document.createElement('p');
      text.className = 'indicator-text';
      text.textContent = indicator.text;
      card.appendChild(text);
    }

    if (indicator.await) {
      const actions = document.createElement('div');
      actions.className = 'indicator-actions';

      const skipButton = document.createElement('button');
      skipButton.type = 'button';
      skipButton.className = 'indicator-action-btn indicator-action-btn-skip';
      skipButton.textContent = 'Skip';
      skipButton.addEventListener('click', () => resolveIndicator(indicator._id, 'skipped'));

      const doneButton = document.createElement('button');
      doneButton.type = 'button';
      doneButton.className = 'indicator-action-btn indicator-action-btn-done';
      doneButton.textContent = 'Done';
      doneButton.addEventListener('click', () => resolveIndicator(indicator._id, 'done'));

      actions.appendChild(skipButton);
      actions.appendChild(doneButton);
      card.appendChild(actions);
    }
    overlayRoot.appendChild(card);
    if (connector) {
      connector.dataset.id = indicator._id;
      overlayRoot.appendChild(connector);
    }
  }
  // Re-evaluate interactivity after DOM updates (e.g. closed the last card).
  syncInteractivity(false);
}

window.overlayApi.onCommand((message) => {
  const requestId = typeof message.requestId === 'string' ? message.requestId : undefined;
  try {
    if (message.protocolVersion !== PROTOCOL_VERSION) {
      window.overlayApi.sendEvent({
        protocolVersion: PROTOCOL_VERSION,
        requestId,
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
      indicators.push({ ...indicator, _id: indicator.id || `indicator-${indicatorSequence++}` });
      render();
      return;
    }
  } catch (error) {
    window.overlayApi.sendEvent({
      protocolVersion: PROTOCOL_VERSION,
      requestId,
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

window.addEventListener('mousemove', (event) => {
  syncInteractivity(shouldBeInteractive(event.target));
});

window.addEventListener('mouseleave', () => {
  syncInteractivity(false);
});

window.addEventListener('resize', () => {
  for (const indicator of indicators) {
    if (!indicator.bounds) {
      continue;
    }
    const card = overlayRoot.querySelector(`.indicator-card[data-id="${indicator._id}"]`);
    const connector = overlayRoot.querySelector(`.indicator-connector[data-id="${indicator._id}"]`);
    if (card && connector) {
      updateConnector(connector, indicator, card);
    }
  }
});

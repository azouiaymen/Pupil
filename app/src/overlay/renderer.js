const PROTOCOL_VERSION = 5;
const overlayRoot = document.getElementById('overlay-root');
const indicators = [];
let indicatorSequence = 0;
let interactiveState = false;
// Shared geometry constants used by both card placement and connector routing.
const BOUNDS_PADDING_PX = 4;
const CARD_GAP_PX = 24;
const TOOLTIP_ESTIMATED_HEIGHT_PX = 132;
const CARD_WIDTH_PX = 320;
const VIEWPORT_MARGIN_PX = 12;

const TYPE_META = {
  info: { icon: 'Info' },
  warning: { icon: 'TriangleAlert' },
  wait: { icon: 'Hourglass' },
  action: { icon: 'Sparkles' },
  click: { icon: 'MousePointerClick' }, // lucide: mouse-pointer-click
  type: { icon: 'TextCursor' },
  shortcut: { icon: 'Keyboard' },
  danger: { icon: 'Skull' },
};

// Action buttons rendered per indicator type. Types that map to an OS-level
// effect (click/type) get a Skip + Accept pair; everything else gets a single
// Next button. Accept variants carry a non-null `action` so the daemon knows
// what input automation to perform; Next is a pure resolution.
const BUTTON_LAYOUTS = {
  click: [
    { kind: 'skip', label: 'Skip', result: 'skipped', action: null, keepVisible: false },
    { kind: 'accept', label: 'Accept', result: 'done', action: 'click', keepVisible: true },
  ],
  type: [
    { kind: 'skip', label: 'Skip', result: 'skipped', action: null, keepVisible: false },
    { kind: 'accept', label: 'Accept', result: 'done', action: 'type', keepVisible: true },
  ],
  shortcut: [
    { kind: 'skip', label: 'Skip', result: 'skipped', action: null, keepVisible: false },
    { kind: 'accept', label: 'Accept', result: 'done', action: 'shortcut', keepVisible: true },
  ],
  info: [{ kind: 'next', label: 'Next', result: 'done', action: null, keepVisible: true }],
  warning: [{ kind: 'next', label: 'Next', result: 'done', action: null, keepVisible: true }],
  wait: [{ kind: 'next', label: 'Next', result: 'done', action: null, keepVisible: true }],
  action: [{ kind: 'next', label: 'Next', result: 'done', action: null, keepVisible: true }],
  danger: [{ kind: 'next', label: 'Next', result: 'done', action: null, keepVisible: true }],
};

function buttonsFor(type) {
  return BUTTON_LAYOUTS[type] || BUTTON_LAYOUTS.info;
}

function primaryButtonFor(type) {
  // The button bound to Tab: Accept where present, otherwise Next.
  const layout = buttonsFor(type);
  return layout.find((btn) => btn.kind === 'accept') || layout.find((btn) => btn.kind === 'next');
}

function typeClass(type) {
  // CSS type classes intentionally mirror indicator type values from the protocol.
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

function topMostUnresolved() {
  // Last-rendered indicator is the visually topmost; Tab targets that one.
  for (let i = indicators.length - 1; i >= 0; i -= 1) {
    if (!indicators[i]._resolved) return indicators[i];
  }
  return null;
}

function measureBboxScreenCenter(indicatorId) {
  const el = overlayRoot.querySelector(`.indicator-bbox[data-indicator-id="${indicatorId}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return {
    x: r.left + r.width / 2 + window.screenX,
    y: r.top + r.height / 2 + window.screenY,
  };
}

function sendResolutionEvent(indicator, { result, action, keepVisible, clickPoint }) {
  const payload = {
    type: 'indicator_resolved',
    indicatorId: indicator._id,
    indicatorType: indicator.type,
    result,
    action: action || null,
    keepVisible: Boolean(keepVisible),
  };
  if (clickPoint && typeof clickPoint.x === 'number' && typeof clickPoint.y === 'number') {
    payload.clickPoint = { x: clickPoint.x, y: clickPoint.y };
  }
  window.overlayApi.sendEvent({
    protocolVersion: PROTOCOL_VERSION,
    event: 'interaction',
    payload,
  });
}

function fireResolution(indicator, button) {
  // Single source of truth for "user pressed Skip / Next / Accept (or Tab)".
  // - keepVisible=true: the card stays as an in-flight spinner; the next
  //   indicate(append=false) clears it. Used for Next and Accept.
  // - keepVisible=false: splice now and re-render. Used for Skip.
  if (!indicator || indicator._resolved) return;
  indicator._resolved = true;
  indicator._resolvedKind = button.kind;
  if (!button.keepVisible) {
    const idx = indicators.indexOf(indicator);
    if (idx !== -1) indicators.splice(idx, 1);
    render();
  } else {
    // Update just this card's controls in place so the click/type doesn't race
    // with a full DOM teardown that could pull focus away.
    updateActionRowFor(indicator);
  }
  let clickPoint = null;
  if (
    (button.action === 'click' || button.action === 'type' || button.action === 'shortcut') &&
    indicator.bounds
  ) {
    clickPoint = measureBboxScreenCenter(indicator._id);
  }
  sendResolutionEvent(indicator, {
    result: button.result,
    action: button.action,
    keepVisible: button.keepVisible,
    clickPoint,
  });
}

function closeIndicator(indicator) {
  // The X button always sends a 'skipped' resolution if the indicator hasn't
  // been resolved yet, then visually removes the card. After Next/Accept has
  // already fired, the X is purely visual (no second event).
  if (!indicator) return;
  const idx = indicators.indexOf(indicator);
  if (idx === -1) return;
  const wasResolved = Boolean(indicator._resolved);
  indicators.splice(idx, 1);
  render();
  if (!wasResolved) {
    sendResolutionEvent(indicator, { result: 'skipped', action: null, keepVisible: false });
  }
}

function syncInteractivity(nextState) {
  // Avoid redundant IPC traffic by only sending transitions.
  const active = Boolean(nextState);
  if (interactiveState === active) {
    return;
  }
  interactiveState = active;
  window.overlayApi.setInteractive(active);
}

function shouldBeInteractive(target) {
  // Overlay should be clickable only when cursor is over a rendered indicator card.
  return Boolean(target && target.closest && target.closest('.indicator-card'));
}

function clampCardLeft(left) {
  const maxLeft = Math.max(
    VIEWPORT_MARGIN_PX,
    window.innerWidth - CARD_WIDTH_PX - VIEWPORT_MARGIN_PX
  );
  return Math.max(VIEWPORT_MARGIN_PX, Math.min(left, maxLeft));
}

function clampCardTop(top) {
  const maxTop = Math.max(
    VIEWPORT_MARGIN_PX,
    window.innerHeight - TOOLTIP_ESTIMATED_HEIGHT_PX - VIEWPORT_MARGIN_PX
  );
  return Math.max(VIEWPORT_MARGIN_PX, Math.min(top, maxTop));
}

function rectOverlapArea(a, b) {
  const w = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const h = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  return w * h;
}

function computeCardLeftTop(bounds) {
  // Pick the first side (below, above, right, left) whose clamped card rect
  // does not overlap the padded bbox; fall back to the smallest-overlap side
  // so cards never spawn directly on top of the highlight, which would steal
  // OS clicks meant for the underlying control.
  const padLeft = bounds.x - BOUNDS_PADDING_PX;
  const padTop = bounds.y - BOUNDS_PADDING_PX;
  const padRight = bounds.x + bounds.width + BOUNDS_PADDING_PX;
  const padBottom = bounds.y + bounds.height + BOUNDS_PADDING_PX;
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;

  const candidates = [
    { left: centerX - CARD_WIDTH_PX / 2, top: padBottom + CARD_GAP_PX },
    { left: centerX - CARD_WIDTH_PX / 2, top: padTop - CARD_GAP_PX - TOOLTIP_ESTIMATED_HEIGHT_PX },
    { left: padRight + CARD_GAP_PX, top: centerY - TOOLTIP_ESTIMATED_HEIGHT_PX / 2 },
    { left: padLeft - CARD_GAP_PX - CARD_WIDTH_PX, top: centerY - TOOLTIP_ESTIMATED_HEIGHT_PX / 2 },
  ];

  const avoid = { left: padLeft, top: padTop, right: padRight, bottom: padBottom };

  let bestPos = null;
  let bestOverlap = Infinity;
  for (const cand of candidates) {
    const left = clampCardLeft(cand.left);
    const top = clampCardTop(cand.top);
    const rect = {
      left,
      top,
      right: left + CARD_WIDTH_PX,
      bottom: top + TOOLTIP_ESTIMATED_HEIGHT_PX,
    };
    const overlap = rectOverlapArea(rect, avoid);
    if (overlap === 0) {
      return { left, top };
    }
    if (overlap < bestOverlap) {
      bestOverlap = overlap;
      bestPos = { left, top };
    }
  }
  return bestPos;
}

function applyCardPosition(card, indicator, base) {
  // _position (set by drag) wins over the auto-computed base so user moves stick.
  const left = indicator._position ? indicator._position.left : base.left;
  const top = indicator._position ? indicator._position.top : base.top;
  card.style.left = `${clampCardLeft(left)}px`;
  card.style.top = `${clampCardTop(top)}px`;
}

function createConnector(indicator, card) {
  // Connectors visually tie floating cards to the highlighted target bounds.
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

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

/** First horizontal leg must not run back through the padded bbox toward the card. */
function horizontalConnectorFeasible(cardLeftOfCenter, cardLeft, cardRight, targetLeftX, targetRightX) {
  if (cardLeftOfCenter) {
    return cardRight <= targetLeftX;
  }
  return cardLeft >= targetRightX;
}

/** First vertical leg must not run back through the padded bbox toward the card. */
function verticalConnectorFeasible(cardAboveCenter, cardTop, cardBottom, targetTopY, targetBottomY) {
  if (cardAboveCenter) {
    return cardBottom <= targetTopY;
  }
  return cardTop >= targetBottomY;
}

function verticalConnectorPenalty(cardAboveCenter, cardTop, cardBottom, targetTopY, targetBottomY) {
  if (cardAboveCenter) {
    return Math.max(0, cardBottom - targetTopY);
  }
  return Math.max(0, targetBottomY - cardTop);
}

function horizontalConnectorPenalty(cardLeftOfCenter, cardLeft, cardRight, targetLeftX, targetRightX) {
  if (cardLeftOfCenter) {
    return Math.max(0, cardRight - targetLeftX);
  }
  return Math.max(0, targetRightX - cardLeft);
}

function buildVerticalConnector(
  inset,
  targetCenterX,
  targetCenterY,
  targetTopY,
  targetBottomY,
  cardLeft,
  cardRight,
  cardTop,
  cardBottom,
  cardCenterY,
) {
  const cardAboveCenter = cardCenterY < targetCenterY;
  const startX = targetCenterX;
  const startY = cardAboveCenter ? targetTopY : targetBottomY;
  const endX = clamp(targetCenterX, cardLeft + inset, cardRight - inset);
  const endY = cardAboveCenter ? cardBottom : cardTop;
  const midY = Math.round((startY + endY) / 2);
  const points = `${startX},${startY} ${startX},${midY} ${endX},${midY} ${endX},${endY}`;
  return { startX, startY, endX, endY, points, cardAboveCenter };
}

function buildHorizontalConnector(
  inset,
  targetCenterX,
  targetCenterY,
  targetLeftX,
  targetRightX,
  cardLeft,
  cardRight,
  cardTop,
  cardBottom,
  cardCenterX,
) {
  const cardLeftOfCenter = cardCenterX < targetCenterX;
  const startX = cardLeftOfCenter ? targetLeftX : targetRightX;
  const startY = targetCenterY;
  const endY = clamp(targetCenterY, cardTop + inset, cardBottom - inset);
  const endX = cardLeftOfCenter ? cardRight : cardLeft;
  const midX = Math.round((startX + endX) / 2);
  const points = `${startX},${startY} ${midX},${startY} ${midX},${endY} ${endX},${endY}`;
  return { startX, startY, endX, endY, points, cardLeftOfCenter };
}

function updateConnector(connector, indicator, card) {
  // Connector path is recomputed from live card geometry (drag + resize aware).
  if (!connector || !indicator.bounds) {
    return;
  }
  const inset = 16;
  const cardLeft = Number.parseFloat(card.style.left || '0');
  const cardTop = Number.parseFloat(card.style.top || '0');
  const cardWidth = card.offsetWidth || 320;
  const cardHeight = card.offsetHeight || TOOLTIP_ESTIMATED_HEIGHT_PX;
  const cardRight = cardLeft + cardWidth;
  const cardBottom = cardTop + cardHeight;
  const cardCenterX = cardLeft + cardWidth / 2;
  const cardCenterY = cardTop + cardHeight / 2;

  const b = indicator.bounds;
  const targetCenterX = b.x + b.width / 2;
  const targetCenterY = b.y + b.height / 2;
  const targetLeftX = b.x - BOUNDS_PADDING_PX;
  const targetRightX = b.x + b.width + BOUNDS_PADDING_PX;
  const targetTopY = b.y - BOUNDS_PADDING_PX;
  // Bottom anchor sits on the outer edge of the padded frame (1px outward fixes dot sitting visually inside).
  const targetBottomY = b.y + b.height + BOUNDS_PADDING_PX + 1;

  const vx = cardCenterX - targetCenterX;
  const vy = cardCenterY - targetCenterY;
  const preferVertical = Math.abs(vy) >= Math.abs(vx);

  const vertical = buildVerticalConnector(
    inset,
    targetCenterX,
    targetCenterY,
    targetTopY,
    targetBottomY,
    cardLeft,
    cardRight,
    cardTop,
    cardBottom,
    cardCenterY,
  );
  const horizontal = buildHorizontalConnector(
    inset,
    targetCenterX,
    targetCenterY,
    targetLeftX,
    targetRightX,
    cardLeft,
    cardRight,
    cardTop,
    cardBottom,
    cardCenterX,
  );

  const vertOk = verticalConnectorFeasible(
    vertical.cardAboveCenter,
    cardTop,
    cardBottom,
    targetTopY,
    targetBottomY,
  );
  const horizOk = horizontalConnectorFeasible(
    horizontal.cardLeftOfCenter,
    cardLeft,
    cardRight,
    targetLeftX,
    targetRightX,
  );

  let chosen;
  if (preferVertical) {
    if (vertOk) {
      chosen = vertical;
    } else if (horizOk) {
      chosen = horizontal;
    } else {
      // Both legs would re-enter the bbox; pick the smaller backward penetration (tie → vertical).
      const vPen = verticalConnectorPenalty(
        vertical.cardAboveCenter,
        cardTop,
        cardBottom,
        targetTopY,
        targetBottomY,
      );
      const hPen = horizontalConnectorPenalty(
        horizontal.cardLeftOfCenter,
        cardLeft,
        cardRight,
        targetLeftX,
        targetRightX,
      );
      chosen = hPen < vPen ? horizontal : vertical;
    }
  } else if (horizOk) {
    chosen = horizontal;
  } else if (vertOk) {
    chosen = vertical;
  } else {
    const vPen = verticalConnectorPenalty(
      vertical.cardAboveCenter,
      cardTop,
      cardBottom,
      targetTopY,
      targetBottomY,
    );
    const hPen = horizontalConnectorPenalty(
      horizontal.cardLeftOfCenter,
      cardLeft,
      cardRight,
      targetLeftX,
      targetRightX,
    );
    chosen = hPen < vPen ? horizontal : vertical;
  }

  const { startX, startY, endX, endY, points } = chosen;

  connector.setAttribute('width', `${window.innerWidth}`);
  connector.setAttribute('height', `${window.innerHeight}`);
  connector.setAttribute('viewBox', `0 0 ${window.innerWidth} ${window.innerHeight}`);
  const line = connector.querySelector('.indicator-connector-line');
  const dots = connector.querySelectorAll('.indicator-connector-dot');
  if (line) {
    line.setAttribute('points', points);
  }
  if (dots.length >= 2) {
    dots[0].setAttribute('cx', `${startX}`);
    dots[0].setAttribute('cy', `${startY}`);
    dots[1].setAttribute('cx', `${endX}`);
    dots[1].setAttribute('cy', `${endY}`);
  }
}

function bindCardDrag(card, closeButton, indicator, connector) {
  // Dragging is disabled on action controls to avoid conflicting click semantics.
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

function createKbdGlyph() {
  // Inline ⇥ keycap; replaced by a CSS spinner once the button fires.
  const kbd = document.createElement('kbd');
  kbd.className = 'indicator-kbd';
  kbd.textContent = '⇥';
  kbd.setAttribute('aria-hidden', 'true');
  return kbd;
}

function createSpinner() {
  const spinner = document.createElement('span');
  spinner.className = 'indicator-spinner';
  spinner.setAttribute('role', 'progressbar');
  spinner.setAttribute('aria-label', 'Action in progress');
  return spinner;
}

function buildActionRow(indicator) {
  // Always rendered; layout depends on indicator.type. After resolution the row
  // shows a spinner in place of the Tab keycap for the fired button and disables
  // siblings so the user cannot double-trigger the daemon.
  const actions = document.createElement('div');
  actions.className = 'indicator-actions';
  const layout = buttonsFor(indicator.type);
  for (const button of layout) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = `indicator-action-btn indicator-action-btn-${button.kind}`;
    el.dataset.kind = button.kind;
    const labelSpan = document.createElement('span');
    labelSpan.className = 'indicator-action-label';
    labelSpan.textContent = button.label;
    el.appendChild(labelSpan);
    if (button.kind !== 'skip') {
      el.appendChild(createKbdGlyph());
    }
    el.addEventListener('click', () => fireResolution(indicator, button));
    actions.appendChild(el);
  }
  applyResolvedState(actions, indicator);
  return actions;
}

function applyResolvedState(actions, indicator) {
  if (!indicator._resolved) return;
  for (const btn of actions.querySelectorAll('.indicator-action-btn')) {
    btn.disabled = true;
    if (btn.dataset.kind === indicator._resolvedKind) {
      btn.classList.add('is-pending');
      const kbd = btn.querySelector('.indicator-kbd');
      if (kbd) kbd.replaceWith(createSpinner());
    }
  }
}

function updateActionRowFor(indicator) {
  // Surgical update for the in-flight transition: keep DOM stable so a click
  // action that's about to be performed by the daemon doesn't get torn down.
  const card = overlayRoot.querySelector(`.indicator-card[data-id="${indicator._id}"]`);
  if (!card) return;
  const actions = card.querySelector('.indicator-actions');
  if (!actions) return;
  applyResolvedState(actions, indicator);
}

function render() {
  // Full rerender keeps state transitions simple; indicators list is source of truth.
  overlayRoot.innerHTML = '';
  for (const indicator of indicators) {
    const card = document.createElement('section');
    card.className = `indicator-card ${typeClass(indicator.type)}`;
    card.dataset.id = indicator._id;
    const meta = TYPE_META[indicator.type] || TYPE_META.info;

    if (indicator.bounds) {
      const bbox = document.createElement('div');
      bbox.className = `indicator-bbox ${typeClass(indicator.type)}`;
      bbox.dataset.indicatorId = indicator._id;
      bbox.style.left = `${indicator.bounds.x - BOUNDS_PADDING_PX}px`;
      bbox.style.top = `${indicator.bounds.y - BOUNDS_PADDING_PX}px`;
      bbox.style.width = `${indicator.bounds.width + BOUNDS_PADDING_PX * 2}px`;
      bbox.style.height = `${indicator.bounds.height + BOUNDS_PADDING_PX * 2}px`;
      overlayRoot.appendChild(bbox);

      applyCardPosition(card, indicator, computeCardLeftTop(indicator.bounds));
    } else {
      applyCardPosition(card, indicator, { left: 24, top: 24 });
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
    closeButton.addEventListener('click', () => closeIndicator(indicator));

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

    const actions = buildActionRow(indicator);
    card.appendChild(actions);

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
    // Protocol guardrail: reject commands from mismatched runtime versions.
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
      // Ping/pong keeps liveness visible to the heartbeat watchdog upstream.
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
    // Command failures are surfaced with requestId so runtime can map the error.
    window.overlayApi.sendEvent({
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      event: 'error',
      payload: { reason: 'renderer_command_failed', message: String(error) },
    });
  }
});

window.overlayApi.sendEvent({
  // Handshake event signals renderer availability to flush queued commands.
  protocolVersion: PROTOCOL_VERSION,
  event: 'ready',
  payload: {},
});

window.addEventListener('keydown', (event) => {
  // Tab acts as a global keyboard shortcut for the topmost unresolved
  // indicator's primary action (Accept where available, otherwise Next).
  // Suppress the browser's default focus-traversal so Tab is fully consumed
  // by Pupil while indicators are up.
  if (event.key !== 'Tab') return;
  const target = topMostUnresolved();
  if (!target) return;
  event.preventDefault();
  event.stopPropagation();
  const button = primaryButtonFor(target.type);
  if (button) {
    fireResolution(target, button);
  }
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

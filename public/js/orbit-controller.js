const TAU = Math.PI * 2;

function wrapDelta(value) {
  if (value > Math.PI) return value - TAU;
  if (value < -Math.PI) return value + TAU;
  return value;
}

/**
 * Reusable elliptical orbit interaction. The caller owns the visuals; this
 * controller owns layout, idle turning, drag/inertia, pause, and click safety.
 */
export function createOrbitController({
  stage,
  surface,
  items,
  center,
  radius,
  reducedMotion = false,
  idlePeriodMs = 240000,
  dragThresholdPx = 8,
  onFrame = () => {},
}) {
  let rotation = 0;
  let velocity = 0;
  let raf = 0;
  let previousFrame = 0;
  let dragging = false;
  let pointerId = null;
  let previousAngle = 0;
  let previousPointerTime = 0;
  let travelPx = 0;
  let previousClientX = 0;
  let previousClientY = 0;
  let suppressNextClick = false;
  let inView = true;
  let destroyed = false;

  const layout = () => {
    for (const item of items) {
      const angle = item.angle + rotation;
      // CSS transform can stay on a compositor layer. Updating SVG's transform
      // attribute invalidates paint for the large shared SVG on mobile browsers.
      item.element.style.transform = `translate(${(Math.cos(angle) * radius.x).toFixed(2)}px,${(Math.sin(angle) * radius.y).toFixed(2)}px)`;
    }
  };

  const toAngle = (event) => {
    const point = surface.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const local = point.matrixTransform(surface.getScreenCTM().inverse());
    return Math.atan2((local.y - center.y) / radius.y, (local.x - center.x) / radius.x);
  };

  const stop = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    previousFrame = 0;
  };

  const tick = (timestamp) => {
    const dt = previousFrame ? Math.min((timestamp - previousFrame) / 1000, 0.05) : 0;
    previousFrame = timestamp;
    if (!dragging) {
      velocity *= Math.pow(0.04, dt);
      rotation += (TAU / (idlePeriodMs / 1000)) * dt + velocity * dt;
    }
    layout();
    onFrame(timestamp);
    raf = requestAnimationFrame(tick);
  };

  const start = () => {
    if (!destroyed && !raf && !reducedMotion && !document.hidden && inView) {
      raf = requestAnimationFrame(tick);
    }
  };

  const onPointerDown = (event) => {
    if (event.isPrimary === false || (event.button !== undefined && event.button !== 0)) return;
    dragging = true;
    pointerId = event.pointerId;
    previousAngle = toAngle(event);
    previousPointerTime = event.timeStamp;
    previousClientX = event.clientX;
    previousClientY = event.clientY;
    travelPx = 0;
    velocity = 0;
    surface.setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = (event) => {
    if (!dragging || (pointerId !== null && event.pointerId !== pointerId)) return;
    const angle = toAngle(event);
    const delta = wrapDelta(angle - previousAngle);
    const elapsed = Math.max((event.timeStamp - previousPointerTime) / 1000, 1 / 120);
    rotation += delta;
    velocity = delta / elapsed;
    travelPx += Math.hypot(event.clientX - previousClientX, event.clientY - previousClientY);
    previousAngle = angle;
    previousPointerTime = event.timeStamp;
    previousClientX = event.clientX;
    previousClientY = event.clientY;
    layout();
  };

  const finishPointer = (event) => {
    if (!dragging || (pointerId !== null && event.pointerId !== undefined && event.pointerId !== pointerId)) return;
    dragging = false;
    pointerId = null;
    suppressNextClick = travelPx >= dragThresholdPx;
  };

  const onClick = (event) => {
    if (!suppressNextClick) return;
    suppressNextClick = false;
    event.preventDefault();
    event.stopPropagation();
  };

  const onVisibility = () => (document.hidden ? stop() : start());
  const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver((entries) => {
    inView = entries.some((entry) => entry.isIntersecting);
    if (inView) start(); else stop();
  }, { threshold: 0.01 }) : null;

  surface.addEventListener('pointerdown', onPointerDown);
  surface.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', finishPointer);
  window.addEventListener('pointercancel', finishPointer);
  surface.addEventListener('click', onClick, true);
  document.addEventListener('visibilitychange', onVisibility);
  observer?.observe(stage);
  layout();
  start();

  return {
    layout,
    stop,
    start,
    destroy() {
      destroyed = true;
      stop();
      observer?.disconnect();
      surface.removeEventListener('pointerdown', onPointerDown);
      surface.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', finishPointer);
      window.removeEventListener('pointercancel', finishPointer);
      surface.removeEventListener('click', onClick, true);
      document.removeEventListener('visibilitychange', onVisibility);
    },
  };
}

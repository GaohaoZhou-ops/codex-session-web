const MIN_WIDTH = 220;

export function setupSidebarResize({ sidebar, handle, storage, onResize }) {
  const saved = Number(storage.get('sidebar-width'));
  let preferred = Number.isFinite(saved) && saved >= MIN_WIDTH ? saved : null;
  let drag = null;
  const desktop = window.matchMedia('(min-width: 721px)');
  const defaultWidth = () => window.innerWidth <= 900 ? 220 : window.innerWidth <= 1180 ? 246 : 280;
  const maximumWidth = () => {
    const available = handle.parentElement.clientWidth;
    // Leave room for the reader and its toolbar, even on a smaller display.
    return Math.max(MIN_WIDTH, Math.min(Math.floor(available * 0.6), available - 480 - handle.offsetWidth));
  };

  function applyWidth(width) {
    const maximum = maximumWidth();
    const value = Math.round(Math.max(MIN_WIDTH, Math.min(maximum, width)));
    document.documentElement.style.setProperty('--sidebar-width', `${value}px`);
    handle.setAttribute('aria-valuemin', String(MIN_WIDTH));
    handle.setAttribute('aria-valuemax', String(maximum));
    handle.setAttribute('aria-valuenow', String(value));
    handle.setAttribute('aria-valuetext', `${value} 像素`);
    onResize();
    return value;
  }

  function restoreWidth() {
    // Narrow screens keep the existing drawer. A temporary viewport change
    // must not overwrite the user's preferred desktop width.
    if (desktop.matches) applyWidth(preferred ?? defaultWidth());
  }

  function rememberWidth(width) {
    preferred = width;
    storage.set('sidebar-width', String(width));
  }

  function finishDrag(event) {
    if (!drag || event?.pointerId !== undefined && event.pointerId !== drag.pointerId) return;
    const { pointerId, width } = drag;
    drag = null;
    document.body.classList.remove('is-resizing-sidebar');
    if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
    rememberWidth(width);
  }

  handle.addEventListener('pointerdown', (event) => {
    if (!desktop.matches || event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    const width = sidebar.getBoundingClientRect().width;
    drag = { pointerId: event.pointerId, startX: event.clientX, startWidth: width, width };
    handle.setPointerCapture(event.pointerId);
    handle.focus({ preventScroll: true });
    document.body.classList.add('is-resizing-sidebar');
  });
  handle.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag.width = applyWidth(drag.startWidth + event.clientX - drag.startX);
  });
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) handle.addEventListener(event, finishDrag);
  window.addEventListener('blur', finishDrag);

  handle.addEventListener('keydown', (event) => {
    if (!desktop.matches || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const width = event.key === 'Home' ? MIN_WIDTH : event.key === 'End' ? maximumWidth()
      : sidebar.getBoundingClientRect().width + (event.key === 'ArrowLeft' ? -16 : 16);
    rememberWidth(applyWidth(width));
  });
  handle.addEventListener('dblclick', () => {
    preferred = null;
    storage.remove('sidebar-width');
    restoreWidth();
  });
  window.addEventListener('resize', () => {
    finishDrag();
    restoreWidth();
  });
  restoreWidth();
}

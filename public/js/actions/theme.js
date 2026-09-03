const THEME_ORDER = ['light', 'island', 'starry', 'dark'];

export function nextTheme(current) {
  const safe = THEME_ORDER.includes(current) ? current : 'dark';
  return THEME_ORDER[(THEME_ORDER.indexOf(safe) + 1) % THEME_ORDER.length];
}

export async function cycleTheme({
  state,
  api,
  cacheBootstrap,
  applyTheme,
  render,
  reportError,
  documentRef = globalThis.document,
  requestFrame = globalThis.requestAnimationFrame,
}) {
  const theme = nextTheme(state.settings.theme);
  try {
    state.settings = await api('/api/settings', {
      method: 'POST',
      body: { ...state.settings, theme },
    });
    cacheBootstrap();
    applyTheme();
    render();
    requestFrame(() => {
      const glyph = documentRef.querySelector('.theme-cycle-glyph');
      if (!glyph) return;
      glyph.classList.add('theme-switching');
      glyph.addEventListener('animationend', () => glyph.classList.remove('theme-switching'), { once: true });
    });
  } catch (err) {
    reportError(err);
  }
}

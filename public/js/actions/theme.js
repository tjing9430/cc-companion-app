export function nextTheme(current, order = []) {
  const sequence = Array.isArray(order) ? order.filter(Boolean) : [];
  if (!sequence.length) return current;
  const fallback = sequence.includes('dark') ? 'dark' : sequence[0];
  const safe = sequence.includes(current) ? current : fallback;
  return sequence[(sequence.indexOf(safe) + 1) % sequence.length];
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
  const theme = nextTheme(state.settings.theme, state.themeCycle);
  if (theme === state.settings.theme) return;
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

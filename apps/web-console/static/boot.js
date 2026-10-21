/* global location, document, localStorage, matchMedia */
// Runs synchronously in <head>, before first paint. An external file instead of inline scripts so
// the Content-Security-Policy needs no 'unsafe-inline' for scripts.
(() => {
  // Signed-in users skip the landing page. The hint cookie is not httpOnly; forging it only
  // leads to a 401 from the API. Crawlers have no cookie and get the prerendered page.
  try {
    if (location.pathname === '/' && /(?:^|;\s*)winnowl_authed=1(?:;|$)/.test(document.cookie)) {
      location.replace('/dashboard');
      return;
    }
  } catch {
    /* cookie unreadable: show the landing page */
  }
  // Set the `.dark` class before first paint; a saved choice overrides the system preference.
  try {
    const saved = localStorage.getItem('winnowl_theme');
    const dark = saved ? saved === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.classList.toggle('dark', dark);
  } catch {
    /* localStorage throws in private mode: keep the default */
  }
})();

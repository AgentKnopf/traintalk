// Loaded synchronously in <head>, before the stylesheet paints, so a
// dark-mode user never sees a white flash. Kept as a separate file rather
// than inline because the server sends a strict `script-src 'self'` CSP.
(function () {
  var t;
  try { t = sessionStorage.getItem('traintalk-theme'); } catch (e) { /* storage blocked */ }
  if (t !== 'light' && t !== 'dark') {
    t = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  document.documentElement.dataset.theme = t;
})();

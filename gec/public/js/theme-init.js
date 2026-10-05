// Applies the saved light/dark choice before the page paints (no flash). "system" follows the device.
(function () {
  try { var t = localStorage.getItem('gec_theme'); if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t); } catch (e) { /* storage blocked */ }
}());

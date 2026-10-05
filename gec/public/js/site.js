// Public site: mobile menu, cookie consent, first-party analytics beacons (only with consent).
(function () {
  'use strict';
  var doc = document;
  var GEC = window.GEC || {};

  // ---- Mobile navigation drawer
  var toggle = doc.querySelector('[data-nav-toggle]');
  var nav = doc.querySelector('[data-main-nav]');
  if (toggle && nav) {
    toggle.addEventListener('click', function () {
      var open = nav.classList.toggle('open');
      toggle.setAttribute('aria-expanded', String(open));
      doc.body.classList.toggle('nav-open', open);
    });
    doc.addEventListener('keydown', function (e) { if (e.key === 'Escape' && nav.classList.contains('open')) { nav.classList.remove('open'); doc.body.classList.remove('nav-open'); toggle.setAttribute('aria-expanded', 'false'); toggle.focus(); } });
  }

  // ---- Cookie consent: "necessary" (no analytics cookie) or "all". Stored as a first-party cookie for 6 months.
  function consent() { var m = doc.cookie.match(/(?:^|; )gec_consent=([^;]+)/); return m ? m[1] : null; }
  var bar = doc.querySelector('[data-cookie-bar]');
  if (bar && !consent()) bar.hidden = false;
  doc.addEventListener('click', function (e) {
    var b = e.target.closest('[data-consent]');
    if (b) {
      var v = b.getAttribute('data-consent');
      doc.cookie = 'gec_consent=' + v + ';path=/;max-age=' + (182 * 86400) + ';samesite=lax' + (location.protocol === 'https:' ? ';secure' : '');
      if (bar) bar.hidden = true;
      if (v === 'all') GEC.track && GEC.track('consent_granted');
      fetch('/t/consent', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': GEC.csrf || '' }, body: JSON.stringify({ consent: v }), credentials: 'same-origin', keepalive: true }).catch(function () {});
    }
    if (e.target.closest('[data-cookie-settings]') && bar) { bar.hidden = false; var first = bar.querySelector('button'); if (first) first.focus(); }
  });
  GEC.consent = consent;
}());

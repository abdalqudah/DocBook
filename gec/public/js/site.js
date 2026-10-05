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

// Multi-step forms: <form data-stepper> with <fieldset data-step="n">. Without JS every step shows at once.
(function () {
  'use strict';
  document.querySelectorAll('form[data-stepper]').forEach(function (form) {
    var steps = Array.prototype.slice.call(form.querySelectorAll('[data-step]'));
    var bars = form.querySelectorAll('[data-stepper-bar] span');
    var cur = Math.max(0, Math.min(steps.length - 1, Number(form.getAttribute('data-start') || 1) - 1));
    function show(i, focus) {
      cur = i;
      steps.forEach(function (s, k) { s.hidden = k !== i; });
      bars.forEach(function (b, k) { b.classList.toggle('on', k <= i); });
      if (focus) { var f = steps[i].querySelector('input:not([type=hidden]):not(.sr-only input), select, textarea'); if (f) f.focus(); }
    }
    function valid(step) {
      var ok = true;
      step.querySelectorAll('input, select, textarea').forEach(function (el) { if (ok && el.willValidate && !el.checkValidity()) { el.reportValidity(); ok = false; } });
      if (ok && step.getAttribute('data-step') === '1') {
        var email = form.elements.email; var phone = form.elements.phone;
        if (email && phone && !email.value.trim() && !phone.value.trim()) { email.setCustomValidity(form.getAttribute('data-need-contact') || 'Enter an email or a phone number.'); email.reportValidity(); email.setCustomValidity(''); ok = false; }
      }
      return ok;
    }
    form.addEventListener('click', function (e) {
      if (e.target.closest('[data-next]')) { e.preventDefault(); if (valid(steps[cur])) show(Math.min(steps.length - 1, cur + 1), true); }
      if (e.target.closest('[data-prev]')) { e.preventDefault(); show(Math.max(0, cur - 1), true); }
    });
    form.querySelectorAll('[data-fill="landing"]').forEach(function (i) { i.value = location.pathname + location.search; });
    form.querySelectorAll('[data-fill="referrer"]').forEach(function (i) { i.value = document.referrer && document.referrer.indexOf(location.host) < 0 ? document.referrer : ''; });
    show(cur, false);
  });
}());

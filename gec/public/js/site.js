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

// Search suggestions for <input data-suggest> (programs, universities, destinations, fields).
(function () {
  'use strict';
  var GEC = window.GEC;
  document.querySelectorAll('input[data-suggest]').forEach(function (input) {
    var box = document.createElement('div');
    box.className = 'suggest'; box.hidden = true; box.setAttribute('role', 'listbox'); box.id = 'suggest-' + Math.random().toString(36).slice(2, 7);
    input.setAttribute('aria-controls', box.id); input.setAttribute('aria-autocomplete', 'list'); input.setAttribute('autocomplete', 'off');
    input.parentElement.parentElement.appendChild(box);
    var timer; var items = []; var sel = -1; var seq = 0;
    function render() {
      box.innerHTML = items.map(function (it, i) { return '<a role="option" id="' + box.id + '-' + i + '" href="' + GEC.esc(it.href) + '" aria-selected="' + (i === sel) + '">' + GEC.icon(it.icon || 'search') + '<span class="grow"><span style="display:block">' + GEC.esc(it.title) + '</span>' + (it.sub ? '<span class="small subtle">' + GEC.esc(it.sub) + '</span>' : '') + '</span></a>'; }).join('');
      box.hidden = !items.length;
      input.setAttribute('aria-expanded', String(!box.hidden));
    }
    input.addEventListener('input', function () {
      clearTimeout(timer);
      var q = input.value.trim();
      if (q.length < 2) { items = []; render(); return; }
      timer = setTimeout(function () {
        var mine = ++seq;
        fetch('/api/suggest?q=' + encodeURIComponent(q), { headers: { Accept: 'application/json' } }).then(function (r) { return r.json(); }).then(function (j) { if (mine !== seq) return; items = j.items || []; sel = -1; render(); }).catch(function () {});
      }, 150);
    });
    input.addEventListener('keydown', function (e) {
      if (box.hidden) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); render(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(-1, sel - 1); render(); }
      if (e.key === 'Enter' && sel >= 0 && items[sel]) { e.preventDefault(); location.href = items[sel].href; }
      if (e.key === 'Escape') { items = []; render(); }
    });
    document.addEventListener('click', function (e) { if (!box.contains(e.target) && e.target !== input) { box.hidden = true; } });
  });
}());

// First-party event beacon (only after "Accept all"; the server also checks consent and Global Privacy Control).
(function () {
  'use strict';
  var GEC = window.GEC = window.GEC || {};
  GEC.track = function (name) {
    if (!GEC.consent || GEC.consent() !== 'all') return;
    try {
      fetch('/t/e', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': GEC.csrf || document.body.getAttribute('data-csrf') || '' }, body: JSON.stringify({ name: name, path: location.pathname }), credentials: 'same-origin', keepalive: true }).catch(function () {});
    } catch (e) { /* ignore */ }
  };
  document.addEventListener('click', function (e) {
    var a = e.target.closest('a, button'); if (!a) return;
    var name = a.getAttribute('data-track');
    var href = a.getAttribute('href') || '';
    if (/^\/go\//.test(href)) return; // counted on the server
    if (!name) {
      if (/^tel:/.test(href)) name = 'phone_click';
      else if (/^mailto:/.test(href)) name = 'email_click';
      else if (/wa\.me|whatsapp/.test(href)) name = 'whatsapp_click';
      else if (/^\/book/.test(href)) name = 'book_click';
      else if (/^https?:/.test(href) && href.indexOf(location.host) < 0) name = 'outbound';
    }
    if (name) GEC.track(name);
  });
}());

// Home hero slider: autoplay (paused on hover, focus, hidden tab or by the button), dots, arrows, swipe, keyboard.
(function () {
  var root = document.querySelector('[data-slider]');
  if (!root) return;
  document.body.classList.add('has-hero');
  var slides = Array.prototype.slice.call(root.querySelectorAll('[data-slide]'));
  var dots = Array.prototype.slice.call(root.querySelectorAll('[data-go]'));
  var pauseBtn = root.querySelector('[data-pause]');
  var MS = 6500; var idx = 0; var timer = null; var userPaused = false; var hover = false;
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  root.style.setProperty('--slide-ms', MS + 'ms');
  function show(n) {
    idx = (n + slides.length) % slides.length;
    slides.forEach(function (s, i) {
      var on = i === idx; s.classList.toggle('is-active', on);
      if (on) s.removeAttribute('aria-hidden'); else s.setAttribute('aria-hidden', 'true');
      s.querySelectorAll('a').forEach(function (a) { if (on) a.removeAttribute('tabindex'); else a.setAttribute('tabindex', '-1'); });
    });
    dots.forEach(function (d, i) {
      d.classList.remove('on'); d.removeAttribute('aria-current');
      if (i === idx) { void d.offsetWidth; d.classList.add('on'); d.setAttribute('aria-current', 'true'); } // restart the progress bar
    });
    schedule();
  }
  function schedule() {
    clearTimeout(timer);
    var paused = userPaused || hover || document.hidden || reduce || slides.length < 2;
    root.classList.toggle('paused', paused);
    if (!paused) timer = setTimeout(function () { show(idx + 1); }, MS);
  }
  dots.forEach(function (d) { d.addEventListener('click', function () { show(Number(d.getAttribute('data-go'))); }); });
  var prev = root.querySelector('[data-prev]'); var next = root.querySelector('[data-next]');
  if (prev) prev.addEventListener('click', function () { show(idx - 1); });
  if (next) next.addEventListener('click', function () { show(idx + 1); });
  if (pauseBtn) {
    if (reduce) userPaused = true;
    var syncBtn = function () { pauseBtn.innerHTML = window.GEC && GEC.icon ? GEC.icon(userPaused ? 'play' : 'pause') : ''; pauseBtn.setAttribute('aria-label', pauseBtn.getAttribute(userPaused ? 'data-label-play' : 'data-label-pause')); };
    pauseBtn.addEventListener('click', function () { userPaused = !userPaused; syncBtn(); schedule(); });
    syncBtn();
  }
  root.addEventListener('mouseenter', function () { hover = true; schedule(); });
  root.addEventListener('mouseleave', function () { hover = false; schedule(); });
  root.addEventListener('focusin', function () { hover = true; schedule(); });
  root.addEventListener('focusout', function () { hover = false; schedule(); });
  document.addEventListener('visibilitychange', schedule);
  var rtl = document.documentElement.dir === 'rtl';
  root.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowRight') show(idx + (rtl ? -1 : 1));
    if (e.key === 'ArrowLeft') show(idx + (rtl ? 1 : -1));
  });
  var x0 = null;
  root.addEventListener('touchstart', function (e) { x0 = e.touches[0].clientX; }, { passive: true });
  root.addEventListener('touchend', function (e) {
    if (x0 === null) return; var dx = e.changedTouches[0].clientX - x0; x0 = null;
    if (Math.abs(dx) > 40) show(idx + ((dx < 0) !== rtl ? 1 : -1));
  });
  schedule();
}());

// Header turns solid once the page scrolls past the top (on pages with a hero underneath).
(function () {
  var h = document.querySelector('.site-header');
  if (!h) return;
  function onScroll() { h.classList.toggle('scrolled', window.scrollY > 40 || !document.body.classList.contains('has-hero')); }
  window.addEventListener('scroll', onScroll, { passive: true }); onScroll();
}());

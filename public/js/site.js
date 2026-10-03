/* Public site: header behaviour and the online booking page (progressive enhancement: the booking form
   works without JavaScript through its "Show free times" button). */
(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  /* ---------- Header: shadow once the page scrolls; the mobile menu closes after a choice ---------- */
  var nav = $('.site-nav');
  if (nav) {
    var onScroll = function () { nav.classList.toggle('is-scrolled', window.scrollY > 8); };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }
  $$('.site-menu').forEach(function (menu) {
    menu.addEventListener('click', function (e) { if (e.target.closest('a')) menu.removeAttribute('open'); });
    document.addEventListener('click', function (e) { if (!menu.contains(e.target)) menu.removeAttribute('open'); });
  });

  /* ---------- Platform home page: reveal on scroll, counting numbers, pricing cycle, pointer light ---------- */
  if (document.body.classList.contains('lp-modern')) {
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // Cards of the other sections reveal too, staggered by their place in the row.
    $$('.section-head, .lp-feature, .lp-step, .lp-role, .lp-split .feature-row > *, .lp-faq-grid > *, .lp-quote, .cta-band, .lp-contact-card, .lp-prose').forEach(function (el) {
      if (el.hasAttribute('data-reveal')) return;
      el.setAttribute('data-reveal', '');
      var i = Array.prototype.indexOf.call(el.parentNode.children, el);
      if (!el.style.getPropertyValue('--d')) el.style.setProperty('--d', ((i % 4) * 70) + 'ms');
    });
    var countUp = function (el) {
      var box = el.querySelector ? el.querySelector('[data-count]') : null;
      if (!box) return;
      var text = box.textContent.trim();
      var m = /^(\d{1,6})(.*)$/.exec(text);
      if (!m || Number(m[1]) < 2) return;
      var to = Number(m[1]); var start = null;
      var step = function (ts) {
        if (start === null) start = ts;
        var k = Math.min(1, (ts - start) / 1100);
        box.textContent = Math.round(to * (1 - Math.pow(1 - k, 3))) + m[2];
        if (k < 1) window.requestAnimationFrame(step); else box.textContent = text;
      };
      window.requestAnimationFrame(step);
    };
    if (!reduce && 'IntersectionObserver' in window) {
      document.documentElement.classList.add('js-motion');
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (!e.isIntersecting) return;
          e.target.classList.add('is-in');
          io.unobserve(e.target);
          countUp(e.target);
        });
      }, { rootMargin: '0px 0px -6% 0px', threshold: 0.12 });
      $$('[data-reveal]').forEach(function (el) { io.observe(el); });
      $$('.lp-tile').forEach(function (t) {
        t.addEventListener('pointermove', function (e) {
          var r = t.getBoundingClientRect();
          t.style.setProperty('--mx', (e.clientX - r.left) + 'px');
          t.style.setProperty('--my', (e.clientY - r.top) + 'px');
        });
      });
    }
    $$('[data-pricing]').forEach(function (sec) {
      var plans = $('[data-cycle-root]', sec);
      $$('input[data-cycle]', sec).forEach(function (r) {
        r.addEventListener('change', function () { if (r.checked && plans) plans.setAttribute('data-cycle-now', r.value); });
      });
    });
  }

  /* ---------- Online booking ---------- */
  var form = $('form[data-booking]');
  if (!form) return;
  var data = {};
  try { data = JSON.parse(($('#booking-data') || {}).textContent || '{}'); } catch (e) { data = {}; }
  var msgs = data.messages || {};
  var url = form.getAttribute('data-slots-url');
  var times = $('[data-times]', form);
  var timesMsg = $('[data-times-msg]', form);
  var dateInput = $('[data-date-input]', form);
  var serviceSelect = $('[data-service-select]', form);
  var slotsBtn = $('[data-slots-btn]', form);
  if (slotsBtn) slotsBtn.parentNode.removeChild(slotsBtn); // free times load by themselves now
  var numLocale = data.locale === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB';

  function sum(key, text) { var el = $('[data-sum="' + key + '"]'); if (el) el.textContent = text || '—'; }
  function doctorId() { var r = $('input[name="doctor_id"]:checked', form); return r ? r.value : ''; }
  function branchId() { var r = $('input[name="branch"]:checked', form); return r ? r.value : ''; }
  // Clinics with branches: show the chosen branch's doctors ("any doctor" when it has more than one).
  function filterDoctors() {
    var b = branchId();
    if (!b) return;
    var shown = 0;
    Array.prototype.forEach.call(form.querySelectorAll('.doc-choice[data-branch]'), function (l) {
      var hide = l.getAttribute('data-branch') !== b;
      l.hidden = hide;
      var inp = l.querySelector('input'); if (hide && inp && inp.checked) inp.checked = false;
      if (!hide) shown += 1;
    });
    var any = form.querySelector('.doc-choice-any');
    if (any) { any.hidden = shown < 2; var ai = any.querySelector('input'); if (any.hidden && ai && ai.checked) ai.checked = false; }
  }
  function setMessage(text) {
    if (!timesMsg) return;
    timesMsg.hidden = !text;
    var span = timesMsg.querySelector('span');
    if (span) span.textContent = text || '';
  }
  function formatDate(v) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v || '')) return '—';
    try { return new Intl.DateTimeFormat(numLocale, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(v + 'T00:00:00Z')); } catch (e) { return v; }
  }

  function filterServices() {
    if (!serviceSelect) return;
    var doc = doctorId();
    Array.prototype.forEach.call(serviceSelect.options, function (o) {
      var owner = o.getAttribute('data-doctor');
      var hide = Boolean(owner && doc && doc !== 'any' && owner !== doc);
      o.hidden = hide; o.disabled = hide;
      if (hide && o.selected) serviceSelect.value = '';
    });
    var opt = serviceSelect.options[serviceSelect.selectedIndex];
    sum('service', opt && opt.value ? opt.textContent.split(' · ')[0] : msgs.anyService);
  }

  var seq = 0;
  function loadSlots() {
    var doc = doctorId();
    var date = dateInput ? dateInput.value : '';
    var chosen = ($('input[name="appointment_time"]:checked', form) || {}).value;
    sum('time', '');
    if (!doc || !date) { times.innerHTML = ''; setMessage(msgs.pick); return; }
    var mine = ++seq;
    times.setAttribute('aria-busy', 'true');
    times.innerHTML = '';
    setMessage(msgs.loading);
    var q = '?doctor=' + encodeURIComponent(doc) + '&date=' + encodeURIComponent(date) + (serviceSelect && serviceSelect.value ? '&service=' + encodeURIComponent(serviceSelect.value) : '') + (branchId() ? '&branch=' + encodeURIComponent(branchId()) : '');
    fetch(url + q, { credentials: 'same-origin', headers: { accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (mine !== seq) return;
        times.removeAttribute('aria-busy');
        var list = (res && res.data) || [];
        if (!list.length) { setMessage((res && res.error) || msgs.none); return; }
        setMessage('');
        times.innerHTML = list.map(function (tm) {
          var safe = String(tm).replace(/[^0-9:]/g, '');
          return '<label class="time-chip"><input type="radio" name="appointment_time" value="' + safe + '"' + (safe === chosen ? ' checked' : '') + ' required><span class="num" dir="ltr">' + safe + '</span></label>';
        }).join('');
        if (chosen && list.indexOf(chosen) !== -1) sum('time', chosen);
      })
      .catch(function () { if (mine === seq) { times.removeAttribute('aria-busy'); setMessage(msgs.error); } });
  }

  form.addEventListener('change', function (e) {
    var el = e.target;
    if (el.name === 'branch') { filterDoctors(); sum('doctor', ''); filterServices(); loadSlots(); }
    else if (el.name === 'doctor_id') { sum('doctor', el.getAttribute('data-name')); filterServices(); loadSlots(); }
    else if (el.name === 'service_id') { filterServices(); loadSlots(); }
    else if (el.name === 'appointment_date') { sum('date', formatDate(el.value)); loadSlots(); }
    else if (el.name === 'appointment_time') sum('time', el.value);
  });
  filterServices();
})();

// Platform tour (landing): tabs that switch the screenshot; it moves on by itself every few seconds until the
// visitor picks a tab (and never when they prefer less motion).
(function () {
  document.querySelectorAll('[data-tour]').forEach(function (box) {
    var tabs = Array.prototype.slice.call(box.querySelectorAll('[data-tour-tab]'));
    var panels = Array.prototype.slice.call(box.querySelectorAll('[data-tour-panel]'));
    if (tabs.length < 2) return;
    var cur = 0; var timer = null;
    function show(i, focus) {
      cur = (i + tabs.length) % tabs.length;
      tabs.forEach(function (t, k) { var on = k === cur; t.classList.toggle('is-on', on); t.setAttribute('aria-selected', on ? 'true' : 'false'); t.tabIndex = on ? 0 : -1; });
      panels.forEach(function (p, k) { p.hidden = k !== cur; });
      if (focus) tabs[cur].focus();
    }
    function stop() { if (timer) { clearInterval(timer); timer = null; } }
    tabs.forEach(function (t, k) {
      t.addEventListener('click', function () { stop(); show(k); });
      t.addEventListener('keydown', function (e) {
        var rtl = document.documentElement.dir === 'rtl';
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); stop(); show(cur + ((e.key === 'ArrowRight') !== rtl ? 1 : -1), true); }
      });
    });
    var calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!calm && 'IntersectionObserver' in window) {
      new IntersectionObserver(function (es) {
        es.forEach(function (en) { if (en.isIntersecting && !timer && !box.dataset.touched) timer = setInterval(function () { show(cur + 1); }, 6000); else if (!en.isIntersecting) stop(); });
      }, { threshold: 0.3 }).observe(box);
      box.addEventListener('pointerdown', function () { box.dataset.touched = '1'; stop(); });
    }
  });
}());

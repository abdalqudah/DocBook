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
    var q = '?doctor=' + encodeURIComponent(doc) + '&date=' + encodeURIComponent(date) + (serviceSelect && serviceSelect.value ? '&service=' + encodeURIComponent(serviceSelect.value) : '');
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
    if (el.name === 'doctor_id') { sum('doctor', el.getAttribute('data-name')); filterServices(); loadSlots(); }
    else if (el.name === 'service_id') { filterServices(); loadSlots(); }
    else if (el.name === 'appointment_date') { sum('date', formatDate(el.value)); loadSlots(); }
    else if (el.name === 'appointment_time') sum('time', el.value);
  });
  filterServices();
})();

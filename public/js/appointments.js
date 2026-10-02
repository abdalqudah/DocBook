/* Appointments, front desk and visit pages: time-grid calendar (drag to select → book / block, drag to move), slot picker, service list per doctor, patient lookup,
   checkout maths (DocBook net-amount rule), BMI, prescription lines and the board auto-refresh.
   Progressive enhancement only — every form also works without JavaScript. */
(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var isAr = document.documentElement.lang === 'ar';
  var numLocale = isAr ? 'ar-EG-u-nu-latn' : 'en-US';
  var esc = function (s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; };
  var parse = function (s, d) { try { return JSON.parse(s); } catch (e) { return d; } };
  var num = function (v) { var n = parseFloat(String(v == null ? '' : v).replace(/,/g, '').replace(/[٠-٩]/g, function (c) { return String(c.charCodeAt(0) - 1632); })); return isFinite(n) ? n : 0; };
  var getJson = function (url) {
    return fetch(url, { headers: { Accept: 'application/json' }, credentials: 'same-origin' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  };

  /* ---------- Slot picker ---------- */
  var pickers = [];
  function initSlotPicker(picker) {
    var form = picker.closest('form');
    if (!form) return;
    var i18n = parse(picker.getAttribute('data-i18n'), {});
    var status = $('[data-slot-status]', picker);
    var grid = $('[data-slot-grid]', picker);
    var fallback = $('[data-slot-fallback]', picker);
    var fbInput = $('input', fallback);
    var selected = picker.getAttribute('data-selected') || '';
    var exclude = picker.getAttribute('data-exclude') || '';
    var seq = 0;
    var f = function (sel) { return $(sel, form); };

    function setStatus(text, tone) {
      status.textContent = text || '';
      status.className = 'slot-status small' + (tone === 'error' ? ' is-error' : tone === 'warn' ? ' is-warn' : ' muted') + (text ? '' : ' hidden');
      if (tone === 'loading') status.insertAdjacentHTML('afterbegin', '<span class="spinner" aria-hidden="true"></span>');
    }
    function useFallback(on) {
      fallback.classList.toggle('hidden', !on);
      fbInput.disabled = !on;
      grid.classList.toggle('hidden', on);
    }
    function state() {
      var d = f('[data-doctor-field]'); var dt = f('[data-date-field]'); var s = f('[data-service-field]'); var du = f('[data-duration-input]');
      return { doctor: d ? d.value : '', date: dt ? dt.value : '', service: s ? s.value : '', duration: (!s || !s.value) && du ? du.value.trim() : '' };
    }
    function part(h) { return h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening'; }
    function render(slots) {
      var groups = {}; var parts = [];
      slots.forEach(function (t) { var g = part(Number(t.slice(0, 2))); if (!groups[g]) { groups[g] = []; parts.push(g); } groups[g].push(t); });
      grid.innerHTML = parts.map(function (g) {
        return '<div class="slot-group"><div class="slot-group-title">' + esc(i18n[g] || '') + '</div><div class="slot-chips">'
          + groups[g].map(function (t) {
            return '<label class="slot-chip"><input type="radio" name="appointment_time" value="' + esc(t) + '"' + (t === selected ? ' checked' : '') + '><span dir="ltr">' + esc(t) + '</span></label>';
          }).join('') + '</div></div>';
      }).join('');
    }
    function load() {
      var checked = $('input:checked', grid);
      if (checked) selected = checked.value;
      var s = state();
      var mine = ++seq;
      if (!s.doctor) { useFallback(true); if (selected && !fbInput.value) fbInput.value = selected; setStatus(''); return; }
      useFallback(false);
      if (!s.date) { grid.innerHTML = ''; setStatus(i18n.pick_date); return; }
      setStatus(i18n.loading, 'loading');
      grid.setAttribute('aria-busy', 'true');
      var url = '/app/api/slots?doctor=' + encodeURIComponent(s.doctor) + '&date=' + encodeURIComponent(s.date)
        + (s.service ? '&service=' + encodeURIComponent(s.service) : '') + (s.duration ? '&duration=' + encodeURIComponent(s.duration) : '')
        + (exclude ? '&exclude=' + encodeURIComponent(exclude) : '');
      getJson(url).then(function (res) {
        if (mine !== seq) return;
        grid.removeAttribute('aria-busy');
        var slots = (res && res.data) || [];
        if (res && res.error) { grid.innerHTML = ''; setStatus(res.error, 'error'); return; }
        if (!slots.length) { grid.innerHTML = ''; setStatus(i18n.none, 'warn'); return; }
        render(slots);
        setStatus((i18n.count || '').replace('{n}', slots.length));
      }).catch(function () {
        if (mine !== seq) return;
        grid.removeAttribute('aria-busy');
        grid.innerHTML = '';
        setStatus(i18n.error, 'error');
      });
    }
    var timer;
    var later = function () { clearTimeout(timer); timer = setTimeout(load, 350); };
    form.addEventListener('change', function (e) {
      if (e.target.matches('[data-doctor-field], [data-date-field], [data-service-field]')) load();
    });
    form.addEventListener('input', function (e) { if (e.target.matches('[data-duration-input]')) later(); if (e.target.matches('[data-date-field]')) later(); });
    grid.addEventListener('change', function (e) { if (e.target.name === 'appointment_time') { selected = e.target.value; setStatus(''); } });
    form.addEventListener('submit', function (e) {
      if (fallback.classList.contains('hidden') && !$('input:checked', grid)) {
        e.preventDefault(); e.stopImmediatePropagation();
        setStatus(i18n.choose || i18n.none, 'error');
        picker.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }, true);
    picker.refresh = load;
    // Calendar "Block time" from a selection: pre-select this start time on the next load.
    picker.select = function (t) { selected = t || ''; $$('input:checked', grid).forEach(function (i) { i.checked = false; }); };
    pickers.push(picker);
    load();
  }
  $$('[data-slot-picker]').forEach(initSlotPicker);
  // Dialog forms are reset when opened: reload their pickers afterwards.
  $$('[data-open-dialog]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var dlg = document.getElementById(btn.getAttribute('data-open-dialog'));
      if (!dlg) return;
      setTimeout(function () { $$('[data-slot-picker]', dlg).forEach(function (p) { if (p.refresh) p.refresh(); }); }, 0);
    });
  });

  /* ---------- Booking form: services per doctor, custom duration, expected fee ---------- */
  $$('form.booking-form').forEach(function (form) {
    var doctor = $('[data-doctor-field]', form);
    var service = $('[data-service-field]', form);
    var durWrap = $('[data-duration-wrap]', form);
    var feeLine = $('[data-fee-line]', form);
    var feeOut = $('[data-fee-out]', form);
    var fees = parse(form.getAttribute('data-fee-default'), {});
    function syncDuration() { if (durWrap && service) durWrap.classList.toggle('hidden', Boolean(service.value)); }
    function syncFee() {
      if (!feeLine) return;
      var opt = service && service.selectedOptions[0];
      var price = opt && opt.value ? num(opt.getAttribute('data-price')) : 0;
      if (!price && doctor && doctor.value) price = num(fees[doctor.value]);
      feeLine.hidden = !price;
      if (price) feeOut.textContent = price.toLocaleString(numLocale, { maximumFractionDigits: 3 }) + ' ' + (form.getAttribute('data-currency') || '');
    }
    if (doctor && service && doctor.tagName === 'SELECT') {
      doctor.addEventListener('change', function () {
        var keep = service.value;
        var minLabel = service.getAttribute('data-min') || '';
        getJson('/app/api/services' + (doctor.value ? '?doctor=' + encodeURIComponent(doctor.value) : '')).then(function (res) {
          var list = (res && res.data) || [];
          service.innerHTML = '<option value="">' + esc(service.getAttribute('data-none-label')) + '</option>' + list.map(function (s) {
            return '<option value="' + s.id + '" data-duration="' + s.duration + '" data-price="' + s.price + '"' + (String(s.id) === keep ? ' selected' : '') + '>' + esc(s.name) + ' · ' + s.duration + ' ' + esc(minLabel) + '</option>';
          }).join('');
          syncDuration(); syncFee();
          var picker = $('[data-slot-picker]', form); if (picker && picker.refresh) picker.refresh();
        }).catch(function () { /* keep the current list */ });
      });
    }
    if (service) service.addEventListener('change', function () { syncDuration(); syncFee(); });
    syncDuration(); syncFee();

    /* Patient lookup */
    var wrap = $('[data-patient-search-wrap]', form);
    var search = $('[data-patient-search]', form);
    var results = $('[data-patient-results]', form);
    var pid = $('[data-patient-id]', form);
    var chip = $('[data-patient-chip]', form);
    var name = $('[data-patient-name]', form); var phone = $('[data-patient-phone]', form); var email = $('[data-patient-email]', form);
    if (!search || !pid) return;
    var found = [];
    var active = -1;
    function showSearch(on) { wrap.classList.toggle('hidden', !on); chip.classList.toggle('hidden', on); }
    function closeResults() { results.classList.add('hidden'); search.setAttribute('aria-expanded', 'false'); active = -1; }
    function choose(p) {
      pid.value = p.id; name.value = p.name; phone.value = p.phone; if (email) email.value = p.email || '';
      $('[data-chip-name]', chip).textContent = p.name; $('[data-chip-phone]', chip).textContent = p.phone;
      var av = $('.avatar', chip); if (av) av.textContent = String(p.name || '?').trim().split(/\s+/).slice(0, 2).map(function (x) { return x[0]; }).join('').toUpperCase();
      closeResults(); search.value = ''; showSearch(false);
    }
    function paint() {
      if (!found.length) { results.innerHTML = '<div class="patient-empty small muted">' + esc(search.getAttribute('data-empty')) + '</div>'; }
      else {
        results.innerHTML = found.map(function (p, i) {
          return '<button type="button" role="option" class="patient-option' + (i === active ? ' active' : '') + '" data-i="' + i + '"><span class="strong">' + esc(p.name) + '</span><span class="small muted" dir="ltr">' + esc(p.phone) + '</span></button>';
        }).join('');
      }
      results.classList.remove('hidden'); search.setAttribute('aria-expanded', 'true');
    }
    showSearch(!pid.value);
    var t; var seq = 0;
    search.addEventListener('input', function () {
      clearTimeout(t);
      var q = search.value.trim();
      if (q.length < 2) { closeResults(); return; }
      t = setTimeout(function () {
        var mine = ++seq;
        getJson('/app/appointments/patient-lookup?q=' + encodeURIComponent(q)).then(function (res) {
          if (mine !== seq) return; found = (res && res.data) || []; active = found.length ? 0 : -1; paint();
        }).catch(closeResults);
      }, 250);
    });
    search.addEventListener('keydown', function (e) {
      if (results.classList.contains('hidden')) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(found.length - 1, active + 1); paint(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); paint(); }
      else if (e.key === 'Enter') { e.preventDefault(); if (found[active]) choose(found[active]); }
      else if (e.key === 'Escape') { closeResults(); }
    });
    results.addEventListener('click', function (e) { var b = e.target.closest('[data-i]'); if (b) choose(found[Number(b.getAttribute('data-i'))]); });
    document.addEventListener('click', function (e) { if (!wrap.contains(e.target)) closeResults(); });
    var clear = $('[data-patient-clear]', form);
    if (clear) clear.addEventListener('click', function () { pid.value = ''; name.value = ''; phone.value = ''; if (email) email.value = ''; showSearch(true); search.focus(); });
    // Typing a different phone detaches the chosen patient (the clinic then matches by exact phone).
    phone.addEventListener('input', function () { if (pid.value) { pid.value = ''; chip.classList.add('hidden'); wrap.classList.remove('hidden'); } });
  });

  /* ---------- Checkout: amount entered is the NET paid; show the price before discount ---------- */
  $$('form[data-checkout]').forEach(function (form) {
    var d = Number(form.getAttribute('data-decimals') || 2);
    var fmt = function (n) { return n.toLocaleString(numLocale, { minimumFractionDigits: d, maximumFractionDigits: d }); };
    var amount = $('[name="amount_paid"]', form); var pct = $('[name="discount_percent"]', form);
    var method = $('[name="payment_method"]', form); var ins = $('[data-co-insurance]', form);
    var box = $('[data-co-summary]', form);
    function run() {
      var a = num(amount.value); var p = Math.min(100, Math.max(0, num(pct.value)));
      if (p > 0 && p < 100 && a > 0) {
        var original = a / (1 - p / 100);
        $('[data-co-original]', form).textContent = fmt(original);
        $('[data-co-discount]', form).textContent = fmt(original - a) + ' (' + p.toLocaleString(numLocale, { maximumFractionDigits: 2 }) + '%)';
        $('[data-co-net]', form).textContent = fmt(a);
        box.hidden = false;
      } else box.hidden = true;
      if (ins) ins.classList.toggle('hidden', method.value !== 'insurance');
      var insSel = ins && $('select', ins); if (insSel) insSel.disabled = method.value !== 'insurance';
    }
    form.addEventListener('input', run); form.addEventListener('change', run); run();
  });

  /* ---------- Vitals: live BMI ---------- */
  $$('form[data-vitals]').forEach(function (form) {
    var labels = parse(form.getAttribute('data-bmi-labels'), {});
    var w = $('[name="weightKg"]', form); var h = $('[name="heightCm"]', form);
    var out = $('[data-bmi-out]', form); var lab = $('[data-bmi-label]', form);
    function run() {
      var kg = num(w.value); var m = num(h.value) / 100;
      if (kg > 0 && m > 0.3) {
        var bmi = kg / (m * m);
        out.textContent = bmi.toLocaleString(numLocale, { maximumFractionDigits: 1 });
        var k = bmi < 18.5 ? 'under' : bmi < 25 ? 'normal' : bmi < 30 ? 'over' : 'obese';
        lab.textContent = labels[k] || '';
        lab.className = 'tiny bmi-' + k;
      } else { out.textContent = '—'; lab.textContent = ''; }
    }
    w.addEventListener('input', run); h.addEventListener('input', run); run();
  });

  /* ---------- Prescription lines ---------- */
  $$('form[data-rx-form]').forEach(function (form) {
    var lines = $('[data-rx-lines]', form);
    var tpl = $('template[data-rx-template]', form);
    function renumber() {
      $$('[data-rx-line]', lines).forEach(function (row, i) {
        $$('[data-name]', row).forEach(function (inp) { inp.name = 'items[' + i + '][' + inp.getAttribute('data-name') + ']'; });
      });
    }
    lines.addEventListener('click', function (e) {
      var rm = e.target.closest('[data-rx-remove]');
      if (!rm) return;
      var rows = $$('[data-rx-line]', lines);
      var row = rm.closest('[data-rx-line]');
      if (rows.length > 1) row.remove(); else $$('input', row).forEach(function (i) { i.value = ''; });
      renumber();
    });
    var add = $('[data-rx-add]', form);
    if (add && tpl) add.addEventListener('click', function () {
      var node = tpl.content.firstElementChild.cloneNode(true);
      lines.appendChild(node); renumber();
      var first = $('input', node); if (first) first.focus();
    });
    renumber();
  });


  /* ---------- Calendar: drag to select (book / block time), drag to move ----------
     Pointer maths use getBoundingClientRect only, so it works the same in RTL and LTR.
     Mouse/pen: press and drag. Touch: tap = one slot; press and hold (~0.4s) to drag, so scrolling still works. */
  var calEl = $('[data-cal]');
  var calData = parse(($('#cal-data') || {}).textContent, null);
  if (calEl && calData) initCalendar(calEl, calData);

  function initCalendar(cal, D) {
    var i18n = D.i18n || {};
    var isRtl = document.documentElement.dir === 'rtl';
    var scroller = $('[data-cal-scroll]', cal);
    var bodies = $$('.cal-body', cal);
    var loadedAt = Date.now();
    var useEl = $('use[href*="icons.svg"]');
    var iconBase = useEl ? useEl.getAttribute('href').replace(/#.*$/, '#i-') : '/icons.svg#i-';
    var svg = function (name) { return '<svg class="icon icon-sm" aria-hidden="true"><use href="' + iconBase + name + '"></use></svg>'; };
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    var hhmm = function (m) { m = Math.round(m); return pad(Math.floor(m / 60)) + ':' + pad(m % 60); };
    var fill = function (tpl, v) { return String(tpl || '').replace(/\{(\w+)\}/g, function (_, k) { return v[k] == null ? '' : v[k]; }); };
    var nowMin = function () { return D.now + Math.floor((Date.now() - loadedAt) / 60000); };
    var span = D.rangeEnd - D.rangeStart;

    function minuteAt(body, clientY) {
      var r = body.getBoundingClientRect();
      var m = D.rangeStart + ((clientY - r.top) / r.height) * span;
      return Math.max(D.rangeStart, Math.min(D.rangeEnd, m));
    }
    function shiftOf(col, m) {
      for (var i = 0; i < col.work.length; i++) if (m >= col.work[i][0] && m < col.work[i][1]) return col.work[i];
      return null;
    }
    // Candidate start times step by the doctor's slot length from the start of the shift (same rule as the server).
    function gridBase(col, m) {
      var b = null;
      (col.shifts || []).forEach(function (s) { if (m >= s[0] && m < s[1]) b = s[0]; });
      return b;
    }
    function snapFloor(col, m) {
      var base = gridBase(col, m); var step = col.slot || 30;
      if (base === null) return Math.floor(m / 15) * 15;
      return base + Math.floor((m - base) / step) * step;
    }
    function snapNearest(col, m) {
      var base = gridBase(col, m); var step = col.slot || 30;
      if (base === null) return Math.round(m / 15) * 15;
      return base + Math.round((m - base) / step) * step;
    }
    function isPast(col, start) { return col.date < D.today || (col.date === D.today && start <= nowMin()); }
    function fits(col, s, e) { return col.work.some(function (w) { return s >= w[0] && e <= w[1]; }); }
    function clash(col, s, e, except) { return col.busy.some(function (b) { return String(b[2]) !== String(except) && s < b[1] && e > b[0]; }); }
    function valid(col, s, e, except) {
      if (!col || col.readonly || !col.doctorId) return false;
      if (e - s < 5 || e - s > 480) return false;
      return fits(col, s, e) && !clash(col, s, e, except) && !isPast(col, s);
    }
    function place(el, s, e) { el.style.top = 'calc(' + ((s - D.rangeStart) / 15) + ' * var(--row))'; el.style.height = 'calc(' + ((e - s) / 15) + ' * var(--row) - 1px)'; }
    function visibleBodies() { return bodies.filter(function (b) { var r = b.getBoundingClientRect(); return r.width > 0; }); }
    function bodyAtX(x) {
      var hit = null;
      visibleBodies().forEach(function (b) { var r = b.getBoundingClientRect(); if (x >= r.left && x < r.right) hit = b; });
      return hit;
    }
    function autoScroll(x, y) {
      if (!scroller) return;
      var r = scroller.getBoundingClientRect();
      var head = $('.cal-head', cal); var hh = head ? head.getBoundingClientRect().height : 0;
      // The calendar is full height: dragging near the window's top / bottom edge scrolls the page.
      if (y < Math.max(r.top + hh, 0) + 40) window.scrollBy(0, -14); else if (y > window.innerHeight - 40) window.scrollBy(0, 14);
      if (x < r.left + 24) scroller.scrollBy({ left: -14 }); else if (x > r.right - 24) scroller.scrollBy({ left: 14 });
    }

    /* toasts for errors that happen without a page load */
    function toast(msg) {
      var box = $('.toasts');
      if (!box) { box = document.createElement('div'); box.className = 'toasts'; box.setAttribute('role', 'status'); box.setAttribute('aria-live', 'polite'); document.body.appendChild(box); }
      var t = document.createElement('div');
      t.className = 'toast error';
      t.innerHTML = svg('circle-alert') + '<div class="grow">' + esc(msg) + '</div><button class="btn btn-ghost btn-icon btn-sm" type="button" aria-label="' + esc(i18n.close) + '">' + svg('x') + '</button>';
      t.querySelector('button').addEventListener('click', function () { t.remove(); });
      box.appendChild(t);
      setTimeout(function () { t.remove(); }, 7000);
    }

    /* touch devices get a touch hint */
    var hint = $('[data-cal-hint]');
    if (hint && window.matchMedia && window.matchMedia('(hover: none)').matches) hint.textContent = hint.getAttribute('data-touch');

    /* mobile: one doctor at a time */
    var sw = $('[data-cal-switch]', cal);
    if (sw) {
      cal.classList.add('js-switch');
      var showCol = function (i) {
        $$('.cal-head, .cal-body', cal).forEach(function (el) { el.classList.toggle('m-hide', el.getAttribute('data-col') !== String(i)); });
      };
      var saved = null; try { saved = sessionStorage.getItem('cal-col'); } catch (e) { /* storage blocked */ }
      if (saved !== null && Number(saved) < D.columns.length) sw.value = saved;
      else { var firstWorking = D.columns.findIndex(function (c) { return c.work.length > 0; }); if (firstWorking > 0) sw.value = String(firstWorking); }
      showCol(sw.value);
      sw.addEventListener('change', function () { closePop(); showCol(sw.value); try { sessionStorage.setItem('cal-col', sw.value); } catch (e) { /* ignore */ } });
    }

    /* now line */
    function tickNow() {
      var m = nowMin();
      $$('[data-cal-now], [data-cal-now-label]', cal).forEach(function (el) {
        el.hidden = m < D.rangeStart || m > D.rangeEnd;
        el.style.setProperty('--y', (m - D.rangeStart) / 15);
        if (el.hasAttribute('data-cal-now-label')) el.textContent = hhmm(m);
      });
    }
    setInterval(tickNow, 30000);
    // Start scrolled near the current time (or the first appointment) so the working day is in view.
    (function initialScroll() {
      if (!scroller) return;
      var target = null;
      if (D.columns.some(function (c) { return c.date === D.today; })) target = nowMin() - 60;
      if (target !== null && target > D.rangeStart) {
        var b = bodies[0];
        // The calendar is full height and the page scrolls normally: nothing to move on load.
        void b;
      }
      // Week view on a narrow screen: bring today's column into view.
      var tb = $('.cal-body[data-date="' + D.today + '"]', cal);
      if (D.view === 'week' && tb && scroller.scrollWidth > scroller.clientWidth) {
        var r = tb.getBoundingClientRect(); var sr = scroller.getBoundingClientRect();
        scroller.scrollBy({ left: (r.left + r.width / 2) - (sr.left + sr.width / 2) });
      }
    }());

    if (!D.canManage) return;

    var st = null;          // current gesture
    var pop = null;         // selection menu
    var suppressClick = 0;

    function closePop() {
      if (pop) { pop.remove(); pop = null; }
      $$('.cal-sel', cal).forEach(function (el) { el.remove(); });
    }

    /* ---- selection ---- */
    function beginSelect(s) {
      s.mode = 'select';
      s.col = D.columns[s.ci];
      s.a0 = snapFloor(s.col, s.anchor);
      s.el = document.createElement('div');
      s.el.className = 'cal-sel';
      s.body.appendChild(s.el);
      updateSelect(s, s.y0);
    }
    function updateSelect(s, clientY) {
      var col = s.col; var slot = col.slot || 30;
      var p = minuteAt(s.body, clientY);
      var start; var end;
      if (p >= s.a0) { start = s.a0; end = Math.max(s.a0 + slot, Math.ceil(p / 15) * 15); }
      else { start = snapFloor(col, p); end = s.a0 + slot; }
      start = Math.max(D.rangeStart, start); end = Math.min(D.rangeEnd, end);
      s.start = start; s.end = end;
      s.ok = valid(col, start, end, null);
      s.el.classList.toggle('bad', !s.ok);
      place(s.el, start, end);
      s.el.innerHTML = '<span dir="ltr">' + hhmm(start) + ' – ' + hhmm(end) + '</span><small>' + esc(s.ok ? fill(i18n.min, { n: end - start }) : i18n.unavailable) + '</small>';
    }
    function finishSelect(s) {
      if (!s.ok) {
        var el = s.el;
        setTimeout(function () { el.remove(); }, 900);
        return;
      }
      openPop(s);
    }
    function openPop(s) {
      var col = s.col; var dur = s.end - s.start;
      pop = document.createElement('div');
      pop.className = 'cal-pop';
      pop.setAttribute('role', 'dialog');
      pop.setAttribute('aria-label', hhmm(s.start) + ' – ' + hhmm(s.end));
      var q = 'doctor=' + encodeURIComponent(col.doctorId) + '&date=' + encodeURIComponent(col.date) + '&time=' + encodeURIComponent(hhmm(s.start)) + '&duration=' + dur + '&return=' + encodeURIComponent(D.here);
      pop.innerHTML = '<div class="cal-pop-head"><strong><span dir="ltr">' + hhmm(s.start) + ' – ' + hhmm(s.end) + '</span></strong><span class="tiny muted">'
        + esc([col.name, col.dateLabel, fill(i18n.min, { n: dur })].filter(Boolean).join(' · ')) + '</span></div>'
        + '<a class="btn btn-primary btn-sm" data-pop-book href="/app/appointments/new?' + q + '">' + svg('calendar-plus') + esc(i18n.book) + '</a>'
        + '<button class="btn btn-secondary btn-sm" type="button" data-pop-block>' + svg('lock') + esc(i18n.block) + '</button>'
        + '<button class="btn btn-ghost btn-sm" type="button" data-pop-cancel>' + esc(i18n.cancel) + '</button>';
      document.body.appendChild(pop);
      var r = s.el.getBoundingClientRect();
      var w = pop.offsetWidth; var h = pop.offsetHeight; var vw = window.innerWidth; var vh = window.innerHeight;
      var x; var y;
      if (vw < 600) {
        x = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), vw - w - 8);
        y = r.bottom + 8 + h < vh ? r.bottom + 8 : Math.max(8, r.top - h - 8);
      } else {
        var after = isRtl ? r.left - w - 8 : r.right + 8;       // the inline-end side of the selection
        var before = isRtl ? r.right + 8 : r.left - w - 8;
        x = after >= 8 && after + w <= vw - 8 ? after : (before >= 8 && before + w <= vw - 8 ? before : Math.min(Math.max(8, r.left), vw - w - 8));
        y = Math.min(Math.max(8, r.top), vh - h - 8);
      }
      pop.style.left = x + 'px'; pop.style.top = y + 'px';
      pop.st = scroller ? scroller.scrollTop : 0; pop.sl = scroller ? scroller.scrollLeft : 0;
      $('[data-pop-cancel]', pop).addEventListener('click', closePop);
      $('[data-pop-block]', pop).addEventListener('click', function () { openBlock(col, s.start, dur); });
      $('[data-pop-book]', pop).focus();
    }
    function openBlock(col, start, dur) {
      var dlg = document.getElementById('block-dialog');
      var opener = $('[data-block-open]');
      if (!dlg || !opener) return;
      opener.setAttribute('data-fill', JSON.stringify({ doctor_id: col.doctorId, appointment_date: col.date, duration_minutes: dur }));
      opener.click();
      opener.removeAttribute('data-fill');
      var picker = $('[data-slot-picker]', dlg);
      if (picker && picker.select) { picker.select(hhmm(start)); if (picker.refresh) picker.refresh(); }
      closePop();
    }

    /* ---- move ---- */
    function beginMove(s) {
      s.mode = 'move';
      s.ev.classList.add('is-dragging');
      cal.classList.add('is-dragging');
      s.el = document.createElement('div');
      s.el.className = 'cal-ghost';
      s.target = s.body;
      updateMove(s, s.x0, s.y0);
    }
    function updateMove(s, x, y) {
      var body = bodyAtX(x) || s.target;
      if (body !== s.target || !s.el.parentNode) { body.appendChild(s.el); s.target = body; }
      var col = D.columns[Number(body.getAttribute('data-col'))];
      var start = snapNearest(col, minuteAt(body, y) - s.grab);
      start = Math.max(D.rangeStart, Math.min(D.rangeEnd - s.len, start));
      s.col = col; s.start = start;
      s.changed = !(col.doctorId === s.fromCol.doctorId && col.date === s.fromCol.date && start === s.origStart);
      s.ok = s.changed && valid(col, start, start + s.len, s.id);
      s.el.classList.toggle('bad', s.changed && !s.ok);
      place(s.el, start, start + s.len);
      s.el.innerHTML = '<span dir="ltr">' + hhmm(start) + ' – ' + hhmm(start + s.len) + '</span><small>' + esc(s.changed && !s.ok ? i18n.unavailable : s.name) + '</small>';
    }
    function endMove(s) {
      cal.classList.remove('is-dragging');
      if (!s.ok) { snapBack(s); return; }
      confirmMove(s);
    }
    function snapBack(s) { if (s.el) s.el.remove(); s.ev.classList.remove('is-dragging'); }

    var moveDlg = document.getElementById('move-dialog');
    var pendingMove = null;
    function confirmMove(s) {
      if (!moveDlg || typeof moveDlg.showModal !== 'function') { if (window.confirm(s.name)) sendMove(s); else snapBack(s); return; }
      pendingMove = s;
      var msg = D.view === 'week'
        ? fill(i18n.moveDate, { name: s.name, date: s.col.dateLabel, time: hhmm(s.start) })
        : fill(i18n.moveDoctor, { name: s.name, time: hhmm(s.start), doctor: s.col.name });
      $('[data-move-title]', moveDlg).textContent = s.block ? i18n.moveBlockTitle : i18n.moveTitle;
      $('[data-move-msg]', moveDlg).textContent = msg;
      var err = $('[data-move-error]', moveDlg); err.classList.add('hidden'); err.textContent = '';
      var yes = $('[data-move-yes]', moveDlg); yes.disabled = false; yes.textContent = yes.getAttribute('data-label') || yes.textContent; yes.setAttribute('data-label', yes.textContent);
      moveDlg.showModal();
      yes.focus();
    }
    if (moveDlg) {
      moveDlg.addEventListener('close', function () { if (pendingMove && !pendingMove.sending) snapBack(pendingMove); if (pendingMove && !pendingMove.sending) pendingMove = null; });
      $('[data-move-no]', moveDlg).addEventListener('click', function () { moveDlg.close(); });
      moveDlg.addEventListener('click', function (e) { if (e.target === moveDlg) moveDlg.close(); });
      $('[data-move-yes]', moveDlg).addEventListener('click', function () { if (pendingMove) sendMove(pendingMove); });
    }
    function sendMove(s) {
      s.sending = true;
      var yes = moveDlg && $('[data-move-yes]', moveDlg);
      if (yes) { yes.disabled = true; yes.textContent = i18n.moving; }
      var body = new URLSearchParams();
      body.set('_csrf', D.csrf); body.set('doctor_id', s.col.doctorId); body.set('appointment_date', s.col.date); body.set('appointment_time', hhmm(s.start));
      fetch('/app/appointments/' + s.id + '/move', { method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json', 'X-CSRF-Token': D.csrf, 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (res) {
          if (res.j && res.j.ok) { location.reload(); return; }
          fail((res.j && res.j.error) || i18n.netError);
        })
        .catch(function () { fail(i18n.netError); });
      function fail(msg) {
        s.sending = false; pendingMove = null;
        if (moveDlg && moveDlg.open) moveDlg.close();
        snapBack(s);
        toast(msg);
      }
    }

    /* ---- pointer plumbing ---- */
    cal.addEventListener('pointerdown', function (e) {
      suppressClick = 0; // only the click that ends a drag/selection gesture is swallowed
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (e.target.closest('.cal-ev-del, .cal-head, .cal-switch')) return;
      var body = e.target.closest('.cal-body');
      if (!body) return;
      if (pop) { closePop(); if (e.pointerType === 'mouse') return; }
      var ci = Number(body.getAttribute('data-col'));
      var col = D.columns[ci];
      var ev = e.target.closest('.cal-ev');
      var touch = e.pointerType !== 'mouse';
      if (ev) {
        if (!ev.hasAttribute('data-movable')) return;
        var start = Number(ev.getAttribute('data-start'));
        st = { mode: 'pending-move', ev: ev, id: ev.getAttribute('data-ev'), len: Number(ev.getAttribute('data-len')), origStart: start, name: ev.getAttribute('data-name') || '', block: ev.hasAttribute('data-block'),
          body: body, fromCol: col, x0: e.clientX, y0: e.clientY, pid: e.pointerId, touch: touch, grab: minuteAt(body, e.clientY) - start };
      } else {
        if (!col || col.readonly || !col.doctorId) return;
        st = { mode: 'pending-select', body: body, ci: ci, x0: e.clientX, y0: e.clientY, pid: e.pointerId, touch: touch, anchor: minuteAt(body, e.clientY) };
        if (!touch) { e.preventDefault(); beginSelect(st); }
      }
      if (touch) {
        var s = st;
        s.timer = setTimeout(function () {
          if (st !== s) return;
          if (s.mode === 'pending-move') beginMove(s); else beginSelect(s);
          if (navigator.vibrate) { try { navigator.vibrate(12); } catch (err) { /* ignore */ } }
        }, 400);
      }
    });
    document.addEventListener('pointermove', function (e) {
      var s = st;
      if (!s || e.pointerId !== s.pid) return;
      var dist = Math.abs(e.clientX - s.x0) + Math.abs(e.clientY - s.y0);
      if (s.mode === 'pending-select' || s.mode === 'pending-move') {
        if (s.touch) { if (dist > 10) { clearTimeout(s.timer); st = null; } return; }  // a scroll, not a drag
        if (s.mode === 'pending-move' && dist > 5) beginMove(s); else return;
      }
      e.preventDefault();
      if (s.mode === 'select') updateSelect(s, e.clientY); else updateMove(s, e.clientX, e.clientY);
      autoScroll(e.clientX, e.clientY);
    });
    function up(e, cancelled) {
      var s = st;
      if (!s || e.pointerId !== s.pid) return;
      clearTimeout(s.timer);
      st = null;
      if (cancelled) {
        if (s.mode === 'select') s.el.remove();
        if (s.mode === 'move') { cal.classList.remove('is-dragging'); snapBack(s); }
        return;
      }
      if (s.mode === 'pending-select') { beginSelect(s); finishSelect(s); suppressClick = Date.now(); return; } // a tap on free time = one slot
      if (s.mode === 'pending-move') return; // a click/tap on the appointment opens it
      suppressClick = Date.now();
      if (s.mode === 'select') finishSelect(s); else endMove(s);
    }
    document.addEventListener('pointerup', function (e) { up(e, false); });
    document.addEventListener('pointercancel', function (e) { up(e, true); });
    // While a touch drag is active the page must not scroll.
    document.addEventListener('touchmove', function (e) { if (st && (st.mode === 'select' || st.mode === 'move')) e.preventDefault(); }, { passive: false });
    cal.addEventListener('click', function (e) { if (suppressClick && Date.now() - suppressClick < 1000) { e.preventDefault(); e.stopPropagation(); } }, true);
    cal.addEventListener('contextmenu', function (e) { if (e.target.closest('.cal-body')) e.preventDefault(); });
    cal.addEventListener('dragstart', function (e) { e.preventDefault(); });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (st) { var s = st; st = null; clearTimeout(s.timer); if (s.mode === 'select') s.el.remove(); if (s.mode === 'move') { cal.classList.remove('is-dragging'); snapBack(s); } }
      closePop();
    });
    document.addEventListener('pointerdown', function (e) { if (pop && !pop.contains(e.target) && !cal.contains(e.target)) closePop(); });
    // Scrolling the grid away from an open menu closes it (small scroll jitter is ignored).
    if (scroller) scroller.addEventListener('scroll', function () { if (pop && (Math.abs(scroller.scrollTop - pop.st) > 40 || Math.abs(scroller.scrollLeft - pop.sl) > 40)) closePop(); }, { passive: true });
    window.addEventListener('resize', function () { if (pop) closePop(); });
  }

  /* ---------- Front desk: fallback refresh every minute when live updates (live.js) are unavailable ---------- */
  var auto = $('[data-auto-refresh]');
  if (auto) {
    var every = Math.max(20, Number(auto.getAttribute('data-auto-refresh')) || 60) * 1000;
    var lastInput = 0;
    document.addEventListener('input', function () { lastInput = Date.now(); }, true);
    setInterval(function () {
      if (window.DocBookLive && window.DocBookLive.connected) return; // live updates (live.js) are on: this is only the fallback
      if (document.visibilityState !== 'visible') return;
      if ($('dialog[open]') || $('details.dropdown[open]') || $('.cmdk.open')) return;
      if (Date.now() - lastInput < 15000) return;
      var url = location.pathname + location.search.replace(/([?&])paid=\d+&?/, '$1').replace(/[?&]$/, '');
      location.replace(url);
    }, every);
  }
  /* ---------- Calendar import: source / doctor-mode panes, select all, selected count ---------- */
  var imp = $('[data-cal-import]');
  if (imp) {
    var syncPanes = function () {
      var src = ($('[data-cal-source]:checked', imp) || {}).value || 'file';
      $$('[data-cal-pane]', imp).forEach(function (p) { p.hidden = p.getAttribute('data-cal-pane') !== src; });
      var mode = ($('[data-cal-mode]:checked', imp) || {}).value || 'one';
      $$('[data-cal-mode-pane]', imp).forEach(function (p) { p.hidden = p.getAttribute('data-cal-mode-pane') !== mode; });
      var file = $('input[type=file]', imp); var url = $('input[name=url]', imp);
      if (file) file.required = src === 'file';
      if (url) url.required = src === 'url';
    };
    $$('[data-cal-source], [data-cal-mode]', imp).forEach(function (r) { r.addEventListener('change', syncPanes); });
    syncPanes();
    imp.addEventListener('submit', function () { var b = $('button[type=submit]', imp); if (b) { b.disabled = true; b.classList.add('is-loading'); } });
  }
  var conf = $('[data-cal-confirm]');
  if (conf) {
    var boxes = $$('[data-cal-row]:not([disabled])', conf);
    var all = $('[data-cal-all]', conf);
    var btn = $('[data-cal-submit]', conf);
    var outside = $('[data-cal-outside]', conf);
    var count = function () {
      var n = boxes.filter(function (b) { return b.checked; }).length;
      if (btn) { var sp = $('span', btn); if (sp) sp.textContent = String(btn.getAttribute('data-label') || '').replace('{n}', n.toLocaleString(numLocale)); btn.disabled = n === 0; }
      if (all) { all.checked = n > 0 && n === boxes.length; all.indeterminate = n > 0 && n < boxes.length; }
    };
    boxes.forEach(function (b) {
      b.addEventListener('change', function () {
        // Choosing a row outside working hours turns the override on (it can be turned off again).
        if (b.checked && b.getAttribute('data-state') === 'outside_hours' && outside && !outside.checked) outside.checked = true;
        count();
      });
    });
    if (all) all.addEventListener('change', function () { boxes.forEach(function (b) { b.checked = all.checked; }); if (all.checked && outside && boxes.some(function (b) { return b.getAttribute('data-state') === 'outside_hours'; })) outside.checked = true; count(); });
    conf.addEventListener('submit', function () { if (btn) btn.disabled = true; });
    count();
  }
}());

/* Appointments, front desk and visit pages: slot picker, service list per doctor, patient lookup,
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

  /* ---------- Front desk: refresh the board every minute (never while a dialog or menu is open) ---------- */
  var auto = $('[data-auto-refresh]');
  if (auto) {
    var every = Math.max(20, Number(auto.getAttribute('data-auto-refresh')) || 60) * 1000;
    var lastInput = 0;
    document.addEventListener('input', function () { lastInput = Date.now(); }, true);
    setInterval(function () {
      if (document.visibilityState !== 'visible') return;
      if ($('dialog[open]') || $('details.dropdown[open]') || $('.cmdk.open')) return;
      if (Date.now() - lastInput < 15000) return;
      var url = location.pathname + location.search.replace(/([?&])paid=\d+&?/, '$1').replace(/[?&]$/, '');
      location.replace(url);
    }, every);
  }
}());

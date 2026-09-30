/* Reception & cash screen (worker: reception-cash).
   • Payment panel (pages/clinic/cashier/_panel.ejs): live preview of the bill — lines, discount, insurance split,
     cash / card / mixed, change — opened in a dialog from the cash screen and the reception board ([data-cx-open]),
     or inline on the cashier page. The server recomputes every figure; this is only a preview + friendly checks.
   • "Paid" panel: prints the receipt on its own in a hidden frame; print links open in the same frame.
   • Cash screen: clock, full screen, live refresh of the doctor columns (SSE /app/live/events, 10 s polling as a
     fallback) with a soft chime and a flash when a doctor finishes a visit ("ready to collect").
   No inline scripts (CSP): texts come from JSON islands. */
(function () {
  'use strict';

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function jsonOf(el) { try { return el ? JSON.parse(el.textContent || '{}') : {}; } catch (e) { return {}; } }
  function store(fn) { try { return fn(window.localStorage); } catch (e) { return null; } }
  function sstore(fn) { try { return fn(window.sessionStorage); } catch (e) { return null; } }
  var pageTexts = jsonOf(document.getElementById('cx-texts'));

  /* ================================================================ payment panel */
  function initPanel(form) {
    if (!form || form.getAttribute('data-cx-ready')) return;
    form.setAttribute('data-cx-ready', '1');
    var cfg = jsonOf($('[data-cx-panel-data]', form));
    var texts = cfg.texts || {};
    var decimals = typeof cfg.decimals === 'number' ? cfg.decimals : 2;
    var factor = Math.pow(10, decimals);
    var nf = null;
    try { nf = new Intl.NumberFormat(cfg.locale || 'en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }); } catch (e) { nf = null; }
    function round(v) { var n = Number(v) || 0; var s = n < 0 ? -1 : 1; return (s * Math.round(Math.abs(n) * factor + 1e-9)) / factor; }
    function fmt(v) { return nf ? nf.format(round(v)) : round(v).toFixed(decimals); }
    function num(el) { if (!el) return 0; var v = parseFloat(String(el.value || '').replace(/,/g, '')); return isFinite(v) ? v : 0; }
    function has(el) { return el && String(el.value || '').trim() !== ''; }
    function field(name) { return form.querySelector('[name="' + name + '"]'); }
    function out(k) { return form.querySelector('[data-cx-out="' + k + '"]'); }
    function row(k) { return form.querySelector('[data-cx-row="' + k + '"]'); }
    function set(k, v) { var el = out(k); if (el) el.textContent = v; }
    function checked(name) { var el = form.querySelector('[name="' + name + '"]:checked'); return el ? el.value : ''; }

    var body = $('[data-cx-lines]', form);
    if (!body) return; // already paid: nothing to compute
    var tpl = $('[data-cx-line-tpl]', form);
    var next = $$('[data-cx-line]', body).length;
    var received = $('[data-cx-received]', form);
    var splitCash = form.querySelector('[data-cx-split="cash"]');
    var splitCard = form.querySelector('[data-cx-split="card"]');
    var insurer = $('[data-cx-insurer]', form);
    var coverage = $('[data-cx-coverage]', form);
    var coverageAmt = field('coverage_amount');
    var reasonBox = $('[data-cx-reason]', form);
    var quick = $('[data-cx-quick]', form);
    var confirmBtn = $('[data-cx-confirm]', form);
    var lastSplit = 'cash';
    var state = {};

    function lineValues(tr) {
      return { qty: num(tr.querySelector('[name$="[qty]"]')), price: num(tr.querySelector('[name$="[unit_price]"]')) };
    }
    function doctorChanged(lines) {
      var docs = cfg.doctorLines || [];
      if (!docs.length) return false;
      var pool = lines.map(function (l) { return l.qty + 'x' + round(l.price); });
      return docs.some(function (d) {
        var i = pool.indexOf((d.qty || 1) + 'x' + round(d.price));
        if (i < 0) return true;
        pool.splice(i, 1);
        return false;
      });
    }

    function compute() {
      var lines = $$('[data-cx-line]', body).map(function (tr) {
        var l = lineValues(tr);
        var cell = tr.querySelector('[data-cx-line-total]');
        if (cell) cell.textContent = fmt(l.qty * l.price);
        return l;
      });
      var subtotal = round(lines.reduce(function (s, l) { return s + round(l.qty * l.price); }, 0));
      var dType = checked('discount_type') || 'percent';
      var dVal = num(field('discount_value'));
      var discount = dType === 'amount' ? round(Math.min(dVal, subtotal)) : round(subtotal * Math.min(dVal, 100) / 100);
      var total = round(subtotal - discount);
      var method = checked('payment_method') || 'cash';
      var insOn = method === 'insurance' || (insurer && insurer.value);
      var cType = checked('coverage_type') || 'percent';
      var insAmt = 0;
      if (method === 'insurance') insAmt = total;
      else if (insOn) insAmt = cType === 'amount' ? round(Math.min(num(coverageAmt), total)) : round(total * Math.min(num(coverage), 100) / 100);
      var patient = round(total - insAmt);

      set('subtotal', fmt(subtotal));
      if (row('discount')) row('discount').hidden = !(discount > 0);
      set('discount', '− ' + fmt(discount));
      set('discount_pct', dType === 'percent' && dVal > 0 ? '(' + dVal + '%)' : '');
      set('total', fmt(total));
      if (row('insurance')) row('insurance').hidden = !insOn;
      if (row('patient')) row('patient').hidden = !insOn;
      set('insurance', fmt(insAmt));
      set('patient', fmt(patient));
      set('confirm_amount', method === 'insurance' || patient <= 0 ? '' : ' · ' + fmt(patient));

      // What the patient pays in cash: all of it (cash), or the cash part (mixed).
      var warn = '';
      var cashDue = 0;
      if (method === 'cash') cashDue = patient;
      if (method === 'mixed') {
        cashDue = round(num(splitCash));
        var sum = round(num(splitCash) + num(splitCard));
        var note = $('[data-cx-split-note]', form);
        var diff = round(patient - sum);
        if (note) {
          note.textContent = !has(splitCash) && !has(splitCard) ? '' : diff === 0 ? texts.split_ok : diff > 0 ? String(texts.split_left || '').replace('{v}', fmt(diff)) : String(texts.split_over || '').replace('{v}', fmt(-diff));
          note.className = 'cx-split-note' + (diff === 0 ? ' is-ok' : (has(splitCash) || has(splitCard) ? ' is-off' : ''));
        }
        if (diff !== 0 && patient > 0) warn = diff > 0 ? String(texts.split_left || '').replace('{v}', fmt(diff)) : String(texts.split_over || '').replace('{v}', fmt(-diff));
      }
      var rec = has(received) ? round(num(received)) : cashDue;
      var change = cashDue > 0 ? round(rec - cashDue) : 0;
      if (row('change')) row('change').hidden = !(cashDue > 0 && has(received));
      set('change', fmt(Math.max(0, change)));
      if (cashDue > 0 && has(received) && change < 0) warn = texts.cash_short || '';
      if (method === 'insurance' && patient > 0) warn = '';
      if (insOn && method !== 'insurance' && patient <= 0 && total > 0) warn = warn || '';
      var w = out('warn');
      if (w) { w.textContent = warn; w.hidden = !warn; }

      // The doctor's bill changed → the reason field appears (and is required by the server).
      var changed = doctorChanged(lines);
      if (reasonBox) { if (changed) reasonBox.hidden = false; else if (!has(field('adjust_reason'))) reasonBox.hidden = true; }

      // Show only what the chosen method needs.
      $$('[data-cx-when]', form).forEach(function (el) { el.hidden = el.getAttribute('data-cx-when').split(' ').indexOf(method) < 0 || (method === 'mixed' && patient <= 0); });
      state = { total: total, patient: patient, cashDue: cashDue, method: method, warn: warn, changed: changed };
      quickNotes(cashDue);
    }

    // Quick "note" buttons for the cash received: exact + the next round amounts.
    var lastQuick = null;
    function quickNotes(due) {
      if (!quick) return;
      var key = String(round(due));
      if (key === lastQuick) return;
      lastQuick = key;
      quick.innerHTML = '';
      if (!(due > 0)) return;
      var opts = [due];
      [1, 5, 10, 20, 50, 100].forEach(function (step) { var v = Math.ceil(due / step) * step; if (v > due && opts.indexOf(v) < 0 && opts.length < 4) opts.push(v); });
      opts.forEach(function (v, i) {
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'btn btn-secondary btn-sm';
        b.textContent = i === 0 ? (texts.exact || fmt(v)) + (i === 0 ? ' · ' + fmt(v) : '') : fmt(v);
        b.addEventListener('click', function () { received.value = String(round(v)); compute(); received.focus(); });
        quick.appendChild(b);
      });
    }

    function addLine(opts) {
      opts = opts || {};
      if (opts.serviceId) {
        var existing = $$('[data-cx-line]', body).filter(function (tr) { var s = tr.querySelector('[name$="[service_id]"]'); return s && s.value === String(opts.serviceId); })[0];
        if (existing) { var q = existing.querySelector('[name$="[qty]"]'); q.value = String((Number(q.value) || 0) + 1); compute(); return; }
      }
      var html = tpl.innerHTML.replace(/__i__/g, String(next));
      next += 1;
      var holder = document.createElement('tbody');
      holder.innerHTML = html;
      var tr = holder.firstElementChild;
      body.appendChild(tr);
      if (opts.serviceId) tr.querySelector('[name$="[service_id]"]').value = String(opts.serviceId);
      if (opts.name) tr.querySelector('[name$="[name]"]').value = opts.name;
      if (opts.price !== undefined) tr.querySelector('[name$="[unit_price]"]').value = String(opts.price);
      compute();
      (opts.name ? tr.querySelector('[name$="[unit_price]"]') : tr.querySelector('[name$="[name]"]')).focus();
    }

    var svc = $('[data-cx-add-service]', form);
    if (svc) svc.addEventListener('change', function () {
      var o = svc.options[svc.selectedIndex];
      if (o && o.value) addLine({ serviceId: o.value, name: o.getAttribute('data-name'), price: o.getAttribute('data-price') });
      svc.value = '';
    });
    var custom = $('[data-cx-add-custom]', form);
    if (custom) custom.addEventListener('click', function () { addLine({}); });

    form.addEventListener('click', function (e) {
      var rm = e.target.closest('[data-cx-remove]');
      if (rm) {
        var tr = rm.closest('[data-cx-line]');
        if ($$('[data-cx-line]', body).length > 1) tr.remove();
        else { tr.querySelector('[name$="[unit_price]"]').value = ''; tr.querySelector('[name$="[name]"]').focus(); }
        compute();
      }
    });
    form.addEventListener('input', function (e) {
      if (e.target === splitCash || e.target === splitCard) {
        lastSplit = e.target === splitCash ? 'cash' : 'card';
        // Typing one part fills the other with what is left.
        var other = e.target === splitCash ? splitCard : splitCash;
        if (state.patient > 0 && has(e.target)) other.value = String(Math.max(0, round(state.patient - num(e.target))));
      }
      compute();
    });
    form.addEventListener('change', function (e) {
      if (e.target === insurer && insurer.value) {
        var o = insurer.options[insurer.selectedIndex];
        var pct = o ? o.getAttribute('data-coverage') : '';
        if (coverage && pct && Number(pct) > 0 && !has(coverage)) coverage.value = pct;
      }
      if (e.target.name === 'coverage_type') {
        var amt = e.target.value === 'amount';
        var p = $('[data-cx-cov-pct]', form); var a = $('[data-cx-cov-amt]', form);
        if (p) p.hidden = amt; if (a) a.hidden = !amt;
      }
      if (e.target.name === 'payment_method') {
        compute();
        if (state.method === 'mixed' && splitCash && !has(splitCash) && !has(splitCard)) { splitCash.focus(); }
        else if (state.method === 'cash' && received) received.focus();
        return;
      }
      compute();
    });

    var submitting = false;
    form.addEventListener('submit', function (e) {
      compute();
      var problem = '';
      if (state.method === 'mixed' && state.patient > 0 && state.warn) problem = state.warn;
      if (state.cashDue > 0 && has(received) && round(num(received)) < state.cashDue) problem = texts.cash_short;
      if (state.changed && reasonBox && !has(field('adjust_reason'))) { problem = texts.reason_needed; reasonBox.hidden = false; }
      if (problem || submitting) {
        e.preventDefault();
        var w = out('warn');
        if (w && problem) { w.textContent = problem; w.hidden = false; }
        if (problem && state.changed && reasonBox && !has(field('adjust_reason'))) field('adjust_reason').focus();
        return;
      }
      submitting = true;
      if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.classList.add('is-busy'); }
    });

    // Close: in a dialog → close it; inline on the cashier page → back to the queue.
    $$('[data-cx-close]', form).forEach(function (b) {
      b.addEventListener('click', function () {
        var dlg = form.closest('dialog');
        if (dlg) dlg.close(); else location.href = '/app/cashier';
      });
    });

    compute();
    setTimeout(function () {
      var first = form.querySelector('.is-invalid') || (state.method === 'cash' && state.cashDue > 0 ? received : null) || confirmBtn;
      if (first && typeof first.focus === 'function') first.focus();
    }, 60);
  }

  $$('[data-cx-panel]').forEach(initPanel);

  /* ================================================================ opening the panel in a dialog */
  var dialog = document.querySelector('[data-cx-dialog]');
  var dialogBody = dialog ? dialog.querySelector('[data-cx-dialog-body]') : null;
  if (dialog) {
    dialog.addEventListener('close', function () {
      // Leave the address clean (?visit= would reopen the panel on the next refresh).
      if (/[?&]visit=/.test(location.search) && window.history && history.replaceState) history.replaceState(null, '', location.pathname + location.search.replace(/([?&])visit=\d+&?/, '$1').replace(/[?&]$/, ''));
    });
    // Clicking the backdrop does not close the panel (a half-entered payment must not vanish); Esc does.
  }
  function openPanel(id, ret, href) {
    if (!dialog || !dialogBody || typeof dialog.showModal !== 'function' || !window.fetch) { location.href = href; return; }
    dialogBody.innerHTML = '<div class="cx-loading"><span class="spinner" aria-hidden="true"></span><span>' + (pageTexts.loading || '') + '</span></div>';
    if (!dialog.open) dialog.showModal();
    fetch('/app/cashier/screen/panel/' + encodeURIComponent(id) + '?return=' + encodeURIComponent(ret || 'screen'), { credentials: 'same-origin', headers: { Accept: 'text/html' } })
      .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.text(); })
      .then(function (html) {
        dialogBody.innerHTML = html;
        initPanel(dialogBody.querySelector('[data-cx-panel]'));
        var close = dialogBody.querySelector('[data-cx-close]');
        if (close && !dialogBody.querySelector('[data-cx-panel][data-cx-ready]')) close.addEventListener('click', function () { dialog.close(); });
      })
      .catch(function () {
        dialogBody.innerHTML = '<div class="cx-loading"><span>' + (pageTexts.failed || '') + '</span></div>';
        setTimeout(function () { location.href = href; }, 1200);
      });
  }
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('[data-cx-open]');
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (!dialog) return; // no billing access here: the link goes to the cashier page
    e.preventDefault();
    var dd = a.closest('details.dropdown'); if (dd) dd.removeAttribute('open');
    openPanel(a.getAttribute('data-cx-open'), a.getAttribute('data-cx-return'), a.getAttribute('href'));
  });

  /* ================================================================ printing in a hidden frame */
  var frame = null;
  function printFrame() {
    frame = frame || document.querySelector('[data-cx-print-frame]');
    if (!frame) {
      frame = document.createElement('iframe');
      frame.className = 'cx-print-frame'; frame.setAttribute('aria-hidden', 'true'); frame.tabIndex = -1; frame.title = 'print';
      document.body.appendChild(frame);
    }
    return frame;
  }
  function printUrl(url) {
    var f = printFrame();
    f.src = url + (url.indexOf('autoprint=1') < 0 ? (url.indexOf('?') < 0 ? '?' : '&') + 'autoprint=1' : '');
  }
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[data-cx-print]');
    if (!a || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    var dd = a.closest('details.dropdown'); if (dd) dd.removeAttribute('open');
    printUrl(a.getAttribute('href'));
  });

  // "Paid" panel: the receipt prints once on its own.
  var done = document.querySelector('[data-cx-done]');
  if (done) {
    var box = done.querySelector('[data-cx-autoprint]');
    var url = box && box.getAttribute('data-cx-autoprint');
    var key = 'cx-printed:' + (url || '');
    if (url && !sstore(function (s) { return s.getItem(key); })) {
      sstore(function (s) { s.setItem(key, '1'); });
      setTimeout(function () { printUrl(url); }, 250);
    }
    var back = done.querySelector('[data-cx-autofocus]');
    if (back) setTimeout(function () { back.focus(); }, 80);
    done.addEventListener('close', function () {
      if (/[?&]paid=/.test(location.search) && window.history && history.replaceState) history.replaceState(null, '', location.pathname + location.search.replace(/([?&])paid=\d+&?/, '$1').replace(/[?&]$/, ''));
    });
  }

  /* ================================================================ cash screen */
  var screen = document.querySelector('[data-cx-screen]');
  if (!screen) return;
  var board = screen.querySelector('[data-cx-board]');
  var totalsBox = screen.querySelector('[data-cx-totals]');
  var notice = screen.querySelector('[data-cx-notice]');
  var liveBox = screen.querySelector('[data-cx-live]');
  var readyKey = screen.getAttribute('data-ready-key') || '';
  var boardUrl = screen.getAttribute('data-board-url');

  // Clock in the clinic's time zone.
  var clock = screen.querySelector('[data-cx-clock]');
  if (clock) {
    var tz = clock.getAttribute('data-tz') || undefined;
    var tf = null;
    try { tf = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz }); } catch (e) { tf = null; }
    var tick = function () { var d = new Date(); clock.textContent = tf ? tf.format(d) : d.toTimeString().slice(0, 5); };
    tick(); setInterval(tick, 10000);
  }

  // Full screen (only when the user asks — the Fullscreen API needs a click).
  var fsBtn = screen.querySelector('[data-cx-fullscreen]');
  var root = document.documentElement;
  var fsOk = !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
  function isFs() { return !!(document.fullscreenElement || document.webkitFullscreenElement); }
  function enterFs() { var fn = root.requestFullscreen || root.webkitRequestFullscreen; if (fn && !isFs()) { try { var p = fn.call(root); if (p && p.catch) p.catch(function () {}); } catch (e) { /* refused */ } } }
  function exitFs() { var fn = document.exitFullscreen || document.webkitExitFullscreen; if (fn && isFs()) { try { var p = fn.call(document); if (p && p.catch) p.catch(function () {}); } catch (e) { /* ignore */ } } }
  function fsLabel() {
    if (!fsBtn) return;
    var l = fsBtn.querySelector('[data-cx-fs-label]');
    if (l) l.textContent = isFs() ? l.getAttribute('data-on') : l.getAttribute('data-off');
    document.body.classList.toggle('cx-is-fs', isFs());
  }
  if (fsBtn && fsOk) {
    fsBtn.hidden = false;
    fsBtn.addEventListener('click', function () { if (isFs()) exitFs(); else enterFs(); });
    document.addEventListener('fullscreenchange', fsLabel);
    document.addEventListener('webkitfullscreenchange', fsLabel);
  }
  // Opened with "Open cash screen" (?fs=1): the first tap on the screen goes full screen.
  if (fsOk && /[?&]fs=1/.test(location.search)) {
    var once = function (e) { if (e.target.closest && e.target.closest('[data-cx-exit]')) return; enterFs(); document.removeEventListener('pointerdown', once, true); };
    document.addEventListener('pointerdown', once, true);
  }
  var exitLink = screen.querySelector('[data-cx-exit]');
  if (exitLink) exitLink.addEventListener('click', function () { exitFs(); });

  // Soft chime (Web Audio; unlocked by the first click / key press — browsers block sound before that).
  var soundBtn = screen.querySelector('[data-cx-sound]');
  var soundOn = store(function (s) { return s.getItem('cx-sound'); }) !== '0';
  var audio = null;
  function unlock() { if (audio || !(window.AudioContext || window.webkitAudioContext)) return; try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { audio = null; } }
  document.addEventListener('pointerdown', unlock, { once: true, capture: true });
  document.addEventListener('keydown', unlock, { once: true, capture: true });
  function soundUi() {
    if (!soundBtn) return;
    soundBtn.setAttribute('aria-pressed', soundOn ? 'true' : 'false');
    var on = soundBtn.querySelector('[data-cx-sound-on]'); var off = soundBtn.querySelector('[data-cx-sound-off]');
    if (on) on.hidden = !soundOn; if (off) off.hidden = soundOn;
  }
  if (soundBtn) soundBtn.addEventListener('click', function () { soundOn = !soundOn; store(function (s) { s.setItem('cx-sound', soundOn ? '1' : '0'); }); soundUi(); if (soundOn) chime(); });
  soundUi();
  function chime() {
    if (!soundOn || !audio) return;
    try {
      if (audio.state === 'suspended' && audio.resume) audio.resume();
      var t0 = audio.currentTime;
      [[659.25, 0], [880, 0.16]].forEach(function (n) {
        var o = audio.createOscillator(); var g = audio.createGain();
        o.type = 'sine'; o.frequency.value = n[0];
        g.gain.setValueAtTime(0.0001, t0 + n[1]);
        g.gain.exponentialRampToValueAtTime(0.12, t0 + n[1] + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + n[1] + 0.5);
        o.connect(g); g.connect(audio.destination);
        o.start(t0 + n[1]); o.stop(t0 + n[1] + 0.55);
      });
    } catch (e) { /* no sound */ }
  }

  function idsOf(key) { return String(key || '').split(',').filter(Boolean).map(function (x) { return x.split(':')[0]; }); }
  var noticeTimer = null;
  function announce(ids) {
    var names = [];
    ids.forEach(function (id) {
      var li = board.querySelector('[data-cx-id="' + id + '"]');
      if (!li) return;
      li.classList.add('is-new');
      setTimeout(function () { li.classList.remove('is-new'); }, 6000);
      var n = li.querySelector('.cx-v-name'); var a = li.querySelector('.cx-v-amount .num');
      names.push(String(pageTexts.newReady || '{name}').replace('{name}', n ? n.textContent.trim() : '').replace('{amount}', a ? a.textContent.trim() : ''));
    });
    if (!names.length || !notice) return;
    notice.textContent = names.join(' · ');
    notice.hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(function () { notice.hidden = true; }, 9000);
    chime();
  }

  var loading = false; var again = false; var lastLoad = 0;
  function busy() { return !!board.querySelector('details.dropdown[open]'); }
  function refresh() {
    if (loading) { again = true; return; }
    if (busy()) { setTimeout(refresh, 2000); return; }
    loading = true; lastLoad = Date.now();
    fetch(boardUrl, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (r) { if (r.status === 401 || r.status === 403) { location.reload(); throw new Error('auth'); } if (!r.ok) throw new Error(String(r.status)); return r.json(); })
      .then(function (d) {
        var before = idsOf(readyKey);
        board.innerHTML = d.board;
        if (totalsBox) totalsBox.innerHTML = d.totals;
        var fresh = idsOf(d.readyKey).filter(function (id) { return before.indexOf(id) < 0; });
        readyKey = d.readyKey || '';
        if (fresh.length) announce(fresh);
      })
      .catch(function () { /* next tick */ })
      .then(function () { loading = false; if (again) { again = false; setTimeout(refresh, 300); } });
  }

  // Live: the clinic's agenda feed (SSE). Without it (or while it is down) poll every 10 s.
  function liveUi(on) {
    if (!liveBox) return;
    liveBox.classList.toggle('is-on', on);
    var tx = liveBox.querySelector('[data-cx-live-text]');
    if (tx) tx.textContent = on ? pageTexts.live_on : pageTexts.live_off;
    liveBox.setAttribute('title', on ? pageTexts.live_on : pageTexts.live_off);
  }
  var connected = false;
  setInterval(function () { if (!connected || Date.now() - lastLoad > 60000) refresh(); }, 10000);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') refresh(); });
  if (window.EventSource) {
    var es = null; var failures = 0;
    var connect = function () {
      es = new EventSource('/app/live/events');
      es.addEventListener('hello', function () { connected = true; failures = 0; liveUi(true); });
      es.addEventListener('appointments', function (e) {
        var ev; try { ev = JSON.parse(e.data); } catch (x) { ev = {}; }
        var dates = ev.dates || (ev.date ? [ev.date] : []);
        if (!ev.today || !dates.length || dates.indexOf(ev.today) >= 0) refresh();
      });
      es.onerror = function () {
        connected = false; liveUi(false); failures += 1;
        if (failures > 5 && es) { es.close(); es = null; setTimeout(function () { failures = 0; connect(); }, 60000); }
      };
    };
    connect();
    window.addEventListener('beforeunload', function () { if (es) es.close(); });
  }
  // Payments made on this screen also refresh the totals: the "paid" dialog comes back with a fresh board anyway.
}());

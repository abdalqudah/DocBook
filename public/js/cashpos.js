/* Cash screen (POS) — /app/cashier/screen (pages/clinic/cashier/screen.ejs).
   Left/right like the clinic's old accounting screen: today's unpaid appointments as cards (search, tap to add) and
   the payment being prepared (several appointments at once, each with its full price, discount % and insurance
   company; one payment method: cash, card, cash + card, insurance). "Complete payment" issues one invoice per
   appointment on the server (POST /app/cashier/screen/checkout — every figure is recomputed there) and shows the
   receipt with Print (hidden frame, so full screen is kept). Opens full screen, updates live (SSE, polling as a
   fallback) with a soft chime when a doctor finishes a visit. Keyboard: Enter pays, Esc clears, F2 searches.
   No inline scripts (CSP): data and texts come from the JSON island #pos-data. */
(function () {
  'use strict';

  var root = document.querySelector('[data-pos]');
  var island = document.getElementById('pos-data');
  if (!root || !island) return;
  var D;
  try { D = JSON.parse(island.textContent || '{}'); } catch (e) { return; }
  var T = D.texts || {};
  var I = D.icons || {};

  function $(sel, el) { return (el || document).querySelector(sel); }
  function $$(sel, el) { return Array.prototype.slice.call((el || document).querySelectorAll(sel)); }
  function esc(s) { return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function tr(tpl, vars) { return String(tpl || '').replace(/\{(\w+)\}/g, function (m, k) { return vars && vars[k] !== undefined ? vars[k] : m; }); }
  function sstore(fn) { try { return fn(window.sessionStorage); } catch (e) { return null; } }
  function lstore(fn) { try { return fn(window.localStorage); } catch (e) { return null; } }

  /* ---------------------------------------------------------------- money */
  var decimals = typeof D.decimals === 'number' ? D.decimals : 2;
  var factor = Math.pow(10, decimals);
  var nf = null;
  try { nf = new Intl.NumberFormat(D.locale === 'ar' ? 'ar-EG-u-nu-latn' : 'en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }); } catch (e) { nf = null; }
  function round(v) { var n = Number(v) || 0; var s = n < 0 ? -1 : 1; return (s * Math.round(Math.abs(n) * factor + 1e-9)) / factor; }
  function fmt(v) { return nf ? nf.format(round(v)) : round(v).toFixed(decimals); }
  function money(v) { return fmt(v) + ' ' + (D.currency || ''); }
  function digits(s) { return String(s === null || s === undefined ? '' : s).replace(/[٠-٩]/g, function (c) { return String(c.charCodeAt(0) - 0x0660); }).replace(/[۰-۹]/g, function (c) { return String(c.charCodeAt(0) - 0x06F0); }).replace(/٫/g, '.').replace(/[,٬\s]/g, ''); }
  function num(s) { var v = parseFloat(digits(s)); return isFinite(v) ? v : 0; }
  function has(s) { return String(s === null || s === undefined ? '' : s).trim() !== ''; }
  function pct(s) { return Math.max(0, Math.min(100, num(s))); }

  /* ---------------------------------------------------------------- elements */
  var grid = $('[data-pos-grid]', root);
  var search = $('[data-pos-search]', root);
  var countBox = $('[data-pos-count]', root);
  var linesBox = $('[data-pos-lines]', root);
  var billN = $('[data-pos-bill-n]', root);
  var clearBtn = $('[data-pos-clear]', root);
  var payBtn = $('[data-pos-pay]', root);
  var payLabel = $('[data-pos-pay-label]', root);
  var warnBox = $('[data-pos-warn]', root);
  var received = $('[data-pos-received]', root);
  var receivedMixed = $('[data-pos-received-mixed]', root);
  var splitCash = $('[data-pos-split="cash"]', root);
  var splitCard = $('[data-pos-split="card"]', root);
  var splitNote = $('[data-pos-split-note]', root);
  var quick = $('[data-pos-quick]', root);
  var alertBox = $('[data-pos-alert]', root);
  var notice = $('[data-pos-notice]', root);
  var mobileBar = $('[data-pos-sheet-open]', root);
  var scrim = $('[data-pos-scrim]', root);
  var doneDlg = document.querySelector('[data-pos-done]');
  var frame = document.querySelector('[data-pos-frame]');

  /* ---------------------------------------------------------------- state */
  var visits = D.visits || [];
  var byId = {};
  function index() { byId = {}; visits.forEach(function (v) { byId[v.id] = v; }); }
  index();
  var insurers = D.insurers || [];
  var insurerById = {};
  insurers.forEach(function (i) { insurerById[i.id] = i; });
  var bill = [];               // [{ id, v (visit), amount, discount, insurer, coverage, reason, edited }]
  var method = 'cash';
  var busy = false;
  var lastSale = null;
  var STORE_KEY = 'pos-bill:' + (D.today || '');

  function inBill(id) { return bill.some(function (l) { return l.id === id; }); }
  function lineOf(id) { return bill.filter(function (l) { return l.id === id; })[0] || null; }

  function save() {
    sstore(function (s) {
      s.setItem(STORE_KEY, JSON.stringify({ method: method, lines: bill.map(function (l) { return { id: l.id, amount: l.amount, discount: l.discount, insurer: l.insurer, coverage: l.coverage, reason: l.reason, edited: l.edited }; }) }));
    });
  }

  /* ---------------------------------------------------------------- alerts */
  var alertTimer = null;
  function showAlert(msg) {
    if (!alertBox) return;
    $('[data-pos-alert-text]', alertBox).textContent = msg;
    alertBox.hidden = false;
    clearTimeout(alertTimer);
    alertTimer = setTimeout(function () { alertBox.hidden = true; }, 8000);
  }
  function hideAlert() { if (alertBox) alertBox.hidden = true; }
  var closeAlert = $('[data-pos-alert-close]', root);
  if (closeAlert) closeAlert.addEventListener('click', hideAlert);
  var noticeTimer = null;
  function showNotice(msg) {
    if (!notice || !msg) return;
    notice.textContent = msg;
    notice.hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(function () { notice.hidden = true; }, 9000);
  }

  /* ---------------------------------------------------------------- header: today's totals */
  function renderToday(t) {
    var box = $('[data-pos-today]', root);
    if (!box || !t) return;
    var bm = t.byMethod || {};
    box.innerHTML = '<div class="pos-today-main"><dt>' + esc(T.collected_today) + '</dt><dd><span class="num">' + esc(fmt(t.total)) + '</span> <span class="pos-cur">' + esc(D.currency) + '</span></dd></div>'
      + '<div><dt>' + esc(T.method.cash) + '</dt><dd class="num">' + esc(fmt(bm.cash || 0)) + '</dd></div>'
      + '<div><dt>' + esc(T.method.card) + '</dt><dd class="num">' + esc(fmt(bm.card || 0)) + '</dd></div>'
      + '<div><dt>' + esc(T.receipts) + '</dt><dd class="num">' + esc(t.count || 0) + '</dd></div>';
  }

  /* ---------------------------------------------------------------- the grid of appointments */
  var COLOR = /^#[0-9a-fA-F]{3,8}$|^[a-zA-Z]{3,20}$/;
  function matches(v, q) {
    if (!q) return true;
    var s = q.toLowerCase();
    return String(v.patient || '').toLowerCase().indexOf(s) >= 0 || String(v.phone || '').replace(/\s/g, '').indexOf(digits(q)) >= 0 || String(v.doctor || '').toLowerCase().indexOf(s) >= 0;
  }
  function filtered() { var q = search ? String(search.value || '').trim() : ''; return visits.filter(function (v) { return matches(v, q); }); }

  function cardHtml(v) {
    var added = inBill(v.id);
    var when = (v.online ? I.online : I.clinic) + '<span class="num" dir="ltr">' + esc(v.time) + '</span>' + (v.date !== D.today ? '<span>· ' + esc(v.dateText) + '</span>' : '');
    var amount = v.due > 0
      ? '<span class="num">' + esc(fmt(v.due)) + '</span> <span class="pos-cur">' + esc(D.currency) + '</span>'
      : '<span class="pos-card-none">' + esc(T.no_amount) + '</span>';
    var dot = v.doctorColor && COLOR.test(v.doctorColor) ? ' style="background:' + esc(v.doctorColor) + '"' : '';
    return '<button type="button" class="pos-card is-' + esc(v.state) + (added ? ' is-in' : '') + '" data-pos-card="' + v.id + '"' + (added ? ' disabled aria-disabled="true"' : '') + '>'
      + '<span class="pos-card-top"><span class="pos-card-when" title="' + esc(v.online ? T.online : T.in_person) + '">' + when + '</span>' + (added ? '<span class="pos-tag">' + esc(T.added) + '</span>' : '') + '</span>'
      + '<span class="pos-card-name"><bdi>' + esc(v.patient) + '</bdi></span>'
      + '<span class="pos-card-doc">' + (v.doctor ? '<i class="pos-dot"' + dot + ' aria-hidden="true"></i>' + esc(v.doctor) : esc(T.no_doctor)) + (v.room ? ' · <b class="pos-room">' + esc(v.room) + '</b>' : '') + '</span>'
      + (v.practice ? '<span class="pos-card-practice">' + esc(v.practice) + '</span>' : '')
      + '<span class="pos-card-state"><i class="pos-sdot is-' + esc(v.state) + '" aria-hidden="true"></i>' + esc((T.state || {})[v.state] || '') + '</span>'
      + '<span class="pos-card-amount">' + amount + (v.due > 0 ? '<span class="pos-card-src">' + esc(v.fromDoctor ? T.set_by_doctor : T.expected_fee) + '</span>' : '') + '</span>'
      + '</button>';
  }

  // Side column: who is waiting and who is with the doctor — for information only: a visit is paid once the doctor is
  // done (no early payment, so no second invoice when the doctor adds to the bill). The grid keeps the rest.
  var SIDE = ['arrived', 'with_doctor'];
  var side = $('[data-pos-side]', root);
  function renderSide(list) {
    if (!side) return;
    var typing = document.activeElement && side.contains(document.activeElement) && document.activeElement.tagName === 'INPUT';
    if (typing) return; // a refresh never wipes an amount being typed
    SIDE.forEach(function (k) {
      var items = list.filter(function (v) { return v.state === k; });
      var box = $('[data-pos-side-list="' + k + '"]', side); var n = $('[data-pos-side-n="' + k + '"]', side);
      if (n) n.textContent = String(items.length);
      if (!box) return;
      box.innerHTML = items.length ? items.map(function (v) {
        var dot = v.doctorColor && COLOR.test(v.doctorColor) ? ' style="background:' + esc(v.doctorColor) + '"' : '';
        var act = k === 'arrived'
          ? '<button type="button" class="pos-side-btn" data-pos-callin="' + v.id + '">' + esc(T.call_in) + '</button>'
          : '<form class="pos-side-finish" data-pos-finish="' + v.id + '"><input class="pos-side-amt" name="amount" inputmode="decimal" autocomplete="off" value="' + (v.due > 0 ? esc(String(round(v.due))) : '') + '" placeholder="' + esc(T.amount_ph) + '" aria-label="' + esc(T.amount_ph) + '"><button type="submit" class="pos-side-btn is-primary">' + esc(T.finish) + '</button></form>';
        return '<div class="pos-side-row">'
          + '<div class="pos-side-top"><span class="pos-side-time num" dir="ltr">' + esc(v.time) + '</span>'
          + '<span class="pos-side-who"><span class="pos-side-name"><bdi>' + esc(v.patient) + '</bdi></span><span class="pos-side-doc">' + (v.doctor ? '<i class="pos-dot"' + dot + ' aria-hidden="true"></i>' + esc(v.doctor) : esc(T.no_doctor)) + (v.room ? ' · <b class="pos-room">' + esc(v.room) + '</b>' : '') + '</span>' + (v.practice ? '<span class="pos-card-practice">' + esc(v.practice) + '</span>' : '') + '</span></div>'
          + act + '</div>';
      }).join('') : '<p class="pos-side-empty">' + esc((T.side_none || {})[k] || '') + '</p>';
    });
  }
  function renderGrid() {
    var all = filtered();
    renderSide(all);
    var list = all.filter(function (v) { return SIDE.indexOf(v.state) < 0; }); // waiting / with the doctor: not payable yet
    if (!visits.length) {
      grid.innerHTML = '<div class="pos-empty"><strong>' + esc(T.empty_title) + '</strong><span>' + esc(T.empty_text) + '</span></div>';
    } else if (!list.length) {
      grid.innerHTML = '<div class="pos-empty"><span>' + esc(all.length ? T.empty_text : T.no_match) + '</span></div>';
    } else {
      grid.innerHTML = list.map(cardHtml).join('');
    }
    if (countBox) countBox.textContent = visits.length ? tr(T.count, { n: visits.length }) : '';
  }

  var onPick = function (e) {
    var b = e.target.closest && e.target.closest('[data-pos-card]');
    if (!b || b.disabled) return;
    add(Number(b.getAttribute('data-pos-card')), true);
  };
  grid.addEventListener('click', onPick);

  // Side actions: send a waiting patient in to the doctor; finish a visit with the amount (it then waits for payment).
  function sideCall(url, body, btn) {
    if (btn) btn.disabled = true;
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-csrf-token': D.csrf }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
      .then(function (d) { if (!d.ok) showAlert(d.error || T.failed); else hideAlert(); })
      .catch(function () { showAlert(T.failed); })
      .then(function () { if (btn) btn.disabled = false; if (document.activeElement && side && side.contains(document.activeElement)) document.activeElement.blur(); refresh(); });
  }
  if (side) {
    side.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('[data-pos-callin]');
      if (b) sideCall('/app/cashier/screen/visit/' + b.getAttribute('data-pos-callin') + '/call-in', {}, b);
    });
    side.addEventListener('submit', function (e) {
      var f = e.target.closest && e.target.closest('[data-pos-finish]');
      if (!f) return;
      e.preventDefault();
      var amt = f.querySelector('[name="amount"]');
      if (!amt.value.trim()) { amt.focus(); return; }
      sideCall('/app/cashier/screen/visit/' + f.getAttribute('data-pos-finish') + '/finish', { amount: amt.value.trim() }, f.querySelector('button'));
    });
  }

  /* ---------------------------------------------------------------- the payment (bill) */
  function add(id, focus) {
    var v = byId[id];
    if (!v || inBill(id) || SIDE.indexOf(v.state) >= 0) return; // still waiting / with the doctor: not payable yet
    // One patient per payment: choosing another patient replaces the one being prepared (each invoice closes alone).
    bill = [];
    bill.push({ id: id, v: v, amount: v.due > 0 ? String(round(v.due)) : '', discount: '', insurer: '', coverage: '', reason: '', edited: false });
    hideAlert();
    renderBill();
    renderGrid();
    save();
    var line = linesBox.querySelector('[data-pos-line="' + id + '"]');
    if (line && line.scrollIntoView) line.scrollIntoView({ block: 'nearest' });
    if (focus && !(v.due > 0) && line) { var a = line.querySelector('[data-f="amount"]'); if (a) a.focus(); }
  }
  function remove(id) {
    bill = bill.filter(function (l) { return l.id !== id; });
    renderBill(); renderGrid(); save();
  }
  function clearBill() {
    bill = [];
    if (received) received.value = '';
    if (receivedMixed) receivedMixed.value = '';
    if (splitCash) splitCash.value = '';
    if (splitCard) splitCard.value = '';
    hideAlert();
    renderBill(); renderGrid(); save();
    sheet(false);
  }

  function lineHtml(l) {
    var v = l.v;
    var sub = [v.doctor || T.no_doctor, v.time, v.what].filter(Boolean).map(esc).join(' · ');
    var rx = (v.rxs || []).map(function (href) { return '<a class="btn btn-ghost btn-icon btn-sm" href="' + esc(href) + '" target="_blank" rel="noopener" title="' + esc(T.rx) + '" aria-label="' + esc(T.rx) + '">' + I.pill + '</a>'; }).join('');
    var ins = '';
    if (insurers.length) {
      ins = '<div class="pos-line-ins"><label class="pos-f"><span>' + I.shield + esc(T.insurer) + '</span><select class="select" data-f="insurer"><option value="">' + esc(T.no_insurance) + '</option>'
        + insurers.map(function (i) { return '<option value="' + i.id + '"' + (String(l.insurer) === String(i.id) ? ' selected' : '') + '>' + esc(i.name) + '</option>'; }).join('')
        + '</select></label><label class="pos-f pos-f-cov" data-cov' + (l.insurer ? '' : ' hidden') + '><span>' + esc(T.coverage_pct) + '</span><input class="input num" type="text" inputmode="decimal" dir="ltr" data-f="coverage" value="' + esc(l.coverage) + '" placeholder="0"></label></div>';
    }
    return '<div class="pos-line" data-pos-line="' + l.id + '">'
      + '<div class="pos-line-top"><div class="pos-line-who"><p class="pos-line-name"><bdi>' + esc(v.patient) + '</bdi></p><p class="pos-line-sub">' + sub + '</p></div>'
      + rx + '<button class="btn btn-ghost btn-icon btn-sm pos-line-rm" type="button" data-pos-rm title="' + esc(T.remove) + '" aria-label="' + esc(T.remove) + '">' + I.trash + '</button></div>'
      + '<div class="pos-line-grid">'
      + '<label class="pos-f"><span>' + esc(T.amount) + '</span><input class="input num" type="text" inputmode="decimal" dir="ltr" data-f="amount" value="' + esc(l.amount) + '" placeholder="0"></label>'
      + '<label class="pos-f"><span>' + esc(T.discount_pct) + '</span><input class="input num" type="text" inputmode="decimal" dir="ltr" data-f="discount" value="' + esc(l.discount) + '" placeholder="0"></label>'
      + '</div>' + ins
      + '<label class="pos-f pos-f-reason" data-reason hidden><span class="sr-only">' + esc(T.reason_ph) + '</span><input class="input" type="text" maxlength="255" data-f="reason" value="' + esc(l.reason) + '" placeholder="' + esc(T.reason_ph) + '"></label>'
      + '<p class="pos-line-net" data-net hidden></p>'
      + '</div>';
  }

  function renderBill() {
    if (!bill.length) linesBox.innerHTML = '<p class="pos-bill-empty">' + esc(T.bill_empty) + '</p>';
    else linesBox.innerHTML = bill.map(lineHtml).join('');
    if (billN) billN.textContent = bill.length ? '(' + bill.length + ')' : '';
    if (clearBtn) clearBtn.hidden = !bill.length;
    compute();
  }

  /** Mirrors cashier.service planSale (the server recomputes everything). */
  function lineMaths(l) {
    var amount = round(num(l.amount));
    var discount = round(amount * pct(l.discount) / 100);
    var total = round(amount - discount);
    var ins = 0;
    if (method === 'insurance') ins = total;
    else if (l.insurer && pct(l.coverage) > 0) ins = round(total * pct(l.coverage) / 100);
    return { amount: amount, discount: discount, total: total, insurance: ins, patient: round(total - ins) };
  }
  function needsReason(l) { return l.v.fromDoctor && has(l.amount) && round(num(l.amount)) !== round(l.v.due); }

  var state = { patient: 0, cashDue: 0, warn: '', change: 0 };
  function compute() {
    var tDisc = 0; var tIns = 0; var tPatient = 0; var tTotal = 0;
    bill.forEach(function (l) {
      var m = lineMaths(l);
      tDisc += m.discount; tIns += m.insurance; tPatient += m.patient; tTotal += m.total;
      var el = linesBox.querySelector('[data-pos-line="' + l.id + '"]');
      if (!el) return;
      var net = el.querySelector('[data-net]');
      var bits = [];
      if (m.discount > 0) bits.push(tr(T.after_discount, { v: fmt(m.total) }));
      if (m.insurance > 0 && method !== 'insurance') { bits.push(tr(T.insurer_pays, { v: fmt(m.insurance) })); bits.push(tr(T.patient_pays, { v: fmt(m.patient) })); }
      if (net) { net.textContent = bits.join(' · '); net.hidden = !bits.length; }
      var rs = el.querySelector('[data-reason]');
      if (rs) rs.hidden = !needsReason(l) && !has(l.reason);
      var cov = el.querySelector('[data-cov]');
      if (cov) cov.hidden = !l.insurer || method === 'insurance';
    });
    tDisc = round(tDisc); tIns = round(tIns); tPatient = round(tPatient); tTotal = round(tTotal);

    function out(k, v) { var o = root.querySelector('[data-pos-out="' + k + '"]'); if (o) o.textContent = v; }
    function row(k, on) { var o = root.querySelector('[data-pos-row="' + k + '"]'); if (o) o.hidden = !on; }
    row('discount', tDisc > 0); out('discount', '− ' + fmt(tDisc));
    row('insurance', tIns > 0); out('insurance', fmt(tIns));
    out('total', fmt(tPatient));

    $$('[data-pos-when]', root).forEach(function (el) { el.hidden = el.getAttribute('data-pos-when') !== method || (method !== 'insurance' && !(tPatient > 0)); });

    var warn = '';
    var cashDue = 0; var change = 0;
    if (method === 'cash') cashDue = tPatient;
    if (method === 'mixed' && tPatient > 0) {
      cashDue = round(num(splitCash.value));
      var diff = round(tPatient - round(num(splitCash.value) + num(splitCard.value)));
      var any = has(splitCash.value) || has(splitCard.value);
      var msg = !any ? '' : diff === 0 ? T.split_ok : diff > 0 ? tr(T.split_left, { v: fmt(diff) }) : tr(T.split_over, { v: fmt(-diff) });
      if (splitNote) { splitNote.textContent = msg; splitNote.className = 'pos-note' + (any ? (diff === 0 ? ' is-ok' : ' is-off') : ''); }
      if (diff !== 0) warn = diff > 0 ? tr(T.split_left, { v: fmt(diff) }) : tr(T.split_over, { v: fmt(-diff) });
    }
    var recEl = method === 'mixed' ? receivedMixed : received;
    if (cashDue > 0 && recEl && has(recEl.value)) {
      change = round(num(recEl.value) - cashDue);
      if (change < 0) warn = T.cash_short;
    }
    var ch = $('[data-pos-change]', root); var chv = $('[data-pos-change-v]', root);
    if (ch) { ch.hidden = !(method === 'cash' && cashDue > 0 && has(received.value) && change >= 0); if (chv) chv.textContent = fmt(Math.max(0, change)); }
    var chm = $('[data-pos-change-mixed]', root); var chmv = $('[data-pos-change-mixed-v]', root);
    if (chm) { chm.hidden = !(method === 'mixed' && cashDue > 0 && has(receivedMixed.value) && change >= 0); if (chmv) chmv.textContent = fmt(Math.max(0, change)); }
    if (bill.some(function (l) { return needsReason(l) && !has(l.reason); })) warn = warn || T.reason_needed;

    if (warnBox) { warnBox.textContent = warn; warnBox.hidden = !warn || !bill.length; }
    payBtn.disabled = !bill.length || busy;
    payLabel.textContent = busy ? T.paying : T.checkout + (bill.length && tPatient > 0 && method !== 'insurance' ? ' · ' + fmt(tPatient) : '');
    state = { patient: tPatient, total: tTotal, cashDue: cashDue, warn: warn, change: change };
    quickNotes(method === 'cash' ? cashDue : 0);

    if (mobileBar) {
      mobileBar.hidden = !bill.length;
      var lb = $('[data-pos-mb-label]', mobileBar); var tt = $('[data-pos-mb-total]', mobileBar);
      if (lb) lb.textContent = tr(T.view_bill, { n: bill.length });
      if (tt) tt.textContent = money(tPatient);
    }
  }

  // Quick buttons for the cash handed over: exact + the next round amounts.
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
      b.textContent = i === 0 ? T.exact + ' · ' + fmt(v) : fmt(v);
      b.addEventListener('click', function () { received.value = String(round(v)); compute(); received.focus(); });
      quick.appendChild(b);
    });
  }

  linesBox.addEventListener('input', function (e) {
    var el = e.target; var f = el.getAttribute('data-f'); var box = el.closest('[data-pos-line]');
    if (!f || !box) return;
    var l = lineOf(Number(box.getAttribute('data-pos-line')));
    if (!l) return;
    l[f] = el.value;
    if (f === 'amount') l.edited = true;
    el.classList.remove('is-invalid');
    compute(); save();
  });
  linesBox.addEventListener('change', function (e) {
    var el = e.target; if (el.getAttribute('data-f') !== 'insurer') return;
    var box = el.closest('[data-pos-line]');
    var l = lineOf(Number(box.getAttribute('data-pos-line')));
    if (!l) return;
    l.insurer = el.value;
    var i = insurerById[el.value];
    if (i && !has(l.coverage) && i.coverage > 0) { l.coverage = String(i.coverage); var c = box.querySelector('[data-f="coverage"]'); if (c) c.value = l.coverage; }
    if (!el.value) { l.coverage = ''; var c2 = box.querySelector('[data-f="coverage"]'); if (c2) c2.value = ''; }
    compute(); save();
  });
  linesBox.addEventListener('click', function (e) {
    var rm = e.target.closest && e.target.closest('[data-pos-rm]');
    if (!rm) return;
    remove(Number(rm.closest('[data-pos-line]').getAttribute('data-pos-line')));
  });
  if (clearBtn) clearBtn.addEventListener('click', clearBill);

  $$('input[name="pos_method"]', root).forEach(function (r) {
    r.addEventListener('change', function () {
      if (!r.checked) return;
      method = r.value;
      compute(); save();
      if (method === 'mixed' && splitCash && !has(splitCash.value)) splitCash.focus();
      else if (method === 'cash' && received && state.cashDue > 0) received.focus();
    });
  });
  [received, receivedMixed].forEach(function (el) { if (el) el.addEventListener('input', compute); });
  [splitCash, splitCard].forEach(function (el) {
    if (!el) return;
    el.addEventListener('input', function () {
      // Typing one part fills the other with what is left.
      var other = el === splitCash ? splitCard : splitCash;
      if (state.patient > 0 && has(el.value)) other.value = String(Math.max(0, round(state.patient - num(el.value))));
      compute();
    });
  });

  /* ---------------------------------------------------------------- checkout */
  function payload() {
    var body = {
      payment_method: method,
      lines: bill.map(function (l) {
        return { appointment_id: l.id, amount: round(num(l.amount)), discount_percent: pct(l.discount), insurance_provider_id: l.insurer || '', coverage: l.insurer ? pct(l.coverage) : '', adjust_reason: needsReason(l) ? String(l.reason || '').trim() : '' };
      }),
    };
    if (method === 'cash' && has(received.value)) body.amount_received = round(num(received.value));
    if (method === 'mixed') {
      body.split_cash = round(num(splitCash.value)); body.split_card = round(num(splitCard.value));
      if (has(receivedMixed.value)) body.amount_received = round(num(receivedMixed.value));
    }
    return body;
  }

  function checkout() {
    if (busy || !bill.length) return;
    compute();
    if (state.warn) {
      showAlert(state.warn);
      var missing = bill.filter(function (l) { return needsReason(l) && !has(l.reason); })[0];
      if (missing) { var r = linesBox.querySelector('[data-pos-line="' + missing.id + '"] [data-f="reason"]'); if (r) { r.classList.add('is-invalid'); r.focus(); } }
      else if (method === 'mixed' && splitCash) splitCash.focus();
      else if (method === 'cash' && received) received.focus();
      return;
    }
    busy = true; compute(); hideAlert();
    var sale = bill.slice();
    fetch('/app/cashier/screen/checkout', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-csrf-token': D.csrf },
      body: JSON.stringify(payload()),
    }).then(function (r) {
      if (r.status === 401) { location.reload(); throw new Error('auth'); }
      return r.json().catch(function () { return { ok: false, error: T.failed }; });
    }).then(function (res) {
      busy = false;
      if (!res || !res.ok) { fail(res || {}); compute(); return; }
      done(res, sale);
    }).catch(function () { busy = false; compute(); showAlert(T.failed); });
  }
  payBtn.addEventListener('click', checkout);

  function fail(res) {
    var l = res.line ? lineOf(Number(res.line)) : null;
    var msg = res.error || T.failed;
    if (l) msg = tr(T.line_error, { name: l.v.patient, error: msg });
    showAlert(msg);
    if (l && (res.code === 'ALREADY_PAID' || res.code === 'NOT_FOUND' || res.code === 'APPOINTMENT_CANCELLED')) { remove(l.id); refresh(); return; }
    if (l) {
      var box = linesBox.querySelector('[data-pos-line="' + l.id + '"]');
      var f = res.field === 'adjust_reason' ? 'reason' : res.field === 'coverage' ? 'coverage' : res.field === 'discount_value' ? 'discount' : 'amount';
      var input = box && box.querySelector('[data-f="' + f + '"]');
      if (input) { if (f === 'reason') box.querySelector('[data-reason]').hidden = false; input.classList.add('is-invalid'); input.focus(); }
    } else if (res.field === 'amount_received') (method === 'mixed' ? receivedMixed : received).focus();
    else if (res.field === 'split_cash' || res.field === 'split_card') splitCash.focus();
  }

  function done(res, sale) {
    lastSale = res;
    var byAppt = {};
    (res.invoices || []).forEach(function (i) { byAppt[i.appointmentId] = i; });
    $('[data-pos-done-total]', doneDlg).textContent = fmt(res.total);
    var ch = $('[data-pos-done-change]', doneDlg);
    ch.hidden = !(res.change > 0);
    ch.textContent = res.change > 0 ? tr(T.give_change, { v: money(res.change) }) : '';
    $('[data-pos-done-nums]', doneDlg).textContent = tr(T.invoice_n, { list: (res.invoices || []).map(function (i) { return '#' + i.number; }).join(D.locale === 'ar' ? ' ، ' : ', ') });
    $('[data-pos-done-lines]', doneDlg).innerHTML = sale.map(function (l) {
      var inv = byAppt[l.id] || {};
      return '<li><span><bdi>' + esc(l.v.patient) + '</bdi>' + (l.v.doctor ? ' <span class="muted">— ' + esc(l.v.doctor) + '</span>' : '') + '</span><span class="num">' + esc(fmt(inv.total || 0)) + '</span></li>';
    }).join('');
    $('[data-pos-done-method]', doneDlg).textContent = tr(T.method_used, { m: (T.method || {})[method] || method });
    var pl = $('[data-pos-print-label]', doneDlg);
    if (pl) pl.textContent = (res.invoices || []).length > 1 ? tr(T.print_n, { n: res.invoices.length }) : T.print;
    // Reset for the next patient.
    bill = []; save();
    if (received) received.value = '';
    if (receivedMixed) receivedMixed.value = '';
    if (splitCash) splitCash.value = '';
    if (splitCard) splitCard.value = '';
    visits = visits.filter(function (v) { return !byAppt[v.id]; }); index();
    renderBill(); renderGrid(); sheet(false);
    if (doneDlg && typeof doneDlg.showModal === 'function') { if (!doneDlg.open) doneDlg.showModal(); }
    else if (doneDlg) doneDlg.setAttribute('open', '');
    var pb = $('[data-pos-print]', doneDlg);
    if (pb) setTimeout(function () { pb.focus(); }, 30);
    refresh();
  }

  function newSale() {
    if (doneDlg && doneDlg.open) doneDlg.close();
    lastSale = null;
    if (search) { search.value = ''; renderGrid(); search.focus(); }
  }
  if (doneDlg) {
    $$('[data-pos-new]', doneDlg).forEach(function (b) { b.addEventListener('click', newSale); });
    doneDlg.addEventListener('cancel', function (e) { e.preventDefault(); newSale(); });
    var pb = $('[data-pos-print]', doneDlg);
    if (pb) pb.addEventListener('click', function () {
      if (lastSale && lastSale.printUrl) printUrl(lastSale.printUrl);
      var nb = doneDlg.querySelector('.btn-primary[data-pos-new]');
      if (nb) setTimeout(function () { nb.focus(); }, 50);
    });
  }

  /* ---------------------------------------------------------------- printing (hidden frame: full screen is kept) */
  var fsBeforePrint = false;
  function printUrl(url) {
    if (!frame) { window.open(url, '_blank'); return; }
    fsBeforePrint = isFs();
    frame.onload = function () {
      try {
        frame.contentWindow.addEventListener('afterprint', function () { if (fsBeforePrint && !isFs()) enterFs(); });
      } catch (e) { /* cross-origin: not expected */ }
    };
    frame.src = url + (url.indexOf('autoprint=1') < 0 ? (url.indexOf('?') < 0 ? '?' : '&') + 'autoprint=1' : '');
  }
  window.addEventListener('afterprint', function () { if (fsBeforePrint && !isFs()) enterFs(); });
  // Some browsers leave full screen for the print dialog and refuse to come back without a tap: the next tap restores it.
  document.addEventListener('pointerdown', function () { if (fsBeforePrint && !isFs()) { fsBeforePrint = false; enterFs(); } }, true);

  /* ---------------------------------------------------------------- full screen */
  var fsBtn = $('[data-pos-fs]', root);
  var docEl = document.documentElement;
  var fsOk = !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
  function isFs() { return !!(document.fullscreenElement || document.webkitFullscreenElement); }
  function enterFs() { var fn = docEl.requestFullscreen || docEl.webkitRequestFullscreen; if (fn && !isFs()) { try { var p = fn.call(docEl); if (p && p.catch) p.catch(function () {}); } catch (e) { /* refused */ } } }
  function exitFs() { var fn = document.exitFullscreen || document.webkitExitFullscreen; if (fn && isFs()) { try { var p = fn.call(document); if (p && p.catch) p.catch(function () {}); } catch (e) { /* ignore */ } } }
  function fsUi() {
    if (!fsBtn) return;
    var on = isFs();
    $('[data-pos-fs-enter]', fsBtn).hidden = on; $('[data-pos-fs-exit]', fsBtn).hidden = !on;
    var label = on ? fsBtn.getAttribute('data-on') : fsBtn.getAttribute('data-off');
    fsBtn.setAttribute('title', label); fsBtn.setAttribute('aria-label', label);
    document.body.classList.toggle('pos-is-fs', on);
  }
  if (fsBtn && fsOk) {
    fsBtn.hidden = false;
    fsBtn.addEventListener('click', function () { if (isFs()) exitFs(); else enterFs(); });
    document.addEventListener('fullscreenchange', fsUi);
    document.addEventListener('webkitfullscreenchange', fsUi);
    fsUi();
  }
  if (fsOk) {
    // Opens full screen: right away when the browser allows it, otherwise on the first tap / key press.
    enterFs();
    var once = function (e) {
      document.removeEventListener('pointerdown', once, true); document.removeEventListener('keydown', once, true);
      if (e.target && e.target.closest && (e.target.closest('[data-pos-exit]') || e.target.closest('[data-pos-fs]'))) return;
      enterFs();
    };
    document.addEventListener('pointerdown', once, true);
    document.addEventListener('keydown', once, true);
  }
  var exitLink = $('[data-pos-exit]', root);
  if (exitLink) exitLink.addEventListener('click', function () { exitFs(); });

  /* ---------------------------------------------------------------- phones: the payment is a bottom sheet */
  function sheet(on) {
    document.body.classList.toggle('pos-sheet-on', !!on);
    if (scrim) scrim.hidden = !on;
  }
  if (mobileBar) mobileBar.addEventListener('click', function () { sheet(true); });
  if (scrim) scrim.addEventListener('click', function () { sheet(false); });
  var sc = $('[data-pos-sheet-close]', root);
  if (sc) sc.addEventListener('click', function () { sheet(false); });

  /* ---------------------------------------------------------------- keyboard */
  document.addEventListener('keydown', function (e) {
    if (doneDlg && doneDlg.open) return; // the receipt dialog: its buttons (Enter) and Esc (new payment)
    var t = e.target;
    var tag = t && t.tagName;
    if (e.key === 'F2' || (e.key === '/' && tag !== 'INPUT' && tag !== 'SELECT' && tag !== 'TEXTAREA')) { e.preventDefault(); if (search) search.focus(); return; }
    if (e.key === 'Escape') {
      if (document.body.classList.contains('pos-sheet-on')) { e.preventDefault(); sheet(false); return; }
      if (search && has(search.value)) { e.preventDefault(); search.value = ''; renderGrid(); search.focus(); return; }
      if (bill.length) { e.preventDefault(); clearBill(); if (search) search.focus(); }
      return;
    }
    if (e.key !== 'Enter' || e.isComposing || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
    if (t === search) {
      e.preventDefault();
      var first = filtered().filter(function (v) { return !inBill(v.id) && SIDE.indexOf(v.state) < 0; })[0];
      if (first) { add(first.id, false); search.select(); }
      return;
    }
    if (tag === 'BUTTON' || tag === 'A' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (!bill.length) return;
    e.preventDefault();
    checkout();
  });

  /* ---------------------------------------------------------------- sound */
  var soundBtn = $('[data-pos-sound]', root);
  var soundOn = lstore(function (s) { return s.getItem('cx-sound'); }) !== '0';
  var audio = null;
  function unlock() { if (audio || !(window.AudioContext || window.webkitAudioContext)) return; try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { audio = null; } }
  document.addEventListener('pointerdown', unlock, { once: true, capture: true });
  document.addEventListener('keydown', unlock, { once: true, capture: true });
  function soundUi() {
    if (!soundBtn) return;
    soundBtn.setAttribute('aria-pressed', soundOn ? 'true' : 'false');
    $('[data-pos-sound-on]', soundBtn).hidden = !soundOn; $('[data-pos-sound-off]', soundBtn).hidden = soundOn;
  }
  if (soundBtn) soundBtn.addEventListener('click', function () { soundOn = !soundOn; lstore(function (s) { s.setItem('cx-sound', soundOn ? '1' : '0'); }); soundUi(); if (soundOn) { unlock(); chime(); } });
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

  /* ---------------------------------------------------------------- clock */
  var clock = $('[data-pos-clock]', root);
  if (clock) {
    var tf = null;
    try { tf = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: clock.getAttribute('data-tz') || undefined }); } catch (e) { tf = null; }
    var tick = function () { var d = new Date(); clock.textContent = tf ? tf.format(d) : d.toTimeString().slice(0, 5); };
    tick(); setInterval(tick, 10000);
  }

  /* ---------------------------------------------------------------- live refresh */
  var readyKey = D.readyKey || '';
  function idsOf(key) { return String(key || '').split(',').filter(Boolean).map(function (x) { return Number(x.split(':')[0]); }); }
  var loading = false; var again = false; var lastLoad = Date.now();
  function refresh() {
    if (loading) { again = true; return; }
    loading = true; lastLoad = Date.now();
    var keep = bill.map(function (l) { return l.id; }).filter(function (id) { return byId[id] && byId[id].date !== D.today; });
    var asked = D.practice || 0;
    fetch('/app/cashier/screen/data?' + (D.scope ? 'scope=' + D.scope + '&' : '') + (asked ? 'p=' + asked + '&' : '') + (keep.length ? 'keep=' + keep.join(',') : ''), { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (r) { if (r.status === 401 || r.status === 403) { location.reload(); throw new Error('auth'); } if (!r.ok) throw new Error(String(r.status)); return r.json(); })
      .then(function (d) { if (asked === (D.practice || 0)) apply(d); else again = true; }) // the tab changed meanwhile
      .catch(function () { /* next tick */ })
      .then(function () { loading = false; if (again) { again = false; setTimeout(refresh, 300); } });
  }
  function apply(d) {
    var before = idsOf(readyKey);
    visits = d.visits || []; index();
    renderToday(d.totals);
    // Appointments paid (or cancelled) elsewhere leave this payment; untouched amounts follow the doctor's changes.
    var gone = []; var changed = false;
    bill = bill.filter(function (l) {
      var v = byId[l.id];
      if (!v) { gone.push(l.v.patient); return false; }
      if (!l.edited && round(v.due) !== round(l.v.due)) { l.amount = v.due > 0 ? String(round(v.due)) : ''; changed = true; }
      l.v = v;
      return true;
    });
    if (gone.length || changed) { renderBill(); save(); } else compute();
    renderGrid();
    if (gone.length) showAlert(gone.map(function (n) { return tr(T.paid_elsewhere, { name: n }); }).join(' '));
    var fresh = idsOf(d.readyKey).filter(function (id) { return before.indexOf(id) < 0; });
    readyKey = d.readyKey || '';
    var quiet = switched; switched = false; // another practice's tab: its waiting visits are not "new"
    if (fresh.length && !quiet) {
      showNotice(fresh.map(function (id) { var v = byId[id]; return v ? tr(T.new_ready, { name: v.patient, amount: v.due > 0 ? money(v.due) : T.no_amount }) : ''; }).filter(Boolean).join(' · '));
      fresh.forEach(function (id) {
        var c = grid.querySelector('[data-pos-card="' + id + '"]');
        if (c) { c.classList.add('is-new'); setTimeout(function () { c.classList.remove('is-new'); }, 6000); }
      });
      chime();
    }
  }
  /* ---------------------------------------------------------------- "add an expense": saved in place (full screen stays on) */
  var expForm = document.querySelector('[data-pos-expense]');
  if (expForm) {
    expForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var body = {};
      Array.prototype.forEach.call(expForm.elements, function (el) { if (el.name && el.name.charAt(0) !== '_' && !el.disabled) body[el.name] = el.value; });
      var btn = expForm.querySelector('[type="submit"]');
      if (btn) btn.disabled = true;
      var box = expForm.querySelector('[data-pos-expense-error]');
      if (!box) { box = document.createElement('div'); box.className = 'form-error'; box.setAttribute('data-pos-expense-error', ''); box.setAttribute('role', 'alert'); var bodyEl = expForm.querySelector('.dialog-body'); if (bodyEl) bodyEl.insertBefore(box, bodyEl.firstChild); }
      box.hidden = true;
      fetch(expForm.getAttribute('action'), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-csrf-token': D.csrf }, body: JSON.stringify(body) })
        .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
        .then(function (d) {
          if (!d.ok) { box.textContent = d.error || T.failed; box.hidden = false; return; }
          var dlg = expForm.closest('dialog'); if (dlg && dlg.open) dlg.close();
          var keepDate = expForm.elements.date ? expForm.elements.date.value : '';
          expForm.reset(); if (expForm.elements.date) expForm.elements.date.value = keepDate;
          showNotice(expForm.getAttribute('data-saved') || '');
        })
        .catch(function () { box.textContent = T.failed; box.hidden = false; })
        .then(function () { if (btn) btn.disabled = false; });
    });
  }

  /* ---------------------------------------------------------------- practice tabs (medical centre)
     Switching tabs reloads the visits in place: the page never navigates, so full screen stays on. */
  var switched = false;
  var tabs = $('.pos-practices', root) || document.querySelector('.pos-practices');
  if (tabs) {
    tabs.addEventListener('click', function (e) {
      var a = e.target.closest ? e.target.closest('a[href]') : null;
      if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.button > 0) return;
      e.preventDefault();
      var p = 0;
      try { p = Number(new URL(a.href, location.href).searchParams.get('p')) || 0; } catch (err) { p = 0; }
      if (p === (D.practice || 0)) return;
      D.practice = p;
      Array.prototype.forEach.call(tabs.querySelectorAll('a'), function (x) {
        var on = x === a;
        x.classList.toggle('is-on', on);
        if (on) x.setAttribute('aria-current', 'page'); else x.removeAttribute('aria-current');
      });
      try { history.replaceState(history.state, '', a.getAttribute('href')); } catch (err) { /* address only */ }
      switched = true;
      refresh();
    });
  }

  var liveBox = $('[data-pos-live]', root);
  function liveUi(on) {
    if (!liveBox) return;
    liveBox.classList.toggle('is-on', on);
    var tx = $('[data-pos-live-text]', liveBox);
    if (tx) tx.textContent = on ? T.live_on : T.live_off;
  }
  var connected = false;
  setInterval(function () { if (!connected || Date.now() - lastLoad > 60000) refresh(); }, 10000);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') refresh(); });
  if (window.EventSource) {
    var es = null; var failures = 0;
    var connect = function () {
      es = new EventSource('/app/live/events');
      es.addEventListener('hello', function () { connected = true; failures = 0; liveUi(true); });
      es.addEventListener('appointments', function () { refresh(); });
      es.onerror = function () {
        connected = false; liveUi(false); failures += 1;
        if (failures > 5 && es) { es.close(); es = null; setTimeout(function () { failures = 0; connect(); }, 60000); }
      };
    };
    connect();
    window.addEventListener('beforeunload', function () { if (es) es.close(); });
  }

  /* ---------------------------------------------------------------- start */
  if (search) search.addEventListener('input', renderGrid);
  var saved = sstore(function (s) { return s.getItem(STORE_KEY); });
  if (saved) {
    try {
      var st = JSON.parse(saved);
      (st.lines || []).forEach(function (x) {
        var v = byId[x.id];
        if (v && !inBill(x.id) && !bill.length) bill.push({ id: x.id, v: v, amount: x.edited ? x.amount : (v.due > 0 ? String(round(v.due)) : ''), discount: x.discount || '', insurer: x.insurer && insurerById[x.insurer] ? x.insurer : '', coverage: x.coverage || '', reason: x.reason || '', edited: !!x.edited });
      });
      if (st.method) { var r = root.querySelector('input[name="pos_method"][value="' + st.method + '"]'); if (r) { r.checked = true; method = st.method; } }
    } catch (e) { /* ignore */ }
  }
  (D.add || []).forEach(function (id) { if (byId[id] && !inBill(id) && !bill.length && SIDE.indexOf(byId[id].state) < 0) bill.push({ id: id, v: byId[id], amount: byId[id].due > 0 ? String(round(byId[id].due)) : '', discount: '', insurer: '', coverage: '', reason: '', edited: false }); });
  if ((D.add || []).length && window.history && history.replaceState) history.replaceState(null, '', location.pathname);
  renderToday(D.totals);
  renderBill();
  renderGrid();
  save();
  if (search && window.matchMedia && window.matchMedia('(min-width: 768px)').matches) search.focus();
}());

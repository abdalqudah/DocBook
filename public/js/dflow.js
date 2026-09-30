/* Doctor journey (round 8) — visit page:
   • quick prescription rows (add / remove / Enter on the last field adds a row),
   • "amount to collect": extra service lines, live total, the print-prescription box follows the prescription,
   • Ctrl/Cmd + Enter = "Finish visit & send to reception",
   • the note + prescription are kept as a local draft (localStorage) while typing, so nothing is lost if the
     page is closed; the draft is cleared once the server saved it (?saved=1 / ?done=1),
   • buttons are disabled while the form is being sent (no double finish).
   Progressive enhancement: without JavaScript the form still posts (one extra service via the select). */
(function () {
  'use strict';
  var form = document.querySelector('form[data-dflow]');
  if (!form) return;
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var bar = $('[data-df-bar]');
  if (bar) bar.classList.add('df-js');

  /* ---------------- quick prescription ---------------- */
  var rxBox = $('[data-df-rx]', form);
  var rxTpl = $('template[data-df-rx-template]', form);
  function rxRenumber() {
    if (!rxBox) return;
    $$('[data-df-rx-row]', rxBox).forEach(function (row, i) {
      $$('[data-name]', row).forEach(function (inp) { inp.name = 'rx[' + i + '][' + inp.getAttribute('data-name') + ']'; });
    });
  }
  function rxAdd(focus) {
    if (!rxBox || !rxTpl) return null;
    var node = rxTpl.content.firstElementChild.cloneNode(true);
    rxBox.appendChild(node); rxRenumber();
    if (focus) { var f = $('input', node); if (f) f.focus(); }
    return node;
  }
  function rxHasItems() { return rxBox ? $$('[data-name="medicationName"]', rxBox).some(function (i) { return i.value.trim(); }) : false; }
  if (rxBox) {
    rxBox.addEventListener('click', function (e) {
      var rm = e.target.closest('[data-df-rx-remove]');
      if (!rm) return;
      var rows = $$('[data-df-rx-row]', rxBox);
      var row = rm.closest('[data-df-rx-row]');
      if (rows.length > 1) row.remove(); else $$('input', row).forEach(function (i) { i.value = ''; });
      rxRenumber(); syncPrint(); saveDraft();
    });
    rxBox.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' || e.ctrlKey || e.metaKey || e.shiftKey) return;
      var inp = e.target.closest('input');
      if (!inp) return;
      e.preventDefault(); // Enter inside a row never submits the whole visit
      var row = inp.closest('[data-df-rx-row]');
      var cells = $$('input', row);
      var idx = cells.indexOf(inp);
      if (idx < cells.length - 1) { cells[idx + 1].focus(); return; }
      var next = row.nextElementSibling;
      if (next) { var f = $('input', next); if (f) f.focus(); } else rxAdd(true);
    });
    var addBtn = $('[data-df-rx-add]', form);
    if (addBtn) addBtn.addEventListener('click', function () { rxAdd(true); });
    rxRenumber();
  }

  /* ---------------- amount to collect ---------------- */
  var decimals = Number(form.getAttribute('data-decimals'));
  if (!(decimals >= 0)) decimals = 2;
  var currency = form.getAttribute('data-currency') || '';
  var numLocale = form.getAttribute('data-locale') || 'en';
  function money(v) { // same shape as the server's fmt.money: "25 JOD", "25.500 JOD"
    var whole = Math.abs(v - Math.round(v)) < 1e-9;
    try { return new Intl.NumberFormat(numLocale, { minimumFractionDigits: whole ? 0 : decimals, maximumFractionDigits: decimals }).format(v) + ' ' + currency; } catch (e) { return v.toFixed(decimals) + ' ' + currency; }
  }
  function num(v) {
    var s = String(v || '').replace(/[٠-٩]/g, function (d) { return String(d.charCodeAt(0) - 0x0660); }).replace('٫', '.').replace(/[,\s]/g, '');
    var n = parseFloat(s);
    return isFinite(n) ? n : 0;
  }
  var linesBox = $('[data-df-lines-box]');
  var linesList = $('[data-df-lines]');
  var lineTpl = $('template[data-df-line-template]');
  var svcSel = $('[data-df-service]');
  var baseInput = $('[data-df-base]');
  var totalOut = $('[data-df-total]');
  var totalLine = $('[data-df-total-line]');
  var baseEcho = $('[data-df-base-echo]');
  var toggle = $('[data-df-lines-toggle]');
  var extraLabel = $('[data-df-extra-label]');
  var labels = {};
  labels.add = bar ? bar.getAttribute('data-add-label') : '';
  if (svcSel) svcSel.removeAttribute('name'); // with JavaScript, services are added as lines (the select is only a picker)

  function linesRenumber() {
    if (!linesList) return;
    $$('[data-df-line]', linesList).forEach(function (row, i) {
      $$('[data-lname]', row).forEach(function (inp) { inp.name = 'lines[' + (i + 1) + '][' + inp.getAttribute('data-lname') + ']'; });
    });
  }
  function recalc() {
    if (!baseInput) return;
    var extras = linesList ? $$('[data-df-line]', linesList) : [];
    var total = num(baseInput.value);
    extras.forEach(function (row) { var p = $('[data-df-price]', row); total += num(p && p.value); });
    if (totalOut) totalOut.textContent = money(total);
    if (totalLine) totalLine.hidden = !extras.length;
    if (baseEcho) baseEcho.textContent = money(num(baseInput.value));
    if (extraLabel) extraLabel.textContent = extras.length ? (bar.getAttribute('data-services-n') || '+{n}').replace('{n}', extras.length.toLocaleString(numLocale)) : labels.add;
  }
  if (toggle && linesBox) {
    toggle.addEventListener('click', function () {
      linesBox.open = !linesBox.open;
      toggle.setAttribute('aria-expanded', linesBox.open ? 'true' : 'false');
      if (linesBox.open && svcSel) svcSel.focus();
    });
    if (linesBox.hasAttribute('data-has-extras')) { /* start closed; the total line shows the sum */ }
  }
  function addService() {
    if (!svcSel || !svcSel.value || !lineTpl || !linesList) return;
    var opt = svcSel.options[svcSel.selectedIndex];
    var node = lineTpl.content.firstElementChild.cloneNode(true);
    $('[data-lname="service_id"]', node).value = svcSel.value;
    $('[data-lname="name"]', node).value = opt.getAttribute('data-name') || '';
    $('[data-lname="name_en"]', node).value = opt.getAttribute('data-name-en') || '';
    $('[data-lname="unit_price"]', node).value = opt.getAttribute('data-price') || '0';
    $('[data-df-line-name]', node).textContent = opt.textContent.split(' · ')[0];
    linesList.appendChild(node);
    svcSel.value = '';
    linesRenumber(); recalc(); saveDraft();
  }
  var svcAdd = $('[data-df-service-add]');
  if (svcAdd) svcAdd.addEventListener('click', addService);
  if (svcSel) svcSel.addEventListener('change', addService);
  if (linesList) {
    linesList.addEventListener('click', function (e) {
      var rm = e.target.closest('[data-df-line-remove]');
      if (!rm) return;
      rm.closest('[data-df-line]').remove();
      linesRenumber(); recalc(); saveDraft();
    });
  }
  document.addEventListener('input', function (e) { if (e.target.hasAttribute && e.target.hasAttribute('data-df-price')) recalc(); });
  recalc();

  /* ---------------- print prescription box follows the prescription ---------------- */
  var printBox = $('[data-df-print]');
  var printTouched = false;
  if (printBox) printBox.addEventListener('change', function () { printTouched = true; });
  function syncPrint() { if (printBox && !printTouched && rxHasItems()) printBox.checked = true; }
  if (rxBox) rxBox.addEventListener('input', syncPrint);

  /* ---------------- local draft ---------------- */
  var KEY = form.getAttribute('data-draft-key');
  var draftState = $('[data-df-draft-state]', form);
  var NOTE_FIELDS = ['subjective', 'objective', 'diagnosis', 'plan_text', 'assessment', 'rx_notes'];
  function local(fn) { try { return fn(window.localStorage); } catch (e) { return null; } }
  if (form.hasAttribute('data-clear-draft')) local(function (s) { s.removeItem(KEY); });
  function collect() {
    var d = { at: Date.now(), f: {}, rx: [] };
    NOTE_FIELDS.forEach(function (n) { var el = form.elements[n]; if (el) d.f[n] = el.value; });
    if (rxBox) $$('[data-df-rx-row]', rxBox).forEach(function (row) {
      var r = {}; $$('[data-name]', row).forEach(function (i) { r[i.getAttribute('data-name')] = i.value; });
      d.rx.push(r);
    });
    return d;
  }
  var initial = JSON.stringify(collect().f) + JSON.stringify(collect().rx);
  var saveTimer = null;
  function saveDraft() {
    if (!KEY) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      var d = collect();
      if (JSON.stringify(d.f) + JSON.stringify(d.rx) === initial) { local(function (s) { s.removeItem(KEY); }); return; }
      local(function (s) { s.setItem(KEY, JSON.stringify(d)); });
      if (draftState) draftState.textContent = form.getAttribute('data-t-draft-saved') || '';
    }, 400);
  }
  form.addEventListener('input', saveDraft);
  // Restore a draft that differs from what the server has (the page was closed before saving).
  var saved = local(function (s) { return s.getItem(KEY); });
  if (saved && !form.hasAttribute('data-clear-draft')) {
    try {
      var d = JSON.parse(saved);
      if (d && Date.now() - d.at < 7 * 24 * 3600 * 1000 && JSON.stringify(d.f) + JSON.stringify(d.rx) !== initial) {
        Object.keys(d.f || {}).forEach(function (n) { var el = form.elements[n]; if (el && typeof d.f[n] === 'string') el.value = d.f[n]; });
        if (rxBox && d.rx && d.rx.length) {
          $$('[data-df-rx-row]', rxBox).forEach(function (r) { r.remove(); });
          d.rx.forEach(function (r) {
            var node = rxAdd(false);
            if (node) $$('[data-name]', node).forEach(function (i) { i.value = r[i.getAttribute('data-name')] || ''; });
          });
          if (!$$('[data-df-rx-row]', rxBox).length) rxAdd(false);
          rxRenumber();
        }
        $$('details', form).forEach(function (det) { if ($('textarea', det) && $('textarea', det).value) det.open = true; });
        var note = document.createElement('div');
        note.className = 'alert alert-info';
        note.setAttribute('role', 'status');
        note.innerHTML = '<div class="grow small"></div><button class="btn btn-ghost btn-sm" type="button"></button>';
        note.querySelector('.grow').textContent = form.getAttribute('data-t-draft-restored') || '';
        note.querySelector('button').textContent = form.getAttribute('data-t-draft-discard') || '×';
        note.querySelector('button').addEventListener('click', function () { local(function (s) { s.removeItem(KEY); }); location.reload(); });
        form.insertBefore(note, form.firstElementChild ? form.firstElementChild.nextSibling : null);
        syncPrint();
      }
    } catch (e) { /* ignore a broken draft */ }
  }

  /* ---------------- submit: one click, no doubles; Ctrl/Cmd + Enter = finish ---------------- */
  var finishBtn = $('[data-df-finish]');
  form.addEventListener('submit', function () {
    rxRenumber(); linesRenumber();
    setTimeout(function () { $$('button[type=submit][form="df-form"], button[type=submit]', form).concat($$('button[form="df-form"]')).forEach(function (b) { b.disabled = true; }); }, 0);
    if (finishBtn) finishBtn.classList.add('is-loading');
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return;
    if (document.querySelector('dialog[open]')) return;
    var btn = finishBtn || $('[data-df-save]');
    if (!btn) return;
    e.preventDefault();
    if (typeof form.requestSubmit === 'function') form.requestSubmit(btn); else btn.click();
  });
  // A price field: Enter finishes too (the obvious "type the amount, press Enter" flow).
  if (baseInput && finishBtn) baseInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); if (typeof form.requestSubmit === 'function') form.requestSubmit(finishBtn); else finishBtn.click(); }
  });

  /* textareas grow with their text */
  $$('textarea[data-autogrow]', form).forEach(function (ta) {
    function fit() { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight + 2, 480) + 'px'; }
    ta.addEventListener('input', fit); fit();
  });
}());

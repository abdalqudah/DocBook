/* Specialty records: dental chart interactions, pregnancy dating preview, form helpers, and the patient-page panel loader. */
(function () {
  'use strict';
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  /* ---------- Patient page: load the "Specialty records" panel ---------- */
  $$('[data-specialty-panel]').forEach(function (box) {
    if (box.getAttribute('data-loaded')) return;
    box.setAttribute('data-loaded', '1');
    var xhr = new XMLHttpRequest();
    xhr.open('GET', box.getAttribute('data-specialty-panel'));
    xhr.setRequestHeader('Accept', 'text/html');
    xhr.onload = function () {
      if (xhr.status === 200 && xhr.responseText.trim()) { box.innerHTML = xhr.responseText; box.hidden = false; }
    };
    xhr.send();
  });

  /* ---------- Dental chart ---------- */
  var chart = $('[data-dental-chart]');
  var dlg = document.getElementById('dental-entry-dialog');
  var form = dlg ? $('[data-dental-form]', dlg) : null;
  var condSel = form ? $('[data-dental-condition]', form) : null;
  var scopes = {};
  try { scopes = condSel ? JSON.parse(condSel.getAttribute('data-scopes')) : {}; } catch (e) { scopes = {}; }

  function syncCondition() {
    if (!form || !condSel) return;
    var scope = scopes[condSel.value] || 'either';
    var surf = $('[data-dental-surfaces]', form);
    var mat = $('.sp-material', form);
    if (surf) {
      surf.hidden = scope.indexOf('tooth') === 0;
      var hint = $('[data-surface-hint]', surf);
      if (hint) hint.hidden = scope.indexOf('surface') !== 0;
    }
    if (mat) mat.hidden = scope.indexOf('+m') < 0;
  }
  if (condSel) { condSel.addEventListener('change', syncCondition); syncCondition(); }

  function openTooth(tooth, surface) {
    if (!dlg || !form || typeof dlg.showModal !== 'function') return false;
    var keepCond = condSel ? condSel.value : null;
    form.reset();
    $$('.field-error', form).forEach(function (el) { el.remove(); });
    if (condSel && keepCond) condSel.value = keepCond;
    var sel = form.querySelector('[name="tooth"]');
    if (sel) sel.value = String(tooth);
    $$('[name="surfaces"]', form).forEach(function (c) { c.checked = surface ? c.value === surface : false; });
    if (surface && condSel && (scopes[condSel.value] || '').indexOf('tooth') === 0) condSel.value = 'caries';
    var title = $('[data-dental-title]', dlg);
    if (title) title.textContent = title.getAttribute('data-base-title') + ' — ' + title.getAttribute('data-tooth-title') + ' ' + tooth;
    syncCondition();
    dlg.showModal();
    return true;
  }

  if (chart) {
    var editable = chart.hasAttribute('data-editable');
    function activate(g, target) {
      var tooth = g.getAttribute('data-tooth');
      var surface = target && target.getAttribute ? target.getAttribute('data-surface') : null;
      if (editable && openTooth(tooth, surface)) return;
      var url = new URL(window.location.href);
      url.searchParams.set('tooth', tooth);
      url.hash = 'history';
      window.location.href = url.toString();
    }
    chart.addEventListener('click', function (e) {
      var g = e.target.closest ? e.target.closest('.dc-tooth') : null;
      if (!g) return;
      activate(g, e.target.closest('[data-surface]'));
    });
    chart.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var g = e.target.closest ? e.target.closest('.dc-tooth') : null;
      if (!g) return;
      e.preventDefault();
      activate(g, null);
    });
  }
  // Header "Add entry" button: reset the title.
  $$('[data-open-dialog="dental-entry-dialog"]').forEach(function (b) {
    b.addEventListener('click', function () { var title = dlg && $('[data-dental-title]', dlg); if (title) title.textContent = title.getAttribute('data-base-title'); setTimeout(syncCondition, 0); });
  });

  /* ---------- Treatment plan: service → price / name ---------- */
  var svcSel = $('[data-plan-service]');
  if (svcSel) {
    var prices = {};
    try { prices = JSON.parse(svcSel.getAttribute('data-prices')) || {}; } catch (e) { prices = {}; }
    svcSel.addEventListener('change', function () {
      var p = prices[svcSel.value];
      var f = svcSel.form;
      var price = f.querySelector('[data-plan-price]');
      var name = f.querySelector('[data-plan-name]');
      if (p && price) price.value = p.price;
      if (name) name.placeholder = p ? p.name : '';
    });
  }

  /* ---------- Pregnancy dating: LMP / scan + EDD preview ---------- */
  function addDays(iso, n) {
    var d = new Date(iso + 'T00:00:00Z');
    if (isNaN(d.getTime())) return null;
    d.setUTCDate(d.getUTCDate() + n);
    return d;
  }
  $$('[data-dating]').forEach(function (box) {
    var lmpBox = $('[data-dating-lmp]', box); var scanBox = $('[data-dating-scan]', box); var preview = $('[data-edd-preview]', box);
    function method() { var r = $('[data-dating-method]:checked', box); return r ? r.value : 'lmp'; }
    function update() {
      var m = method();
      if (lmpBox) lmpBox.hidden = m !== 'lmp';
      if (scanBox) scanBox.hidden = m !== 'scan';
      var edd = null;
      if (m === 'lmp') {
        var lmp = $('[data-edd-lmp]', box).value;
        if (lmp) edd = addDays(lmp, 280);
      } else {
        var sd = $('[data-edd-scan]', box).value; var w = parseInt($('[data-edd-gaw]', box).value, 10); var d = parseInt($('[data-edd-gad]', box).value || '0', 10);
        if (sd && w >= 4 && w <= 43 && d >= 0 && d <= 6) edd = addDays(sd, 280 - (w * 7 + d));
      }
      if (preview) {
        if (edd) {
          var loc = preview.getAttribute('data-locale') === 'ar' ? 'ar-EG-u-ca-gregory-nu-latn' : 'en-GB';
          preview.textContent = preview.getAttribute('data-label') + ': ' + new Intl.DateTimeFormat(loc, { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(edd);
          preview.hidden = false;
        } else preview.hidden = true;
      }
    }
    box.addEventListener('change', update);
    box.addEventListener('input', update);
    update();
  });

  /* ---------- Antenatal visit: live gestational age ---------- */
  $$('[data-ga-date]').forEach(function (input) {
    var help = input.parentNode.querySelector('.help');
    var base = help ? help.textContent : '';
    function update() {
      var edd = input.getAttribute('data-edd');
      var a = new Date(input.value + 'T00:00:00Z'); var b = new Date(edd + 'T00:00:00Z');
      if (!help || isNaN(a.getTime())) return;
      var ga = 280 - Math.round((b - a) / 86400000);
      help.textContent = ga >= 0 ? base + ' — ' + Math.floor(ga / 7) + '+' + (ga % 7) : base;
    }
    input.addEventListener('change', update); update();
  });

  /* ---------- Close pregnancy: birth-only fields ---------- */
  $$('[data-close-form]').forEach(function (f) {
    var sel = f.querySelector('[data-outcome]');
    function sync() { var birth = sel && (sel.value === 'live_birth' || sel.value === 'stillbirth'); $$('.sp-birth-only', f).forEach(function (el) { el.hidden = !birth; }); }
    if (sel) { sel.addEventListener('change', sync); sync(); }
  });
})();

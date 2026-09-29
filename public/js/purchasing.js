// Purchase orders: suggested quantities, extra lines, live summary and "receive all" helpers.
(function () {
  'use strict';
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var isAr = document.documentElement.lang === 'ar';
  var num = function (v) { var n = parseFloat(String(v || '').replace(/,/g, '')); return isNaN(n) ? 0 : n; };

  var form = document.getElementById('po-form');
  if (form) {
    var summary = form.querySelector('[data-po-summary]');
    var baseSummary = summary ? summary.textContent : '';
    var updateSummary = function () {
      if (!summary) return;
      var n = $$('input[name$="[quantity]"]', form).filter(function (i) { return num(i.value) > 0; }).length;
      summary.textContent = n ? (isAr ? n + ' صنف في هذا الأمر' : n + ' item(s) in this order') : baseSummary;
    };
    form.addEventListener('input', updateSummary);
    form.addEventListener('change', updateSummary);

    // Suggested quantity buttons.
    form.addEventListener('click', function (e) {
      var use = e.target.closest('[data-use-qty]');
      if (use) {
        var row = use.closest('tr');
        var input = row && row.querySelector('input[name$="[quantity]"]');
        if (input) { input.value = use.getAttribute('data-use-qty'); input.focus(); updateSummary(); }
        return;
      }
      var rm = e.target.closest('[data-remove-line]');
      if (rm) {
        var line = rm.closest('[data-line]');
        var box = line && line.parentNode;
        if (line) line.parentNode.removeChild(line);
        if (box && !box.querySelector('[data-line]')) addLine('tpl-free');
        updateSummary();
      }
    });
    var useAll = form.querySelector('[data-use-all]');
    if (useAll) {
      useAll.hidden = false;
      useAll.addEventListener('click', function () {
        $$('input[data-suggested]', form).forEach(function (i) { i.value = i.getAttribute('data-suggested'); });
        updateSummary();
      });
    }

    // Extra lines: clone a template with the next index.
    var box = form.querySelector('[data-lines]');
    var addLine = function (tplId) {
      var tpl = document.getElementById(tplId);
      if (!tpl || !box) return null;
      var next = Number(box.getAttribute('data-next')) || 0;
      box.setAttribute('data-next', String(next + 1));
      var wrap = document.createElement('div');
      wrap.innerHTML = tpl.innerHTML.replace(/__i__/g, String(next));
      var el = wrap.firstElementChild;
      box.appendChild(el);
      showRemove();
      var first = el.querySelector('select, input');
      if (first) first.focus();
      return el;
    };
    var showRemove = function () { $$('[data-remove-line]', form).forEach(function (b) { b.hidden = false; }); };
    showRemove();
    var bar = form.querySelector('[data-add-bar]');
    if (bar) bar.hidden = false;
    $$('[data-add-line]', form).forEach(function (b) { b.addEventListener('click', function () { addLine(b.getAttribute('data-add-line')); }); });

    // Another clinic item: show its stock and pre-fill the suggestion.
    form.addEventListener('change', function (e) {
      var sel = e.target.closest('[data-other-item]');
      if (!sel) return;
      var opt = sel.options[sel.selectedIndex];
      var row = sel.closest('[data-line]');
      var info = row && row.querySelector('[data-item-info]');
      if (info) info.textContent = opt && opt.value ? (isAr ? 'المخزون: ' + opt.getAttribute('data-stock') + ' · حد إعادة الطلب: ' + opt.getAttribute('data-level') : 'In stock: ' + opt.getAttribute('data-stock') + ' · reorder level: ' + opt.getAttribute('data-level')) : '';
      var q = row && row.querySelector('input[name$="[quantity]"]');
      if (q && !q.value && opt && opt.getAttribute('data-suggested')) q.value = opt.getAttribute('data-suggested');
      updateSummary();
    });
    updateSummary();
  }

  // Receive dialog: everything remaining / clear.
  $$('[data-recv-tools]').forEach(function (tools) {
    tools.hidden = false;
    var dlg = tools.closest('form');
    $$('[data-recv]', tools).forEach(function (b) {
      b.addEventListener('click', function () {
        var all = b.getAttribute('data-recv') === 'all';
        $$('input[data-max]', dlg).forEach(function (i) { i.value = all ? i.getAttribute('data-max') : '0'; });
      });
    });
  });
}());

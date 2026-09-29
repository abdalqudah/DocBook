/* Payroll, supplies and help center behaviour (progressive enhancement). */
(function () {
  'use strict';
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  /* ---------- Commission rule: rate suffix + help follow the basis; per-service rows ---------- */
  $$('[data-rule-form]').forEach(function (form) {
    var basis = form.querySelector('[data-basis-select]');
    var suffix = form.querySelector('[data-rate-suffix]');
    var help = form.querySelector('[data-basis-help]');
    var helps = {};
    try { helps = JSON.parse(form.getAttribute('data-basis-helps') || '{}'); } catch (e) { helps = {}; }
    if (basis && suffix) {
      basis.addEventListener('change', function () {
        suffix.textContent = basis.value === 'percentage' ? suffix.getAttribute('data-pct') : suffix.getAttribute('data-cur');
        if (help && helps[basis.value]) help.textContent = helps[basis.value];
      });
    }
    var list = form.querySelector('[data-ov-list]');
    var add = form.querySelector('[data-ov-add]');
    if (!list) return;
    var blank = list.querySelector('[data-ov-blank]');
    var template = blank ? blank.cloneNode(true) : null;
    // With JavaScript the spare empty row is only shown on demand.
    if (blank && list.children.length > 1) blank.parentNode.removeChild(blank);
    function wire(row) {
      var rm = row.querySelector('[data-ov-remove]');
      if (rm) rm.addEventListener('click', function () { row.parentNode.removeChild(row); });
    }
    $$('.ov-row', list).forEach(wire);
    if (add && template) {
      add.hidden = false;
      add.addEventListener('click', function () {
        var row = template.cloneNode(true);
        $$('select, input', row).forEach(function (f) { if (f.tagName === 'SELECT') f.selectedIndex = 0; else f.value = ''; });
        list.appendChild(row);
        wire(row);
        var first = row.querySelector('select'); if (first) first.focus();
      });
    }
  });

  /* ---------- Stock movement dialog: help text follows the movement type ---------- */
  var moveHelps = document.getElementById('move-help-texts');
  if (moveHelps) {
    var texts = {};
    try { texts = JSON.parse(moveHelps.textContent); } catch (e) { texts = {}; }
    $$('#move-dialog input[name="type"]').forEach(function (r) {
      var sync = function () { var h = document.querySelector('#move-dialog [data-move-help]'); var sel = document.querySelector('#move-dialog input[name="type"]:checked'); if (h && sel && texts[sel.value]) h.textContent = texts[sel.value]; };
      r.addEventListener('change', sync);
      r.addEventListener('input', sync);
    });
  }

  /* ---------- Help center search ---------- */
  var search = document.querySelector('[data-help-search]');
  if (search) {
    var sections = $$('[data-help-section]');
    var empty = document.querySelector('[data-help-empty]');
    var norm = function (s) { return String(s || '').toLowerCase().replace(/[ً-ْـ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه'); };
    var run = function () {
      var q = norm(search.value.trim());
      var any = false;
      sections.forEach(function (sec) {
        var title = norm((sec.querySelector('h2') || {}).textContent);
        var titleHit = q && title.indexOf(q) >= 0;
        var hits = 0;
        $$('[data-help-item]', sec).forEach(function (it) {
          var hit = !q || titleHit || norm(it.textContent).indexOf(q) >= 0;
          it.classList.toggle('hidden', !hit);
          if (it.tagName === 'DETAILS') { if (q && hit && !titleHit) it.open = true; else if (!q) it.open = false; }
          if (hit) hits += 1;
        });
        var sub = sec.querySelector('.help-sub'); if (sub) sub.classList.toggle('hidden', q && !$$('.role-card:not(.hidden)', sec).length);
        sec.classList.toggle('hidden', hits === 0);
        var link = document.querySelector('[data-help-link="' + sec.id + '"]'); if (link) link.classList.toggle('dim', hits === 0);
        if (hits) any = true;
      });
      if (empty) empty.classList.toggle('hidden', any);
    };
    var timer;
    search.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(run, 120); });
    // Opening a topic from the list opens its first question.
    $$('[data-help-link]').forEach(function (a) {
      a.addEventListener('click', function () {
        if (search.value) { search.value = ''; run(); }
        var sec = document.getElementById(a.getAttribute('data-help-link'));
        var first = sec && sec.querySelector('details'); if (first) first.open = true;
      });
    });
    if (location.hash) { var target = document.getElementById(location.hash.slice(1)); var d = target && target.querySelector('details'); if (d) d.open = true; }
  }
})();

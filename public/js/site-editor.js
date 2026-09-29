/* Landing page editor (platform admin): repeatable rows and the icon picker.
   Without JavaScript the rows already on the page can still be edited and the icon is a plain list. */
(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var assetV = document.documentElement.getAttribute('data-v') || '';
  var iconSvg = function (name, cls) { return '<svg class="icon ' + (cls || '') + '" aria-hidden="true"><use href="/icons.svg?v=' + assetV + '#i-' + String(name).replace(/[^a-z0-9-]/g, '') + '"></use></svg>'; };
  var text = {};
  try { text = JSON.parse(($('#icon-picker-data') || {}).textContent || '{}'); } catch (e) { text = {}; }

  /* ---------- Repeatable rows: data-repeater > data-rows + template[data-row-template] ---------- */
  function renumber(box) {
    var rows = $$('[data-rows] > [data-row]', box);
    rows.forEach(function (r, i) { var n = r.querySelector('[data-row-n]'); if (n) n.textContent = String(i + 1); });
    var c = box.querySelector('[data-row-count]'); if (c) c.textContent = String(rows.length);
  }
  $$('[data-repeater]').forEach(function (box) {
    var rows = box.querySelector('[data-rows]');
    var tpl = box.querySelector('template[data-row-template]');
    renumber(box);
    box.addEventListener('click', function (e) {
      var add = e.target.closest('[data-add-row]');
      var rm = e.target.closest('[data-remove-row]');
      var mv = e.target.closest('[data-move-row]');
      if (!add && !rm && !mv) return;
      e.preventDefault(); // buttons inside <summary> must not toggle the row
      if (add && rows && tpl) {
        rows.appendChild(tpl.content.cloneNode(true));
        var last = rows.lastElementChild;
        if (last) { enhanceIcons(last); var first = last.querySelector('input:not([type=hidden]), textarea'); if (first) first.focus(); }
      }
      if (rm) {
        var row = rm.closest('[data-row]');
        if (row && rows.querySelectorAll(':scope > [data-row]').length > 1) row.parentNode.removeChild(row);
        else if (row) $$('input, textarea', row).forEach(function (i) { i.value = ''; });
      }
      if (mv && rows) {
        var r0 = mv.closest('[data-row]');
        if (mv.getAttribute('data-move-row') === '-1' && r0.previousElementSibling) rows.insertBefore(r0, r0.previousElementSibling);
        else if (mv.getAttribute('data-move-row') === '1' && r0.nextElementSibling) rows.insertBefore(r0.nextElementSibling, r0);
        mv.focus();
      }
      renumber(box);
    });
  });

  /* ---------- Icon picker: a searchable grid over the <select> (which stays the form value) ---------- */
  var openPop = null;
  function closePop() { if (openPop) { openPop.hidden = true; openPop = null; } }
  document.addEventListener('click', function (e) { if (openPop && !openPop.parentNode.contains(e.target)) closePop(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && openPop) { var b = openPop.parentNode.querySelector('.icon-btn'); closePop(); if (b) b.focus(); } });

  function enhanceIcons(root) {
    $$('[data-icon-pick]', root).forEach(function (wrap) {
      if (wrap.getAttribute('data-ready')) return;
      wrap.setAttribute('data-ready', '1');
      var sel = wrap.querySelector('select');
      var prev = wrap.querySelector('[data-icon-preview]');
      if (!sel) return;
      var names = Array.prototype.map.call(sel.options, function (o) { return o.value; }).filter(Boolean);
      sel.hidden = true; if (prev) prev.hidden = true;
      var btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'btn btn-secondary icon-btn';
      btn.setAttribute('aria-haspopup', 'true');
      var paint = function () { btn.innerHTML = (sel.value ? iconSvg(sel.value) + '<span class="mono small">' + sel.value + '</span>' : '<span class="muted">' + (text.none || '—') + '</span>') + iconSvg('chevron-down', 'icon-sm muted'); btn.setAttribute('aria-label', (text.choose || '') + (sel.value ? ': ' + sel.value : '')); };
      paint();
      var pop = document.createElement('div');
      pop.className = 'icon-pop'; pop.hidden = true;
      pop.innerHTML = '<input class="input" type="search" placeholder="' + (text.search || '') + '" aria-label="' + (text.search || '') + '"><div class="icon-grid" role="listbox"></div>';
      var grid = pop.querySelector('.icon-grid');
      var search = pop.querySelector('input');
      var draw = function (q) {
        q = (q || '').toLowerCase().trim();
        var list = [''].concat(names.filter(function (n) { return !q || n.indexOf(q) !== -1; }));
        grid.innerHTML = list.map(function (n) {
          return '<button type="button" class="icon-cell' + (n === sel.value ? ' is-on' : '') + '" data-icon="' + n + '" role="option" aria-selected="' + (n === sel.value) + '" title="' + (n || text.none || '') + '">' + (n ? iconSvg(n) : iconSvg('x', 'muted')) + '</button>';
        }).join('');
      };
      btn.addEventListener('click', function () {
        if (openPop === pop) { closePop(); return; }
        closePop(); draw(''); search.value = ''; pop.hidden = false; openPop = pop; search.focus();
      });
      search.addEventListener('input', function () { draw(search.value); });
      search.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); var f = grid.querySelector('[data-icon]:not([data-icon=""])'); if (f) f.click(); } });
      grid.addEventListener('click', function (e) {
        var cell = e.target.closest('[data-icon]');
        if (!cell) return;
        sel.value = cell.getAttribute('data-icon');
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        paint(); closePop(); btn.focus();
      });
      wrap.appendChild(btn); wrap.appendChild(pop);
    });
  }
  enhanceIcons(document);

  /* ---------- Row titles follow the first text as you type ---------- */
  document.addEventListener('input', function (e) {
    var row = e.target.closest && e.target.closest('[data-row]');
    if (!row || !e.target.matches('input.input, textarea')) return;
    var first = row.querySelector('.bi-lang input, .bi-lang textarea');
    if (first !== e.target && !(e.target.lang && first && first.lang !== e.target.lang && first.closest('.bi-lang') === e.target.closest('.bi-lang'))) return;
    var title = row.querySelector('.se-item-sum .grow');
    if (title && e.target.value.trim()) title.textContent = e.target.value.trim();
  });
})();

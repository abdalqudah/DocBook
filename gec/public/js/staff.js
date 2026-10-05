// Staff workspace: sidebar, command palette (Ctrl/Cmd + K) with global search and actions.
(function () {
  'use strict';
  var doc = document;
  var GEC = window.GEC;

  // ---- Sidebar (phones: drawer; desktop: can fold to icons, remembered in a cookie)
  var sidebar = doc.querySelector('[data-sidebar]');
  var shell = doc.querySelector('[data-shell]');
  var backdrop;
  function closeSidebar() { sidebar.classList.remove('open'); if (backdrop) { backdrop.remove(); backdrop = null; } var t = doc.querySelector('[data-sidebar-toggle]'); if (t) t.setAttribute('aria-expanded', 'false'); }
  doc.addEventListener('click', function (e) {
    var t = e.target.closest('[data-sidebar-toggle]');
    if (t && sidebar) {
      sidebar.classList.add('open'); t.setAttribute('aria-expanded', 'true');
      backdrop = doc.createElement('div'); backdrop.className = 'sidebar-backdrop'; backdrop.addEventListener('click', closeSidebar); doc.body.appendChild(backdrop);
      var first = sidebar.querySelector('a'); if (first) first.focus();
    }
    if (e.target.closest('[data-sidebar-mini]') && shell) {
      var mini = shell.classList.toggle('mini');
      doc.cookie = 'gec_sb=' + (mini ? 'mini' : 'full') + ';path=/staff;max-age=31536000;samesite=lax';
    }
  });
  doc.addEventListener('keydown', function (e) { if (e.key === 'Escape' && sidebar && sidebar.classList.contains('open')) closeSidebar(); });
  // Remember folded groups
  doc.querySelectorAll('.sb-group').forEach(function (g) {
    var k = 'gec_sbg_' + g.getAttribute('data-group');
    try { if (localStorage.getItem(k) === '0') g.removeAttribute('open'); } catch (e) { /* ignore */ }
    g.addEventListener('toggle', function () { try { localStorage.setItem(k, g.open ? '1' : '0'); } catch (e) { /* ignore */ } });
  });

  // ---- Command palette
  var dlg = doc.querySelector('[data-palette]');
  if (!dlg) return;
  var input = dlg.querySelector('[data-palette-input]');
  var results = dlg.querySelector('[data-palette-results]');
  var items = [];
  var sel = 0;
  var timer;
  var seq = 0;

  function render(groups) {
    items = [];
    var html = '';
    groups.forEach(function (g) {
      if (!g.items.length) return;
      html += '<div class="group" role="presentation">' + GEC.esc(g.label) + '</div>';
      g.items.forEach(function (it) {
        var i = items.length;
        items.push(it);
        html += '<a role="option" id="pal-' + i + '" href="' + GEC.esc(it.href) + '" data-i="' + i + '">' + GEC.icon(it.icon || 'arrow-right') +
          '<span class="grow"><span class="truncate" style="display:block">' + GEC.esc(it.title) + '</span>' + (it.sub ? '<span class="sub truncate" style="display:block">' + GEC.esc(it.sub) + '</span>' : '') + '</span></a>';
      });
    });
    if (!items.length) html = '<div class="empty compact"><p>' + GEC.esc(results.getAttribute('data-empty') || 'No results') + '</p></div>';
    results.innerHTML = html;
    sel = 0; highlight();
  }
  function highlight() {
    results.querySelectorAll('[role="option"]').forEach(function (a) { a.setAttribute('aria-selected', String(Number(a.getAttribute('data-i')) === sel)); });
    var cur = results.querySelector('[data-i="' + sel + '"]');
    if (cur) { cur.scrollIntoView({ block: 'nearest' }); input.setAttribute('aria-activedescendant', cur.id); }
  }
  function search() {
    var q = input.value.trim();
    var mine = ++seq;
    GEC.api('/staff/api/palette?q=' + encodeURIComponent(q)).then(function (data) { if (mine === seq) render(data.groups || []); }).catch(function () { /* offline */ });
  }
  function open() { if (!dlg.open) { dlg.showModal(); input.value = ''; search(); input.focus(); } }
  doc.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); if (dlg.open) dlg.close(); else open(); }
    if (e.key === '/' && !/input|textarea|select/i.test((doc.activeElement || {}).tagName || '') && !doc.activeElement.isContentEditable) { e.preventDefault(); open(); }
  });
  doc.addEventListener('click', function (e) { if (e.target.closest('[data-palette-open]')) open(); });
  dlg.addEventListener('click', function (e) { if (e.target === dlg) dlg.close(); });
  input.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(search, 120); });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); highlight(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); highlight(); }
    if (e.key === 'Enter' && items[sel]) { e.preventDefault(); window.location.href = items[sel].href; }
  });
}());

// Colour pickers mirrored into their text field: <input type="color" data-sync="#field">
(function () {
  document.querySelectorAll('input[type="color"][data-sync]').forEach(function (c) {
    var f = document.querySelector(c.getAttribute('data-sync'));
    if (!f) return;
    c.addEventListener('input', function () { f.value = c.value; });
    f.addEventListener('input', function () { if (/^#[0-9a-fA-F]{6}$/.test(f.value)) c.value = f.value; });
  });
}());

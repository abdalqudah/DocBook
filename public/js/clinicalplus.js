/* DocBook — clinical extras: live consultation timer and ICD-10 diagnosis autocomplete (progressive enhancement).
   Without JavaScript the timer buttons are plain forms and the diagnosis codes are a plain comma-separated field. */
(function () {
  'use strict';

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function clock(sec) {
    sec = Math.max(0, Math.floor(sec));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (h ? h + ':' + pad(m) : pad(m)) + ':' + pad(s);
  }

  /* ---------------------------------------------------------------- consultation timer */
  function initTimer(el) {
    var state = el.getAttribute('data-state');
    var out = el.querySelector('[data-cp-timer-value]');
    if (!out || state !== 'running') return;
    var started = Date.parse(el.getAttribute('data-started'));
    var paused = Number(el.getAttribute('data-paused-seconds') || 0);
    var offset = Date.parse(el.getAttribute('data-now')) - Date.now(); // server clock − browser clock
    if (!started || isNaN(offset)) return;
    function tick() { out.textContent = clock((Date.now() + offset - started) / 1000 - paused); }
    tick();
    setInterval(tick, 1000);
  }

  /* ---------------------------------------------------------------- ICD-10 autocomplete */
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function parseCodes(v) {
    return String(v || '').split(/[,،;\n]+/).map(function (s) { return s.trim().toUpperCase(); }).filter(function (s, i, a) { return s && a.indexOf(s) === i; });
  }

  var uid = 0;
  function initIcd(root) {
    var raw = root.querySelector('[data-cp-icd-raw]');
    if (!raw) return;
    var browse = root.hasAttribute('data-cp-browse');
    var url = root.getAttribute('data-search-url');
    var L = {};
    try { L = JSON.parse(root.getAttribute('data-labels') || '{}'); } catch (e) { L = {}; }
    var primaryInput = root.querySelector('[data-cp-icd-primary]');
    var chipsBox = root.querySelector('[data-cp-icd-chips]');
    var titles = {};
    var island = root.querySelector('[data-cp-icd-data]');
    if (island) { try { JSON.parse(island.textContent || '[]').forEach(function (d) { titles[d.code] = d.title; }); } catch (e) { /* ignore */ } }

    var codes = browse ? [] : parseCodes(raw.value);
    var primary = primaryInput && primaryInput.value && codes.indexOf(primaryInput.value.toUpperCase()) >= 0 ? primaryInput.value.toUpperCase() : (codes[0] || '');

    // The search box: in browse mode the original input is the search box; otherwise a new one replaces the raw field.
    var input = raw;
    if (!browse) {
      input = el('input', 'input cp-icd-search');
      input.type = 'search';
      input.placeholder = L.search || '';
      input.setAttribute('autocomplete', 'off');
      input.setAttribute('aria-label', L.search || '');
      raw.hidden = true;
      raw.setAttribute('aria-hidden', 'true');
      var help = root.querySelector('[data-cp-icd-help]');
      if (help) help.hidden = true;
      raw.parentNode.insertBefore(input, raw);
      if (raw.id) { input.id = raw.id; raw.removeAttribute('id'); }
    }
    uid += 1;
    var listId = 'cp-icd-list-' + uid;
    var wrap = el('div', 'cp-icd-combo');
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    var list = el('ul', 'cp-icd-list');
    list.id = listId;
    list.setAttribute('role', 'listbox');
    list.hidden = true;
    wrap.appendChild(list);
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', listId);
    input.setAttribute('aria-expanded', 'false');

    function sync() {
      if (browse) return;
      raw.value = codes.join(', ');
      if (codes.indexOf(primary) < 0) primary = codes[0] || '';
      if (primaryInput) primaryInput.value = primary;
      renderChips();
    }

    function renderChips() {
      if (!chipsBox) return;
      chipsBox.innerHTML = '';
      chipsBox.hidden = !codes.length;
      codes.forEach(function (c) {
        var chip = el('span', 'cp-chip' + (c === primary ? ' is-primary' : ''));
        var code = el('span', 'cp-code', c); code.setAttribute('dir', 'ltr');
        chip.appendChild(code);
        if (titles[c]) { var tt = el('span', 'cp-chip-title', titles[c]); tt.setAttribute('dir', 'auto'); chip.appendChild(tt); }
        if (c === primary) {
          chip.appendChild(el('span', 'cp-chip-primary', L.primary || ''));
        } else if (codes.length > 1) {
          var mk = el('button', 'cp-chip-btn', L.make_primary || '');
          mk.type = 'button';
          mk.addEventListener('click', function () { primary = c; sync(); });
          chip.appendChild(mk);
        }
        var rm = el('button', 'cp-chip-x', '×');
        rm.type = 'button';
        rm.setAttribute('aria-label', (L.remove || '') + ' ' + c);
        rm.title = L.remove || '';
        rm.addEventListener('click', function () { codes = codes.filter(function (x) { return x !== c; }); sync(); input.focus(); });
        chip.appendChild(rm);
        chipsBox.appendChild(chip);
      });
    }

    var items = [];
    var active = -1;
    var timer = null;
    var seq = 0;

    function close() { list.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); active = -1; }
    function highlight(i) {
      var nodes = list.querySelectorAll('[role="option"]');
      if (!nodes.length) return;
      active = (i + nodes.length) % nodes.length;
      for (var k = 0; k < nodes.length; k += 1) nodes[k].setAttribute('aria-selected', k === active ? 'true' : 'false');
      input.setAttribute('aria-activedescendant', nodes[active].id);
      if (nodes[active].scrollIntoView) nodes[active].scrollIntoView({ block: 'nearest' });
    }
    function choose(i) {
      var it = items[i];
      if (!it || browse) return;
      titles[it.code] = it.title;
      if (codes.indexOf(it.code) < 0) codes.push(it.code);
      if (!primary) primary = it.code;
      input.value = '';
      close();
      sync();
      input.focus();
    }
    function message(text) {
      list.innerHTML = '';
      var li = el('li', 'cp-icd-empty', text);
      list.appendChild(li);
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
    }
    function render(rows) {
      items = rows;
      list.innerHTML = '';
      active = -1;
      if (!rows.length) { message(L.none || ''); return; }
      rows.forEach(function (r, i) {
        var li = el('li', 'cp-icd-opt');
        li.id = listId + '-' + i;
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', 'false');
        var code = el('span', 'cp-code', r.code); code.setAttribute('dir', 'ltr');
        var body = el('span', 'cp-icd-opt-body');
        var t1 = el('span', 'cp-icd-opt-title', r.title); t1.setAttribute('dir', 'auto');
        body.appendChild(t1);
        if (r.alt && r.alt !== r.title) { var t2 = el('span', 'cp-icd-opt-alt', r.alt); t2.setAttribute('dir', 'auto'); body.appendChild(t2); }
        li.appendChild(code);
        li.appendChild(body);
        var meta = [];
        if (r.custom) meta.push(L.custom || '');
        if (r.uses) meta.push(String(L.used || '').replace('{n}', r.uses));
        if (meta.length) li.appendChild(el('span', 'cp-icd-opt-meta', meta.join(' · ')));
        if (!browse && codes.indexOf(r.code) >= 0) li.className += ' is-chosen';
        li.addEventListener('mousedown', function (e) { e.preventDefault(); choose(i); });
        list.appendChild(li);
      });
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
    }
    function search() {
      var q = input.value.trim();
      if (q.length < 2) { if (q.length) message(L.min || ''); else close(); return; }
      seq += 1;
      var mine = seq;
      var xhr = new XMLHttpRequest();
      xhr.open('GET', url + '?q=' + encodeURIComponent(q), true);
      xhr.setRequestHeader('Accept', 'application/json');
      xhr.onload = function () {
        if (mine !== seq) return;
        if (xhr.status !== 200) { close(); return; }
        try { render(JSON.parse(xhr.responseText).data || []); } catch (e) { close(); }
      };
      xhr.send();
    }

    input.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(search, 180); });
    input.addEventListener('focus', function () { if (input.value.trim().length >= 2) search(); });
    input.addEventListener('blur', function () { setTimeout(close, 120); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); if (list.hidden) search(); else highlight(active + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); highlight(active - 1); }
      else if (e.key === 'Enter') {
        if (!list.hidden && items.length) { e.preventDefault(); choose(active >= 0 ? active : 0); }
        else if (!browse) e.preventDefault(); // never submit the note by accident from the search box
      } else if (e.key === 'Escape') { if (!list.hidden) { e.preventDefault(); close(); } }
      else if (e.key === 'Backspace' && !browse && !input.value && codes.length) { codes.pop(); sync(); }
    });
    sync();
  }

  function init() {
    var timers = document.querySelectorAll('[data-cp-timer]');
    for (var i = 0; i < timers.length; i += 1) initTimer(timers[i]);
    var boxes = document.querySelectorAll('[data-cp-icd]');
    for (var j = 0; j < boxes.length; j += 1) initIcd(boxes[j]);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
}());

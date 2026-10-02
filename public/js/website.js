/* Website builder (src/views/pages/website/builder.ejs): preview device and language, panes (hide on wide screens,
   one at a time on narrow ones), tabs, drag-and-drop order, list items (add / remove), choosing a section by clicking
   it in the preview, and saving the selected section to the draft as you type (the preview reloads after each save).
   Without JavaScript every form still posts and comes back. */
(function () {
  'use strict';
  var root = document.querySelector('[data-ws-builder]');
  if (!root) return;
  var $$ = function (sel, el) { return Array.prototype.slice.call((el || root).querySelectorAll(sel)); };
  var frame = root.querySelector('[data-ws-frame]');
  var wrap = root.querySelector('[data-ws-frame-wrap]');
  var csrf = (document.querySelector('meta[name="csrf-token"]') || {}).content || '';
  var qs = new URLSearchParams(window.location.search);
  var selected = qs.get('s') || (qs.get('panel') === 'header' ? '__header' : qs.get('panel') === 'footer' ? '__footer' : '');
  var store = { get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } } };
  var sstore = { get: function (k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }, set: function (k, v) { try { sessionStorage.setItem(k, v); } catch (e) { /* ignore */ } } };
  root.classList.add('is-live');

  // ---------------------------------------------------------------- device, language
  var device = store.get('wsb-device') || 'desktop';
  function setDevice(d) {
    device = d; wrap.setAttribute('data-device', d); store.set('wsb-device', d);
    $$('[data-ws-device]').forEach(function (x) { x.classList.toggle('active', x.getAttribute('data-ws-device') === d); });
  }
  setDevice(device);
  $$('[data-ws-device]').forEach(function (b) { b.addEventListener('click', function () { setDevice(b.getAttribute('data-ws-device')); }); });
  $$('[data-ws-lang]').forEach(function (b) {
    b.addEventListener('click', function () {
      $$('[data-ws-lang]').forEach(function (x) { x.classList.toggle('active', x === b); });
      var u = new URL(frame.getAttribute('src'), window.location.href);
      u.searchParams.set('lang', b.getAttribute('data-ws-lang'));
      frame.setAttribute('src', u.pathname + u.search + u.hash);
    });
  });

  // ---------------------------------------------------------------- panes
  ['sections', 'settings'].forEach(function (p) { if (store.get('wsb-hide-' + p) === '1') root.classList.add('no-' + p); });
  $$('[data-ws-toggle]').forEach(function (b) {
    b.addEventListener('click', function () {
      var p = b.getAttribute('data-ws-toggle');
      var off = root.classList.toggle('no-' + p);
      store.set('wsb-hide-' + p, off ? '1' : '0');
    });
  });
  function setPane(p) {
    root.setAttribute('data-pane', p);
    $$('[data-ws-pane]').forEach(function (x) { x.classList.toggle('active', x.getAttribute('data-ws-pane') === p); });
  }
  setPane(root.getAttribute('data-pane') || 'preview');
  $$('[data-ws-pane]').forEach(function (b) { b.addEventListener('click', function () { setPane(b.getAttribute('data-ws-pane')); }); });

  // ---------------------------------------------------------------- tabs (the settings tab is kept between sections)
  function openTab(aside, name) {
    $$('[data-ws-tab]', aside).forEach(function (x) { var on = x.getAttribute('data-ws-tab') === name; x.classList.toggle('active', on); x.setAttribute('aria-selected', on ? 'true' : 'false'); });
    $$('[data-ws-tab-body]', aside).forEach(function (x) { x.hidden = x.getAttribute('data-ws-tab-body') !== name; });
  }
  $$('.wsb-side').forEach(function (aside) {
    $$('[data-ws-tab]', aside).forEach(function (b) {
      b.addEventListener('click', function () {
        var name = b.getAttribute('data-ws-tab');
        openTab(aside, name);
        if (aside.classList.contains('wsb-end')) sstore.set('wsb-tab', name);
      });
    });
  });
  var endPane = root.querySelector('.wsb-end');
  if (endPane && sstore.get('wsb-tab') === 'design' && endPane.querySelector('[data-ws-tab-body="design"]')) openTab(endPane, 'design');
  if (window.location.hash === '#add') { var sp = root.querySelector('.wsb-start'); if (sp) { openTab(sp, 'add'); setPane('sections'); } }

  // ---------------------------------------------------------------- preview: click a section to edit it
  function markInPreview(scroll) {
    if (!selected || !frame.contentWindow) return;
    frame.contentWindow.postMessage({ type: 'ws-mark', id: selected, scroll: Boolean(scroll) }, window.location.origin);
  }
  window.addEventListener('message', function (e) {
    if (e.origin !== window.location.origin || !e.data || e.source !== frame.contentWindow) return;
    if (e.data.type === 'ws-ready') markInPreview(false);
    if (e.data.type === 'ws-select' && (e.data.id === '__header' || e.data.id === '__footer')) {
      var panel = e.data.id.slice(2);
      var pg = root.getAttribute('data-page');
      flush(function () { window.location.href = '/app/website/builder?panel=' + panel + (pg && pg !== 'home' ? '&page=' + pg : ''); });
      return;
    }
    if (e.data.type === 'ws-select' && /^[a-f0-9]{10}$/.test(String(e.data.id))) {
      if (e.data.id === selected) { setPane('settings'); return; }
      flush(function () { window.location.href = '/app/website/builder?s=' + e.data.id; });
    }
  });

  // ---------------------------------------------------------------- saving the selected section
  var form = root.querySelector('[data-ws-section-form]');
  var stateEl = root.querySelector('[data-ws-save-state]');
  var timer = null; var busy = false; var again = false;
  function say(kind, msg) {
    if (!stateEl) return;
    stateEl.textContent = msg || root.getAttribute('data-t-' + kind) || '';
    stateEl.classList.toggle('is-ok', kind === 'saved'); stateEl.classList.toggle('is-err', kind === 'failed');
  }
  function save(done) {
    if (!form) { if (done) done(); return; }
    if (busy) { again = true; return; }
    clearTimeout(timer); timer = null; busy = true; say('saving');
    var body = new URLSearchParams(new FormData(form));
    fetch(form.getAttribute('action'), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-CSRF-Token': csrf, Accept: 'application/json' }, body: body.toString() })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok && j && j.ok, j: j }; }, function () { return { ok: false }; }); })
      .then(function (res) {
        busy = false;
        if (res.ok) { say('saved'); if (frame.contentWindow) frame.contentWindow.location.reload(); }
        else say('failed', res.j && res.j.error);
        if (again) { again = false; save(done); return; }
        if (done) done();
      }, function () { busy = false; say('failed'); if (done) done(); });
  }
  function later(ms) { clearTimeout(timer); timer = setTimeout(save, ms); }
  function flush(next) { if (timer || busy) { save(next); } else next(); }
  if (form) {
    form.addEventListener('input', function (e) {
      if (e.target.matches('[data-ws-range]')) { var out = form.querySelector('[data-ws-range-out="' + e.target.id + '"]'); if (out) out.textContent = Number(e.target.value) ? e.target.value + 'px' : (e.target.getAttribute('data-auto') || ''); }
      if (e.target.matches('input[type=text], input:not([type]), textarea, input[type=number], input[type=date]')) later(900);
    });
    form.addEventListener('change', function () { later(150); });
    form.addEventListener('submit', function (e) { e.preventDefault(); save(); });
    window.addEventListener('beforeunload', function (e) { if (timer || busy) { e.preventDefault(); e.returnValue = ''; } });
    // Options of one layout only (e.g. the slider's slides) follow the chosen layout.
    $$('input[name="variant"]', form).forEach(function (r) {
      r.addEventListener('change', function () { if (r.checked) $$('[data-ws-only]', form).forEach(function (el) { el.hidden = el.getAttribute('data-ws-only') !== r.value; }); });
    });
    // A picture background shows its picture options.
    var bgBox = form.querySelector('[data-ws-bg-image]');
    $$('[data-ws-bg]', form).forEach(function (r) { r.addEventListener('change', function () { if (bgBox) bgBox.hidden = !(r.checked && r.value === 'image'); }); });
  }

  // ---------------------------------------------------------------- page picker, menu links
  var pick = root.querySelector('[data-ws-page-pick] select');
  if (pick) pick.addEventListener('change', function () { flush(function () { window.location.href = '/app/website/builder?page=' + encodeURIComponent(pick.value); }); });
  root.addEventListener('change', function (e) {
    var sel = e.target.closest && e.target.closest('[data-ws-nav-pick]');
    if (!sel) return;
    var item = sel.closest('[data-ws-item]'); var parts = sel.value.split(':');
    var k = item.querySelector('[data-ws-nav-kind]'); var tg = item.querySelector('[data-ws-nav-target]');
    if (k) k.value = parts[0]; if (tg) tg.value = parts[1] || '';
  }, true);

  // ---------------------------------------------------------------- list items: add / remove
  $$('[data-ws-list]').forEach(function (fs) {
    var box = fs.querySelector('[data-ws-items]');
    var tpl = fs.querySelector('[data-ws-item-template]');
    var addBtn = fs.querySelector('[data-ws-item-add]');
    var max = Number(fs.getAttribute('data-max')) || 12;
    var count = function () { return box.querySelectorAll('[data-ws-item]').length; };
    var sync = function () { if (addBtn) addBtn.disabled = count() >= max; };
    if (addBtn && tpl) addBtn.addEventListener('click', function () {
      if (count() >= max) return;
      var i = Number(fs.getAttribute('data-next')) || 0;
      fs.setAttribute('data-next', String(i + 1));
      var html = tpl.innerHTML.split('__i__').join(String(i)).replace(/>#</, '>' + (count() + 1) + '<');
      var holder = document.createElement('div'); holder.innerHTML = html;
      var item = holder.firstElementChild; box.appendChild(item);
      var first = item.querySelector('input:not([type=hidden]):not([type=radio]), textarea'); if (first) first.focus();
      sync();
    });
    box.addEventListener('click', function (e) {
      var rm = e.target.closest && e.target.closest('[data-ws-item-remove]');
      if (!rm) return;
      e.preventDefault();
      var item = rm.closest('[data-ws-item]'); if (item) item.parentNode.removeChild(item);
      sync(); save();
    });
    sync();
  });

  // ---------------------------------------------------------------- drag and drop to reorder (saved at once)
  var list = root.querySelector('[data-ws-order]');
  var dragging = null;
  if (list) {
    list.addEventListener('dragstart', function (e) {
      dragging = e.target.closest ? e.target.closest('li[data-id]') : null;
      if (!dragging) return;
      dragging.classList.add('is-dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', dragging.getAttribute('data-id')); } catch (err) { /* old browsers */ }
    });
    list.addEventListener('dragover', function (e) {
      var over = e.target.closest ? e.target.closest('li[data-id]') : null;
      if (!dragging || !over || over === dragging) return;
      e.preventDefault();
      Array.prototype.forEach.call(list.children, function (li) { li.classList.toggle('is-over', li === over); });
    });
    list.addEventListener('drop', function (e) {
      var over = e.target.closest ? e.target.closest('li[data-id]') : null;
      if (!dragging || !over || over === dragging) return;
      e.preventDefault();
      list.insertBefore(dragging, over);
    });
    list.addEventListener('dragend', function () {
      if (!dragging) return;
      dragging.classList.remove('is-dragging');
      Array.prototype.forEach.call(list.children, function (li) { li.classList.remove('is-over'); });
      dragging = null;
      var ids = Array.prototype.map.call(list.querySelectorAll('li[data-id]'), function (li) { return 'ids=' + encodeURIComponent(li.getAttribute('data-id')); }).join('&') + '&page=' + encodeURIComponent(root.getAttribute('data-page') || 'home');
      fetch('/app/website/builder/order', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-CSRF-Token': csrf, Accept: 'application/json' }, body: ids })
        .then(function (r) { if (r.ok && frame) frame.contentWindow.location.reload(); else window.location.reload(); })
        .catch(function () { window.location.reload(); });
    });
  }
}());

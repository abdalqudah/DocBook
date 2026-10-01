/* Integrations: Google Sheets page helpers and the reusable media picker.
   Picker usage: <input type="hidden" name="x"> + <button type="button" data-media-pick="x"> inside a form,
   optional [data-media-preview="x"] (single) or [data-media-list="x"] + data-media-multiple (list). */
(function () {
  'use strict';
  if (window.__dbIntegrations) return;
  window.__dbIntegrations = true;

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function el(tag, attrs, text) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function iconSvg(name) {
    var use = document.querySelector('svg.icon use');
    var base = use ? (use.getAttribute('href') || '').split('#')[0] : '/icons.svg';
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon icon-sm'); svg.setAttribute('aria-hidden', 'true');
    var u = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    u.setAttribute('href', base + '#i-' + name); svg.appendChild(u);
    return svg;
  }

  /* ---------- Google Sheets: busy state while an export runs ---------- */
  $$('form[data-gs-run]').forEach(function (f) {
    f.addEventListener('submit', function () {
      var b = f.querySelector('button[type=submit]');
      if (!b) return;
      setTimeout(function () { b.disabled = true; var txt = b.getAttribute('data-busy-text'); if (txt) { b.textContent = ''; var s = el('span', { 'class': 'spinner' }); b.appendChild(s); b.appendChild(document.createTextNode(' ' + txt)); } }, 0);
    });
  });

  /* ---------- Media library: PDFs cannot be public ---------- */
  $$('[data-open-dialog="media-edit"]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var wrap = $('#media-edit [data-ml-public]');
      if (wrap) wrap.hidden = btn.hasAttribute('data-ml-pdf');
    });
  });

  /* ---------- Media picker ---------- */
  var dlg = document.getElementById('media-picker');
  if (!dlg) return;
  var grid = $('[data-mp-grid]', dlg);
  var status = $('[data-mp-status]', dlg);
  var qInput = $('[data-mp-q]', dlg);
  var folderSel = $('[data-mp-folder]', dlg);
  var fileInput = $('[data-mp-file]', dlg);
  var target = null; // { form, name, multiple, max }
  var timer = null;
  var foldersLoaded = false;

  function setStatus(text) { status.textContent = text || ''; }

  function load() {
    var url = dlg.getAttribute('data-api') + '?kind=image&q=' + encodeURIComponent(qInput.value || '') + (folderSel.value !== '' ? '&folder=' + encodeURIComponent(folderSel.value) : '');
    setStatus('');
    grid.setAttribute('aria-busy', 'true');
    fetch(url, { headers: { accept: 'application/json' }, credentials: 'same-origin' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (res) { render(res.data || []); if (!foldersLoaded) fillFolders(res.folders || []); })
      .catch(function () { grid.textContent = ''; setStatus(dlg.getAttribute('data-t-error')); })
      .then(function () { grid.removeAttribute('aria-busy'); });
  }

  function fillFolders(list) {
    foldersLoaded = true;
    list.forEach(function (f) {
      var o = el('option', { value: f }, f || dlg.getAttribute('data-t-nofolder'));
      folderSel.appendChild(o);
    });
  }

  function render(items) {
    grid.textContent = '';
    if (!items.length) { grid.appendChild(el('p', { 'class': 'small muted mp-empty' }, dlg.getAttribute('data-t-empty'))); return; }
    items.forEach(function (m) {
      var b = el('button', { type: 'button', 'class': 'mp-item', title: m.name });
      var img = el('img', { src: m.url, alt: m.alt || '', loading: 'lazy' });
      b.appendChild(img);
      var cap = el('span', { 'class': 'mp-cap tiny truncate' }, m.name);
      b.appendChild(cap);
      if (!m.isPublic) b.appendChild(el('span', { 'class': 'mp-flag tiny muted' }, dlg.getAttribute('data-t-private')));
      b.addEventListener('click', function () { choose(m); });
      grid.appendChild(b);
    });
  }

  function inputFor(name) { return target && target.form ? target.form.querySelector('input[type=hidden][name="' + name + '"]') : null; }

  function choose(m) {
    if (!target) return;
    var form = target.form; var name = target.name;
    if (target.multiple) {
      var list = form.querySelector('[data-media-list="' + name + '"]');
      if (!list) return;
      var exists = $$('input[name="' + name + '"]', list).some(function (i) { return i.value === String(m.id); });
      var count = $$('input[name="' + name + '"]', list).length;
      if (!exists && (!target.max || count < target.max)) list.appendChild(listItem(name, m));
    } else {
      var input = inputFor(name);
      if (input) input.value = String(m.id);
      var prev = form.querySelector('[data-media-preview="' + name + '"]');
      if (prev) { prev.textContent = ''; prev.appendChild(el('img', { src: m.url, alt: m.alt || '' })); }
      var clear = form.querySelector('[data-media-clear="' + name + '"]');
      if (clear) clear.hidden = false;
    }
    dlg.close();
    changed(form);
  }

  // Lets a form that saves itself (the website builder) know a picture changed.
  function changed(form) { if (form && form.dispatchEvent && window.Event) form.dispatchEvent(new Event('change', { bubbles: true })); }

  function listItem(name, m) {
    var li = el('li', { 'class': 'pm-item' });
    li.appendChild(el('img', { src: m.url, alt: m.alt || '' }));
    li.appendChild(el('input', { type: 'hidden', name: name, value: String(m.id) }));
    var rm = el('button', { type: 'button', 'class': 'btn btn-secondary btn-sm btn-icon pm-remove', 'data-media-remove': '', 'aria-label': dlg.getAttribute('data-t-remove'), title: dlg.getAttribute('data-t-remove') });
    rm.appendChild(iconSvg('x'));
    li.appendChild(rm);
    return li;
  }

  document.addEventListener('click', function (e) {
    var pick = e.target.closest && e.target.closest('[data-media-pick]');
    if (pick) {
      e.preventDefault();
      target = { form: pick.closest('form') || document, name: pick.getAttribute('data-media-pick'), multiple: pick.hasAttribute('data-media-multiple'), max: Number(pick.getAttribute('data-media-max')) || 0 };
      dlg.showModal();
      load();
      qInput.focus();
      return;
    }
    var clear = e.target.closest && e.target.closest('[data-media-clear]');
    if (clear) {
      var form = clear.closest('form'); var name = clear.getAttribute('data-media-clear');
      var input = form && form.querySelector('input[type=hidden][name="' + name + '"]');
      if (input) input.value = '';
      var prev = form && form.querySelector('[data-media-preview="' + name + '"]');
      if (prev) prev.textContent = '';
      clear.hidden = true;
      changed(form);
      return;
    }
    var rm = e.target.closest && e.target.closest('[data-media-remove]');
    if (rm) { var li = rm.closest('li'); var f = rm.closest('form'); if (li) li.parentNode.removeChild(li); changed(f); }
  });

  qInput.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(load, 250); });
  folderSel.addEventListener('change', load);

  fileInput.addEventListener('change', function () {
    var f = fileInput.files && fileInput.files[0];
    if (!f) return;
    var fd = new FormData();
    fd.append('_csrf', dlg.getAttribute('data-csrf'));
    fd.append('files', f);
    setStatus(dlg.getAttribute('data-t-uploading'));
    fetch(dlg.getAttribute('data-upload'), { method: 'POST', body: fd, credentials: 'same-origin', headers: { accept: 'application/json', 'x-csrf-token': dlg.getAttribute('data-csrf') } })
      .then(function (r) { return r.json().catch(function () { return { data: [], errors: [{ message: dlg.getAttribute('data-t-error') }] }; }); })
      .then(function (res) {
        fileInput.value = '';
        if (res.data && res.data.length) { setStatus(''); choose(res.data[0]); return; }
        setStatus((res.errors && res.errors[0] && res.errors[0].message) || dlg.getAttribute('data-t-error'));
      })
      .catch(function () { setStatus(dlg.getAttribute('data-t-error')); });
  });
}());

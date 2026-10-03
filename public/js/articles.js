// Article editor: Arabic / English tabs, a small formatting toolbar that writes the article markup into the text,
// image upload (into the clinic's media library) inserted as [[img:ID]] or set as the cover, and a preview.
(function () {
  'use strict';
  var form = document.querySelector('[data-art-form]');
  if (!form) return;
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var csrf = (form.querySelector('[name="_csrf"]') || {}).value || '';
  var T = {};
  try { T = JSON.parse(document.querySelector('[data-art-i18n]').textContent); } catch (e) { T = {}; }
  var lastBody = document.getElementById('f-body');

  // Language tabs (both languages are posted; an empty one is simply not shown to visitors).
  $$('[data-art-lang]').forEach(function (b) {
    b.addEventListener('click', function () {
      var lg = b.getAttribute('data-art-lang');
      $$('[data-art-lang]').forEach(function (x) { var on = x === b; x.classList.toggle('is-on', on); x.setAttribute('aria-selected', on ? 'true' : 'false'); });
      $$('[data-art-pane]').forEach(function (p) { p.hidden = p.getAttribute('data-art-pane') !== lg; });
      lastBody = document.getElementById(lg === 'en' ? 'f-body_en' : 'f-body');
    });
  });
  $$('textarea.art-body').forEach(function (t) { t.addEventListener('focus', function () { lastBody = t; }); });

  function wrapSel(ta, before, after, placeholder) {
    var s = ta.selectionStart; var e = ta.selectionEnd; var v = ta.value;
    var sel = v.slice(s, e) || placeholder || '';
    ta.value = v.slice(0, s) + before + sel + after + v.slice(e);
    ta.focus(); ta.selectionStart = s + before.length; ta.selectionEnd = s + before.length + sel.length;
  }
  function linePrefix(ta, prefix) {
    var s = ta.selectionStart; var v = ta.value;
    var start = v.lastIndexOf('\n', s - 1) + 1;
    ta.value = v.slice(0, start) + prefix + v.slice(start);
    ta.focus(); ta.selectionStart = ta.selectionEnd = s + prefix.length;
  }
  function insertBlock(ta, text) {
    var s = ta.selectionStart; var v = ta.value;
    var pre = s > 0 && v[s - 1] !== '\n' ? '\n\n' : (s > 1 && v[s - 2] !== '\n' ? '\n' : '');
    ta.value = v.slice(0, s) + pre + text + '\n\n' + v.slice(s);
    ta.focus(); ta.selectionStart = ta.selectionEnd = s + pre.length + text.length + 2;
  }
  $$('[data-art-toolbar]').forEach(function (bar) {
    var ta = document.getElementById(bar.getAttribute('data-art-toolbar'));
    bar.addEventListener('click', function (e) {
      var b = e.target.closest('[data-art-md]');
      if (!b) return;
      var k = b.getAttribute('data-art-md');
      if (k === 'b') wrapSel(ta, '**', '**');
      else if (k === 'i') wrapSel(ta, '*', '*');
      else if (k === 'h2') linePrefix(ta, '## ');
      else if (k === 'h3') linePrefix(ta, '### ');
      else if (k === 'ul') linePrefix(ta, '- ');
      else if (k === 'ol') linePrefix(ta, '1. ');
      else if (k === 'q') linePrefix(ta, '> ');
      else if (k === 'link') {
        var url = window.prompt(T.link_url || 'https://', 'https://');
        if (!url || !/^https?:\/\/\S+$/.test(url)) return;
        wrapSel(ta, '[', '](' + url + ')', T.link_text || 'link');
      }
    });
  });

  // Images: upload → add to the strip; in the body as [[img:ID]], or as the cover.
  var strip = document.querySelector('[data-art-images]');
  var coverBox = document.querySelector('[data-art-cover]');
  var coverId = document.querySelector('[data-art-cover-id]');
  var coverClear = document.querySelector('[data-art-cover-clear]');
  function addThumb(m) {
    if (!strip || strip.querySelector('[data-art-insert="' + m.id + '"]')) return;
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'art-img'; b.setAttribute('data-art-insert', String(m.id));
    var img = document.createElement('img'); img.src = m.url; img.alt = '';
    b.appendChild(img); strip.appendChild(b);
  }
  function setCover(m) {
    coverId.value = m ? String(m.id) : '';
    coverBox.textContent = '';
    if (m) { var img = document.createElement('img'); img.src = m.url; img.alt = ''; coverBox.appendChild(img); } else { var s = document.createElement('span'); s.className = 'muted small'; s.textContent = T.cover_none || ''; coverBox.appendChild(s); }
    if (coverClear) coverClear.hidden = !m;
  }
  if (coverClear) coverClear.addEventListener('click', function () { setCover(null); });
  if (strip) strip.addEventListener('click', function (e) {
    var b = e.target.closest('[data-art-insert]');
    if (b && lastBody) insertBlock(lastBody, '[[img:' + b.getAttribute('data-art-insert') + ']]');
  });
  $$('[data-art-upload]').forEach(function (input) {
    input.addEventListener('change', function () {
      if (!input.files || !input.files.length) return;
      var fd = new FormData();
      fd.append('_csrf', csrf);
      Array.prototype.forEach.call(input.files, function (f) { fd.append('files', f); });
      var label = input.closest('label'); if (label) label.classList.add('is-busy');
      fetch('/app/articles/images', { method: 'POST', body: fd, credentials: 'same-origin', headers: { Accept: 'application/json' } })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          (d.data || []).forEach(function (m) {
            addThumb(m);
            if (input.getAttribute('data-art-upload') === 'cover') setCover(m);
            else if (lastBody) insertBlock(lastBody, '[[img:' + m.id + ']]');
          });
          if (d.errors && d.errors.length) window.alert(d.errors.join('\n'));
        })
        .catch(function () { window.alert(T.upload_failed || 'Upload failed'); })
        .then(function () { input.value = ''; if (label) label.classList.remove('is-busy'); });
    });
  });

  // Preview of the language being edited.
  $$('[data-art-preview]').forEach(function (b) {
    b.addEventListener('click', function () {
      var pane = b.closest('[data-art-pane]');
      var ta = pane.querySelector('textarea.art-body');
      var box = pane.querySelector('[data-art-preview-box]');
      var label = b.querySelector('span');
      if (!box.hidden) { box.hidden = true; ta.hidden = false; if (label) label.textContent = T.preview || ''; return; }
      fetch('/app/articles/preview', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify({ body: ta.value }) })
        .then(function (r) { return r.json(); })
        .then(function (d) { box.innerHTML = d.html || ''; box.hidden = false; ta.hidden = true; if (label) label.textContent = T.preview_hide || ''; });
    });
  });
}());

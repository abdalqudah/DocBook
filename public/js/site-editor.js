/* Landing page editor (platform admin): repeatable rows, the icon picker, the media picker and uploads
   (media library), design options that depend on each other, and character counters (Search & AI).
   Without JavaScript the rows already on the page can still be edited, icons and images are plain lists. */
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
        if (last) { enhanceIcons(last); enhanceMedia(last); var first = last.querySelector('input:not([type=hidden]), textarea'); if (first) first.focus(); }
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
  /* ---------- Media: upload (the raw file with the CSRF token in a header), picker thumbnails ---------- */
  var csrf = ($('meta[name="csrf-token"]') || {}).content || '';
  var maxBytes = Number(text.maxBytes) || 5242880;
  function uploadFile(file, name) {
    if (!file) return Promise.reject(new Error(text.choose || ''));
    if (['image/png', 'image/jpeg', 'image/webp'].indexOf(file.type) === -1 && file.type) return Promise.reject(new Error(text.failed || ''));
    if (file.size > maxBytes) return Promise.reject(new Error(text.tooBig || ''));
    return fetch('/admin/site/media', {
      method: 'POST', credentials: 'same-origin', body: file,
      headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-CSRF-Token': csrf, 'X-File-Name': encodeURIComponent(name || file.name || ''), Accept: 'application/json' }
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (body) {
        if (!r.ok || !body.data) throw new Error(body.error || text.failed || '');
        return body.data;
      });
    });
  }

  function paintThumb(pick) {
    var sel = pick.querySelector('select');
    var thumb = pick.querySelector('[data-media-thumb]');
    if (!sel || !thumb) return;
    var opt = sel.options[sel.selectedIndex];
    var url = opt && opt.getAttribute('data-url');
    thumb.innerHTML = url ? '<img src="' + url.replace(/"/g, '') + '" alt="">' : iconSvg('image', 'muted');
  }
  function enhanceMedia(root) {
    $$('[data-media-pick]', root).forEach(function (pick) {
      if (pick.getAttribute('data-ready')) return;
      pick.setAttribute('data-ready', '1');
      var btn = pick.querySelector('[data-media-upload]');
      if (btn) btn.hidden = false;
      paintThumb(pick);
    });
  }
  enhanceMedia(document);
  document.addEventListener('change', function (e) {
    var pick = e.target.closest && e.target.closest('[data-media-pick]');
    if (pick) paintThumb(pick);
    if (e.target.matches && (e.target.matches('[data-design]') || e.target.name === 'd_media')) designVisibility();
  });

  // Upload from inside a picker: the new image joins every picker on the page and is chosen in this one.
  var fileInput = $('[data-media-file]');
  var target = null;
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-media-upload]');
    if (!b || !fileInput) return;
    e.preventDefault();
    target = b.closest('[data-media-pick]');
    fileInput.value = '';
    fileInput.click();
  });
  if (fileInput) fileInput.addEventListener('change', function () {
    var file = fileInput.files && fileInput.files[0];
    if (!file || !target) return;
    var btn = target.querySelector('[data-media-upload]');
    var label = btn && btn.querySelector('span');
    var before = label ? label.textContent : '';
    if (btn) btn.disabled = true;
    if (label) label.textContent = text.uploading || '…';
    uploadFile(file).then(function (m) {
      $$('select[data-media-select]').forEach(function (sel) {
        var o = document.createElement('option');
        o.value = String(m.id); o.textContent = m.name + (m.width ? ' · ' + m.width + '×' + m.height : ''); o.setAttribute('data-url', m.url);
        sel.insertBefore(o, sel.options[1] || null);
      });
      $$('template[data-row-template]').forEach(function (tpl) {
        $$('select[data-media-select]', tpl.content).forEach(function (sel) {
          var o = document.createElement('option');
          o.value = String(m.id); o.textContent = m.name; o.setAttribute('data-url', m.url);
          sel.insertBefore(o, sel.options[1] || null);
        });
      });
      var sel = target.querySelector('select');
      sel.value = String(m.id);
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      if (label) label.textContent = text.uploaded || before;
      setTimeout(function () { if (label) label.textContent = before; }, 2000);
    }).catch(function (err) {
      if (label) label.textContent = before;
      window.alert(err.message || text.failed || '');
    }).then(function () { if (btn) btn.disabled = false; });
  });

  // Media library page: the upload form (shown only with JavaScript).
  var mform = $('form[data-media-form]');
  if (mform) {
    mform.hidden = false;
    var status = $('[data-media-status]', mform);
    mform.addEventListener('submit', function (e) {
      e.preventDefault();
      var input = mform.querySelector('input[type=file]');
      var file = input && input.files && input.files[0];
      var submit = mform.querySelector('button[type=submit]');
      if (status) status.textContent = text.uploading || '';
      if (submit) submit.disabled = true;
      uploadFile(file, (mform.querySelector('input[name=name]') || {}).value).then(function () {
        if (status) status.textContent = text.uploaded || '';
        window.location.reload();
      }).catch(function (err) {
        if (status) status.textContent = err.message || text.failed || '';
        if (submit) submit.disabled = false;
      });
    });
  }

  /* ---------- Design options: show what applies (background image, image position/size/alt) ---------- */
  function designVisibility() {
    var bg = $('select[data-design="background"]');
    var mediaSel = $('select[name="d_media"]');
    var show = function (key, on) { var f = $('[data-design-field="' + key + '"]'); if (f) f.hidden = !on; };
    if (bg) show('bg_image', bg.value === 'image');
    if (mediaSel) ['media_pos', 'media_size', 'media_alt'].forEach(function (k) { show(k, Boolean(mediaSel.value)); });
  }
  designVisibility();

  /* ---------- Character counters (data-count = recommended length) ---------- */
  $$('[data-count]').forEach(function (el) {
    var limit = Number(el.getAttribute('data-count'));
    var out = document.createElement('span');
    out.className = 'char-count tiny';
    out.setAttribute('aria-live', 'polite');
    el.parentNode.appendChild(out);
    var update = function () {
      var n = el.value.length;
      out.textContent = n + ' / ' + limit;
      out.classList.toggle('is-over', n > limit);
    };
    el.addEventListener('input', update);
    update();
  });
})();

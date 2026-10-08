// Legacy Patient Recovery: drag-and-drop uploads (one file at a time, with progress), the live dashboard (polls the
// job's status and refreshes when a stage ends), the image viewer (zoom, full screen, download) and the patient
// picker of the recovery list. Everything talks only to this application.
(function () {
  'use strict';
  var csrf = (document.querySelector('meta[name="csrf-token"]') || {}).content || '';
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
  function fmtSize(n) { return n >= 1073741824 ? (n / 1073741824).toFixed(1) + ' GB' : n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }

  // ---------------------------------------------------------------- uploads
  document.querySelectorAll('[data-legacy-drop]').forEach(function (form) {
    var input = form.querySelector('input[type=file]');
    var queue = form.querySelector('[data-queue]');
    var accept = (form.getAttribute('data-accept') || '').toLowerCase();
    if (!input || !window.FormData || !window.XMLHttpRequest) return;
    form.classList.add('js-ready');
    input.removeAttribute('required');
    function send(files) {
      var list = Array.prototype.filter.call(files, function (f) { return !accept || f.name.toLowerCase().slice(-accept.length) === accept; });
      if (!form.getAttribute('data-multiple')) list = list.slice(0, 1);
      if (!list.length) return;
      var rows = list.map(function (f) {
        var row = el('div', 'lg-qrow');
        row.appendChild(el('span', 'ellipsis', f.name));
        var pct = el('span', 'num', '0%'); row.appendChild(pct);
        var meter = el('span', 'meter'); var bar = el('span'); bar.style.width = '0%'; meter.appendChild(bar); row.appendChild(meter);
        queue.appendChild(row);
        return { file: f, row: row, pct: pct, bar: bar };
      });
      var failed = false;
      (function next(i) {
        if (i >= rows.length) { if (!failed) window.location.reload(); return; }
        var r = rows[i];
        var fd = new FormData();
        fd.append('_csrf', csrf);
        fd.append('file', r.file, r.file.name);
        var xhr = new XMLHttpRequest();
        xhr.open('POST', form.getAttribute('action'));
        xhr.setRequestHeader('Accept', 'application/json');
        xhr.setRequestHeader('X-CSRF-Token', csrf);
        xhr.upload.onprogress = function (e) { if (e.lengthComputable) { var p = Math.round(e.loaded * 100 / e.total); r.pct.textContent = p + '% · ' + fmtSize(e.total); r.bar.style.width = p + '%'; } };
        xhr.onload = function () {
          var res = {}; try { res = JSON.parse(xhr.responseText); } catch (err) { res = {}; }
          if (xhr.status >= 200 && xhr.status < 300 && res.ok) { r.pct.textContent = '✓'; r.bar.style.width = '100%'; }
          else { failed = true; r.row.classList.add('is-bad'); r.pct.textContent = res.message || ('HTTP ' + xhr.status); }
          next(i + 1);
        };
        xhr.onerror = function () { failed = true; r.row.classList.add('is-bad'); r.pct.textContent = '✕'; next(i + 1); };
        xhr.send(fd);
      }(0));
    }
    input.addEventListener('change', function () { send(input.files); input.value = ''; });
    ['dragenter', 'dragover'].forEach(function (t) { form.addEventListener(t, function (e) { e.preventDefault(); form.classList.add('is-over'); }); });
    ['dragleave', 'drop'].forEach(function (t) { form.addEventListener(t, function (e) { e.preventDefault(); form.classList.remove('is-over'); }); });
    form.addEventListener('drop', function (e) { if (e.dataTransfer && e.dataTransfer.files) send(e.dataTransfer.files); });
  });

  // ---------------------------------------------------------------- live dashboard
  var job = document.querySelector('[data-legacy-job]');
  if (job && job.getAttribute('data-live')) {
    var url = job.getAttribute('data-status-url');
    var start = job.getAttribute('data-state');
    var bar = job.querySelector('[data-lg-bar]'); var pctEl = job.querySelector('[data-lg-pct]'); var proc = job.querySelector('[data-lg-processed]');
    var tick = function () {
      fetch(url, { headers: { Accept: 'application/json' }, credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (s) {
        if (bar) { bar.style.width = Math.min(100, s.progress) + '%'; bar.parentNode.setAttribute('aria-valuenow', s.progress); }
        if (pctEl) pctEl.textContent = s.progress + '%';
        if (proc) proc.textContent = proc.getAttribute('data-text').replace('{done}', s.processed).replace('{total}', s.total);
        // A stage ended (checked, imported, failed): show the new state.
        var state = s.status + '|' + (s.analyzing ? 1 : 0);
        if (state.split('|')[0] !== start.split('|')[0] || (s.status !== 'processing' && !s.analyzing)) { window.location.reload(); return; }
        setTimeout(tick, 2500);
      }).catch(function () { setTimeout(tick, 6000); });
    };
    setTimeout(tick, 2000);
  }

  // ---------------------------------------------------------------- image viewer
  var viewer = document.querySelector('[data-lg-viewer]');
  if (viewer && typeof viewer.showModal === 'function') {
    var img = viewer.querySelector('[data-v-img]'); var stage = viewer.querySelector('[data-v-stage]'); var zoom = 1;
    // Zoom by size (not transform) so a zoomed image scrolls to every edge.
    var fitW = 0;
    var setZoom = function (z) {
      if (!stage.classList.contains('is-zoomed')) fitW = img.getBoundingClientRect().width || img.naturalWidth || 1;
      zoom = Math.max(1, Math.min(8, z));
      if (zoom === 1) { stage.classList.remove('is-zoomed'); img.style.width = ''; return; }
      stage.classList.add('is-zoomed'); img.style.width = Math.round(fitW * zoom) + 'px';
    };
    document.querySelectorAll('[data-lg-view]').forEach(function (b) {
      b.addEventListener('click', function () {
        img.src = b.getAttribute('data-lg-view'); img.alt = b.getAttribute('data-name') || '';
        viewer.querySelector('[data-v-name]').textContent = b.getAttribute('data-name') || '';
        viewer.querySelector('[data-v-date]').textContent = b.getAttribute('data-date') || '';
        viewer.querySelector('[data-v-source]').textContent = b.getAttribute('data-source') || '';
        viewer.querySelector('[data-v-download]').setAttribute('href', b.getAttribute('data-download'));
        zoom = 1; img.style.width = ''; stage.classList.remove('is-zoomed'); viewer.showModal();
      });
    });
    viewer.querySelectorAll('[data-v-zoom]').forEach(function (b) { b.addEventListener('click', function () { setZoom(zoom * (b.getAttribute('data-v-zoom') === '1' ? 1.25 : 0.8)); }); });
    stage.addEventListener('wheel', function (e) { if (e.ctrlKey || e.metaKey) { e.preventDefault(); setZoom(zoom * (e.deltaY < 0 ? 1.1 : 0.9)); } }, { passive: false });
    img.addEventListener('dblclick', function () { setZoom(zoom > 1 ? 1 : 2); });
    viewer.querySelector('[data-v-full]').addEventListener('click', function () { if (document.fullscreenElement) document.exitFullscreen(); else if (viewer.requestFullscreen) viewer.requestFullscreen(); });
    viewer.querySelector('[data-v-close]').addEventListener('click', function () { if (document.fullscreenElement) document.exitFullscreen(); viewer.close(); });
    viewer.addEventListener('close', function () { img.removeAttribute('src'); });
  }

  // ---------------------------------------------------------------- recovery: pick the patient to link
  document.querySelectorAll('[data-legacy-link]').forEach(function (form) {
    var find = form.querySelector('[data-find]'); var out = form.querySelector('[data-found]'); var pid = form.querySelector('[data-pid]'); var go = form.querySelector('[data-go]'); var timer;
    find.addEventListener('input', function () {
      clearTimeout(timer); pid.value = ''; go.disabled = true;
      timer = setTimeout(function () {
        var q = find.value.trim(); out.textContent = '';
        if (q.length < 2) return;
        fetch('/app/appointments/patient-lookup?q=' + encodeURIComponent(q), { headers: { Accept: 'application/json' }, credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (res) {
          out.textContent = '';
          (res.data || []).forEach(function (p) {
            var b = el('button', '', p.name + (p.file ? ' · #' + p.file : '') + (p.phone ? ' · ' + p.phone : ''));
            b.type = 'button'; b.setAttribute('dir', 'auto'); b.setAttribute('aria-pressed', 'false');
            b.addEventListener('click', function () { out.querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-pressed', 'false'); }); b.setAttribute('aria-pressed', 'true'); pid.value = p.id; go.disabled = false; });
            out.appendChild(b);
          });
        }).catch(function () {});
      }, 250);
    });
  });
}());

// Direct pull from Clinica: the counts while it runs; the page reloads when it ends.
(function () {
  'use strict';
  var box = document.querySelector('[data-remote][data-live]');
  if (!box) return;
  var url = box.getAttribute('data-status-url');
  var nf = function (n) { return Number(n || 0).toLocaleString(); };
  var set = function (k, v) { var el = box.querySelector('[data-rm="' + k + '"]'); if (el) el.textContent = v; };
  var tick = function () {
    fetch(url, { headers: { Accept: 'application/json' }, credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (s) {
      if (!s || s.status !== 'processing') { window.location.reload(); return; }
      set('patients', nf(s.patients.done) + ' / ' + nf(s.patients.total)); set('found', nf(s.found)); set('downloaded', nf(s.downloaded)); set('skipped', nf(s.skipped)); set('failed', nf(s.failed));
      setTimeout(tick, 5000);
    }).catch(function () { setTimeout(tick, 15000); });
  };
  setTimeout(tick, 5000);
}());

// Doctors of the Clinica data: one select per name → the hidden action / doctor_id fields; the conversion progress.
(function () {
  'use strict';
  document.querySelectorAll('[data-legacy-doctors] [data-pick]').forEach(function (sel) {
    var td = sel.parentNode; var act = td.querySelector('[data-act]'); var doc = td.querySelector('[data-doc]');
    sel.addEventListener('change', function () {
      var v = sel.value;
      if (v.indexOf('d:') === 0) { act.value = 'doctor'; doc.value = v.slice(2); } else { act.value = v; doc.value = ''; }
    });
  });
  var box = document.querySelector('[data-promote]');
  if (box && box.getAttribute('data-live')) {
    var url = box.getAttribute('data-status-url');
    var tick = function () {
      fetch(url, { headers: { Accept: 'application/json' }, credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (s) {
        var pct = s.total ? Math.round(s.done * 100 / s.total) : 0;
        var bar = box.querySelector('[data-bar]'); if (bar) bar.style.width = pct + '%';
        var p = box.querySelector('[data-pct]'); if (p) p.textContent = pct + '%';
        var t = box.querySelector('[data-text]'); if (t) t.textContent = t.getAttribute('data-tpl').replace('{done}', s.done.toLocaleString()).replace('{total}', s.total.toLocaleString());
        var v = box.querySelector('[data-visits]'); if (v) v.textContent = s.visits.toLocaleString();
        if (!s.running) { window.location.reload(); return; }
        setTimeout(tick, 3000);
      }).catch(function () { setTimeout(tick, 6000); });
    };
    setTimeout(tick, 2000);
  }
}());

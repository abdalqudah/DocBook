/* Signatures & stamp: upload checks, "Upload | Draw" switch and the drawing pad (pointer events: mouse, pen, touch).
   Without JavaScript the upload forms work as plain forms; the drawing pad needs JavaScript and stays hidden. */
(function () {
  'use strict';
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  function helpError(help, msg) {
    if (!help) return;
    if (!help.getAttribute('data-default')) help.setAttribute('data-default', help.textContent);
    help.textContent = msg || help.getAttribute('data-default');
    help.classList.toggle('is-error', Boolean(msg));
  }

  /* ---------- file inputs: type and size before uploading, local preview ---------- */
  $$('input[data-sig-file]').forEach(function (input) {
    var form = input.form;
    var help = form.querySelector('[data-sig-help]');
    var box = input.closest('.sig-doctor');
    var preview = box ? box.querySelector('[data-sig-preview]') : null;
    function problem() {
      var f = input.files && input.files[0];
      if (!f) return '';
      if (['image/png', 'image/jpeg'].indexOf(f.type) === -1) return input.getAttribute('data-wrong-type');
      if (f.size > Number(input.getAttribute('data-max') || 1048576)) return input.getAttribute('data-too-big');
      return '';
    }
    input.addEventListener('change', function () {
      var msg = problem();
      helpError(help, msg);
      var f = input.files && input.files[0];
      if (!msg && f && preview && window.URL && URL.createObjectURL) {
        var img = document.createElement('img');
        img.alt = '';
        img.src = URL.createObjectURL(f);
        preview.textContent = '';
        preview.appendChild(img);
      }
    });
    // Capture phase: runs before the confirmation dialog, so a wrong file never asks "Replace?".
    form.addEventListener('submit', function (e) {
      var msg = problem();
      if (msg) { e.preventDefault(); e.stopImmediatePropagation(); helpError(help, msg); input.focus(); }
    }, true);
  });

  /* ---------- Upload | Draw ---------- */
  $$('[data-sig-doctor]').forEach(function (box) {
    var modes = box.querySelector('[data-sig-modes]');
    var drawForm = box.querySelector('[data-sig-draw-form]');
    if (!modes || !drawForm || !window.HTMLCanvasElement) return;
    modes.hidden = false;
    var pad = null;
    function show(mode) {
      $$('[data-sig-pane]', box).forEach(function (p) { p.hidden = p.getAttribute('data-sig-pane') !== mode; });
      if (mode === 'draw') { if (!pad) pad = makePad(drawForm); else pad.fit(); }
    }
    $$('[data-sig-mode]', modes).forEach(function (r) {
      r.addEventListener('change', function () { if (r.checked) show(r.value); });
    });
  });

  /* ---------- drawing pad ---------- */
  function makePad(form) {
    var canvas = form.querySelector('[data-sig-canvas]');
    var paper = canvas.parentNode;
    var ctx = canvas.getContext('2d');
    var help = form.querySelector('[data-sig-draw-help]');
    var field = form.querySelector('[data-sig-data]');
    var strokes = []; // [[{x, y}, …], …] in CSS pixels
    var current = null;
    var ratio = Math.min(window.devicePixelRatio || 1, 2);
    var LINE = 2.4;

    function ink() { return window.getComputedStyle(paper).color; }

    function fit() {
      var r = paper.getBoundingClientRect();
      if (!r.width) return;
      canvas.width = Math.round(r.width * ratio);
      canvas.height = Math.round(r.height * ratio);
      redraw();
    }

    function drawStroke(c, pts, scale, dx, dy) {
      if (!pts.length) return;
      c.beginPath();
      c.moveTo((pts[0].x - dx) * scale, (pts[0].y - dy) * scale);
      if (pts.length === 1) { c.lineTo((pts[0].x - dx) * scale + 0.1, (pts[0].y - dy) * scale + 0.1); }
      for (var i = 1; i < pts.length - 1; i += 1) {
        var mx = (pts[i].x + pts[i + 1].x) / 2;
        var my = (pts[i].y + pts[i + 1].y) / 2;
        c.quadraticCurveTo((pts[i].x - dx) * scale, (pts[i].y - dy) * scale, (mx - dx) * scale, (my - dy) * scale);
      }
      if (pts.length > 1) { var last = pts[pts.length - 1]; c.lineTo((last.x - dx) * scale, (last.y - dy) * scale); }
      c.stroke();
    }

    function style(c, scale) {
      c.lineWidth = LINE * scale;
      c.lineCap = 'round';
      c.lineJoin = 'round';
      c.strokeStyle = ink();
    }

    function redraw() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      style(ctx, ratio);
      strokes.forEach(function (s) { drawStroke(ctx, s, ratio, 0, 0); });
    }

    function point(e) {
      var r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    canvas.addEventListener('pointerdown', function (e) {
      if (e.button !== undefined && e.button > 0) return;
      e.preventDefault();
      if (canvas.setPointerCapture) canvas.setPointerCapture(e.pointerId);
      current = [point(e)];
      strokes.push(current);
      helpError(help, '');
      redraw();
    });
    canvas.addEventListener('pointermove', function (e) {
      if (!current) return;
      e.preventDefault();
      var list = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      (list.length ? list : [e]).forEach(function (ev) { current.push(point(ev)); });
      redraw();
    });
    function end() { current = null; }
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('lostpointercapture', end);

    form.querySelector('[data-sig-clear]').addEventListener('click', function () { strokes = []; field.value = ''; redraw(); helpError(help, ''); });

    /** PNG of the strokes only (cropped, transparent background, 2× for print). */
    function exportPng() {
      var minX = Infinity; var minY = Infinity; var maxX = -Infinity; var maxY = -Infinity;
      strokes.forEach(function (s) { s.forEach(function (p) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }); });
      var padPx = 6;
      var scale = 2;
      var w = Math.max(16, Math.ceil((maxX - minX + padPx * 2) * scale));
      var h = Math.max(16, Math.ceil((maxY - minY + padPx * 2) * scale));
      var out = document.createElement('canvas');
      out.width = w; out.height = h;
      var c = out.getContext('2d');
      style(c, scale);
      strokes.forEach(function (s) { drawStroke(c, s, scale, minX - padPx, minY - padPx); });
      return out.toDataURL('image/png');
    }

    // Capture phase: fill the field (or stop an empty drawing) before the confirmation dialog.
    form.addEventListener('submit', function (e) {
      var any = strokes.some(function (s) { return s.length > 1; });
      if (!any) { e.preventDefault(); e.stopImmediatePropagation(); helpError(help, help.getAttribute('data-empty')); return; }
      field.value = exportPng();
    }, true);

    var resizeTimer;
    window.addEventListener('resize', function () { clearTimeout(resizeTimer); resizeTimer = setTimeout(fit, 120); });
    fit();
    return { fit: fit };
  }
}());

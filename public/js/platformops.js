/* Platform operations: invoice template preview, service category filters (clinic page + booking),
   in-app update upload and the "restarting" page. Everything works without it except the zip upload. */
(function () {
  'use strict';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  /* ---------- invoice template: live mini preview ---------- */
  var inv = $('[data-po-invoice]');
  if (inv) {
    var mini = $('[data-po-mini]', inv);
    var sync = function () {
      $$('[data-po-toggle]', inv).forEach(function (cb) {
        $$('[data-po-field="' + cb.getAttribute('data-po-toggle') + '"]', inv).forEach(function (el) { el.hidden = !cb.checked; });
      });
      // Letterhead: move the logo, the name block and the invoice number to the chosen zones (the number takes the
      // end side, or the start side when the name is at the end).
      var lh = $('[data-po-lh]', inv);
      if (lh) {
        var val = function (n, d) { var r = $('input[name="' + n + '"]:checked', inv); return r ? r.value : d; };
        var np = val('name_pos', 'start');
        var place = { logo: val('logo_pos', 'start'), who: np, doc: np === 'end' ? 'start' : 'end' };
        ['logo', 'who', 'doc'].forEach(function (k) { var el = $('[data-po-lh-item="' + k + '"]', lh); var z = $('[data-po-zone="' + place[k] + '"]', lh); if (el && z) z.appendChild(el); });
        lh.className = 'po-mini-lh po-mini-logo-' + val('logo_size', 'm');
      }
      var paper = $('[data-po-paper]:checked', inv);
      if (mini && paper) mini.className = 'po-mini po-mini-' + paper.value;
      var prefix = $('[data-po-prefix]', inv); var pout = $('[data-po-prefix-out]', inv);
      if (prefix && pout) pout.textContent = prefix.value.trim();
      var en = document.documentElement.lang === 'en';
      var fa = inv.elements.footer ? inv.elements.footer.value.trim() : '';
      var fe = inv.elements.footer_en ? inv.elements.footer_en.value.trim() : '';
      var fout = $('[data-po-footer-out]', inv);
      if (fout) { var txt = en ? (fe || fa) : (fa || fe); if (!fout.getAttribute('data-default')) fout.setAttribute('data-default', fout.textContent); fout.textContent = txt || fout.getAttribute('data-default'); }
    };
    inv.addEventListener('change', sync);
    inv.addEventListener('input', sync);
  }

  /* ---------- clinic page: category chips filter the service groups ---------- */
  $$('[data-po-cat-chips]').forEach(function (nav) {
    var groups = $$('[data-po-cat-group]', nav.parentNode);
    nav.addEventListener('click', function (e) {
      var a = e.target.closest('[data-po-cat]');
      if (!a) return;
      e.preventDefault();
      var key = a.getAttribute('data-po-cat');
      $$('[data-po-cat]', nav).forEach(function (x) { x.classList.toggle('is-active', x === a); x.setAttribute('aria-pressed', x === a ? 'true' : 'false'); });
      groups.forEach(function (g) { g.hidden = Boolean(key) && g.getAttribute('data-po-cat-group') !== key; });
    });
  });

  /* ---------- booking: category select narrows the service list (hides whole <optgroup>s) ---------- */
  $$('[data-po-book-cat]').forEach(function (box) {
    var sel = $('[data-po-cat-select]', box);
    var target = sel && $(sel.getAttribute('data-target'));
    if (!sel || !target) return;
    box.hidden = false;
    sel.addEventListener('change', function () {
      var key = sel.value;
      $$('optgroup[data-po-cat-group]', target).forEach(function (g) {
        var off = Boolean(key) && g.getAttribute('data-po-cat-group') !== key;
        g.hidden = off; g.disabled = off;
      });
      var opt = target.options[target.selectedIndex];
      if (opt && opt.parentNode && opt.parentNode.disabled) {
        target.value = '';
        target.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
  });

  /* ---------- admin: upload the dist zip (raw body + CSRF header) ---------- */
  var up = $('[data-po-upload]');
  if (up) {
    var file = $('[data-po-file]', up); var status = $('[data-po-status]', up); var bar = $('[data-po-progress]', up);
    var say = function (msg, bad) { status.textContent = msg || ''; status.className = 'small' + (bad ? ' text-danger' : ''); };
    up.addEventListener('submit', function (e) {
      e.preventDefault();
      var f = file && file.files && file.files[0];
      if (!f) { say(up.getAttribute('data-msg-choose'), true); return; }
      if (f.size > Number(up.getAttribute('data-max'))) { say(up.getAttribute('data-msg-too-big'), true); return; }
      var btn = $('button[type="submit"]', up); if (btn) btn.disabled = true;
      bar.hidden = false; say(up.getAttribute('data-msg-uploading'));
      var xhr = new XMLHttpRequest();
      xhr.open('POST', up.getAttribute('action'));
      xhr.setRequestHeader('X-CSRF-Token', up.getAttribute('data-csrf'));
      xhr.setRequestHeader('Accept', 'application/json');
      xhr.setRequestHeader('Content-Type', 'application/zip');
      xhr.upload.onprogress = function (ev) { if (ev.lengthComputable) bar.firstElementChild.style.width = Math.round(ev.loaded / ev.total * 100) + '%'; };
      xhr.onload = function () {
        var body = {}; try { body = JSON.parse(xhr.responseText || '{}'); } catch (err) { body = {}; }
        if (xhr.status >= 200 && xhr.status < 300) { say(body.message || ''); window.location.reload(); return; }
        bar.hidden = true; if (btn) btn.disabled = false;
        say((body.error && (body.error.message || body.error)) || up.getAttribute('data-msg-failed'), true);
      };
      xhr.onerror = function () { bar.hidden = true; if (btn) btn.disabled = false; say(up.getAttribute('data-msg-failed'), true); };
      xhr.send(f);
    });
  }

  /* ---------- admin: wait for the restarted app ---------- */
  var rs = $('[data-po-restart]');
  if (rs) {
    var out = $('[data-po-restart-status]', rs); var tries = 0; var sawDown = false;
    var poll = function () {
      tries += 1;
      var x = new XMLHttpRequest();
      x.open('GET', '/healthz?t=' + Date.now());
      x.timeout = 3000;
      x.onload = function () {
        if (x.status === 200 && (sawDown || tries > 3)) { out.textContent = rs.getAttribute('data-done'); setTimeout(function () { window.location.href = '/admin/updates'; }, 1200); return; }
        if (x.status !== 200) sawDown = true;
        if (tries < 120) setTimeout(poll, 1500);
      };
      x.onerror = x.ontimeout = function () { sawDown = true; if (tries < 120) setTimeout(poll, 1500); };
      x.send();
    };
    setTimeout(poll, 2000);
  }
}());

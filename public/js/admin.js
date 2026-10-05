/* Settings, staff logins and setup wizard behaviour. Progressive enhancement: every form works without it. */
(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  /* ---------- Settings nav: keep the active tab visible on small screens ---------- */
  var nav = $('[data-settings-nav]');
  if (nav) {
    var act = $('a.active', nav);
    if (act && nav.scrollWidth > nav.clientWidth) {
      var nr = nav.getBoundingClientRect(); var ar = act.getBoundingClientRect();
      nav.scrollLeft += (ar.left + ar.width / 2) - (nr.left + nr.width / 2); // works for LTR and RTL scroll origins
    }
  }

  /* ---------- Staff login forms: role ⇄ doctor profile ---------- */
  $$('[data-staff-form]').forEach(function (form) {
    var role = $('[data-role-select]', form);
    var docField = $('[data-doctor-field]', form);
    if (!role || !docField) return;
    var docSelect = $('select', docField);
    var req = $('[data-doctor-req]', docField);
    var name = $('[data-staff-name]', form);
    function sync() {
      var opt = role.options[role.selectedIndex];
      var isDoctor = opt && opt.getAttribute('data-key') === 'doctor';
      if (req) req.hidden = !isDoctor;
      if (docSelect) docSelect.required = isDoctor;
    }
    role.addEventListener('change', sync);
    role.addEventListener('input', sync);
    if (docSelect && name) {
      docSelect.addEventListener('change', function () {
        var o = docSelect.options[docSelect.selectedIndex];
        if (o && o.getAttribute('data-name') && !name.value.trim()) name.value = o.getAttribute('data-name');
        if (o && o.value) {
          var docOpt = $$('option', role).filter(function (x) { return x.getAttribute('data-key') === 'doctor'; })[0];
          if (docOpt && role.value !== docOpt.value && !role.dataset.touched) { role.value = docOpt.value; sync(); }
        }
      });
      role.addEventListener('change', function () { role.dataset.touched = '1'; });
    }
    sync();
  });

  // Team → send sign-in details to one person: e-mail to their address; WhatsApp only with a number and when the
  // clinic may manage the account fully (else the reason is shown).
  $$('[data-open-dialog="send-one-dialog"]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var dlg = document.getElementById('send-one-dialog'); if (!dlg) return;
      var wa = btn.getAttribute('data-send-wa');
      var to = $('[data-send-email-to]', dlg); if (to) to.textContent = btn.getAttribute('data-send-email') || '';
      var ph = $('[data-send-wa-to]', dlg); if (ph) ph.textContent = btn.getAttribute('data-send-phone') || '';
      var wb = $('[data-send-wa-btn]', dlg); if (wb) wb.disabled = wa !== 'ok';
      $$('[data-send-wa-note]', dlg).forEach(function (n) { n.hidden = n.getAttribute('data-send-wa-note') !== wa; });
    });
  });
  // WhatsApp: ask for the ready message (JSON) and open it as a link — a form may not redirect to wa.me. A window is
  // opened at the click (so no pop-up blocker stops it) and sent to WhatsApp once the address is back; the button
  // under it stays for a second try.
  (function () {
    var dlg = document.getElementById('send-one-dialog'); if (!dlg) return;
    var form = $('form', dlg); var wb = $('[data-send-wa-btn]', dlg); var open = $('[data-send-wa-open]', dlg); var err = $('[data-send-error]', dlg);
    dlg.addEventListener('close', function () { if (open) open.hidden = true; if (err) err.hidden = true; });
    $$('[data-open-dialog="send-one-dialog"]').forEach(function (b) { b.addEventListener('click', function () { if (open) open.hidden = true; if (err) err.hidden = true; }); });
    if (!form || !wb || !window.fetch || !window.FormData) return;
    wb.addEventListener('click', function (e) {
      e.preventDefault();
      var w = null; try { w = window.open('', '_blank'); } catch (x) { w = null; }
      var fd = new FormData(form); fd.set('channel', 'whatsapp');
      wb.disabled = true; if (err) err.hidden = true;
      fetch(form.getAttribute('action'), { method: 'POST', body: new URLSearchParams(fd), credentials: 'same-origin', headers: { Accept: 'application/json' } })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          wb.disabled = false;
          if (!j || !j.ok || !j.href) { if (w) w.close(); if (err) { err.textContent = (j && j.error) || ''; err.hidden = false; } return; }
          if (open) { open.href = j.href; open.hidden = false; }
          if (w) { try { w.opener = null; w.location.href = j.href; } catch (x) { /* the button below stays */ } }
        })
        .catch(function () { wb.disabled = false; if (w) w.close(); if (err) { err.textContent = err.getAttribute('data-fallback') || ''; err.hidden = false; } });
    });
  })();

  // You can't disable your own access: grey out "Disabled" when editing yourself.
  $$('[data-open-dialog="edit-dialog"]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var dlg = document.getElementById('edit-dialog');
      if (!dlg) return;
      var self = btn.getAttribute('data-self') === '1';
      $$('[data-disable-radio]', dlg).forEach(function (r) { r.disabled = self; });
      // Name, e-mail and phone: read-only when the clinic may not change them (own account, an account shared with
      // another clinic, someone with more access); the reason is shown under them.
      var lock = btn.getAttribute('data-details-lock') || '';
      var emailLock = btn.getAttribute('data-email-lock') === '1';
      $$('[data-details-field]', dlg).forEach(function (f) { f.disabled = Boolean(lock) || (emailLock && f.name === 'email'); });
      $$('[data-details-note]', dlg).forEach(function (n) { n.hidden = n.getAttribute('data-details-note') !== (lock || (emailLock ? 'owner_email' : 'none')); });
      var role = $('[data-role-select]', dlg);
      if (role) role.dispatchEvent(new Event('change'));
    });
  });

  /* ---------- Clinic page address: live availability check ---------- */
  $$('[data-slug-input]').forEach(function (input) {
    var form = input.closest('form');
    var status = form && $('[data-slug-status]', form);
    var url = input.getAttribute('data-check-url');
    if (!status || !url || !window.fetch) return;
    var base = status.textContent;
    var timer; var seq = 0;
    function show(text, cls) { status.textContent = text; status.classList.remove('set-slug-ok', 'set-slug-bad'); if (cls) status.classList.add(cls); }
    function check() {
      var v = input.value.trim().toLowerCase().replace(/\s+/g, '-');
      if (!v) { show(base); return; }
      var mine = ++seq;
      show(status.getAttribute('data-checking') || '…');
      fetch(url + '?slug=' + encodeURIComponent(v), { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
        .then(function (r) { return r.json(); })
        .then(function (res) {
          if (mine !== seq) return;
          if (res.ok) show(res.current ? (status.getAttribute('data-current') || '') : (status.getAttribute('data-available') || '✓') + ' — ' + res.url.replace(/^https?:\/\//, ''), 'set-slug-ok');
          else show(res.error || base, 'set-slug-bad');
        })
        .catch(function () { show(base); });
    }
    input.addEventListener('input', function () {
      var cleaned = input.value.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
      if (cleaned !== input.value) input.value = cleaned;
      clearTimeout(timer); timer = setTimeout(check, 350);
    });
  });

  /* ---------- Brand colour: picker ⇄ text, live preview ---------- */
  var picker = $('[data-color-picker]');
  var text = $('[data-color-text]');
  var preview = $('[data-brand-preview]');
  function inkFor(hex) {
    var n = parseInt(hex.slice(1), 16);
    var r = (n >> 16) & 255; var g = (n >> 8) & 255; var b = n & 255;
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6 ? 'dark' : 'light';
  }
  function applyColor(hex) {
    if (!preview) return;
    if (/^#[0-9a-f]{6}$/i.test(hex)) { preview.style.setProperty('--pv', hex); preview.setAttribute('data-ink', inkFor(hex)); }
    else { preview.style.removeProperty('--pv'); preview.removeAttribute('data-ink'); }
  }
  if (picker && text) {
    picker.addEventListener('input', function () { text.value = picker.value; applyColor(picker.value); });
    text.addEventListener('input', function () {
      var v = text.value.trim();
      if (v && v[0] !== '#') v = '#' + v;
      if (/^#[0-9a-f]{6}$/i.test(v)) picker.value = v.toLowerCase();
      applyColor(v);
    });
    if (text.value) applyColor(text.value);
  }

  /* ---------- Logo: size check and preview before upload ---------- */
  var logoInput = $('[data-logo-input]');
  if (logoInput) {
    var box = $('[data-logo-preview]');
    logoInput.addEventListener('change', function () {
      var f = logoInput.files && logoInput.files[0];
      logoInput.setCustomValidity('');
      if (!f) return;
      var max = Number(logoInput.getAttribute('data-max')) || 1048576;
      if (f.size > max) { logoInput.setCustomValidity(logoInput.getAttribute('data-too-big') || 'Too large'); logoInput.reportValidity(); return; }
      if (!/^image\/(png|jpeg|webp)$/.test(f.type) || !box || !window.FileReader) return;
      var reader = new FileReader();
      reader.onload = function () { box.innerHTML = ''; var img = document.createElement('img'); img.alt = ''; img.src = reader.result; box.appendChild(img); };
      reader.readAsDataURL(f);
    });
  }

  /* ---------- Roles: select a whole permission group ---------- */
  $$('[data-perm-all]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var group = btn.closest('[data-perm-group]');
      var boxes = $$('input[type=checkbox]', group);
      var all = boxes.every(function (b) { return b.checked; });
      boxes.forEach(function (b) { b.checked = !all; });
    });
  });

  /* ---------- Setup wizard: "I am a doctor here" fills in my name ---------- */
  var me = $('[data-is-me]');
  var docName = $('[data-doctor-name]');
  if (me && docName) {
    me.addEventListener('change', function () {
      var mine = me.getAttribute('data-my-name') || '';
      if (me.checked && !docName.value.trim()) docName.value = mine;
      else if (!me.checked && docName.value === mine) docName.value = '';
    });
  }
}());

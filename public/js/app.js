/* Client behaviour. Progressive enhancement only: every link and form works without JavaScript. */
(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var isAr = document.documentElement.lang === 'ar';
  var assetV = document.documentElement.getAttribute('data-v') || '';

  function storage(key, value) {
    try {
      if (value === undefined) return window.localStorage.getItem(key);
      window.localStorage.setItem(key, value);
    } catch (e) { /* storage unavailable */ }
    return null;
  }
  var iconSvg = function (name, cls) { return '<svg class="icon ' + (cls || 'icon-sm') + '" aria-hidden="true"><use href="/icons.svg?v=' + assetV + '#i-' + name + '"></use></svg>'; };
  var esc = function (s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; };

  /* ---------- Theme: system / light / dark, persisted in a cookie ---------- */
  function effectiveTheme() {
    var attr = document.documentElement.getAttribute('data-theme');
    if (attr) return attr;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function syncThemeIcons() {
    var dark = effectiveTheme() === 'dark';
    $$('.theme-moon').forEach(function (el) { el.classList.toggle('hidden', dark); });
    $$('.theme-sun').forEach(function (el) { el.classList.toggle('hidden', !dark); });
  }
  syncThemeIcons();
  if (window.matchMedia) window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncThemeIcons);
  $$('[data-theme-toggle]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var next = effectiveTheme() === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      document.cookie = 'db_theme=' + next + ';path=/;max-age=31536000;samesite=lax';
      syncThemeIcons();
    });
  });

  /* ---------- Navigation ---------- */
  /* Desktop: fold the sidebar to icons (remembered for a year; the server reads the cookie, so no flash on load). */
  $$('[data-sb-toggle]').forEach(function (b) {
    b.addEventListener('click', function () {
      var shell = document.querySelector('[data-shell]'); if (!shell) return;
      var mini = shell.classList.toggle('sb-mini');
      b.setAttribute('aria-pressed', mini ? 'true' : 'false');
      document.cookie = 'db_sb=' + (mini ? 'mini' : 'full') + '; path=/; max-age=31536000; samesite=lax';
    });
    var sh = document.querySelector('[data-shell]'); b.setAttribute('aria-pressed', sh && sh.classList.contains('sb-mini') ? 'true' : 'false');
  });
  $$('[data-nav-toggle]').forEach(function (b) { b.addEventListener('click', function (e) { e.preventDefault(); document.body.classList.toggle('nav-open'); }); });
  $$('[data-nav-close]').forEach(function (b) { b.addEventListener('click', function () { document.body.classList.remove('nav-open'); }); });
  $$('[data-back]').forEach(function (b) { b.addEventListener('click', function (e) { if (history.length > 1) { e.preventDefault(); history.back(); } }); });
  // Thin progress bar while the next page loads.
  window.addEventListener('beforeunload', function () { document.body.classList.add('is-navigating'); });
  window.addEventListener('pageshow', function () { document.body.classList.remove('is-navigating'); });
  // Whole-row links in tables.
  $$('tr[data-href]').forEach(function (tr) {
    tr.classList.add('row-link');
    tr.addEventListener('click', function (e) { if (e.target.closest('a, button, form, input, summary, details')) return; window.location.href = tr.getAttribute('data-href'); });
  });

  /* ---------- Dropdowns: close on outside click ---------- */
  document.addEventListener('click', function (e) {
    $$('details.dropdown[open]').forEach(function (d) { if (!d.contains(e.target)) d.removeAttribute('open'); });
  });

  /* ---------- Toasts: dismiss + auto-hide ---------- */
  $$('[data-dismiss]').forEach(function (b) { b.addEventListener('click', function () { var a = b.closest('[data-toast], [data-dismissible]'); if (a) a.remove(); }); });
  $$('[data-toast]').forEach(function (t) { if (!t.classList.contains('error')) setTimeout(function () { t.style.transition = 'opacity .3s'; t.style.opacity = '0'; setTimeout(function () { t.remove(); }, 320); }, 5000); });

  /* ---------- Dialogs & drawers ---------- */
  function fillForm(form, data) {
    Object.keys(data).forEach(function (key) {
      $$('[name="' + key + '"]', form).forEach(function (field) {
        var val = data[key];
        if (field.type === 'checkbox') field.checked = Array.isArray(val) ? val.indexOf(field.value) >= 0 : Boolean(val);
        else if (field.type === 'radio') field.checked = String(field.value) === String(val);
        else field.value = val === null || val === undefined ? '' : val;
        field.dispatchEvent(new Event('input', { bubbles: true }));
      });
    });
  }
  function resetForm(form) {
    form.reset();
    $$('[name="id"]', form).forEach(function (i) { i.value = ''; });
    $$('.field-error', form).forEach(function (el) { el.remove(); });
    $$('.is-invalid', form).forEach(function (el) { el.classList.remove('is-invalid'); });
    $$('[data-default]', form).forEach(function (el) { el.value = el.getAttribute('data-default'); });
  }
  function openDialog(dlg, btn) {
    if (!dlg || typeof dlg.showModal !== 'function') return false;
    var form = dlg.querySelector('form');
    if (btn && form && (btn.hasAttribute('data-fill') || btn.hasAttribute('data-reset-form'))) resetForm(form);
    if (btn && form && btn.hasAttribute('data-fill')) { try { fillForm(form, JSON.parse(btn.getAttribute('data-fill'))); } catch (err) { /* ignore */ } }
    if (btn) {
      var title = btn.getAttribute('data-dialog-title');
      var t = dlg.querySelector('[data-dialog-title-target]'); if (t && title) t.textContent = title;
      var action = btn.getAttribute('data-action'); if (form && action) form.setAttribute('action', action);
    }
    var menu = btn && btn.closest('details'); if (menu) menu.removeAttribute('open');
    dlg.showModal();
    var first = dlg.querySelector('input:not([type=hidden]):not([readonly]), select, textarea'); if (first) first.focus();
    return true;
  }
  $$('[data-open-dialog]').forEach(function (btn) {
    btn.addEventListener('click', function (e) { if (openDialog(document.getElementById(btn.getAttribute('data-open-dialog')), btn)) e.preventDefault(); });
  });
  $$('[data-close-dialog]').forEach(function (b) { b.addEventListener('click', function () { b.closest('dialog').close(); }); });
  $$('dialog.dialog').forEach(function (d) {
    d.addEventListener('click', function (e) { if (e.target === d) d.close(); });
    if (d.hasAttribute('data-open-on-load') && typeof d.showModal === 'function') d.showModal();
  });
  // ?new=1 opens the page's "create" dialog (used by ⌘K quick actions).
  if (/[?&]new=1/.test(location.search)) { var nd = $('dialog[data-new-dialog]'); if (nd) openDialog(nd, $('[data-open-dialog="' + nd.id + '"][data-reset-form]')); }

  /* ---------- Confirmations for destructive or important forms ---------- */
  var confirmDlg;
  function confirmBox(message, onYes, opts) {
    opts = opts || {};
    if (!confirmDlg) {
      confirmDlg = document.createElement('dialog');
      confirmDlg.className = 'dialog';
      confirmDlg.innerHTML = '<div class="dialog-head"><h2 data-title></h2></div><div class="dialog-body"><p data-msg></p>'
        + '<div class="field mt-3 hidden" data-type-wrap><label class="label" data-type-label></label><input class="input" data-type-input autocomplete="off"></div></div>'
        + '<div class="dialog-foot"><button class="btn btn-ghost" type="button" data-no>' + (isAr ? 'إلغاء' : 'Cancel') + '</button>'
        + '<button class="btn btn-danger" type="button" data-yes></button></div>';
      document.body.appendChild(confirmDlg);
      confirmDlg.querySelector('[data-no]').addEventListener('click', function () { confirmDlg.close(); });
      confirmDlg.addEventListener('click', function (e) { if (e.target === confirmDlg) confirmDlg.close(); });
    }
    confirmDlg.querySelector('[data-title]').textContent = opts.title || (isAr ? 'تأكيد الإجراء' : 'Confirm action');
    confirmDlg.querySelector('[data-msg]').textContent = message;
    var wrap = confirmDlg.querySelector('[data-type-wrap]');
    var input = confirmDlg.querySelector('[data-type-input]');
    wrap.classList.toggle('hidden', !opts.typeToConfirm);
    input.value = '';
    if (opts.typeToConfirm) confirmDlg.querySelector('[data-type-label]').textContent = (isAr ? 'اكتب للتأكيد: ' : 'Type to confirm: ') + opts.typeToConfirm;
    var yes = confirmDlg.querySelector('[data-yes]');
    var clone = yes.cloneNode(true); yes.parentNode.replaceChild(clone, yes);
    clone.textContent = opts.yesLabel || (isAr ? 'تأكيد' : 'Confirm');
    clone.className = 'btn ' + (opts.tone === 'primary' ? 'btn-primary' : 'btn-danger');
    clone.disabled = Boolean(opts.typeToConfirm);
    input.oninput = function () { clone.disabled = opts.typeToConfirm && input.value.trim() !== opts.typeToConfirm; };
    clone.addEventListener('click', function () { confirmDlg.close(); onYes(input.value); });
    if (typeof confirmDlg.showModal === 'function') { confirmDlg.showModal(); (opts.typeToConfirm ? input : clone).focus(); } else if (window.confirm(message)) onYes();
  }
  // Delegated (capture phase, so it runs before the busy-button feedback below) — also covers forms added later,
  // e.g. the appointment drawer.
  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (!form || !form.matches || !form.matches('form[data-confirm]') || form.dataset.confirmed) return;
    e.preventDefault();
    confirmBox(form.getAttribute('data-confirm'), function (typed) {
      var target = form.querySelector('[name="confirm_name"]'); if (target && typed) target.value = typed;
      form.dataset.confirmed = '1';
      if (form.requestSubmit) form.requestSubmit(); else form.submit();
    }, { title: form.getAttribute('data-confirm-title'), yesLabel: form.getAttribute('data-confirm-yes'), tone: form.getAttribute('data-confirm-tone'), typeToConfirm: form.getAttribute('data-confirm-type') });
  }, true);

  /* ---------- Submit feedback (prevents double submits) ---------- */
  $$('form').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      if (e.defaultPrevented || form.hasAttribute('data-no-busy') || form.method.toLowerCase() === 'get') return;
      var btn = form.querySelector('button[type=submit]:not([name])');
      if (btn) setTimeout(function () { btn.classList.add('is-loading'); btn.insertAdjacentHTML('afterbegin', '<span class="spinner" aria-hidden="true"></span>'); }, 0);
    });
  });

  /* ---------- Auto-submit filter forms ---------- */
  $$('form[data-autosubmit]').forEach(function (form) {
    var timer;
    $$('select, input[type=checkbox], input[type=date], input[type=month]', form).forEach(function (s) { s.addEventListener('change', function () { form.submit(); }); });
    $$('input[type=search]', form).forEach(function (i) { i.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(function () { form.submit(); }, 450); }); });
  });

  /* ---------- Dropdown menus stay on the screen (phones, buttons near an edge, Arabic and English) ---------- */
  document.addEventListener('toggle', function (e) {
    var d = e.target;
    if (!d || d.tagName !== 'DETAILS' || !d.open) return;
    var m = d.querySelector(':scope > .menu'); if (!m) return;
    m.style.transform = '';
    var r = m.getBoundingClientRect(); var vw = document.documentElement.clientWidth; var pad = 8; var dx = 0;
    if (r.right > vw - pad) dx = (vw - pad) - r.right;
    if (r.left + dx < pad) dx = pad - r.left;
    if (dx) m.style.transform = 'translateX(' + Math.round(dx) + 'px)';
  }, true);

  /* ---------- A file picker that sends its form as soon as a file is chosen (My account → photo) ---------- */
  $$('input[type=file][data-send-on-pick]').forEach(function (inp) {
    inp.addEventListener('change', function () { if (inp.files && inp.files.length && inp.form) { inp.form.classList.add('is-busy'); inp.form.submit(); } });
  });

  /* ---------- Filter a list of checkboxes (lab / imaging tests on the visit page) ---------- */
  $$('[data-ord-filter]').forEach(function (inp) {
    var list = inp.parentNode.querySelector('[data-ord-list]');
    if (!list) return;
    inp.addEventListener('input', function () {
      var q = inp.value.trim().toLowerCase();
      $$('label', list).forEach(function (l) { l.hidden = Boolean(q) && l.textContent.toLowerCase().indexOf(q) === -1 && !l.querySelector('input:checked'); });
    });
  });

  /* ---------- Copy / print ---------- */
  $$('[data-copy]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var src = document.getElementById(btn.getAttribute('data-copy')) || btn.parentNode.querySelector('[data-copy-source]');
      if (!src || !navigator.clipboard) return;
      navigator.clipboard.writeText((src.value || src.textContent).trim()).then(function () {
        var old = btn.innerHTML; btn.innerHTML = iconSvg('check') + (isAr ? ' تم النسخ' : ' Copied'); setTimeout(function () { btn.innerHTML = old; }, 1600);
      });
    });
  });
  $$('[data-print]').forEach(function (b) { b.addEventListener('click', function () { window.print(); }); });
  /* "Send these papers" menus: WhatsApp opens straight away (a GET to /app/share/wa, which redirects to wa.me) —
     a posted form may not be redirected to another site. The e-mail button posts as usual. */
  $$('form.send-menu, form[data-share-pick]').forEach(function (f) {
    f.addEventListener('submit', function (e) {
      var by = e.submitter;
      if (by && by.getAttribute('formaction')) return; // e-mail
      e.preventDefault();
      var q = new URLSearchParams();
      ['kind', 'id', 'lang_msg'].forEach(function (k) { var i = f.querySelector('[name="' + k + '"]'); if (i && i.value) q.append(k, i.value); });
      $$('input[name="pick"]:checked', f).forEach(function (c) { q.append('pick', c.value); });
      if (!q.getAll('pick').length) return;
      window.open('/app/share/wa?' + q.toString(), '_blank', 'noopener');
      var dd = f.closest('details'); if (dd) dd.open = false;
    });
  });
  /* A page that only hands over to another site (WhatsApp after choosing the papers to send). */
  var go = $('[data-go-url]');
  if (go && /^https:\/\/(wa\.me|api\.whatsapp\.com)\//.test(go.getAttribute('data-go-url'))) location.replace(go.getAttribute('data-go-url'));
  /* The ready diagnosis table: filter its rows by code or name as you type. */
  $$('[data-dx-filter]').forEach(function (inp) {
    var rows = $$('[data-dx-row]', inp.closest('section'));
    inp.addEventListener('input', function () { var q = inp.value.trim().toLowerCase(); rows.forEach(function (r) { r.hidden = q && r.textContent.toLowerCase().indexOf(q) === -1; }); });
  });
  /* A shared document's "Share" button: the PDF itself through the phone's share sheet (WhatsApp, e-mail…); shown only
     where the browser can share files. */
  $$('[data-share-pdf]').forEach(function (b) {
    if (!navigator.share || !navigator.canShare || typeof File === 'undefined') return;
    try { if (!navigator.canShare({ files: [new File(['x'], 'x.pdf', { type: 'application/pdf' })] })) return; } catch (e) { return; }
    b.hidden = false;
    b.addEventListener('click', function () {
      b.disabled = true;
      fetch(b.getAttribute('data-share-pdf'), { credentials: 'same-origin' }).then(function (r) {
        if (!r.ok) throw new Error('pdf');
        var name = ((r.headers.get('content-disposition') || '').match(/filename="([^"]+)"/) || [])[1] || 'document.pdf';
        return r.blob().then(function (blob) { return navigator.share({ files: [new File([blob], name, { type: 'application/pdf' })], title: b.getAttribute('data-share-title') || name }); });
      }).catch(function () { /* cancelled or not possible: the save button stays */ }).then(function () { b.disabled = false; });
    });
  });
  if (/[?&]autoprint=1/.test(location.search)) setTimeout(function () { window.print(); }, 400);

  /* ---------- Password strength ---------- */
  $$('[data-pw-meter]').forEach(function (meter) {
    var input = document.getElementById(meter.getAttribute('data-pw-meter'));
    var bar = meter.querySelector('span');
    if (!input || !bar) return;
    input.addEventListener('input', function () {
      var v = input.value; var s = 0;
      if (v.length >= 8) s++; if (v.length >= 12) s++; if (/[A-Z]/.test(v) && /[a-z]/.test(v)) s++; if (/\d/.test(v)) s++; if (/[^A-Za-z0-9]/.test(v)) s++;
      bar.style.width = Math.min(100, s * 20) + '%';
      bar.style.background = s <= 2 ? 'var(--danger)' : s === 3 ? 'var(--warning)' : 'var(--success)';
    });
  });

  /* ---------- Chart tooltips ---------- */
  $$('[data-chart]').forEach(function (chart) {
    var tip = chart.querySelector('.chart-tip'); var svg = chart.querySelector('svg');
    if (!tip || !svg) return;
    var cross = svg.querySelector('.ch-cross');
    function show(el) {
      var vb = svg.viewBox.baseVal; var rect = svg.getBoundingClientRect(); var scale = rect.width / vb.width;
      var x = Number(el.getAttribute('data-x')) * scale; var y = Number(el.getAttribute('data-y') || 20) * scale;
      tip.querySelector('[data-tip-value]').textContent = el.getAttribute('data-tip-value');
      tip.querySelector('[data-tip-label]').textContent = el.getAttribute('data-tip-label');
      tip.hidden = false; tip.style.left = x + 'px'; tip.style.top = y + 'px';
      if (cross) { cross.setAttribute('x1', el.getAttribute('data-x')); cross.setAttribute('x2', el.getAttribute('data-x')); cross.setAttribute('visibility', 'visible'); }
    }
    function hide() { tip.hidden = true; if (cross) cross.setAttribute('visibility', 'hidden'); }
    $$('.ch-hit', svg).forEach(function (h) { h.addEventListener('mouseenter', function () { show(h); }); h.addEventListener('focus', function () { show(h); }); h.addEventListener('mouseleave', hide); h.addEventListener('blur', hide); });
  });

  /* ---------- Command palette (Ctrl/⌘ + K) ---------- */
  var cmdk = $('[data-cmdk]');
  if (cmdk) {
    var input = $('[data-cmdk-input]', cmdk);
    var results = $('[data-cmdk-results]', cmdk);
    var pages = JSON.parse($('[data-cmdk-pages]', cmdk).textContent);
    var i18n = JSON.parse($('[data-cmdk-i18n]', cmdk).textContent);
    var items = []; var active = 0; var seq = 0; var debounce;
    // Recently opened records (this browser only; a convenience, never required).
    var RECENT_KEY = 'docbook.recent.' + (cmdk.getAttribute('data-cmdk-scope') || 'x');
    function recent() { try { return JSON.parse(window.localStorage.getItem(RECENT_KEY) || '[]') || []; } catch (e) { return []; } }
    function remember(it) {
      if (!it || !it.group || it.group === 'pages' || it.group === 'actions') return;
      try {
        var list = recent().filter(function (x) { return x.href !== it.href; });
        list.unshift({ title: it.title, subtitle: it.subtitle || '', href: it.href, icon: it.icon, group: 'recent' });
        window.localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 5)));
      } catch (e) { /* storage blocked */ }
    }
    function render(groups) {
      items = []; var html = '';
      groups.forEach(function (g) {
        if (!g.items.length) return;
        html += '<div class="cmdk-group">' + esc(g.title) + '</div>';
        g.items.forEach(function (it) {
          var i = items.length; items.push(it);
          html += '<div class="cmdk-row"><a class="cmdk-item" data-i="' + i + '" href="' + esc(it.href) + '">' + iconSvg(it.icon || 'arrow-right') + '<span>' + esc(it.title) + '</span>' + (it.subtitle ? '<span class="sub">' + esc(it.subtitle) + '</span>' : '') + '</a>'
            + (it.action ? '<a class="btn btn-secondary btn-sm cmdk-act" href="' + esc(it.action.href) + '">' + esc(it.action.label) + '</a>' : '') + '</div>';
        });
      });
      results.innerHTML = html || '<div class="cmdk-empty">' + esc(i18n.empty) + '</div>';
      active = 0; highlight();
    }
    function highlight() { $$('.cmdk-item', results).forEach(function (el, i) { el.classList.toggle('active', i === active); if (i === active) el.scrollIntoView({ block: 'nearest' }); }); }
    function search() {
      var q = input.value.trim().toLowerCase();
      var match = function (p) { return !q || p.title.toLowerCase().indexOf(q) >= 0; };
      var local = [{ title: i18n.actions, items: pages.filter(function (p) { return p.group === 'actions' && match(p); }) }, { title: i18n.pages, items: pages.filter(function (p) { return p.group === 'pages' && match(p); }) }];
      if (q.length < 2) { render((q ? [] : [{ title: i18n.recent, items: recent() }]).concat(local)); return; }
      var mine = ++seq;
      fetch('/app/search?q=' + encodeURIComponent(input.value.trim()), { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
        .then(function (r) { return r.ok ? r.json() : { data: [] }; })
        .then(function (res) {
          if (mine !== seq) return;
          var names = res.groups || {}; var byGroup = {}; var order = [];
          (res.data || []).forEach(function (it) { var g = it.group || 'records'; if (!byGroup[g]) { byGroup[g] = []; order.push(g); } byGroup[g].push(it); });
          render(order.map(function (g) { return { title: names[g] || i18n.records, items: byGroup[g] }; }).concat(local));
        })
        .catch(function () { render(local); });
    }
    function open() { cmdk.classList.add('open'); input.value = ''; search(); setTimeout(function () { input.focus(); }, 10); }
    function close() { cmdk.classList.remove('open'); }
    $$('[data-cmdk-open]').forEach(function (b) { b.addEventListener('click', open); });
    cmdk.addEventListener('click', function (e) { if (e.target === cmdk) close(); });
    results.addEventListener('click', function (e) { var a = e.target.closest ? e.target.closest('.cmdk-item') : null; if (a) remember(items[Number(a.getAttribute('data-i'))]); });
    input.addEventListener('input', function () { clearTimeout(debounce); debounce = setTimeout(search, 180); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(items.length - 1, active + 1); highlight(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); highlight(); }
      else if (e.key === 'Enter' && items[active]) { e.preventDefault(); remember(items[active]); window.location.href = items[active].href; }
    });
    document.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); if (cmdk.classList.contains('open')) close(); else open(); }
      // "/" opens search when not typing somewhere.
      var tag = (e.target && e.target.tagName) || '';
      if (e.key === '/' && !e.ctrlKey && !e.metaKey && !/^(INPUT|TEXTAREA|SELECT)$/.test(tag) && !(e.target && e.target.isContentEditable) && !cmdk.classList.contains('open')) { e.preventDefault(); open(); }
      if (e.key === 'Escape') { close(); document.body.classList.remove('nav-open'); }
    });
    var kbd = $('.search-trigger .kbd');
    if (kbd && /Mac|iPhone|iPad/.test(navigator.platform || '')) kbd.textContent = '⌘K';
  }
}());

// Consultation timers beside patients (partials/visit-timer.ejs): a running one counts on from the page's time.
(function () {
  var chips = document.querySelectorAll('[data-vt][data-vt-state="running"]');
  if (!chips.length) return;
  var t0 = Date.now();
  var fmt = function (s) { var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; var p = function (n) { return (n < 10 ? '0' : '') + n; }; return (h ? h + ':' + p(m) : p(m)) + ':' + p(x); };
  var tick = function () {
    var add = Math.floor((Date.now() - t0) / 1000);
    chips.forEach(function (c) { var el = c.querySelector('[data-vt-text]'); if (el) el.textContent = fmt((Number(c.getAttribute('data-vt')) || 0) + add); });
  };
  setInterval(tick, 1000);
}());

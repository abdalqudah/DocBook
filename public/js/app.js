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
  $$('form[data-confirm]').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      if (form.dataset.confirmed) return;
      e.preventDefault();
      confirmBox(form.getAttribute('data-confirm'), function (typed) {
        var target = form.querySelector('[name="confirm_name"]'); if (target && typed) target.value = typed;
        form.dataset.confirmed = '1';
        if (form.requestSubmit) form.requestSubmit(); else form.submit();
      }, { title: form.getAttribute('data-confirm-title'), yesLabel: form.getAttribute('data-confirm-yes'), tone: form.getAttribute('data-confirm-tone'), typeToConfirm: form.getAttribute('data-confirm-type') });
    });
  });

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

  /* ---------- Live calculators (data-calc) ---------- */
  var num = function (v) { var n = parseFloat(String(v || '').replace(/,/g, '')); return isFinite(n) ? n : 0; };
  var money = function (n, d) { return n.toLocaleString(isAr ? 'ar-EG-u-nu-latn' : 'en-US', { minimumFractionDigits: d, maximumFractionDigits: d }); };
  // Purchase: total = unit × qty; payable = total + shipping; remaining = payable − paid.
  $$('form[data-calc="purchase"]').forEach(function (form) {
    var d = Number(form.getAttribute('data-decimals') || 2);
    var f = function (n) { return form.querySelector('[name="' + n + '"]'); };
    function run() {
      var total = num(f('unit_cost').value) * num(f('quantity').value);
      var payable = total + num(f('shipping_cost').value);
      var remaining = Math.max(0, payable - num(f('paid_amount').value));
      var set = function (k, v) { var el = form.querySelector('[data-out="' + k + '"]'); if (el) el.textContent = money(v, d); };
      set('total', total); set('payable', payable); set('remaining', remaining);
    }
    form.addEventListener('input', run); run();
  });
  // Employee: monthly net = base + bonus − deductions.
  $$('form[data-calc="salary"]').forEach(function (form) {
    var d = Number(form.getAttribute('data-decimals') || 2);
    function run() {
      var g = function (n) { var el = form.querySelector('[name="' + n + '"]'); return el ? num(el.value) : 0; };
      var el = form.querySelector('[data-out="net"]'); if (el) el.textContent = money(g('base_salary') + g('bonus') - g('deductions'), d);
      var type = form.querySelector('[name="commission_type"]'); var sfx = form.querySelector('[data-rate-suffix]');
      if (type && sfx) sfx.textContent = type.value === 'percentage' ? '%' : sfx.getAttribute('data-currency');
    }
    form.addEventListener('input', run); form.addEventListener('change', run); run();
  });
  // Campaign preview: ROAS / CTR / CPC / CPA.
  $$('form[data-calc="campaign"]').forEach(function (form) {
    function run() {
      var g = function (n) { var el = form.querySelector('[name="' + n + '"]'); return el ? num(el.value) : 0; };
      var cost = g('cost'); var rev = g('revenue_generated'); var cl = g('clicks'); var im = g('impressions'); var cv = g('conversions');
      var put = function (k, v) { var el = form.querySelector('[data-out="' + k + '"]'); if (el) el.textContent = v; };
      put('roas', cost > 0 ? (rev / cost).toFixed(2) + '×' : '—');
      put('ctr', im > 0 ? (cl / im * 100).toFixed(2) + '%' : '—');
      put('cpc', cl > 0 ? money(cost / cl, 2) : '—');
      put('cpa', cv > 0 ? money(cost / cv, 2) : '—');
    }
    form.addEventListener('input', run); run();
  });

  /* ---------- Order line editor ---------- */
  $$('[data-order-form]').forEach(function (form) {
    var lines = form.querySelector('[data-lines]');
    var tpl = form.querySelector('template[data-line-template]');
    var d = Number(form.getAttribute('data-decimals') || 2);
    var reps = {}; try { reps = JSON.parse(form.getAttribute('data-reps') || '{}'); } catch (e) { reps = {}; }
    var customers = {}; try { customers = JSON.parse(form.getAttribute('data-customers') || '{}'); } catch (e) { customers = {}; }
    function renumber() {
      $$('[data-line]', lines).forEach(function (row, i) {
        $$('[data-name]', row).forEach(function (inp) { inp.name = 'items[' + i + '][' + inp.getAttribute('data-name') + ']'; });
      });
    }
    function totals() {
      var sub = 0; var cogs = 0;
      $$('[data-line]', lines).forEach(function (row) {
        var q = num(row.querySelector('[data-name=quantity]').value); var p = num(row.querySelector('[data-name=unitPrice]').value); var c = num(row.querySelector('[data-name=unitCost]').value);
        var lt = row.querySelector('[data-line-total]'); if (lt) lt.textContent = money(q * p, d);
        sub += q * p; cogs += q * c;
      });
      var disc = num((form.querySelector('[name=discount]') || {}).value); var fee = num((form.querySelector('[name=delivery_fee]') || {}).value);
      var total = Math.max(0, sub - disc + fee);
      var put = function (k, v) { var el = form.querySelector('[data-out="' + k + '"]'); if (el) el.textContent = money(v, d); };
      put('subtotal', sub); put('discount', disc); put('fee', fee); put('total', total); put('cogs', cogs); put('gross', total - cogs);
      // Commission preview (region rate overrides the rep's default rate).
      var repSel = form.querySelector('[name=employee_id]'); var custSel = form.querySelector('[name=customer_id]');
      var rep = repSel && reps[repSel.value]; var region = custSel && customers[custSel.value] ? customers[custSel.value].region : '';
      var com = 0;
      if (rep) { var rr = rep.regions && region && rep.regions[region] !== undefined && rep.regions[region] !== '' ? num(rep.regions[region]) : num(rep.rate); com = rep.type === 'percentage' ? total * rr / 100 : rr; }
      put('commission', com);
    }
    function bind(row) {
      var rm = row.querySelector('[data-remove-line]');
      if (rm) rm.addEventListener('click', function () { if ($$('[data-line]', lines).length > 1) { row.remove(); renumber(); totals(); } });
    }
    $$('[data-line]', lines).forEach(bind);
    var add = form.querySelector('[data-add-line]');
    if (add && tpl) add.addEventListener('click', function () { var node = tpl.content.firstElementChild.cloneNode(true); lines.appendChild(node); bind(node); renumber(); totals(); var f = node.querySelector('input'); if (f) f.focus(); });
    // Picking a known customer fills the name/phone/email fields.
    var custSel2 = form.querySelector('[name=customer_id]');
    if (custSel2) custSel2.addEventListener('change', function () {
      var c = customers[custSel2.value]; if (!c) return;
      ['customer_name', 'customer_phone', 'customer_email'].forEach(function (k) { var el = form.querySelector('[name=' + k + ']'); if (el) el.value = c[k.replace('customer_', '')] || ''; });
    });
    form.addEventListener('input', totals); form.addEventListener('change', totals);
    renumber(); totals();
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

  /* ---------- AI chat: suggestions fill the box, Enter sends ---------- */
  $$('[data-chat-form]').forEach(function (form) {
    var ta = form.querySelector('textarea');
    $$('[data-suggest]').forEach(function (b) { b.addEventListener('click', function () { ta.value = b.getAttribute('data-suggest'); ta.focus(); }); });
    if (ta) ta.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (ta.value.trim()) { if (form.requestSubmit) form.requestSubmit(); else form.submit(); } } });
    var thread = document.querySelector('[data-thread]'); if (thread) thread.scrollTop = thread.scrollHeight;
  });

  /* ---------- Command palette (Ctrl/⌘ + K) ---------- */
  var cmdk = $('[data-cmdk]');
  if (cmdk) {
    var input = $('[data-cmdk-input]', cmdk);
    var results = $('[data-cmdk-results]', cmdk);
    var pages = JSON.parse($('[data-cmdk-pages]', cmdk).textContent);
    var i18n = JSON.parse($('[data-cmdk-i18n]', cmdk).textContent);
    var items = []; var active = 0; var seq = 0; var debounce;
    function render(groups) {
      items = []; var html = '';
      groups.forEach(function (g) {
        if (!g.items.length) return;
        html += '<div class="cmdk-group">' + esc(g.title) + '</div>';
        g.items.forEach(function (it) {
          items.push(it);
          html += '<a class="cmdk-item" href="' + esc(it.href) + '">' + iconSvg(it.icon || 'arrow-right') + '<span>' + esc(it.title) + '</span>' + (it.subtitle ? '<span class="sub">' + esc(it.subtitle) + '</span>' : '') + '</a>';
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
      if (q.length < 2) { render(local); return; }
      var mine = ++seq;
      fetch('/app/search?q=' + encodeURIComponent(input.value.trim()), { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
        .then(function (r) { return r.ok ? r.json() : { data: [] }; })
        .then(function (res) { if (mine !== seq) return; render([{ title: i18n.records, items: res.data || [] }].concat(local)); })
        .catch(function () { render(local); });
    }
    function open() { cmdk.classList.add('open'); input.value = ''; search(); setTimeout(function () { input.focus(); }, 10); }
    function close() { cmdk.classList.remove('open'); }
    $$('[data-cmdk-open]').forEach(function (b) { b.addEventListener('click', open); });
    cmdk.addEventListener('click', function (e) { if (e.target === cmdk) close(); });
    input.addEventListener('input', function () { clearTimeout(debounce); debounce = setTimeout(search, 180); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(items.length - 1, active + 1); highlight(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); highlight(); }
      else if (e.key === 'Enter' && items[active]) { e.preventDefault(); window.location.href = items[active].href; }
    });
    document.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); if (cmdk.classList.contains('open')) close(); else open(); }
      if (e.key === 'Escape') { close(); document.body.classList.remove('nav-open'); }
    });
    var kbd = $('.search-trigger .kbd');
    if (kbd && /Mac|iPhone|iPad/.test(navigator.platform || '')) kbd.textContent = '⌘K';
  }
}());

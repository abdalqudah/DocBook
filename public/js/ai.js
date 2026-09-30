// AI clinical assistant panel on the visit page: tabs, POST to /app/visits/:id/ai/:kind (CSRF header),
// spinner, structured result rendering, copy and "add to note" (fills the SOAP textarea client-side; the doctor saves).
(function () {
  'use strict';
  var panel = document.querySelector('[data-ai-panel]');
  var dataEl = document.getElementById('ai-data');
  if (!panel || !dataEl) return;
  var D;
  try { D = JSON.parse(dataEl.textContent || '{}'); } catch (e) { return; }
  var I = D.i18n || {};
  var csrfMeta = document.querySelector('meta[name="csrf-token"]');
  var csrf = csrfMeta ? csrfMeta.content : '';
  var busy = false;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function arr(v) { return Array.isArray(v) ? v.filter(function (x) { return x !== null && x !== undefined && String(typeof x === 'object' ? JSON.stringify(x) : x).trim() !== ''; }) : []; }
  function txt(v) { return typeof v === 'string' ? v.trim() : ''; }
  function tag() { return '<span class="ai-tag">' + esc(I.suggestion) + '</span>'; }
  function section(title, body) { return body ? '<div class="ai-sec"><div class="ai-sec-title">' + esc(title) + '</div>' + body + '</div>' : ''; }
  function para(v) { var s = txt(v); return s ? '<p class="ai-text">' + esc(s) + '</p>' : ''; }
  function list(items) {
    var a = arr(items); if (!a.length) return '';
    return '<ul class="ai-list">' + a.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>';
  }
  var sevCls = { major: 'badge-danger', moderate: 'badge-warning', minor: 'badge-neutral', high: 'badge-neutral', low: 'badge-neutral' };
  function badge(cls, label) { return '<span class="badge badge-dot ' + (cls || 'badge-neutral') + '">' + esc(label) + '</span>'; }

  // ------------------------------------------------------------ note text (for "add to note" and copy)
  function bullets(a) { return arr(a).map(function (x) { return '- ' + x; }).join('\n'); }
  function noteParts(kind, r) {
    if (kind === 'summary') {
      var plan = bullets(r.plan); if (txt(r.follow_up)) plan += (plan ? '\n' : '') + '- ' + txt(r.follow_up);
      return { assessment: txt(r.summary_text), plan: plan };
    }
    if (kind === 'second_opinion') {
      return {
        assessment: arr(r.differentials).map(function (d) { return '- ' + txt(d.diagnosis) + (d.likelihood ? ' (' + (I['likelihood_' + d.likelihood] || d.likelihood) + ')' : ''); }).join('\n'),
        plan: arr(r.investigations).map(function (x) { return '- ' + txt(x.test) + (txt(x.reason) ? ': ' + txt(x.reason) : ''); }).join('\n'),
      };
    }
    var lines = [];
    arr(r.interactions).forEach(function (x) { lines.push('- ' + txt(x.drugs) + ': ' + txt(x.suggestion || x.explanation)); });
    arr(r.dose_concerns).forEach(function (x) { lines.push('- ' + txt(x.drug) + ': ' + txt(x.suggestion || x.concern)); });
    arr(r.allergy_concerns).forEach(function (x) { lines.push('- ' + txt(x.drug) + ' / ' + txt(x.allergy) + ': ' + txt(x.concern)); });
    arr(r.condition_concerns).forEach(function (x) { lines.push('- ' + txt(x.drug) + ' / ' + txt(x.condition) + ': ' + txt(x.concern)); });
    if (txt(r.notes)) lines.push(txt(r.notes));
    return { assessment: '', plan: lines.join('\n') };
  }
  function plainText(root) { return (root.innerText || root.textContent || '').replace(/\n{3,}/g, '\n\n').trim(); }

  // ------------------------------------------------------------ renderers
  var R = {
    summary: function (r) {
      return section(I.r_summary_text, para(r.summary_text))
        + section(I.r_chief_complaint, para(r.chief_complaint))
        + section(I.r_key_findings, list(r.key_findings))
        + section(I.r_assessment, para(r.assessment))
        + section(I.r_plan, list(r.plan))
        + section(I.r_medications, list(r.medications))
        + section(I.r_follow_up, para(r.follow_up));
    },
    second_opinion: function (r) {
      var diff = arr(r.differentials).map(function (d) {
        return '<li class="ai-item"><div class="ai-item-head"><span class="strong">' + esc(d.diagnosis) + '</span>'
          + (d.likelihood ? badge('badge-neutral', I['likelihood_' + d.likelihood] || d.likelihood) : '') + tag() + '</div>'
          + (txt(d.reasoning) ? '<p class="ai-text">' + esc(d.reasoning) + '</p>' : '') + '</li>';
      }).join('');
      var flags = arr(r.red_flags).map(function (x) { return '<li class="ai-flag">' + esc(x) + '</li>'; }).join('');
      var inv = arr(r.investigations).map(function (x) {
        return '<li class="ai-item"><div class="ai-item-head"><span class="strong">' + esc(x.test) + '</span>' + tag() + '</div>'
          + (txt(x.reason) ? '<p class="ai-text">' + esc(x.reason) + '</p>' : '') + '</li>';
      }).join('');
      return section(I.r_differentials, diff ? '<ol class="ai-items">' + diff + '</ol>' : '')
        + section(I.r_red_flags, flags ? '<ul class="ai-list ai-flags">' + flags + '</ul>' : '')
        + section(I.r_investigations, inv ? '<ul class="ai-items">' + inv + '</ul>' : '')
        + section(I.r_questions, list(r.questions))
        + section(I.r_missing_information, list(r.missing_information));
    },
    rx_check: function (r) {
      var ov = r.overall || 'review';
      var ovCls = ov === 'serious' ? 'badge-danger' : ov === 'review' ? 'badge-warning' : 'badge-neutral';
      var item = function (title, sev, body, sugg) {
        return '<li class="ai-item"><div class="ai-item-head"><span class="strong">' + esc(title) + '</span>' + (sev ? badge(sevCls[sev], I['severity_' + sev] || sev) : '') + tag() + '</div>'
          + (txt(body) ? '<p class="ai-text">' + esc(body) + '</p>' : '')
          + (txt(sugg) ? '<p class="ai-text ai-sugg">' + esc(sugg) + '</p>' : '') + '</li>';
      };
      var ul = function (a) { return a ? '<ul class="ai-items">' + a + '</ul>' : ''; };
      return '<div class="ai-overall">' + badge(ovCls, I['overall_' + ov] || ov) + '</div>'
        + section(I.r_interactions, ul(arr(r.interactions).map(function (x) { return item(x.drugs, x.severity, x.explanation, x.suggestion); }).join('')))
        + section(I.r_dose_concerns, ul(arr(r.dose_concerns).map(function (x) { return item(x.drug, null, x.concern, x.suggestion); }).join('')))
        + section(I.r_allergy_concerns, ul(arr(r.allergy_concerns).map(function (x) { return item(txt(x.drug) + ' · ' + txt(x.allergy), null, x.concern, ''); }).join('')))
        + section(I.r_condition_concerns, ul(arr(r.condition_concerns).map(function (x) { return item(txt(x.drug) + ' · ' + txt(x.condition), null, x.concern, ''); }).join('')))
        + section(I.r_notes, para(r.notes));
    },
  };

  function box(kind) { return panel.querySelector('[data-ai-kind="' + kind + '"]'); }

  function show(kind, out) {
    var el = box(kind); if (!el) return;
    var res = el.querySelector('[data-ai-result]');
    var r = out.result || {};
    var body = (R[kind] || function () { return ''; })(r);
    var parts = noteParts(kind, r);
    var hasA = D.canNote && parts.assessment && document.getElementById('n-assessment');
    var hasP = D.canNote && parts.plan && document.getElementById('n-plan_text');
    var meta = out.when ? I.generated + ' ' + out.when + (out.by ? ' · ' + I.by + ' ' + out.by : '') : I.generated_now;
    res.innerHTML = '<div class="ai-out">'
      + '<div class="ai-out-head"><span class="tiny muted">' + esc(meta) + '</span>' + (r._meta && r._meta.fallback ? '<span class="tiny muted">' + esc(I.fallback_used) + '</span>' : '') + '</div>'
      + '<div class="ai-out-body" data-ai-body>' + (body || '<p class="small muted">' + esc(I.none) + '</p>') + '</div>'
      + '<div class="ai-out-actions">'
      + (hasA ? '<button type="button" class="btn btn-ghost btn-sm" data-ai-add="assessment">' + esc(I.add_assessment) + '</button>' : '')
      + (hasP ? '<button type="button" class="btn btn-ghost btn-sm" data-ai-add="plan_text">' + esc(I.add_plan) + '</button>' : '')
      + '<button type="button" class="btn btn-ghost btn-sm" data-ai-copy>' + esc(I.copy) + '</button>'
      + '</div></div>';
    res._parts = parts;
    var lbl = el.querySelector('[data-ai-run-label]'); if (lbl) lbl.textContent = I.rerun;
  }

  function status(kind, html, cls) {
    var el = box(kind); if (!el) return;
    var s = el.querySelector('[data-ai-status]');
    s.className = 'ai-status' + (cls ? ' ' + cls : '');
    s.innerHTML = html || '';
  }

  function run(kind, btn) {
    if (busy) return;
    busy = true;
    var buttons = panel.querySelectorAll('[data-ai-run]');
    Array.prototype.forEach.call(buttons, function (b) { b.disabled = true; });
    status(kind, '<div class="ai-running"><span class="spinner" aria-hidden="true"></span><div><div class="small strong">' + esc(I.running) + '</div><div class="tiny muted">' + esc(I.running_hint) + '</div></div></div>');
    fetch('/app/visits/' + encodeURIComponent(D.apptId) + '/ai/' + kind, {
      method: 'POST', credentials: 'same-origin',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: '{}',
    }).then(function (r) {
      return r.json().catch(function () { return { ok: false, error: { message: I.error_generic } }; });
    }).then(function (j) {
      if (j && j.ok && j.data) {
        status(kind, '');
        show(kind, { result: j.data.result });
      } else {
        var msg = (j && j.error && j.error.message) || I.error_generic;
        status(kind, '<div class="alert alert-error small"><svg class="icon icon-sm" aria-hidden="true"><use href="/icons.svg#i-circle-alert"></use></svg><div class="grow">' + esc(msg) + '</div></div>');
      }
    }).catch(function () {
      status(kind, '<div class="alert alert-error small"><div class="grow">' + esc(I.error_generic) + '</div></div>');
    }).then(function () {
      busy = false;
      Array.prototype.forEach.call(buttons, function (b) { b.disabled = false; });
      if (btn) btn.focus();
    });
  }

  function addToNote(field, text, kind) {
    var ta = document.getElementById('n-' + field);
    if (!ta || !text) return;
    ta.value = ta.value.replace(/\s+$/, '') ? ta.value.replace(/\s+$/, '') + '\n\n' + text : text;
    try { ta.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) { /* old browsers */ }
    ta.scrollIntoView({ behavior: 'smooth', block: 'center' });
    ta.focus({ preventScroll: true });
    status(kind, '<p class="tiny muted">' + esc(I.added) + '</p>');
  }

  function copy(text, btn) {
    var done = function () { var old = btn.textContent; btn.textContent = I.copied; setTimeout(function () { btn.textContent = old; }, 1500); };
    if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text).then(done, function () {}); return; }
    var ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { /* ignore */ }
    document.body.removeChild(ta);
  }

  // ------------------------------------------------------------ tabs
  var tabs = panel.querySelector('[data-ai-tabs]');
  function select(kind) {
    Array.prototype.forEach.call(panel.querySelectorAll('[data-ai-tab]'), function (b) { b.setAttribute('aria-selected', b.getAttribute('data-ai-tab') === kind ? 'true' : 'false'); });
    Array.prototype.forEach.call(panel.querySelectorAll('[data-ai-kind]'), function (k) { k.hidden = k.getAttribute('data-ai-kind') !== kind; });
  }
  if (tabs) {
    tabs.hidden = false;
    var first = tabs.querySelector('[data-ai-tab]');
    select(first ? first.getAttribute('data-ai-tab') : 'summary');
  }
  Array.prototype.forEach.call(panel.querySelectorAll('[data-ai-run]'), function (b) { b.hidden = false; });

  panel.addEventListener('click', function (e) {
    var t = e.target.closest ? e.target.closest('button') : null;
    if (!t || !panel.contains(t)) return;
    var k = t.closest('[data-ai-kind]');
    var kind = k ? k.getAttribute('data-ai-kind') : null;
    if (t.hasAttribute('data-ai-tab')) { select(t.getAttribute('data-ai-tab')); return; }
    if (t.hasAttribute('data-ai-run')) { run(t.getAttribute('data-ai-run'), t); return; }
    var res = k ? k.querySelector('[data-ai-result]') : null;
    if (t.hasAttribute('data-ai-add') && res && res._parts) { addToNote(t.getAttribute('data-ai-add'), t.getAttribute('data-ai-add') === 'assessment' ? res._parts.assessment : res._parts.plan, kind); return; }
    if (t.hasAttribute('data-ai-copy') && res) { var b = res.querySelector('[data-ai-body]'); if (b) copy(plainText(b), t); }
  });

  // Tab keyboard support (arrow keys move between tabs).
  if (tabs) {
    tabs.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      var all = Array.prototype.slice.call(tabs.querySelectorAll('[data-ai-tab]'));
      var i = all.indexOf(document.activeElement); if (i < 0) return;
      var rtl = document.documentElement.dir === 'rtl';
      var step = (e.key === 'ArrowRight') !== rtl ? 1 : -1;
      var n = all[(i + step + all.length) % all.length];
      n.focus(); select(n.getAttribute('data-ai-tab')); e.preventDefault();
    });
  }

  // Last saved results.
  Object.keys(D.last || {}).forEach(function (k) { show(k, D.last[k]); });
}());

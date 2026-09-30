// Finance pages (staff salaries, partners, budgets, profit & loss): small progressive enhancements.
(function () {
  'use strict';

  /* Partners: live equity total while typing a partner's share (the server blocks saving above 100 %). */
  var island = document.getElementById('fin-equity-data');
  var input = document.querySelector('[data-equity-input]');
  if (island && input) {
    var data;
    try { data = JSON.parse(island.textContent || '{}'); } catch (e) { data = { partners: [] }; }
    var form = input.form;
    var field = input.closest('.field');
    var note = document.createElement('span');
    note.className = 'help fin-equity-live';
    note.setAttribute('aria-live', 'polite');
    var help = field ? field.querySelector('.help') : null;
    var update = function () {
      var m = /\/partners\/(\d+)$/.exec(form.getAttribute('action') || '');
      var id = m ? Number(m[1]) : null;
      var statusEl = form.querySelector('[name="status"]');
      var active = !statusEl || statusEl.value === 'active';
      var others = (data.partners || []).reduce(function (s, p) { return s + (p.active && p.id !== id ? Number(p.pct) || 0 : 0); }, 0);
      var v = parseFloat(String(input.value).replace(/,/g, ''));
      var total = Math.round((others + (active && isFinite(v) ? v : 0)) * 1000) / 1000;
      var over = total > 100.0005;
      note.textContent = over ? String(data.over || '').replace('{total}', total) : String(data.total || '').replace('{total}', total);
      note.classList.toggle('is-over', over);
      input.classList.toggle('is-invalid', over);
    };
    if (field) {
      if (help) help.insertAdjacentElement('afterend', note); else field.appendChild(note);
    }
    input.addEventListener('input', update);
    var st = form.querySelector('[name="status"]');
    if (st) st.addEventListener('change', update);
    form.addEventListener('submit', function (e) {
      update();
      if (input.classList.contains('is-invalid')) { e.preventDefault(); input.focus(); }
    });
    // The dialog's action (which partner is edited) is set after the fields are filled: recheck once it is open.
    document.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('[data-open-dialog="partner-dialog"]');
      if (b) setTimeout(update, 0);
    });
    update();
  }
}());

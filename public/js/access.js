// Settings → Team → Page access: live "can open / hidden" state, the "can also edit" option and the summary line.
(function () {
  var form = document.querySelector('[data-acc-form]');
  if (!form) return;
  var summary = document.querySelector('[data-acc-summary]');
  function modeOf(row) { var r = row.querySelector('input[type=radio]:checked'); return r ? r.value : 'default'; }
  function update() {
    var added = 0; var removed = 0;
    Array.prototype.forEach.call(form.querySelectorAll('[data-acc-row]'), function (row) {
      var mode = modeOf(row); var byRole = row.getAttribute('data-by-role') === '1';
      var open = mode === 'allow' ? true : (mode === 'deny' ? false : byRole);
      if (mode === 'allow' && !byRole) added += 1;
      if (mode === 'deny' && byRole) removed += 1;
      var st = row.querySelector('[data-acc-state]');
      if (st) { st.querySelector('.acc-dot').classList.toggle('on', open); st.lastElementChild.textContent = st.getAttribute(open ? 'data-open' : 'data-closed'); }
      var lvl = row.querySelector('[data-acc-level]');
      if (lvl) lvl.hidden = mode !== 'allow';
    });
    if (summary) {
      var parts = [];
      if (added) parts.push(summary.getAttribute('data-tpl-added').replace('{n}', added));
      if (removed) parts.push(summary.getAttribute('data-tpl-removed').replace('{n}', removed));
      summary.textContent = parts.length ? parts.join(' · ') : summary.getAttribute('data-tpl-none');
    }
  }
  form.addEventListener('change', update);
})();

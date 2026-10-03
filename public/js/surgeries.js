/* Surgeries: the "block / surgery" choice of the time-block dialog, the patient search and the "other hospital" field.
   Works for every form holding [data-sx-patient] (the dialog and the surgery page). */
(function () {
  'use strict';
  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }

  // Block or surgery.
  $$('form').forEach(function (form) {
    var radios = $$('[data-block-kind]', form);
    if (!radios.length) return;
    function sync() {
      var surgery = radios.some(function (r) { return r.checked && r.value === 'surgery'; });
      var b = $('[data-kind-block]', form); var s = $('[data-kind-surgery]', form);
      if (b) b.hidden = surgery;
      if (s) s.hidden = !surgery;
      $$('[data-sx-required]', form).forEach(function (el) { el.required = surgery; });
    }
    radios.forEach(function (r) { r.addEventListener('change', sync); });
    sync();
  });

  // "Other hospital": a typed name.
  $$('[data-sx-hospital]').forEach(function (sel) {
    var box = sel.closest('form') && $('[data-sx-hospital-name]', sel.closest('form'));
    if (!box) return;
    function sync() { box.classList.toggle('hidden', sel.value !== 'other'); }
    sel.addEventListener('change', sync); sync();
  });

  // Patient search (clinic patients), or a typed name and phone.
  $$('[data-sx-patient]').forEach(function (wrap) {
    var pid = $('[data-sx-pid]', wrap); var chip = $('[data-sx-chip]', wrap); var find = $('[data-sx-find]', wrap);
    var search = $('[data-sx-search]', wrap); var results = $('[data-sx-results]', wrap);
    var name = $('[data-sx-name]', wrap); var phone = $('[data-sx-phone]', wrap);
    var found = []; var t; var seq = 0;
    function close() { results.classList.add('hidden'); results.innerHTML = ''; }
    function choose(p) {
      pid.value = p.id; name.value = p.name; phone.value = p.phone || '';
      $('[data-sx-chip-name]', wrap).textContent = p.name;
      $('[data-sx-chip-phone]', wrap).textContent = p.phone || '';
      $('[data-sx-initials]', wrap).textContent = (p.name || '?').trim().slice(0, 2);
      chip.classList.remove('hidden'); find.classList.add('hidden'); close();
    }
    $('[data-sx-clear]', wrap).addEventListener('click', function () {
      pid.value = ''; chip.classList.add('hidden'); find.classList.remove('hidden'); search.value = ''; search.focus();
    });
    search.addEventListener('input', function () {
      clearTimeout(t);
      var q = search.value.trim();
      if (q.length < 2) { close(); return; }
      t = setTimeout(function () {
        var mine = ++seq;
        fetch('/app/surgeries/patient-lookup?q=' + encodeURIComponent(q), { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
          .then(function (r) { return r.json(); })
          .then(function (res) {
            if (mine !== seq) return;
            found = (res && res.data) || [];
            results.innerHTML = '';
            if (!found.length) { var e = document.createElement('div'); e.className = 'patient-empty small muted'; e.textContent = search.getAttribute('data-empty'); results.appendChild(e); }
            found.forEach(function (p, i) {
              var b = document.createElement('button');
              b.type = 'button'; b.className = 'patient-option'; b.setAttribute('role', 'option'); b.setAttribute('data-i', i);
              var n = document.createElement('span'); n.className = 'strong'; n.textContent = p.name;
              var ph = document.createElement('span'); ph.className = 'small muted'; ph.dir = 'ltr'; ph.textContent = p.phone || '';
              b.appendChild(n); b.appendChild(ph); results.appendChild(b);
            });
            results.classList.remove('hidden');
          }).catch(close);
      }, 250);
    });
    results.addEventListener('click', function (e) { var b = e.target.closest('[data-i]'); if (b) choose(found[Number(b.getAttribute('data-i'))]); });
    search.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); if (found[0]) choose(found[0]); } if (e.key === 'Escape') close(); });
  });
}());

/* Owner journey (worker: owner): small helpers for the setup wizard. Progressive enhancement only. */
(function () {
  'use strict';
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  /* ---------- Step 1: logo — read the chosen image, shrink it, and send it with the form as a data: URL ---------- */
  var logoInput = $('[data-ox-logo-input]');
  if (logoInput) {
    var hidden = $('[data-ox-logo-data]');
    var box = $('[data-ox-logo-preview]');
    var nameEl = $('[data-ox-logo-name]');
    var MAX_SIDE = 600;
    var fail = function (msg) { logoInput.value = ''; hidden.value = ''; if (nameEl) nameEl.textContent = msg; };
    var show = function (url, label) {
      hidden.value = url;
      box.innerHTML = '';
      var img = document.createElement('img'); img.src = url; img.alt = ''; box.appendChild(img);
      if (nameEl) nameEl.textContent = label;
    };
    logoInput.addEventListener('change', function () {
      var f = logoInput.files && logoInput.files[0];
      if (!f) return;
      if (!/^image\/(png|jpeg|webp)$/.test(f.type)) { fail(logoInput.getAttribute('data-bad')); return; }
      var reader = new FileReader();
      reader.onload = function () {
        var img = new Image();
        img.onload = function () {
          var scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
          if (scale === 1 && f.size <= Number(logoInput.getAttribute('data-max') || 1048576)) { show(reader.result, f.name); return; }
          var c = document.createElement('canvas');
          c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          var url = c.toDataURL(f.type === 'image/jpeg' ? 'image/jpeg' : 'image/png', 0.9);
          if (url.length > 1.3 * 1048576) { fail(logoInput.getAttribute('data-too-big')); return; }
          show(url, f.name);
        };
        img.onerror = function () { fail(logoInput.getAttribute('data-bad')); };
        img.src = reader.result;
      };
      reader.readAsDataURL(f);
    });
  }

  /* ---------- Step 1: WhatsApp is the same number as the clinic phone ---------- */
  var phone = $('[data-ox-phone]');
  var wa = $('[data-ox-whatsapp]');
  var same = $('[data-ox-same]');
  var sameWrap = $('[data-ox-same-wrap]');
  if (phone && wa && same && sameWrap) {
    sameWrap.hidden = false;
    same.checked = Boolean(phone.value.trim()) && phone.value.trim() === wa.value.trim();
    var sync = function () { if (same.checked) wa.value = phone.value; wa.readOnly = same.checked; };
    same.addEventListener('change', sync);
    phone.addEventListener('input', sync);
    sync();
  }

  /* ---------- Step 2: evening shift ---------- */
  var split = $('[data-ox-split]');
  var splitBox = $('[data-ox-split-box]');
  if (split && splitBox) {
    var toggle = function () { splitBox.hidden = !split.checked; };
    split.addEventListener('change', toggle);
    toggle();
  }

  /* ---------- Step 2: different hours per day — copy the first open day to the other open days ---------- */
  var copyDay = $('[data-ox-copy-day]');
  if (copyDay) {
    copyDay.addEventListener('click', function () {
      var rows = $$('.week-table tbody tr').filter(function (tr) { var cb = $('input[name$="[enabled]"]', tr); return cb && cb.checked; });
      if (rows.length < 2) return;
      var field = function (tr, k) { return $$('input[name$="[' + k + ']"]', tr).pop(); };
      rows.slice(1).forEach(function (tr) {
        ['s1', 'e1', 's2', 'e2', 'bs', 'be'].forEach(function (k) { field(tr, k).value = field(rows[0], k).value; });
        ['extra', 'break'].forEach(function (k) { field(tr, k).checked = field(rows[0], k).checked; });
      });
    });
  }

  /* ---------- Step 4: suggested services — typing a price ticks the row ---------- */
  var pick = $('[data-ox-pick]');
  if (pick) {
    var counter = $('[data-ox-pick-count]', pick);
    var update = function () {
      var n = 0;
      $$('[data-ox-svc]', pick).forEach(function (row) {
        var cb = $('[data-ox-svc-pick]', row);
        row.classList.toggle('is-on', cb.checked);
        if (cb.checked) n += 1;
      });
      if (counter && n) counter.textContent = (counter.getAttribute('data-text') || '{n}').replace('{n}', n);
    };
    $$('[data-ox-svc]', pick).forEach(function (row) {
      var cb = $('[data-ox-svc-pick]', row);
      var price = $('[data-ox-svc-price]', row);
      cb.addEventListener('change', function () { update(); if (cb.checked && price && !price.value) price.focus(); });
      if (price) price.addEventListener('input', function () { if (price.value.trim() && !cb.checked) { cb.checked = true; update(); } });
    });
    update();
  }

  /* ---------- Step 5: staff — the doctor list only matters for a doctor's login ---------- */
  var staff = $('[data-ox-staff]');
  if (staff) {
    var docField = $('[data-ox-doctor-field]', staff);
    var nameInput = $('input[name="name"]', staff);
    var refresh = function () {
      var r = $('[data-ox-role]:checked', staff);
      var isDoctor = r && r.getAttribute('data-key') === 'doctor';
      if (docField) docField.hidden = !isDoctor;
    };
    $$('[data-ox-role]', staff).forEach(function (r) { r.addEventListener('change', refresh); });
    var docSelect = docField && $('select', docField);
    if (docSelect && nameInput) {
      docSelect.addEventListener('change', function () {
        var o = docSelect.options[docSelect.selectedIndex];
        if (o && o.value && !nameInput.value.trim()) nameInput.value = o.textContent;
      });
    }
    refresh();
  }
}());

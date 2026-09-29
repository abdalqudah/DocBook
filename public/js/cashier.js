/* Cashier screen (bill lines, discount, payment method, cash received / change) and drawer closing counter.
   Figures shown here are a preview only — the server recomputes everything when the payment is posted. */
(function () {
  'use strict';

  var dataEl = document.getElementById('cs-data');
  var cfg = {};
  try { cfg = dataEl ? JSON.parse(dataEl.textContent) : JSON.parse((document.getElementById('cs-closing-data') || {}).textContent || '{}'); } catch (e) { cfg = {}; }
  var decimals = typeof cfg.decimals === 'number' ? cfg.decimals : 2;
  var factor = Math.pow(10, decimals);
  var nf;
  try { nf = new Intl.NumberFormat(cfg.locale || 'en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }); } catch (e) { nf = null; }

  function round(v) { var n = Number(v) || 0; var s = n < 0 ? -1 : 1; return (s * Math.round(Math.abs(n) * factor + 1e-9)) / factor; }
  function fmt(v) { return nf ? nf.format(round(v)) : round(v).toFixed(decimals); }
  function num(el) { if (!el) return 0; var v = parseFloat(String(el.value || '').replace(/,/g, '')); return isFinite(v) ? v : 0; }
  function isTyping(e) { var t = e.target; return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable); }

  // "/" jumps to the patient search from anywhere on the page.
  var search = document.querySelector('[data-cs-search]');
  document.addEventListener('keydown', function (e) {
    if (e.key === '/' && search && !isTyping(e) && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); search.focus(); search.select(); }
  });

  // ------------------------------------------------------------------ the bill
  var form = document.querySelector('[data-cs-bill]');
  if (form && form.querySelector('[data-lines]')) initBill(form);

  function initBill(f) {
    var body = f.querySelector('[data-lines]');
    var tpl = document.getElementById('cs-line-tpl');
    var received = f.querySelector('[data-received]');
    var discountInput = f.querySelector('[name="discount_value"]');
    var insurance = f.querySelector('[data-insurance]');
    var coverage = f.querySelector('[data-coverage-input]');
    var notesBox = f.querySelector('[data-quick-notes]');
    var out = function (k) { return f.querySelector('[data-out="' + k + '"]'); };
    var next = body.querySelectorAll('[data-line]').length;
    var state = { total: 0 };

    function method() { var r = f.querySelector('[name="payment_method"]:checked'); return r ? r.value : 'cash'; }
    function discType() { var r = f.querySelector('[name="discount_type"]:checked'); return r ? r.value : 'percent'; }
    function field(row, key) { return row.querySelector('[name$="[' + key + ']"]'); }

    function recalc() {
      var subtotal = 0;
      Array.prototype.forEach.call(body.querySelectorAll('[data-line]'), function (row) {
        var qty = Math.max(0, Math.floor(num(field(row, 'qty'))));
        var line = round(qty * Math.max(0, num(field(row, 'unit_price'))));
        subtotal += line;
        row.querySelector('[data-line-total]').textContent = fmt(line);
      });
      subtotal = round(subtotal);
      var dv = Math.max(0, num(discountInput));
      var discount = discType() === 'amount' ? round(Math.min(dv, subtotal)) : round(subtotal * Math.min(dv, 100) / 100);
      var total = round(subtotal - discount);
      state.total = total;
      out('subtotal').textContent = fmt(subtotal);
      out('discount').textContent = discount > 0 ? '− ' + fmt(discount) : fmt(0);
      out('discount_pct').textContent = discount > 0 && subtotal > 0 ? '(' + (Math.round(discount / subtotal * 10000) / 100) + '%)' : '';
      out('total').textContent = fmt(total);

      var cov = Math.min(100, Math.max(0, num(coverage)));
      var insurer = round(total * cov / 100);
      out('patient_share').textContent = fmt(total - insurer);
      out('insurer_share').textContent = fmt(insurer);

      var hasReceived = received && String(received.value).trim() !== '';
      var got = hasReceived ? round(num(received)) : total;
      out('received').textContent = fmt(got);
      var short = method() === 'cash' && hasReceived && got < total;
      out('change').textContent = short ? '—' : fmt(Math.max(0, got - total));
      out('short').hidden = !short;
      if (received) received.classList.toggle('is-invalid', short);
      renderNotes(total);
    }

    // Quick amounts: exact, and the next round notes above the total (5 / 10 / 20 / 50).
    var lastNotesFor = null;
    function renderNotes(total) {
      if (!notesBox || lastNotesFor === total) return;
      lastNotesFor = total;
      Array.prototype.forEach.call(notesBox.querySelectorAll('[data-quick]:not([data-quick="exact"])'), function (b) { b.remove(); });
      var seen = {};
      (cfg.notes || [5, 10, 20, 50]).forEach(function (n) {
        var v = Math.ceil((total + 1e-9) / n) * n;
        if (v <= total) v += n;
        if (seen[v]) return;
        seen[v] = true;
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'btn btn-secondary btn-sm num'; b.setAttribute('data-quick', String(v)); b.textContent = fmt(v);
        notesBox.appendChild(b);
      });
    }

    function toggleMethod() {
      var m = method();
      Array.prototype.forEach.call(f.querySelectorAll('[data-when]'), function (el) { el.hidden = el.getAttribute('data-when') !== m; });
      recalc();
    }

    function addLine(opts) {
      opts = opts || {};
      if (opts.serviceId) {
        var existing = Array.prototype.filter.call(body.querySelectorAll('[data-line]'), function (row) { return field(row, 'service_id').value === String(opts.serviceId); })[0];
        if (existing) { var q = field(existing, 'qty'); q.value = Math.min(999, Math.floor(num(q)) + 1); recalc(); flash(existing); return; }
      }
      var html = tpl.innerHTML.replace(/__i__/g, String(next++));
      var holder = document.createElement('tbody');
      holder.innerHTML = html;
      var row = holder.firstElementChild;
      body.appendChild(row);
      if (opts.serviceId) {
        field(row, 'service_id').value = String(opts.serviceId);
        field(row, 'name').value = opts.name || '';
        field(row, 'unit_price').value = String(opts.price);
        flash(row);
      } else {
        field(row, 'name').focus();
      }
      recalc();
    }
    function flash(row) { row.classList.remove('is-new'); void row.offsetWidth; row.classList.add('is-new'); }

    f.addEventListener('input', function (e) { if (e.target.matches('input')) recalc(); });
    f.addEventListener('change', function (e) {
      if (e.target.name === 'payment_method') toggleMethod();
      else if (e.target === insurance) {
        var opt = insurance.options[insurance.selectedIndex];
        if (coverage) coverage.value = opt && opt.getAttribute('data-coverage') ? opt.getAttribute('data-coverage') : '';
        recalc();
      } else recalc();
    });
    f.addEventListener('click', function (e) {
      var t = e.target.closest ? e.target.closest('button') : null;
      if (!t || !f.contains(t)) return;
      if (t.hasAttribute('data-qty')) {
        var q = field(t.closest('[data-line]'), 'qty');
        q.value = Math.min(999, Math.max(1, Math.floor(num(q)) + Number(t.getAttribute('data-qty'))));
        recalc();
      } else if (t.hasAttribute('data-remove-line')) {
        var row = t.closest('[data-line]');
        if (body.querySelectorAll('[data-line]').length > 1) row.remove();
        else { field(row, 'service_id').value = ''; field(row, 'name').value = ''; field(row, 'unit_price').value = ''; field(row, 'qty').value = '1'; field(row, 'name').focus(); }
        recalc();
      } else if (t.hasAttribute('data-add-service')) {
        var s = {}; try { s = JSON.parse(t.getAttribute('data-add-service')); } catch (err) { s = {}; }
        addLine({ serviceId: s.id, name: s.name, price: s.price });
      } else if (t.hasAttribute('data-add-custom')) {
        addLine();
      } else if (t.hasAttribute('data-quick') && received) {
        var v = t.getAttribute('data-quick');
        received.value = v === 'exact' ? String(state.total) : v;
        recalc();
        received.focus();
      }
    });

    var filter = f.querySelector('[data-service-filter]');
    if (filter) {
      filter.addEventListener('input', function () {
        var q = filter.value.trim().toLowerCase();
        Array.prototype.forEach.call(f.querySelectorAll('[data-add-service]'), function (b) { b.hidden = q !== '' && (b.getAttribute('data-name') || '').indexOf(q) === -1; });
      });
      filter.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        var first = f.querySelector('[data-add-service]:not([hidden])');
        if (first) { first.click(); filter.value = ''; filter.dispatchEvent(new Event('input')); }
      });
    }

    // Enter never pays by accident from a line / discount field; Enter in "amount received" pays & prints.
    f.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target !== received) { e.preventDefault(); }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'F8' || e.key === 'F9') {
        e.preventDefault();
        var btns = f.querySelectorAll('[data-pay]');
        var b = btns[e.key === 'F8' ? 0 : 1];
        if (b) { if (f.requestSubmit) f.requestSubmit(b); else b.click(); }
      }
    });

    var submitting = false;
    f.addEventListener('submit', function (e) {
      recalc();
      var hasReceived = received && String(received.value).trim() !== '';
      if (method() === 'cash' && hasReceived && round(num(received)) < state.total) { e.preventDefault(); received.focus(); return; }
      if (submitting) { e.preventDefault(); return; }
      submitting = true;
      Array.prototype.forEach.call(f.querySelectorAll('[data-pay]'), function (b) { b.classList.add('is-loading'); });
    });

    toggleMethod();
    if (insurance && coverage && insurance.value && coverage.value === '') {
      var opt = insurance.options[insurance.selectedIndex];
      coverage.value = opt.getAttribute('data-coverage') || '';
      recalc();
    }
    if (received && method() === 'cash' && !document.querySelector('.alert') && window.matchMedia && window.matchMedia('(min-width: 1024px)').matches) received.focus();
  }

  // ------------------------------------------------------------------ drawer closing: denomination counter
  var closing = document.querySelector('[data-closing]');
  if (closing) {
    var counted = closing.querySelector('[name="counted_cash"]');
    var expected = Number(closing.getAttribute('data-expected')) || 0;
    var afterExp = Number(closing.getAttribute('data-expected-after')) || expected;
    var varOut = closing.querySelector('[data-variance]');
    var varText = closing.querySelector('[data-variance-text]');
    var counter = closing.querySelector('[data-denoms]');

    var showVariance = function () {
      if (!varOut) return;
      var has = String(counted.value).trim() !== '';
      var v = round(num(counted) - expected);
      varOut.textContent = has ? (v > 0 ? '+' : v < 0 ? '−' : '') + fmt(Math.abs(v)) : '—';
      varOut.setAttribute('data-sign', !has || v === 0 ? 'zero' : v > 0 ? 'over' : 'short');
      if (varText) {
        varText.textContent = !has ? '' : v === 0 ? varText.getAttribute('data-even') : (v > 0 ? varText.getAttribute('data-over') : varText.getAttribute('data-short'));
      }
      var after = closing.querySelector('[data-variance-after]');
      if (after) { var va = round(num(counted) - afterExp); after.textContent = has ? (va > 0 ? '+' : va < 0 ? '−' : '') + fmt(Math.abs(va)) : '—'; }
    };
    var sumDenoms = function () {
      var total = 0; var any = false;
      Array.prototype.forEach.call(counter.querySelectorAll('[data-denom]'), function (inp) {
        var c = Math.max(0, Math.floor(num(inp)));
        if (String(inp.value).trim() !== '') any = true;
        var line = round(c * Number(inp.getAttribute('data-denom')));
        total += line;
        var cell = inp.closest('tr').querySelector('[data-denom-total]');
        if (cell) cell.textContent = c ? fmt(line) : '—';
      });
      var sumEl = counter.querySelector('[data-denom-sum]');
      if (sumEl) sumEl.textContent = fmt(total);
      if (any) { counted.value = String(round(total)); showVariance(); }
    };
    if (counter) counter.addEventListener('input', sumDenoms);
    if (counted) counted.addEventListener('input', showVariance);
    showVariance();
  }
})();

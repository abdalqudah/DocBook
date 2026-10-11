// Admin → Quotations: lines (add / remove, a service from the catalog), the customer from the CRM, and WhatsApp sends
// (the server logs the send and answers the wa.me link, opened here: a form may not leave the site under the CSP).
(function () {
  var form = document.querySelector('[data-quote-form]');
  if (form) {
    var body = form.querySelector('[data-quote-lines] tbody');
    var blank = function () {
      var row = body.querySelector('[data-line]').cloneNode(true);
      row.querySelectorAll('input, textarea').forEach(function (el) { el.value = el.name === 'item_quantity' ? '1' : ''; });
      return row;
    };
    form.addEventListener('click', function (e) {
      if (e.target.closest('[data-line-add]')) body.appendChild(blank());
      var rm = e.target.closest('[data-line-remove]');
      if (rm) { if (body.querySelectorAll('[data-line]').length > 1) rm.closest('[data-line]').remove(); else rm.closest('[data-line]').querySelectorAll('input, textarea').forEach(function (el) { el.value = el.name === 'item_quantity' ? '1' : ''; }); }
    });
    var svc = form.querySelector('[data-quote-service]');
    if (svc) svc.addEventListener('change', function () {
      var o = svc.selectedOptions[0];
      if (!o || !o.value) return;
      var lang = (form.querySelector('[name="locale"]') || {}).value === 'en' ? 'en' : 'ar';
      var rows = body.querySelectorAll('[data-line]');
      var last = rows[rows.length - 1];
      var row = last.querySelector('[name="item_description"]').value.trim() ? blank() : last;
      row.querySelector('[name="item_description"]').value = o.getAttribute('data-text-' + lang);
      row.querySelector('[name="item_price"]').value = o.getAttribute('data-price');
      row.querySelector('[name="item_service_id"]').value = o.value;
      if (row !== last) body.appendChild(row);
      svc.value = '';
    });
    var contact = form.querySelector('[data-quote-contact]');
    if (contact) contact.addEventListener('change', function () {
      var o = contact.selectedOptions[0];
      if (!o || !o.value) return;
      [['customer_name', 'name'], ['customer_company', 'company'], ['customer_email', 'email'], ['customer_phone', 'phone']].forEach(function (p) {
        var el = form.querySelector('[name="' + p[0] + '"]'); if (el && !el.value) el.value = o.getAttribute('data-' + p[1]) || '';
      });
    });
  }
  document.querySelectorAll('[data-wa-send]').forEach(function (f) {
    f.addEventListener('submit', function (e) {
      e.preventDefault();
      var w = window.open('about:blank', '_blank');
      fetch(f.action, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams(new FormData(f)).toString(), credentials: 'same-origin' })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d.ok && d.href) { if (w) w.location = d.href; else window.location = d.href; setTimeout(function () { window.location.reload(); }, 800); }
          else { if (w) w.close(); window.alert(d.error || 'Error'); }
        })
        .catch(function () { if (w) w.close(); });
    });
  });
}());

/* Subscriptions (clinic Settings → Subscription, platform admin plans/subscriptions). Progressive enhancement only. */
(function () {
  'use strict';
  // Admin settings: ask for confirmation only when the on/off switch itself changes (app.js shows the dialog for
  // form[data-confirm] unless data-confirmed is set).
  var form = document.querySelector('form[data-sub-switch-form]');
  if (form) {
    var box = form.querySelector('[data-sub-enabled]');
    var initial = box ? box.checked : false;
    var sync = function () { if (box && box.checked !== initial) delete form.dataset.confirmed; else form.dataset.confirmed = '1'; };
    sync();
    if (box) box.addEventListener('change', sync);
  }

  // Record-payment dialog: picking an open invoice fills the amount, plan and cycle from it.
  var inv = document.querySelector('[data-sub-invoice-pick]');
  if (inv) {
    inv.addEventListener('change', function () {
      var opt = inv.options[inv.selectedIndex];
      var f = inv.form;
      if (!opt || !f) return;
      if (opt.getAttribute('data-amount') && f.elements.amount) f.elements.amount.value = opt.getAttribute('data-amount');
      if (opt.getAttribute('data-cycle') && f.elements.billing_cycle) f.elements.billing_cycle.value = opt.getAttribute('data-cycle');
      if (f.elements.plan_id && opt.getAttribute('data-plan') !== null) f.elements.plan_id.value = opt.getAttribute('data-plan');
      if (f.elements.period_start) f.elements.period_start.value = opt.getAttribute('data-start') || '';
      if (f.elements.period_end) f.elements.period_end.value = opt.getAttribute('data-end') || '';
    });
  }

  // Invoice page opened with ?autoprint=1 is handled by app.js; nothing else to do here.
}());

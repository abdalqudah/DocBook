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
      if (f.elements.branches && opt.getAttribute('data-branches')) f.elements.branches.value = opt.getAttribute('data-branches');
      if (f.elements.period_start) f.elements.period_start.value = opt.getAttribute('data-start') || '';
      if (f.elements.period_end) f.elements.period_end.value = opt.getAttribute('data-end') || '';
    });
  }

  // Choosing a plan: the cards show the price for the number of branches typed (1 … the plan's limit).
  var nb = document.querySelector('[data-sub-branches]');
  if (nb) {
    var update = function () {
      var n = Math.max(1, Math.floor(Number(nb.value) || 1));
      Array.prototype.forEach.call(document.querySelectorAll('[data-bp-for]'), function (el) {
        var max = el.getAttribute('data-max'); var prices = {};
        try { prices = JSON.parse(el.getAttribute('data-prices') || '{}'); } catch (e) { prices = {}; }
        var k = max ? Math.min(n, Number(max)) : n;
        var box = el.closest('.box'); var p = prices[String(k)];
        var tooFew = Boolean(max) && n > Number(max);
        el.textContent = (el.getAttribute(tooFew ? 'data-too-few' : 'data-text') || '{n}').replace('{n}', tooFew ? max : k);
        el.classList.toggle('warn-text', tooFew); el.classList.toggle('muted', !tooFew);
        if (!box || !p) return;
        var m = box.querySelector('[data-bp-price="m"]'); var y = box.querySelector('[data-bp-price="y"]');
        if (m) m.textContent = p.m; if (y) y.textContent = p.y;
      });
    };
    nb.addEventListener('input', update);
  }

  // Invoice page opened with ?autoprint=1 is handled by app.js; nothing else to do here.
}());

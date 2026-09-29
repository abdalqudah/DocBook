// Online payments: settings form (show the fields of the chosen provider), the hand-over to PayTabs' page and
// the options for HyperPay's card widget (read from a JSON data island; must run before their script loads).
(function () {
  'use strict';

  // HyperPay widget options: a global the widget reads when it loads (this file is included right before it).
  var opts = document.getElementById('wpwl-options');
  if (opts) {
    try {
      var o = JSON.parse(opts.textContent || '{}');
      o.onReady = function () {
        var l = document.querySelector('[data-pay-loading]');
        if (l) l.hidden = true;
      };
      window.wpwlOptions = o;
    } catch (e) { /* the widget still works with its defaults */ }
  }

  function ready(fn) { if (document.readyState !== 'loading') fn(); else document.addEventListener('DOMContentLoaded', fn); }

  ready(function () {
    // Settings: only the chosen provider's fields (all stay in the form without JavaScript).
    var form = document.querySelector('[data-pay-settings]');
    if (form) {
      var sync = function () {
        var checked = form.querySelector('[data-provider-choice]:checked');
        var p = checked ? checked.value : 'none';
        Array.prototype.forEach.call(form.querySelectorAll('[data-provider-when]'), function (el) {
          el.hidden = (' ' + el.getAttribute('data-provider-when') + ' ').indexOf(' ' + p + ' ') === -1;
        });
      };
      Array.prototype.forEach.call(form.querySelectorAll('[data-provider-choice]'), function (r) { r.addEventListener('change', sync); });
      sync();
    }

    // PayTabs: continue to the secure payment page automatically (the button stays for browsers without JS).
    var go = document.querySelector('[data-pay-redirect]');
    if (go && /^https:\/\//.test(go.getAttribute('href') || '')) {
      setTimeout(function () { window.location.href = go.getAttribute('href'); }, 1200);
    }
  });
}());

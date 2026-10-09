// Patient portal: show / hide a password; the patient page's tabs (one section at a time).
(function () {
  'use strict';
  document.querySelectorAll('[data-pw-eye]').forEach(function (btn) {
    var input = btn.parentNode.querySelector('input');
    btn.addEventListener('click', function () {
      var show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.setAttribute('aria-pressed', show ? 'true' : 'false');
      btn.setAttribute('aria-label', btn.getAttribute(show ? 'data-label-hide' : 'data-label-show'));
      btn.querySelector('[data-eye-on]').hidden = show;
      btn.querySelector('[data-eye-off]').hidden = !show;
    });
  });
  var tabs = document.querySelectorAll('[data-pp-tab]');
  if (!tabs.length) return;
  var showTab = function (key) {
    tabs.forEach(function (a) { var on = a.getAttribute('data-pp-tab') === key; a.classList.toggle('active', on); if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    document.querySelectorAll('[data-pp-section]').forEach(function (s) { s.hidden = s.getAttribute('data-pp-section') !== key; });
  };
  tabs.forEach(function (a) { a.addEventListener('click', function (e) { e.preventDefault(); showTab(a.getAttribute('data-pp-tab')); history.replaceState(null, '', '#pp-' + a.getAttribute('data-pp-tab')); }); });
  var h = (location.hash || '').replace('#pp-', '');
  showTab(document.querySelector('[data-pp-tab="' + h + '"]') ? h : tabs[0].getAttribute('data-pp-tab'));
}());

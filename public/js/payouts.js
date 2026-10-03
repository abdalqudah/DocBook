// Bank transfer pages: pick-all per bank file, a confirmation before e-mailing the bank, and the column builder of a
// bank file layout (add, remove, move; a column's label follows its field until the user types their own).
(function () {
  'use strict';
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  $$('[data-bank-group]').forEach(function (form) {
    var all = form.querySelector('[data-pick-all]');
    var boxes = $$('input[name="p"]:not([disabled])', form);
    if (all) all.addEventListener('change', function () { boxes.forEach(function (b) { b.checked = all.checked; }); });
    form.addEventListener('submit', function (e) {
      var btn = e.submitter;
      if (btn && btn.getAttribute('data-confirm') && !window.confirm(btn.getAttribute('data-confirm'))) e.preventDefault();
    });
  });

  var list = document.querySelector('[data-cols]');
  if (!list) return;
  var tpl = document.querySelector('[data-col-template]');
  var labels = {};
  try { labels = JSON.parse(document.querySelector('[data-field-labels]').textContent); } catch (err) { /* none */ }
  function sync(li) {
    var field = li.querySelector('[data-col-field]').value;
    var value = li.querySelector('[data-col-value]');
    value.hidden = !(field === 'text' || field === 'reference');
  }
  function number() { $$('[data-col]', list).forEach(function (li, i) { li.querySelector('.bk-col-n').textContent = String(i + 1); sync(li); }); }
  list.addEventListener('focusin', function (e) {
    if (e.target.matches('[data-col-field]')) e.target.setAttribute('data-was', e.target.value);
  });
  list.addEventListener('change', function (e) {
    if (!e.target.matches('[data-col-field]')) return;
    var li = e.target.closest('[data-col]');
    var label = li.querySelector('[name="col_label"]');
    var was = e.target.getAttribute('data-was');
    if (!label.value || (was && label.value === labels[was])) label.value = labels[e.target.value] || '';
    e.target.setAttribute('data-was', e.target.value);
    sync(li);
  });
  list.addEventListener('click', function (e) {
    var btn = e.target.closest('button');
    if (!btn) return;
    var li = btn.closest('[data-col]');
    if (btn.hasAttribute('data-col-remove')) li.remove();
    else if (btn.hasAttribute('data-col-up') && li.previousElementSibling) list.insertBefore(li, li.previousElementSibling);
    else if (btn.hasAttribute('data-col-down') && li.nextElementSibling) list.insertBefore(li.nextElementSibling, li);
    number();
  });
  document.querySelector('[data-col-add]').addEventListener('click', function () {
    var li = tpl.content.firstElementChild.cloneNode(true);
    list.appendChild(li);
    li.querySelector('[name="col_label"]').value = labels.text || '';
    number();
    li.querySelector('select').focus();
  });
  number();
}());

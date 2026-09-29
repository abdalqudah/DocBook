// Review form: live character counter for the comment (progressive enhancement — the form works without it).
(function () {
  'use strict';
  var fields = document.querySelectorAll('textarea[data-count]');
  Array.prototype.forEach.call(fields, function (ta) {
    var out = document.getElementById(ta.getAttribute('data-count'));
    if (!out) return;
    var max = Number(ta.getAttribute('maxlength')) || 1000;
    var update = function () { out.textContent = ta.value.length + ' / ' + max; };
    ta.addEventListener('input', update);
    update();
  });
}());

// Reschedule: keep the chosen day visible in the horizontally scrolling day list.
(function () {
  'use strict';
  var active = document.querySelector('.eg-days .eg-day.active');
  if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest', inline: 'center' });
}());

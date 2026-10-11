// Admin → CRM → a bulk e-mail campaign: "select all" ticks every contact listed; the "+ customer's name" buttons put
// {name} / {organization} where the cursor is in the subject or the message.
(function () {
  var all = document.querySelector('[data-camp-all]');
  if (all) {
    all.addEventListener('change', function () {
      document.querySelectorAll('[data-camp-people] input[name="contact"]').forEach(function (b) { b.checked = all.checked; });
    });
  }
  document.querySelectorAll('[data-camp-insert]').forEach(function (row) {
    var field = document.getElementById(row.getAttribute('data-camp-insert'));
    if (!field) return;
    row.querySelectorAll('[data-insert]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var text = btn.getAttribute('data-insert');
        var start = field.selectionStart == null ? field.value.length : field.selectionStart;
        var end = field.selectionEnd == null ? start : field.selectionEnd;
        field.value = field.value.slice(0, start) + text + field.value.slice(end);
        field.focus();
        field.setSelectionRange(start + text.length, start + text.length);
      });
    });
  });
}());

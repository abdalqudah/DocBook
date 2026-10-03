// The member's e-mail: "show images" reloads the sandboxed body with outside images allowed; the connect form fills
// the server names from the address (known providers, else mail.<domain>) until the member edits them.
(function () {
  var btn = document.querySelector('[data-mail-images]');
  var frame = document.querySelector('[data-mail-frame]');
  if (btn && frame) btn.addEventListener('click', function () { frame.src = btn.getAttribute('data-mail-images'); btn.hidden = true; });

  var form = document.querySelector('[data-mail-connect]');
  if (!form) return;
  var email = form.querySelector('[data-mail-email]');
  var imap = form.querySelector('[data-mail-imap]');
  var smtp = form.querySelector('[data-mail-smtp]');
  var port = form.querySelector('[name="smtp_port"]');
  var sec = form.querySelector('[name="smtp_security"]');
  var touched = false;
  [imap, smtp, port].forEach(function (el) { if (el) el.addEventListener('input', function () { touched = true; }); });
  var known = [
    [/^(gmail|googlemail)\.com$/, 'imap.gmail.com', 'smtp.gmail.com', 465, 'ssl'],
    [/^(outlook|hotmail|live|msn)\.[a-z.]+$|^office365\.com$/, 'outlook.office365.com', 'smtp.office365.com', 587, 'starttls'],
    [/^(yahoo|ymail)\.[a-z.]+$/, 'imap.mail.yahoo.com', 'smtp.mail.yahoo.com', 465, 'ssl'],
    [/^(icloud|me|mac)\.com$/, 'imap.mail.me.com', 'smtp.mail.me.com', 587, 'starttls'],
  ];
  if (email) email.addEventListener('input', function () {
    if (touched || !imap || !smtp) return;
    var domain = (email.value.split('@')[1] || '').toLowerCase().trim();
    if (!domain) return;
    var k = known.find(function (x) { return x[0].test(domain); });
    imap.value = k ? k[1] : 'mail.' + domain;
    smtp.value = k ? k[2] : 'mail.' + domain;
    if (port) port.value = k ? k[3] : 465;
    if (sec) sec.value = k ? k[4] : 'ssl';
  });
}());

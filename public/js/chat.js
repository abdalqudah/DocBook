/* Staff chat: send without reloading, new messages every few seconds, Enter sends (Shift+Enter = new line). */
(function () {
  'use strict';
  var box = document.querySelector('[data-chat]');
  if (!box) return;
  var list = box.querySelector('[data-chat-msgs]');
  var form = box.querySelector('[data-chat-form]');
  var input = form.querySelector('textarea');
  var fileInput = form.querySelector('[data-chat-file]');
  var picked = box.querySelector('[data-chat-picked]');
  var kb = function (n) { return n >= 1048576 ? (Math.round(n / 104857.6) / 10) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; };
  var id = box.getAttribute('data-chat');
  var me = Number(box.getAttribute('data-me'));
  var after = Number(box.getAttribute('data-after')) || 0;
  var csrf = (document.querySelector('meta[name="csrf-token"]') || {}).content || '';
  var i18n = {}; try { i18n = JSON.parse(document.getElementById('chat-i18n').textContent); } catch (e) { i18n = {}; }
  var end = list.querySelector('#end');
  var down = function () { list.scrollTop = list.scrollHeight; };
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  var stamp = function (iso) { var d = new Date(iso); return isNaN(d) ? '' : pad(d.getHours()) + ':' + pad(d.getMinutes()); };

  function add(m) {
    if (list.querySelector('[data-id="' + m.id + '"]')) return;
    var empty = list.querySelector('[data-chat-empty]'); if (empty) empty.remove();
    var wrap = document.createElement('div');
    wrap.className = 'chat-msg' + (m.user_id === me ? ' is-me' : '');
    wrap.setAttribute('data-id', m.id);
    if (m.user_id !== me) { var who = document.createElement('div'); who.className = 'chat-who tiny'; who.textContent = m.user_name || '—'; wrap.appendChild(who); }
    if (m.files && m.files.length) {
      var fl = document.createElement('div'); fl.className = 'chat-files';
      m.files.forEach(function (f) {
        var a = document.createElement('a'); a.href = '/app/chat/files/' + f.id; a.target = '_blank'; a.rel = 'noopener';
        if (f.image) { a.className = 'chat-img'; var img = document.createElement('img'); img.src = a.href; img.alt = f.name; img.loading = 'lazy'; img.addEventListener('load', function () { if (list.scrollHeight - list.scrollTop - list.clientHeight < 400) down(); }); a.appendChild(img); }
        else { a.className = 'chat-file'; var sp = document.createElement('span'); sp.textContent = f.name; var sm = document.createElement('small'); sm.dir = 'ltr'; sm.textContent = kb(f.size); a.appendChild(sp); a.appendChild(sm); }
        fl.appendChild(a);
      });
      wrap.appendChild(fl);
    }
    if (m.body) { var b = document.createElement('div'); b.className = 'chat-bubble'; b.dir = 'auto'; b.textContent = m.body; wrap.appendChild(b); }
    var at = document.createElement('div'); at.className = 'chat-at tiny muted'; at.textContent = stamp(m.at); wrap.appendChild(at);
    list.insertBefore(wrap, end);
    after = Math.max(after, m.id);
  }

  function poll() {
    fetch('/app/chat/' + id + '/messages?after=' + after, { headers: { accept: 'application/json' }, credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : { data: [] }; })
      .then(function (j) { var near = list.scrollHeight - list.scrollTop - list.clientHeight < 80; (j.data || []).forEach(add); if (near && (j.data || []).length) down(); })
      .catch(function () {});
  }

  function showPicked() {
    var files = fileInput && fileInput.files ? Array.prototype.slice.call(fileInput.files) : [];
    picked.hidden = !files.length;
    picked.textContent = '';
    files.forEach(function (f) { var c = document.createElement('span'); c.className = 'chat-chip'; c.textContent = f.name + ' · ' + kb(f.size); picked.appendChild(c); });
    if (files.length) { var x = document.createElement('button'); x.type = 'button'; x.className = 'btn btn-ghost btn-sm'; x.textContent = '×'; x.setAttribute('aria-label', i18n.clear || 'Clear'); x.addEventListener('click', function () { fileInput.value = ''; showPicked(); }); picked.appendChild(x); }
  }
  if (fileInput) fileInput.addEventListener('change', showPicked);

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = input.value.trim();
    var hasFiles = fileInput && fileInput.files && fileInput.files.length;
    if (!text && !hasFiles) return;
    var body = new FormData(form);
    var btn = form.querySelector('button[type=submit]'); if (btn) btn.disabled = true;
    fetch(form.action, { method: 'POST', body: body, headers: { accept: 'application/json', 'x-csrf-token': csrf }, credentials: 'same-origin' })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error((j.error && j.error.message) || i18n.failed); return j; }); })
      .then(function () { input.value = ''; input.style.height = ''; if (fileInput) { fileInput.value = ''; showPicked(); } poll(); setTimeout(down, 150); })
      .catch(function (err) { alert(err.message || i18n.failed || 'Could not send'); })
      .then(function () { if (btn) btn.disabled = false; });
  });
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit')); } });
  input.addEventListener('input', function () { input.style.height = 'auto'; input.style.height = Math.min(160, input.scrollHeight) + 'px'; });
  down();
  setInterval(function () { if (!document.hidden) poll(); }, 4000);
})();

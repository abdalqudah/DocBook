/* Staff chat: send without reloading, new messages every few seconds, Enter sends (Shift+Enter = new line). */
(function () {
  'use strict';
  var box = document.querySelector('[data-chat]');
  if (!box) return;
  var list = box.querySelector('[data-chat-msgs]');
  var form = box.querySelector('[data-chat-form]');
  var input = form.querySelector('textarea');
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
    var b = document.createElement('div'); b.className = 'chat-bubble'; b.dir = 'auto'; b.textContent = m.body; wrap.appendChild(b);
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

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text) return;
    var body = new URLSearchParams({ _csrf: csrf, body: text });
    input.value = ''; input.style.height = '';
    fetch(form.action, { method: 'POST', body: body, headers: { accept: 'application/json', 'x-csrf-token': csrf }, credentials: 'same-origin' })
      .then(function (r) { if (!r.ok) throw new Error('send'); return r.json(); })
      .then(function () { poll(); setTimeout(down, 120); })
      .catch(function () { input.value = text; alert(i18n.failed || 'Could not send'); });
  });
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit')); } });
  input.addEventListener('input', function () { input.style.height = 'auto'; input.style.height = Math.min(160, input.scrollHeight) + 'px'; });
  down();
  setInterval(function () { if (!document.hidden) poll(); }, 4000);
})();

// AI finance assistant page: chat over fetch (JSON), confirm/cancel of proposed actions, busy state for the analysis.
// Everything also works without JavaScript (plain form posts + redirects).
(function () {
  'use strict';
  var csrfMeta = document.querySelector('meta[name="csrf-token"]');
  var csrf = csrfMeta ? csrfMeta.content : '';
  var thread = document.querySelector('[data-aifin-thread]');
  var chatForm = document.querySelector('[data-aifin-chat]');

  function post(url, body) {
    return fetch(url, {
      method: 'POST', credentials: 'same-origin',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify(body || {}),
    }).then(function (r) {
      return r.json().catch(function () { return { ok: false, error: {} }; });
    });
  }
  function scrollDown() { if (thread) thread.scrollTop = thread.scrollHeight; }
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; }

  // ---- analysis: busy state on submit (normal post)
  var analyze = document.querySelector('[data-aifin-analyze]');
  if (analyze) {
    analyze.addEventListener('submit', function () {
      var btn = analyze.querySelector('button[type="submit"]');
      if (!btn) return;
      setTimeout(function () { btn.disabled = true; }, 0);
      var label = btn.querySelector('span');
      if (label && btn.getAttribute('data-busy-text')) label.textContent = btn.getAttribute('data-busy-text');
      var sp = el('span', 'spinner'); sp.setAttribute('aria-hidden', 'true');
      var ic = btn.querySelector('svg'); if (ic) btn.replaceChild(sp, ic);
    });
  }

  // ---- chat
  if (chatForm && thread) {
    var input = chatForm.querySelector('textarea');
    var sendBtn = chatForm.querySelector('button[type="submit"]');
    var busy = false;
    scrollDown();

    function autosize() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 160) + 'px'; }
    input.addEventListener('input', autosize);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (typeof chatForm.requestSubmit === 'function') chatForm.requestSubmit(); else chatForm.dispatchEvent(new Event('submit', { cancelable: true })); }
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-aifin-suggest]'), function (b) {
      b.addEventListener('click', function () { input.value = b.getAttribute('data-aifin-suggest'); autosize(); input.focus(); });
    });

    chatForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var text = input.value.trim();
      if (!text || busy) return;
      busy = true; sendBtn.disabled = true;
      var welcome = thread.querySelector('[data-aifin-welcome]'); if (welcome) welcome.remove();
      var turn = el('div', 'aifin-turn is-me');
      var bubble = el('div', 'msg me', text); bubble.setAttribute('dir', 'auto');
      turn.appendChild(bubble); thread.appendChild(turn);
      var wait = el('div', 'aifin-turn');
      var typing = el('div', 'msg aifin-typing');
      var sp = el('span', 'spinner'); sp.setAttribute('aria-hidden', 'true');
      typing.appendChild(sp); typing.appendChild(el('span', '', chatForm.getAttribute('data-thinking')));
      wait.appendChild(typing); thread.appendChild(wait);
      input.value = ''; autosize(); scrollDown();
      var month = chatForm.querySelector('input[name="month"]');
      post(chatForm.action, { message: text, month: month ? month.value : '' }).then(function (res) {
        wait.remove();
        if (res && res.ok && res.data) {
          turn.remove();
          thread.insertAdjacentHTML('beforeend', res.data.html);
          var u = document.querySelector('[data-aifin-usage]');
          if (u && res.data.usage && u.textContent.indexOf('/') !== -1) u.textContent = u.textContent.replace(/^[^/]*\//, String(res.data.usage.month) + ' /');
        } else {
          var msg = (res && res.error && res.error.message) || chatForm.getAttribute('data-error');
          turn.appendChild(el('div', 'aifin-error', msg));
          input.value = text; autosize();
        }
      }).catch(function () {
        wait.remove();
        turn.appendChild(el('div', 'aifin-error', chatForm.getAttribute('data-error')));
        input.value = text; autosize();
      }).then(function () { busy = false; sendBtn.disabled = false; scrollDown(); input.focus(); });
    });
  }

  // ---- confirm / cancel a proposed action (event delegation: cards arrive with chat replies)
  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (!form || !form.matches || !form.matches('[data-aifin-decide]')) return;
    e.preventDefault();
    var card = form.closest('[data-aifin-action]');
    var btns = card ? card.querySelectorAll('button') : [];
    Array.prototype.forEach.call(btns, function (b) { b.disabled = true; });
    var old = card && card.querySelector('.aifin-error'); if (old) old.remove();
    post(form.action, {}).then(function (res) {
      if (res && res.ok && res.data && card) {
        card.insertAdjacentHTML('afterend', res.data.html);
        card.remove();
      } else {
        Array.prototype.forEach.call(btns, function (b) { b.disabled = false; });
        var msg = (res && res.error && res.error.message) || (chatForm && chatForm.getAttribute('data-error')) || '';
        var foot = card && card.querySelector('.aifin-action-foot');
        if (foot) foot.insertAdjacentElement('beforebegin', el('div', 'aifin-error aifin-action-error', msg));
      }
    }).catch(function () { Array.prototype.forEach.call(btns, function (b) { b.disabled = false; }); });
  });
}());

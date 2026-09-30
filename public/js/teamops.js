/* Team operations — loaded on every /app page:
 *  • presence heartbeat (every ~60 s while the tab is visible, POST with the CSRF header);
 *  • notification bell: polls the unread count (~45 s while visible), updates the badge and plays a short chime
 *    when a new notification arrives and the member turned the sound on (the AudioContext is armed on first click);
 *  • Settings → Team: online dot / "last seen" next to each member;
 *  • "E-mail the patient" dialog: loads shared documents and recent e-mails when it opens;
 *  • Settings → Notifications: "Play test sound". */
(function () {
  'use strict';
  if (!/^\/app(\/|$)/.test(location.pathname) || window.__docbookTeamops) return;
  window.__docbookTeamops = true;

  var meta = document.querySelector('meta[name="csrf-token"]');
  var csrf = meta ? meta.getAttribute('content') : '';
  var HEARTBEAT_MS = 60000;
  var POLL_MS = 45000;
  var STORE_KEY = 'docbook.teamops.lastNotif';

  function visible() { return !document.hidden; }
  function getJson(url, cb) {
    var x = new XMLHttpRequest();
    x.open('GET', url, true);
    x.setRequestHeader('Accept', 'application/json');
    x.onload = function () { if (x.status >= 200 && x.status < 300) { try { cb(JSON.parse(x.responseText)); } catch (e) { /* ignore */ } } };
    x.send();
  }
  function post(url) {
    var x = new XMLHttpRequest();
    x.open('POST', url, true);
    x.setRequestHeader('Accept', 'application/json');
    x.setRequestHeader('X-CSRF-Token', csrf);
    x.send();
  }
  function store(k, v) { try { if (v === undefined) return window.localStorage.getItem(k); window.localStorage.setItem(k, v); } catch (e) { /* private mode */ } return null; }
  function loadCss() {
    if (document.querySelector('link[data-teamops-css]') || document.querySelector('link[href^="/css/teamops.css"]')) return;
    var l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = '/css/teamops.css?v=' + (document.documentElement.getAttribute('data-v') || '');
    l.setAttribute('data-teamops-css', '');
    document.head.appendChild(l);
  }

  // ---------------------------------------------------------------- presence heartbeat
  var lastBeat = 0;
  function beat() {
    if (!visible()) return;
    lastBeat = Date.now();
    post('/app/teamops/heartbeat');
  }
  beat();
  setInterval(function () { if (visible() && Date.now() - lastBeat >= HEARTBEAT_MS - 1000) beat(); }, 15000);

  // ---------------------------------------------------------------- sound
  var audio = null;
  function arm() {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      if (!audio) audio = new AC();
      if (audio.state === 'suspended') audio.resume();
    } catch (e) { audio = null; }
  }
  document.addEventListener('click', arm, { once: true, capture: true });
  document.addEventListener('keydown', arm, { once: true, capture: true });

  function chime() {
    if (!audio) arm();
    if (!audio || audio.state !== 'running') return;
    try {
      var now = audio.currentTime;
      [880, 1175].forEach(function (freq, i) {
        var osc = audio.createOscillator();
        var gain = audio.createGain();
        var t0 = now + i * 0.12;
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0, t0);
        gain.gain.linearRampToValueAtTime(0.12, t0 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.25);
        osc.connect(gain); gain.connect(audio.destination);
        osc.start(t0); osc.stop(t0 + 0.3);
      });
    } catch (e) { /* never break the page */ }
  }

  // ---------------------------------------------------------------- bell
  var bell = document.querySelector('.topbar a.bell, a.bell');
  function setBell(n) {
    if (!bell) return;
    var badge = bell.querySelector('.bell-count');
    if (n > 0) {
      if (!badge) { badge = document.createElement('span'); badge.className = 'bell-count'; bell.appendChild(badge); }
      badge.textContent = n > 9 ? '9+' : String(n);
    } else if (badge) badge.parentNode.removeChild(badge);
  }
  var baseline = null;
  function poll() {
    if (!visible()) return;
    getJson('/app/teamops/unread', function (d) {
      if (typeof d.count !== 'number') return;
      setBell(d.count);
      var latest = Number(d.latestId) || 0;
      var seen = Number(store(STORE_KEY)) || 0;
      if (baseline === null) {
        // First look on this page: remember what exists, don't chime for it.
        baseline = latest;
        if (latest > seen) store(STORE_KEY, String(latest));
        return;
      }
      if (latest > Math.max(baseline, seen)) {
        store(STORE_KEY, String(latest));
        baseline = latest;
        if (d.sound) chime();
      }
    });
  }
  poll();
  setInterval(poll, POLL_MS);
  document.addEventListener('visibilitychange', function () {
    if (!visible()) return;
    if (Date.now() - lastBeat > HEARTBEAT_MS) beat();
    poll();
  });

  // ---------------------------------------------------------------- Settings → Team: presence dots
  if (/^\/app\/settings\/team\/?$/.test(location.pathname)) {
    var editBtns = document.querySelectorAll('[data-open-dialog="edit-dialog"][data-action^="/app/clinic/team/"]');
    if (editBtns.length) {
      loadCss();
      getJson('/app/teamops/presence', function (d) {
        var map = d.byMembership || {};
        Array.prototype.forEach.call(editBtns, function (btn) {
          var m = (btn.getAttribute('data-action') || '').match(/\/team\/(\d+)$/);
          var p = m && map[m[1]];
          var row = btn.closest('tr');
          var name = row && row.querySelector('.person-name');
          if (!p || !name || p.hidden || row.querySelector('.to-pres')) return;
          var line = document.createElement('span');
          line.className = 'to-pres';
          var dot = document.createElement('span');
          dot.className = 'status-dot' + (p.online ? ' on' : '');
          line.appendChild(dot);
          line.appendChild(document.createTextNode(p.label));
          name.parentNode.insertBefore(line, name.nextSibling);
        });
      });
    }
  }

  // ---------------------------------------------------------------- test sound (settings)
  Array.prototype.forEach.call(document.querySelectorAll('[data-teamops-chime]'), function (b) {
    b.addEventListener('click', function () { arm(); setTimeout(chime, 30); });
  });

  // ---------------------------------------------------------------- patient e-mail dialog
  var dlg = document.querySelector('[data-teamops-mail-dialog]');
  if (dlg) {
    loadCss();
    var loaded = false;
    var fmtDate = function (iso) {
      try { return new Date(iso).toLocaleString(document.documentElement.lang === 'en' ? 'en-GB' : 'ar-EG-u-nu-latn', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch (e) { return iso; }
    };
    var el = function (tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
    var load = function () {
      if (loaded) return;
      loaded = true;
      getJson(dlg.getAttribute('data-src'), function (d) {
        var off = dlg.querySelector('[data-dm-off]');
        var send = dlg.querySelector('[data-dm-send]');
        if (!d.mailConfigured) { if (off) off.hidden = false; if (send) send.disabled = true; }
        var box = dlg.querySelector('[data-dm-docs]');
        if (box) {
          box.textContent = '';
          if (!d.docs || !d.docs.length) box.appendChild(el('span', 'small muted', box.getAttribute('data-empty')));
          (d.docs || []).forEach(function (doc) {
            var lab = el('label', 'check');
            var cb = document.createElement('input');
            cb.type = 'checkbox'; cb.name = 'docs'; cb.value = String(doc.id);
            lab.appendChild(cb);
            var span = el('span', '', doc.label);
            if (doc.date) { span.appendChild(document.createTextNode(' ')); span.appendChild(el('span', 'tiny muted', doc.date)); }
            lab.appendChild(span);
            box.appendChild(lab);
          });
        }
        var list = dlg.querySelector('[data-dm-history]');
        var wrap = dlg.querySelector('[data-dm-history-wrap]');
        if (list && wrap && d.history && d.history.length) {
          d.history.forEach(function (h) {
            var li = el('li');
            var head = el('div', 'row-sm wrap');
            head.appendChild(el('span', 'strong', h.subject));
            head.appendChild(el('span', 'tiny muted', fmtDate(h.at) + (h.sender ? ' · ' + h.sender : '')));
            if (h.status === 'failed') head.appendChild(el('span', 'badge badge-danger', list.getAttribute('data-failed')));
            if (h.files) head.appendChild(el('span', 'tiny muted', (list.getAttribute('data-files') || '').replace('{n}', h.files)));
            li.appendChild(head);
            li.appendChild(el('div', 'dm-h-body', h.body));
            list.appendChild(li);
          });
          wrap.hidden = false;
        }
      });
    };
    Array.prototype.forEach.call(document.querySelectorAll('[data-teamops-mail]'), function (b) { b.addEventListener('click', load); });
    dlg.querySelector('form').addEventListener('submit', function () {
      var send = dlg.querySelector('[data-dm-send]');
      if (send) setTimeout(function () { send.disabled = true; }, 0);
    });
  }
}());

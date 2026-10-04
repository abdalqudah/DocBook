/* Online consultations (telehealth):
   • copy buttons for consultation links (clipboard, with a fallback for plain-http installations)
   • the online booking page: time-zone detection, free times shown in the patient's time and the clinic's,
     country → dialling code, file checks before upload
   • the consultation page and the doctor's visit page: countdown, join window, camera/microphone check,
     and the 1:1 WebRTC video call. Signaling goes through our server (POST …/signal, GET …/signal?after=…
     short long-polling). The doctor always makes the offer; the patient answers. */
(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var isAr = document.documentElement.lang === 'ar';
  var csrf = ($('meta[name="csrf-token"]') || {}).content || '';
  var parse = function (id) { try { return JSON.parse(($(id) || {}).textContent || '{}'); } catch (e) { return {}; } };
  var fmt = function (s, vars) { return String(s || '').replace(/\{(\w+)\}/g, function (m, k) { return vars && vars[k] !== undefined ? vars[k] : m; }); };

  /* ---------------- copy ---------------- */
  function copyText(text, done) {
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { if (document.execCommand('copy')) done(); } catch (e) { /* ignore */ }
      document.body.removeChild(ta);
    }
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, fallback);
    else fallback();
  }
  $$('[data-tele-copy]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      copyText(btn.getAttribute('data-tele-copy'), function () {
        var span = btn.querySelector('span');
        if (!span) return;
        var old = span.textContent;
        span.textContent = isAr ? 'تم النسخ' : 'Copied';
        setTimeout(function () { span.textContent = old; }, 1600);
      });
    });
  });

  /* ---------------- online booking page ---------------- */
  var bookForm = $('form[data-tele-book]');
  if (bookForm) initBooking(bookForm);

  function initBooking(form) {
    var data = parse('#tele-book-data');
    var msgs = data.messages || {};
    var url = form.getAttribute('data-slots-url');
    var tzSel = $('[data-tz-select]', form);
    var dateInput = $('[data-date-input]', form);
    var times = $('[data-times]', form);
    var timesMsg = $('[data-times-msg]', form);
    var timesHint = $('[data-times-hint]', form);
    var slotsBtn = $('[data-slots-btn]', form);
    if (slotsBtn) slotsBtn.parentNode.removeChild(slotsBtn);
    var numLocale = data.locale === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB';
    var detected = false;

    if (tzSel && !tzSel.hasAttribute('data-tz-given')) {
      try {
        var tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (tz && tz !== tzSel.value && $('option[value="' + tz.replace(/"/g, '') + '"]', tzSel)) { tzSel.value = tz; detected = true; }
      } catch (e) { /* keep the clinic's zone */ }
    }

    function sum(key, text) { var el = $('[data-sum="' + key + '"]'); if (el) el.textContent = text || '—'; }
    function doctorInput() { return $('input[name="doctor_id"]:checked', form); }
    function setMessage(text) {
      if (!timesMsg) return;
      timesMsg.hidden = !text;
      var span = timesMsg.querySelector('span');
      if (span) span.textContent = text || '';
      if (timesHint) timesHint.hidden = Boolean(text);
    }
    function formatDate(v) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v || '')) return '—';
      try { return new Intl.DateTimeFormat(numLocale, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(v + 'T00:00:00Z')); } catch (e) { return v; }
    }
    function zoneText() { var o = tzSel && tzSel.options[tzSel.selectedIndex]; sum('zone', o ? o.textContent : ''); }
    function chosenTime() { return ($('input[name="appointment_time"]:checked', form) || {}).value; }
    function showChosen() {
      var r = $('input[name="appointment_time"]:checked', form);
      sum('time', r ? r.value : '');
      sum('local', r ? r.getAttribute('data-local') + (r.getAttribute('data-note') ? ' (' + r.getAttribute('data-note') + ')' : '') : '');
    }

    var seq = 0;
    function loadSlots() {
      var doc = doctorInput();
      var date = dateInput ? dateInput.value : '';
      var chosen = chosenTime();
      if (!doc || !date) { times.innerHTML = ''; setMessage(msgs.pick); showChosen(); return; }
      var mine = ++seq;
      times.setAttribute('aria-busy', 'true');
      times.innerHTML = '';
      setMessage(msgs.loading);
      var q = '?doctor=' + encodeURIComponent(doc.value) + '&date=' + encodeURIComponent(date) + '&tz=' + encodeURIComponent(tzSel ? tzSel.value : '');
      fetch(url + q, { credentials: 'same-origin', headers: { accept: 'application/json' } })
        .then(function (r) { return r.json(); })
        .then(function (res) {
          if (mine !== seq) return;
          times.removeAttribute('aria-busy');
          var list = (res && res.data) || [];
          if (!list.length) { setMessage((res && res.error) || msgs.none); showChosen(); return; }
          setMessage('');
          times.innerHTML = list.map(function (s) {
            var time = String(s.time).replace(/[^0-9:]/g, '');
            var local = String(s.local).replace(/[^0-9:]/g, '');
            var note = s.shift < 0 ? msgs.prev : s.shift > 0 ? msgs.next : '';
            var esc = function (v) { return String(v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
            return '<label class="tele-chip"><input type="radio" name="appointment_time" value="' + time + '" data-local="' + local + '" data-note="' + esc(note) + '"' + (time === chosen ? ' checked' : '') + ' required>'
              + '<span><strong class="num" dir="ltr">' + local + '</strong><small class="num" dir="ltr">' + time + '</small>' + (note ? '<em>' + esc(note) + '</em>' : '') + '</span></label>';
          }).join('');
          showChosen();
        })
        .catch(function () { if (mine === seq) { times.removeAttribute('aria-busy'); setMessage(msgs.error); } });
    }

    form.addEventListener('change', function (e) {
      var el = e.target;
      if (el.name === 'doctor_id') { sum('doctor', el.getAttribute('data-name')); sum('fee', el.getAttribute('data-fee')); sum('length', ''); var l = $('[data-sum="length"]'); if (l) l.textContent = (el.closest('.doc-choice').querySelector('.muted.small') || {}).textContent || '—'; loadSlots(); }
      else if (el.name === 'appointment_date') { sum('date', formatDate(el.value)); loadSlots(); }
      else if (el.name === 'patient_timezone') { zoneText(); loadSlots(); }
      else if (el.name === 'appointment_time') showChosen();
    });

    // Country of residence → dialling code (until the patient picks a code themselves).
    var country = $('[data-country-select]', form);
    var dial = $('[data-dial-select]', form);
    var dialTouched = Boolean(dial && dial.value);
    if (dial) dial.addEventListener('change', function () { dialTouched = true; });
    if (country && dial) {
      country.addEventListener('change', function () {
        var o = country.options[country.selectedIndex];
        if (!dialTouched && o && o.getAttribute('data-dial')) dial.value = o.getAttribute('data-dial');
      });
    }

    // Files: the same limits as the server (count, size, type) — checked before the upload starts.
    var files = $('[data-files]', form);
    var filesErr = $('[data-files-error]', form);
    function checkFiles() {
      if (!files || !files.files) return true;
      var max = Number(files.getAttribute('data-max')) || 5;
      var maxBytes = Number(files.getAttribute('data-max-bytes')) || 10485760;
      var list = Array.prototype.slice.call(files.files);
      var msg = '';
      if (list.length > max) msg = msgs.tooMany;
      else if (list.some(function (f) { return f.size > maxBytes; })) msg = msgs.tooBig;
      else if (list.some(function (f) { return !/\.(pdf|jpe?g|png)$/i.test(f.name) && !/^(application\/pdf|image\/(jpeg|png))$/.test(f.type); })) msg = msgs.badType;
      if (filesErr) { filesErr.textContent = msg; filesErr.hidden = !msg; }
      files.classList.toggle('is-invalid', Boolean(msg));
      return !msg;
    }
    if (files) files.addEventListener('change', checkFiles);
    form.addEventListener('submit', function (e) { if (!checkFiles()) { e.preventDefault(); files.focus(); } });

    zoneText();
    if (detected) loadSlots();
  }

  /* ---------------- consultation: countdown, join, device check, call ---------------- */
  var cfg = parse('#tele-call-data');
  if (!cfg || !cfg.role) return;
  var L = cfg.labels || {};
  var skew = (Number(cfg.serverNow) || Date.now()) - Date.now();
  var now = function () { return Date.now() + skew; };
  var joinBtn = $('[data-join]');
  var joinNote = $('[data-join-note]');
  var canState = cfg.role === 'patient' ? cfg.state === 'confirmed' : (cfg.state === 'confirmed' || cfg.state === 'pending');
  var inWindow = function () { var n = now(); return n >= cfg.openMs && n <= cfg.closeMs; };

  function tick() {
    var cd = $('[data-countdown]');
    if (cd) {
      var n = now();
      var label = $('[data-cd-label]', cd);
      var value = $('[data-cd-value]', cd);
      if (n < cfg.startMs) {
        var mins = Math.ceil((cfg.startMs - n) / 60000);
        var d = Math.floor(mins / 1440); var h = Math.floor((mins % 1440) / 60); var m = mins % 60;
        label.textContent = L.startsIn || '';
        value.textContent = mins <= 1 ? (L.startingNow || '') : [d ? fmt(L.d, { n: d }) : '', h ? fmt(L.h, { n: h }) : '', m ? fmt(L.m, { n: m }) : ''].filter(Boolean).join(' ');
      } else if (n <= cfg.endMs) { label.textContent = ''; value.textContent = L.inProgress || ''; }
      else { label.textContent = ''; value.textContent = L.over || ''; }
    }
    if (joinBtn && canState) {
      var open = inWindow();
      if (joinBtn.tagName === 'A') joinBtn.setAttribute('aria-disabled', open ? 'false' : 'true');
      else if (!callActive) joinBtn.disabled = !open;
      if (joinNote && open) joinNote.textContent = '';
      else if (joinNote && now() > cfg.closeMs) joinNote.textContent = L.over || '';
    }
  }
  var callActive = false;
  tick();
  setInterval(tick, 1000);

  function request(method, path, body) {
    return fetch(cfg.base + path, {
      method: method, credentials: 'same-origin', cache: 'no-store',
      headers: method === 'POST' ? { 'content-type': 'application/json', accept: 'application/json', 'x-csrf-token': csrf } : { accept: 'application/json' },
      body: method === 'POST' ? JSON.stringify(body || {}) : undefined,
    }).then(function (r) { return r.json().catch(function () { return { ok: false }; }); });
  }

  /* Device check (camera preview + microphone level) */
  var testStream = null; var testAudio = null; var testRaf = 0;
  function stopDeviceTest() {
    if (testStream) testStream.getTracks().forEach(function (t) { t.stop(); });
    testStream = null;
    if (testAudio) { try { testAudio.close(); } catch (e) { /* ignore */ } testAudio = null; }
    cancelAnimationFrame(testRaf);
    var box = $('[data-device-check]');
    if (box) {
      $('[data-device-preview]', box).hidden = true;
      var span = $('[data-device-btn] span', box); if (span) span.textContent = L.deviceBtn || span.textContent;
    }
  }
  var dc = $('[data-device-check]');
  if (dc) {
    var dcMsg = $('[data-device-msg]', dc);
    $('[data-device-btn]', dc).addEventListener('click', function () {
      if (testStream) { stopDeviceTest(); dcMsg.textContent = ''; return; }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { dcMsg.textContent = L.deviceUnsupported; return; }
      navigator.mediaDevices.getUserMedia({ video: true, audio: true }).then(function (stream) {
        testStream = stream;
        $('[data-device-preview]', dc).hidden = false;
        $('[data-device-video]', dc).srcObject = stream;
        $('[data-device-btn] span', dc).textContent = L.deviceStop;
        dcMsg.textContent = L.deviceOk;
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        testAudio = new AC();
        var an = testAudio.createAnalyser(); an.fftSize = 512;
        testAudio.createMediaStreamSource(stream).connect(an);
        var buf = new Uint8Array(an.fftSize); var bar = $('[data-device-meter]', dc);
        (function loop() {
          an.getByteTimeDomainData(buf);
          var sum = 0; for (var i = 0; i < buf.length; i++) { var v = (buf[i] - 128) / 128; sum += v * v; }
          bar.style.width = Math.min(100, Math.round(Math.sqrt(sum / buf.length) * 300)) + '%';
          testRaf = requestAnimationFrame(loop);
        }());
      }).catch(function () { dcMsg.textContent = L.deviceFail; });
    });
  }

  /* Link method: the doctor's own meeting service in a new tab (joining still marks the arrival). */
  if (joinBtn && joinBtn.hasAttribute('data-join-link')) {
    joinBtn.addEventListener('click', function (e) {
      if (joinBtn.getAttribute('aria-disabled') === 'true') { e.preventDefault(); return; }
      request('POST', '/join').catch(function () { /* the link opens anyway */ });
    });
    return;
  }

  var root = $('[data-tele-call]');
  if (!root || !joinBtn) return;
  var remoteV = $('[data-remote]', root);
  var localV = $('[data-local]', root);
  var statusEl = $('[data-call-status]', root);
  var playBtn = $('[data-play]', root);
  var stage = $('[data-stage]', root);
  var pc = null; var local = null; var sid = null; var cursor = 0; var connected = false;
  var pendingIce = []; var outIce = null; var retries = 0; var facing = 'user'; var jitsiFrame = null; var peerGone = false;

  function setStatus(text, kind) {
    statusEl.textContent = text || '';
    statusEl.hidden = !text;
    statusEl.className = 'tele-status' + (kind ? ' is-' + kind : '');
  }
  function send(kind, payload) { return request('POST', '/signal', { kind: kind, payload: payload }); }
  function rand() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }

  function closePc() {
    if (pc) { pc.onicecandidate = null; pc.ontrack = null; pc.onconnectionstatechange = null; try { pc.close(); } catch (e) { /* ignore */ } }
    pc = null; pendingIce = []; outIce = null; connected = false;
  }
  function queueIce(c) { if (outIce) outIce.push(c); else send('ice', { sid: sid, c: c }); }
  function releaseIce() { var list = outIce || []; outIce = null; list.forEach(function (c) { send('ice', { sid: sid, c: c }); }); }
  function addIce(c) {
    if (!pc || !c) return null;
    if (!pc.remoteDescription) { pendingIce.push(c); return null; }
    return pc.addIceCandidate(c).catch(function () { /* stale candidate */ });
  }
  function flushIce() { var list = pendingIce; pendingIce = []; list.forEach(addIce); }
  function tryPlay() {
    var p = remoteV.play && remoteV.play();
    if (p && p.catch) p.then(function () { playBtn.hidden = true; }).catch(function () { playBtn.hidden = false; });
  }
  playBtn.addEventListener('click', function () { remoteV.muted = false; tryPlay(); });

  function newPc() {
    var mine = new RTCPeerConnection({ iceServers: cfg.ice || [] });
    pc = mine;
    if (local) local.getTracks().forEach(function (t) { mine.addTrack(t, local); });
    else { mine.addTransceiver('audio', { direction: 'recvonly' }); mine.addTransceiver('video', { direction: 'recvonly' }); }
    mine.onicecandidate = function (e) { if (e.candidate && pc === mine) queueIce(e.candidate.toJSON ? e.candidate.toJSON() : e.candidate); };
    mine.ontrack = function (e) {
      var s = e.streams && e.streams[0];
      if (!s) { s = remoteV.srcObject || new MediaStream(); s.addTrack(e.track); }
      if (remoteV.srcObject !== s) remoteV.srcObject = s;
      tryPlay();
    };
    mine.onconnectionstatechange = function () {
      if (pc !== mine) return;
      var st = mine.connectionState;
      root.setAttribute('data-state', st);
      if (st === 'connected') { connected = true; retries = 0; setStatus(''); root.classList.add('is-connected'); var pj = document.querySelector('[data-peer-joined]'); if (pj && pj.getAttribute('data-yes')) pj.textContent = pj.getAttribute('data-yes'); }
      else if (st === 'disconnected') { setStatus(L.reconnecting, 'warn'); }
      else if (st === 'failed') { connected = false; root.classList.remove('is-connected'); setStatus(L.failed, 'error'); recover(); }
    };
    return mine;
  }

  function makeOffer() {
    closePc();
    sid = rand();
    var mine = newPc();
    outIce = [];
    return mine.createOffer()
      .then(function (o) { return mine.setLocalDescription(o); })
      .then(function () { return send('offer', { sid: sid, sdp: mine.localDescription }); })
      .then(releaseIce);
  }
  function answer(p) {
    closePc();
    sid = p.sid;
    var mine = newPc();
    outIce = [];
    return mine.setRemoteDescription(p.sdp)
      .then(function () { flushIce(); return mine.createAnswer(); })
      .then(function (a) { return mine.setLocalDescription(a); })
      .then(function () { return send('answer', { sid: sid, sdp: mine.localDescription }); })
      .then(releaseIce);
  }
  function recover() {
    if (!callActive || retries >= 4) return;
    retries += 1;
    setTimeout(function () {
      if (!callActive || connected) return;
      setStatus(L.reconnecting, 'warn');
      if (cfg.role === 'doctor') makeOffer(); else send('ready');
    }, 1200 * retries);
  }

  function handle(m) {
    var p = m.payload || {};
    if (m.kind === 'bye') { closePc(); remoteV.srcObject = null; root.classList.remove('is-connected'); peerGone = true; setStatus(L.peerLeft); return null; }
    if (m.kind === 'hello' || m.kind === 'ready' || m.kind === 'offer') peerGone = false;
    if (cfg.role === 'doctor') {
      if (m.kind === 'hello' || m.kind === 'ready') { setStatus(L.peerHere); return makeOffer(); }
      if (m.kind === 'answer' && pc && p.sid === sid) return pc.setRemoteDescription(p.sdp).then(flushIce);
    } else {
      if (m.kind === 'hello') return send('ready');
      if (m.kind === 'offer' && p.sid && p.sdp) { setStatus(L.peerHere); return answer(p); }
    }
    if (m.kind === 'ice' && p.sid === sid) return addIce(p.c);
    return null;
  }

  function peerText(peer) {
    if (connected || jitsiFrame || peerGone) return;
    if (peer) { if (!pc) setStatus(L.peerHere); }
    else setStatus(cfg.role === 'doctor' ? L.waitingPatient : L.waitingDoctor);
  }

  function poll() {
    if (!callActive) return;
    fetch(cfg.base + '/signal?after=' + encodeURIComponent(cursor) + '&wait=20', { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!callActive) return;
        if (!j || !j.ok) { setStatus((j && j.error && j.error.length > 20 ? j.error : L.closed), 'error'); setTimeout(poll, 5000); return; }
        cursor = j.last;
        var chain = Promise.resolve();
        (j.messages || []).forEach(function (m) { chain = chain.then(function () { return handle(m); }).catch(function () { /* next message */ }); });
        chain.then(function () { peerText(j.peer); setTimeout(poll, 60); });
      })
      .catch(function () { if (callActive) setTimeout(poll, 2500); });
  }

  function getMedia() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return Promise.resolve(null);
    return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } } })
      .catch(function () { return navigator.mediaDevices.getUserMedia({ audio: true }).catch(function () { return null; }); });
  }

  function controlsFor(stream) {
    var hasA = stream && stream.getAudioTracks().length; var hasV = stream && stream.getVideoTracks().length;
    $('[data-act="mute"]', root).disabled = !hasA;
    $('[data-act="cam"]', root).disabled = !hasV;
    $('[data-no-media]', root).hidden = Boolean(hasA || hasV);
    if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices && hasV) {
      navigator.mediaDevices.enumerateDevices().then(function (list) {
        $('[data-act="switch"]', root).hidden = list.filter(function (d) { return d.kind === 'videoinput'; }).length < 2;
      }).catch(function () { /* ignore */ });
    }
  }

  function startJitsi() {
    stage.classList.add('is-jitsi');
    jitsiFrame = document.createElement('iframe');
    jitsiFrame.className = 'tele-jitsi';
    jitsiFrame.src = cfg.jitsiUrl;
    jitsiFrame.setAttribute('allow', 'camera; microphone; fullscreen; display-capture; autoplay');
    jitsiFrame.setAttribute('title', L.connecting || 'Video');
    stage.appendChild(jitsiFrame);
    setStatus('');
    $$('.tele-ctl', root).forEach(function (b) { if (b.getAttribute('data-act') !== 'hangup') b.hidden = true; });
  }

  function start() {
    if (callActive) return;
    callActive = true;
    joinBtn.disabled = true;
    stopDeviceTest();
    root.hidden = false;
    root.classList.remove('is-ended');
    if (root.scrollIntoView) root.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setStatus(L.connecting);
    if (cfg.method === 'jitsi' && cfg.jitsiUrl) {
      request('POST', '/join').then(function (j) {
        if (!j || !j.ok) throw new Error((j && j.error) || L.closed);
        startJitsi();
      }).catch(function (e) { setStatus(e.message || L.error, 'error'); callActive = false; joinBtn.disabled = !inWindow(); });
      return;
    }
    if (!window.RTCPeerConnection) { setStatus(L.deviceUnsupported, 'error'); callActive = false; return; }
    getMedia().then(function (stream) {
      local = stream;
      if (stream) localV.srcObject = stream;
      controlsFor(stream);
      return request('POST', '/join');
    }).then(function (j) {
      if (!j || !j.ok) throw new Error((j && j.error) || L.closed);
      if (j.ice) cfg.ice = j.ice; // relay servers with their passwords, only once the call may start
      return request('GET', '/signal');
    }).then(function (j) {
      if (!j || !j.ok) throw new Error((j && j.error) || L.closed);
      cursor = j.last;
      peerText(j.peer);
      poll();
      return send('hello');
    }).catch(function (e) {
      setStatus(e && e.message && e.message.length > 3 ? e.message : L.error, 'error');
      stop(false);
    });
  }

  function stop(sayBye) {
    if (sayBye && callActive && !jitsiFrame) send('bye');
    callActive = false;
    closePc();
    if (local) local.getTracks().forEach(function (t) { t.stop(); });
    local = null;
    localV.srcObject = null; remoteV.srcObject = null;
    if (jitsiFrame) { jitsiFrame.parentNode.removeChild(jitsiFrame); jitsiFrame = null; stage.classList.remove('is-jitsi'); $$('.tele-ctl', root).forEach(function (b) { if (b.getAttribute('data-act') !== 'switch') b.hidden = false; }); }
    root.classList.remove('is-connected');
    root.classList.add('is-ended');
    joinBtn.disabled = !inWindow();
  }

  joinBtn.addEventListener('click', start);

  root.addEventListener('click', function (e) {
    var b = e.target.closest('[data-act]');
    if (!b) return;
    var act = b.getAttribute('data-act');
    var toggle = function (kind) {
      if (!local) return;
      var tracks = kind === 'audio' ? local.getAudioTracks() : local.getVideoTracks();
      var off = tracks.length && tracks[0].enabled;
      tracks.forEach(function (t) { t.enabled = !off; });
      b.setAttribute('aria-pressed', off ? 'true' : 'false');
      b.classList.toggle('is-off', Boolean(off));
      var span = b.querySelector('span'); if (span) span.textContent = off ? b.getAttribute('data-off') : b.getAttribute('data-on');
    };
    if (act === 'mute') toggle('audio');
    else if (act === 'cam') toggle('video');
    else if (act === 'hangup') { stop(true); setStatus(L.ended); }
    else if (act === 'reconnect') {
      if (!callActive) { start(); return; }
      setStatus(L.reconnecting, 'warn');
      if (cfg.role === 'doctor') makeOffer(); else send('ready');
    } else if (act === 'switch' && local) {
      facing = facing === 'user' ? 'environment' : 'user';
      navigator.mediaDevices.getUserMedia({ video: { facingMode: facing } }).then(function (s) {
        var track = s.getVideoTracks()[0];
        var old = local.getVideoTracks()[0];
        if (old) { local.removeTrack(old); old.stop(); }
        local.addTrack(track);
        localV.srcObject = local;
        if (pc) pc.getSenders().forEach(function (snd) { if (snd.track === null || (snd.track && snd.track.kind === 'video')) snd.replaceTrack(track); });
      }).catch(function () { facing = facing === 'user' ? 'environment' : 'user'; });
    }
  });

  // Leaving the page ends the call for the other side too (best effort).
  window.addEventListener('pagehide', function () {
    if (!callActive || jitsiFrame || !navigator.sendBeacon) return;
    navigator.sendBeacon(cfg.base + '/signal', new URLSearchParams({ kind: 'bye', _csrf: csrf }));
  });
}());

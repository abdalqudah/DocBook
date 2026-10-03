// Waiting-room TV screen (/queue/<token>): refreshes every 2 s from data-queue-src, slides the new patient in
// when someone is called, and plays a "ding-dong" whenever the queue changes (going in, next or waiting); when the
// screen's "voice" setting is on it then reads the name and room aloud (Web Speech, the browser's own voices).
// Browsers only allow sound after a tap: the screen shows "Tap to start" once; the choice is remembered.
(function () {
  var root = document.querySelector('[data-queue-src]');
  if (!root) return;
  var src = root.getAttribute('data-queue-src');
  var sig = root.getAttribute('data-sig') || '';
  var nowId = root.getAttribute('data-now') || '';
  var roomTpl = root.getAttribute('data-room-tpl') || '{n}';
  var moreTpl = root.getAttribute('data-more-tpl') || '+{n}';
  var locale = root.getAttribute('data-locale') || 'en';
  var tz = root.getAttribute('data-tz') || undefined;
  var $ = function (s) { return root.querySelector(s); };
  var store = { get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } } };

  // ------------------------------------------------------------- sound
  var audio = null;
  var soundOn = store.get('qs-sound') !== '0';
  function arm() {
    if (!audio) { try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { audio = null; } }
    if (audio && audio.state === 'suspended') audio.resume();
  }
  function dingDong() {
    if (!soundOn || !audio || audio.state !== 'running') return;
    try {
      var t = audio.currentTime;
      [[659, 0], [523, 0.5]].forEach(function (p) {
        var osc = audio.createOscillator(); var gain = audio.createGain(); var t0 = t + p[1];
        osc.type = 'triangle'; osc.frequency.value = p[0];
        gain.gain.setValueAtTime(0, t0); gain.gain.linearRampToValueAtTime(0.35, t0 + 0.02); gain.gain.exponentialRampToValueAtTime(0.001, t0 + 1.1);
        osc.connect(gain); gain.connect(audio.destination); osc.start(t0); osc.stop(t0 + 1.15);
      });
    } catch (e) { /* never break the screen */ }
  }
  // Read the name and room aloud after the chime (screen setting "voice"; the clinic can turn it off = chime only).
  var voiceOn = root.getAttribute('data-voice') === '1';
  var sayTpl = root.getAttribute('data-say-tpl') || '{name} {room}';
  var sayPlain = root.getAttribute('data-say-tpl-plain') || '{name}';
  var synth = window.speechSynthesis || null;
  var voices = [];
  function loadVoices() { try { voices = synth ? synth.getVoices() : []; } catch (e) { voices = []; } }
  if (synth) { loadVoices(); if ('onvoiceschanged' in synth) synth.onvoiceschanged = loadVoices; }
  function voiceFor(lang) {
    var want = voices.filter(function (v) { return v.lang && v.lang.toLowerCase().indexOf(lang) === 0; });
    return want.find(function (v) { return /google|microsoft|natural/i.test(v.name); }) || want[0] || null;
  }
  function speak(p) {
    if (!voiceOn || !soundOn || !synth || !p) return;
    var room = roomOf(p);
    var text = (room ? sayTpl.replace('{room}', room) : sayPlain).replace('{name}', p.say || p.name);
    try {
      synth.cancel();
      var u = new SpeechSynthesisUtterance(text);
      u.lang = locale === 'ar' ? 'ar-SA' : 'en-GB';
      var v = voiceFor(locale === 'ar' ? 'ar' : 'en'); if (v) u.voice = v;
      u.rate = 0.9;
      synth.speak(u);
    } catch (e) { /* no voice on this device: the chime still plays */ }
  }
  var start = $('[data-qs-start]');
  var soundBtn = $('[data-qs-sound]');
  var soundLabel = $('[data-qs-sound-label]');
  function paintSound() {
    if (soundLabel) soundLabel.textContent = root.getAttribute(soundOn ? 'data-sound-on' : 'data-sound-off') || '';
    if (soundBtn) soundBtn.classList.toggle('is-off', !soundOn);
  }
  if (start) {
    if (!soundOn) start.hidden = true;
    // The tap also unlocks speech (browsers only speak after a tap): the screen says who is going in now.
    start.addEventListener('click', function () {
      arm(); start.hidden = true; dingDong();
      if (synth) { try { synth.speak(new SpeechSynthesisUtterance('')); } catch (e) { /* ignore */ } }
      if (current) setTimeout(function () { speak(current); }, 1600);
    });
  }
  document.addEventListener('pointerdown', arm, { once: true });
  if (soundBtn) soundBtn.addEventListener('click', function () { soundOn = !soundOn; store.set('qs-sound', soundOn ? '1' : '0'); arm(); paintSound(); if (start) start.hidden = true; });
  paintSound();

  // ------------------------------------------------------------- clock + full screen
  var clock = $('[data-qs-clock]'); var date = $('[data-qs-date]');
  function tick() {
    var d = new Date();
    try {
      if (clock) clock.textContent = d.toLocaleTimeString(locale === 'ar' ? 'ar-u-nu-latn' : 'en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz });
      if (date) date.textContent = d.toLocaleDateString(locale === 'ar' ? 'ar-u-nu-latn' : 'en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: tz });
    } catch (e) { if (clock) clock.textContent = d.toTimeString().slice(0, 5); }
  }
  tick(); setInterval(tick, 15000);
  var fs = $('[data-qs-fullscreen]');
  if (fs && document.documentElement.requestFullscreen) {
    fs.hidden = false;
    fs.addEventListener('click', function () { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(function () {}); });
  }

  // ------------------------------------------------------------- render
  function roomOf(p) { return p && p.room ? (/^[0-9]+[A-Za-z]?$/.test(p.room) ? roomTpl.replace('{n}', p.room) : p.room) : ''; }
  function docOf(p) { return p ? ((locale === 'en' && p.doctorEn) || p.doctor || '') : ''; }
  function fill(card, p) {
    card.hidden = !p;
    if (!p) return;
    card.querySelector('[data-f="name"]').textContent = p.name;
    var r = card.querySelector('[data-f="room"]'); r.textContent = roomOf(p); r.hidden = !roomOf(p);
    card.querySelector('[data-f="doctor"]').textContent = docOf(p);
  }
  function rowsInto(list, people, nameCls) {
    list.textContent = '';
    people.forEach(function (p) {
      var li = document.createElement('li');
      var room = document.createElement('span'); room.className = 'qs-room qs-room-sm'; room.textContent = roomOf(p); room.hidden = !roomOf(p);
      var name = document.createElement('span'); name.className = nameCls; name.dir = 'auto'; name.textContent = p.name;
      if (nameCls === 'qs-rname') { li.appendChild(room); li.appendChild(name); } else { li.appendChild(name); li.appendChild(room); }
      list.appendChild(li);
    });
  }
  function slide(el) { if (!el || el.hidden) return; el.classList.remove('qs-in'); void el.offsetWidth; el.classList.add('qs-in'); }
  function render(b) {
    var nowCard = $('[data-qs-now]'); var nextCard = $('[data-qs-next]'); var wait = $('[data-qs-wait]');
    fill(nowCard, b.now); fill(nextCard, b.next);
    rowsInto($('[data-qs-list]'), b.waiting || [], 'qs-wname');
    wait.hidden = !(b.waiting && b.waiting.length);
    var more = $('[data-qs-more]'); more.hidden = !b.more; more.textContent = moreTpl.replace('{n}', b.more || 0);
    rowsInto($('[data-qs-rooms]'), b.rooms || [], 'qs-rname');
    $('[data-qs-rooms-empty]').hidden = Boolean(b.rooms && b.rooms.length);
    $('[data-qs-empty]').hidden = Boolean(b.now || b.next);
    var newNow = b.now ? String(b.now.id) : '';
    if (newNow && newNow !== nowId) { slide(nowCard); setTimeout(function () { slide(nextCard); }, 450); root.classList.add('qs-flash'); setTimeout(function () { root.classList.remove('qs-flash'); }, 2500); }
    else if (b.sig !== sig) { slide(nextCard); }
    if (typeof b.voice === 'boolean') voiceOn = b.voice;
    if (b.header) {
      var nm = $('[data-screen-name]'); var msg = $('[data-screen-msg]');
      if (nm) nm.hidden = !b.header.showName;
      if (msg) { msg.textContent = b.header.message || ''; msg.hidden = !b.header.message; }
    }
    if (b.sig !== sig) dingDong();
    if (newNow && newNow !== nowId) { var who = b.now; setTimeout(function () { speak(who); }, 1600); }
    current = b.now || null;
    nowId = newNow; sig = b.sig;
  }

  // ------------------------------------------------------------- refresh every 2 s
  var off = $('[data-qs-offline]'); var gone = $('[data-qs-gone]');
  var busy = false;
  var current = null;
  function load() {
    if (busy) return;
    busy = true;
    fetch(src, { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } })
      .then(function (r) {
        if (r.status === 404) { gone.hidden = false; return null; }
        if (!r.ok) throw new Error('http ' + r.status);
        return r.json();
      })
      .then(function (j) { off.hidden = true; if (j && j.data) { gone.hidden = true; render(j.data); } })
      .catch(function () { off.hidden = false; })
      .then(function () { busy = false; });
  }
  setInterval(load, 2000);
  // A TV left on for days: reload the page once a night to pick up updates.
  setTimeout(function () { location.reload(); }, 12 * 3600 * 1000);
})();

/* Staff attendance — the door screen (kiosk): fetches a new QR code every 10 seconds without reloading, keeps the
   clinic's clock and date, refreshes the list of the last check-ins, and goes full screen on the first touch. */
(function () {
  'use strict';
  var kiosk = document.querySelector('[data-kiosk-src]');
  if (!kiosk) return;
  var qrBox = kiosk.querySelector('[data-kiosk-qr]');
  var leftEl = kiosk.querySelector('[data-kiosk-left]');
  var bar = kiosk.querySelector('[data-kiosk-bar]');
  var clockEl = kiosk.querySelector('[data-kiosk-clock]');
  var dateEl = kiosk.querySelector('[data-kiosk-date]');
  var offline = kiosk.querySelector('[data-kiosk-offline]');
  var gone = kiosk.querySelector('[data-kiosk-gone]');
  var feedEl = kiosk.querySelector('[data-kiosk-feed]');
  var feedEmpty = kiosk.querySelector('[data-kiosk-feed-empty]');
  var fsBtn = document.querySelector('[data-kiosk-fullscreen]');
  var step = Number(kiosk.getAttribute('data-step')) || 10;
  var deadline = Date.now() + (Number(kiosk.getAttribute('data-expires')) || step) * 1000;
  var tz = kiosk.getAttribute('data-tz') || undefined;
  var loc = kiosk.getAttribute('data-locale') === 'ar' ? 'ar-JO-u-nu-latn' : 'en-GB';
  var labels = { 'in': kiosk.getAttribute('data-label-in') || '', out: kiosk.getAttribute('data-label-out') || '' };
  var timer = null;
  var stopped = false;
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  var timeFmt = null; var dateFmt = null;
  try {
    timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
    dateFmt = new Intl.DateTimeFormat(loc, { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' });
  } catch (e) { timeFmt = null; dateFmt = null; }

  // The clinic's time (its time zone), whatever the device is set to.
  function paint() {
    var left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    if (leftEl) leftEl.textContent = String(left);
    if (bar) bar.style.width = Math.max(0, Math.min(100, (left / step) * 100)) + '%';
    var d = new Date();
    if (clockEl) clockEl.textContent = timeFmt ? timeFmt.format(d) : pad(d.getHours()) + ':' + pad(d.getMinutes());
    if (dateEl && dateFmt) dateEl.textContent = dateFmt.format(d);
  }

  function renderFeed(list) {
    if (!feedEl || !Array.isArray(list)) return;
    while (feedEl.firstChild) feedEl.removeChild(feedEl.firstChild);
    list.forEach(function (e) {
      var li = document.createElement('li');
      var av = document.createElement('span'); av.className = 'avatar'; av.textContent = e.initials || '';
      var nm = document.createElement('bdi'); nm.className = 'kiosk-feed-name'; nm.textContent = e.name || '';
      var act = document.createElement('span'); act.className = 'kiosk-feed-act'; act.textContent = labels[e.action] || '';
      var tm = document.createElement('bdi'); tm.className = 'kiosk-feed-time'; tm.setAttribute('dir', 'ltr'); tm.textContent = e.time || '';
      li.appendChild(av); li.appendChild(nm); li.appendChild(act); li.appendChild(tm);
      feedEl.appendChild(li);
    });
    if (feedEmpty) feedEmpty.hidden = list.length > 0;
  }

  function schedule(ms) { clearTimeout(timer); if (!stopped) timer = setTimeout(load, ms); }

  function load() {
    qrBox.classList.add('is-changing');
    fetch(kiosk.getAttribute('data-kiosk-src'), { headers: { accept: 'application/json' }, cache: 'no-store', credentials: 'same-origin' })
      .then(function (r) {
        if (r.status === 404) { var err = new Error('gone'); err.gone = true; throw err; }
        if (!r.ok) throw new Error('status ' + r.status);
        return r.json();
      })
      .then(function (j) {
        qrBox.innerHTML = j.data.svg;
        step = Number(j.data.step) || step;
        deadline = Date.now() + j.data.expiresIn * 1000;
        offline.hidden = true;
        qrBox.classList.remove('is-changing');
        renderFeed(j.data.feed);
        paint();
        schedule(j.data.expiresIn * 1000 + 250);
      })
      .catch(function (err) {
        qrBox.classList.remove('is-changing');
        if (err && err.gone) {
          // The screen link was replaced or switched off: stop showing a code that no longer works.
          stopped = true; qrBox.classList.add('is-gone'); if (gone) gone.hidden = false; offline.hidden = true;
          return;
        }
        offline.hidden = false;
        schedule(4000);
      });
  }

  setInterval(paint, 1000);
  paint();
  schedule(Math.max(0, deadline - Date.now()) + 250);
  // Coming back to a sleeping tablet: fetch a fresh code at once.
  document.addEventListener('visibilitychange', function () { if (!document.hidden && !stopped) load(); });

  // Keep the screen awake where the browser allows it.
  function wake() { if (navigator.wakeLock && navigator.wakeLock.request) navigator.wakeLock.request('screen').catch(function () {}); }
  wake();
  document.addEventListener('visibilitychange', function () { if (!document.hidden) wake(); });

  // Full screen: the button, and the first touch anywhere on the screen (browsers need a tap to allow it).
  var root = document.documentElement;
  if (fsBtn && root.requestFullscreen) {
    fsBtn.hidden = false;
    fsBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (document.fullscreenElement) document.exitFullscreen(); else root.requestFullscreen().catch(function () {});
    });
    var first = function (e) {
      if (e.target && e.target.closest && e.target.closest('a, button')) return;
      document.removeEventListener('pointerdown', first);
      if (!document.fullscreenElement) root.requestFullscreen().catch(function () {});
    };
    document.addEventListener('pointerdown', first);
    document.addEventListener('fullscreenchange', function () { document.body.classList.toggle('is-fullscreen', Boolean(document.fullscreenElement)); });
  }
})();

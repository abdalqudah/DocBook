/* Staff attendance: the attendance screen (kiosk) fetches a new QR code every 10 seconds without reloading. */
(function () {
  'use strict';
  var kiosk = document.querySelector('[data-kiosk-src]');
  if (!kiosk) return;
  var qrBox = kiosk.querySelector('[data-kiosk-qr]');
  var leftEl = kiosk.querySelector('[data-kiosk-left]');
  var bar = kiosk.querySelector('[data-kiosk-bar]');
  var clockEl = kiosk.querySelector('[data-kiosk-clock]');
  var offline = kiosk.querySelector('[data-kiosk-offline]');
  var fsBtn = kiosk.querySelector('[data-kiosk-fullscreen]');
  var step = Number(kiosk.getAttribute('data-step')) || 10;
  var deadline = Date.now() + (Number(kiosk.getAttribute('data-expires')) || step) * 1000;
  var timer = null;
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  var tzFmt = null;
  try { tzFmt = new Intl.DateTimeFormat('en-GB', { timeZone: kiosk.getAttribute('data-tz') || undefined, hour: '2-digit', minute: '2-digit', hour12: false }); } catch (e) { tzFmt = null; }
  // The clinic's time (its time zone), whatever the tablet is set to.
  function clinicTime() {
    if (tzFmt) return tzFmt.format(new Date());
    var d = new Date(); return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function paint() {
    var left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    if (leftEl) leftEl.textContent = String(left);
    if (bar) bar.style.width = Math.max(0, Math.min(100, (left / step) * 100)) + '%';
    if (clockEl) clockEl.textContent = clinicTime();
  }

  function schedule(ms) { clearTimeout(timer); timer = setTimeout(load, ms); }

  function load() {
    qrBox.classList.add('is-changing');
    fetch(kiosk.getAttribute('data-kiosk-src'), { headers: { accept: 'application/json' }, cache: 'no-store', credentials: 'same-origin' })
      .then(function (r) { if (!r.ok) throw new Error('status ' + r.status); return r.json(); })
      .then(function (j) {
        qrBox.innerHTML = j.data.svg;
        step = Number(j.data.step) || step;
        deadline = Date.now() + j.data.expiresIn * 1000;
        offline.hidden = true;
        qrBox.classList.remove('is-changing');
        paint();
        schedule(j.data.expiresIn * 1000 + 250);
      })
      .catch(function () {
        offline.hidden = false;
        qrBox.classList.remove('is-changing');
        schedule(4000);
      });
  }

  setInterval(paint, 1000);
  paint();
  schedule(Math.max(0, deadline - Date.now()) + 250);
  // Coming back to a sleeping tablet: fetch a fresh code at once.
  document.addEventListener('visibilitychange', function () { if (!document.hidden) load(); });

  // Keep the screen awake where the browser allows it.
  function wake() { if (navigator.wakeLock && navigator.wakeLock.request) navigator.wakeLock.request('screen').catch(function () {}); }
  wake();
  document.addEventListener('visibilitychange', function () { if (!document.hidden) wake(); });

  if (fsBtn && document.documentElement.requestFullscreen) {
    fsBtn.hidden = false;
    fsBtn.addEventListener('click', function () {
      if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(function () {});
    });
  }
})();

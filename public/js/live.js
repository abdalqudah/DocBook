/* Live agenda (worker: live) — loaded on every /app page.
   Pages that show the schedule (appointments calendar/list: [data-live], front desk: [data-auto-refresh],
   doctor's day: [data-autorefresh]) open one EventSource to /app/live/events. When the clinic's agenda changes for
   the dates/doctor on screen, the page refreshes itself — never while a dialog/menu is open, while the user is
   typing, or in the middle of a drag — and shows a small "Schedule updated" note. A doctor's day also gets a
   notice when one of their patients checks in or is sent in. Without EventSource (or when it keeps failing), the
   existing timed refresh stays in charge (appointments.js / records.js; the calendar gets a gentle 60 s fallback). */
(function () {
  'use strict';
  var live = window.DocBookLive = { connected: false, fallback: false };
  var root = document.querySelector('[data-live]') || document.querySelector('[data-auto-refresh]') || document.querySelector('[data-autorefresh]');
  var STORE = 'db-live:' + location.pathname + location.search;
  var html = document.documentElement;
  var assetV = html.getAttribute('data-v') || '';

  function ss(fn) { try { return fn(window.sessionStorage); } catch (e) { return null; } }

  /* ---------- toasts ---------- */
  function toast(msg, opts) {
    opts = opts || {};
    var box = document.querySelector('.toasts');
    if (!box) { box = document.createElement('div'); box.className = 'toasts'; box.setAttribute('role', 'status'); box.setAttribute('aria-live', 'polite'); document.body.appendChild(box); }
    var el = document.createElement('div');
    el.className = 'toast info lv-toast' + (opts.notice ? ' lv-notice' : '');
    el.innerHTML = '<svg class="icon" aria-hidden="true"><use href="/icons.svg?v=' + assetV + '#i-' + (opts.icon || 'refresh-cw') + '"></use></svg><div class="grow"></div>'
      + '<button class="btn btn-ghost btn-icon btn-sm" type="button" aria-label="' + (opts.close || '×') + '"><svg class="icon icon-sm" aria-hidden="true"><use href="/icons.svg?v=' + assetV + '#i-x"></use></svg></button>';
    el.querySelector('.grow').textContent = msg;
    el.querySelector('button').addEventListener('click', function () { el.remove(); });
    box.appendChild(el);
    setTimeout(function () { el.style.transition = 'opacity .3s'; el.style.opacity = '0'; setTimeout(function () { el.remove(); }, 320); }, opts.notice ? 9000 : 3500);
  }

  // Notes saved just before a live refresh are shown again on the fresh page.
  var pending = ss(function (s) { var v = s.getItem('db-live-toasts'); s.removeItem('db-live-toasts'); return v; });
  if (pending) {
    try { JSON.parse(pending).forEach(function (t) { if (Date.now() - t.at < 15000) toast(t.msg, t.opts); }); } catch (e) { /* ignore */ }
  }
  function keepToast(msg, opts) {
    ss(function (s) { var list = []; try { list = JSON.parse(s.getItem('db-live-toasts') || '[]'); } catch (e) { list = []; } list.push({ msg: msg, opts: opts, at: Date.now() }); s.setItem('db-live-toasts', JSON.stringify(list.slice(-4))); });
  }

  // Scroll position (page + calendar grid) survives a live refresh.
  var saved = ss(function (s) { var v = s.getItem(STORE); s.removeItem(STORE); return v; });
  if (saved) {
    window.addEventListener('load', function () {
      try {
        var p = JSON.parse(saved);
        if (Date.now() - p.at > 20000) return;
        window.scrollTo(0, p.y || 0);
        var sc = document.querySelector('[data-cal-scroll]');
        if (sc) { sc.scrollTop = p.st || 0; sc.scrollLeft = p.sl || 0; }
        var sw = document.querySelector('[data-cal-switch]');
        if (sw && p.sw !== undefined && sw.value !== String(p.sw)) { sw.value = String(p.sw); sw.dispatchEvent(new Event('change', { bubbles: true })); }
      } catch (e) { /* ignore */ }
    });
  }

  if (!root) return;
  var kind = root.getAttribute('data-live') || (root.hasAttribute('data-auto-refresh') ? 'frontdesk' : 'myday');
  var from = root.getAttribute('data-live-from');
  var to = root.getAttribute('data-live-to');
  var doctor = Number(root.getAttribute('data-live-doctor')) || 0;
  var texts = {};
  var today = null;

  /* ---------- when is it safe to refresh? ---------- */
  var lastInput = 0; var pointerDown = false;
  document.addEventListener('input', function () { lastInput = Date.now(); }, true);
  document.addEventListener('keydown', function () { lastInput = Date.now(); }, true);
  document.addEventListener('pointerdown', function () { pointerDown = true; }, true);
  document.addEventListener('pointerup', function () { pointerDown = false; }, true);
  document.addEventListener('pointercancel', function () { pointerDown = false; }, true);
  function busy() {
    if (document.visibilityState !== 'visible') return true;
    if (document.querySelector('dialog[open], details.dropdown[open], .cmdk.open, .cal-pop, .cal.is-dragging')) return true;
    var a = document.activeElement;
    if (a && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName) && Date.now() - lastInput < 15000) return true;
    if (Date.now() - lastInput < 5000 || pointerDown) return true;
    if (document.querySelector('form.is-submitting, .loading-bar.active')) return true;
    return false;
  }

  var want = false; var timer = null; var lastRefresh = 0; var noticed = false;
  function refresh() {
    timer = null;
    if (!want) return;
    if (busy() || Date.now() - lastRefresh < 4000) { timer = setTimeout(refresh, 2000); return; }
    want = false; lastRefresh = Date.now();
    var sc = document.querySelector('[data-cal-scroll]'); var sw = document.querySelector('[data-cal-switch]');
    ss(function (s) { s.setItem(STORE, JSON.stringify({ at: Date.now(), y: window.scrollY, st: sc ? sc.scrollTop : 0, sl: sc ? sc.scrollLeft : 0, sw: sw ? sw.value : undefined })); });
    if (texts.updated && !noticed) keepToast(texts.updated, { close: texts.close }); // a patient notice already says what changed
    noticed = false;
    var url = location.pathname + location.search.replace(/([?&])(paid|new)=[^&]*&?/g, '$1').replace(/[?&]$/, '');
    location.replace(url + location.hash);
  }
  function schedule() { want = true; if (!timer) timer = setTimeout(refresh, 300); }
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && want && !timer) timer = setTimeout(refresh, 500); });

  function relevant(ev) {
    var dates = ev.dates || (ev.date ? [ev.date] : []);
    var lo = from || ev.today || today; var hi = to || ev.today || today;
    if (lo && hi && !dates.some(function (d) { return d >= lo && d <= hi; })) return false;
    if (doctor && ev.doctorIds && ev.doctorIds.indexOf(doctor) < 0) return false;
    return true;
  }
  function fill(tpl, a) { return String(tpl || '').replace('{name}', a.name || '').replace('{time}', a.time || ''); }

  /* ---------- indicator ---------- */
  var dot = null;
  function indicator(on) {
    var h1 = root.querySelector('h1') || document.querySelector('.page-head h1');
    if (!h1) return;
    if (!dot) {
      dot = document.createElement('span'); dot.className = 'lv-live'; dot.setAttribute('role', 'img');
      // styled inline: this runs on pages that do not load live.css (front desk, my day)
      dot.style.cssText = 'display:inline-block;width:7px;height:7px;border-radius:50%;margin-inline-start:10px;vertical-align:middle;transition:background .3s';
      h1.appendChild(dot);
    }
    dot.classList.toggle('on', on);
    dot.style.background = on ? 'var(--success)' : 'var(--border-strong)';
    dot.setAttribute('title', on ? (texts.live_on || '') : (texts.live_off || ''));
    dot.setAttribute('aria-label', on ? (texts.live_on || '') : (texts.live_off || ''));
  }

  /* ---------- fallback polling (calendar/list only: the other pages keep their own timers) ---------- */
  var fallbackTimer = null;
  function startFallback() {
    live.connected = false; live.fallback = true;
    if (kind !== 'appointments' || fallbackTimer) return;
    fallbackTimer = setInterval(function () { want = true; if (!timer) refresh(); }, 60000);
  }

  if (!window.EventSource) { startFallback(); return; }

  var es = null; var failures = 0; var retryTimer = null;
  function connect() {
    es = new EventSource('/app/live/events');
    es.addEventListener('hello', function (e) {
      failures = 0;
      try { var h = JSON.parse(e.data); texts = h.texts || texts; today = h.today || today; } catch (x) { /* ignore */ }
      live.connected = true; live.fallback = false;
      if (fallbackTimer) { clearInterval(fallbackTimer); fallbackTimer = null; }
      indicator(true);
    });
    es.addEventListener('appointments', function (e) {
      var ev; try { ev = JSON.parse(e.data); } catch (x) { return; }
      if (ev.today) today = ev.today;
      if (kind === 'myday' && ev.arrivals && ev.arrivals.length) {
        ev.arrivals.forEach(function (a) {
          var msg = fill(a.kind === 'with_doctor' ? texts.with_doctor : texts.checked_in, a);
          var opts = { notice: true, icon: a.kind === 'with_doctor' ? 'stethoscope' : 'armchair', close: texts.close };
          toast(msg, opts); keepToast(msg, opts);
          noticed = true;
        });
      }
      if (relevant(ev)) schedule();
    });
    es.onerror = function () {
      live.connected = false;
      indicator(false);
      failures += 1;
      // The browser retries by itself; after repeated failures (or a refusal) fall back to timed refreshes
      // and try the live channel again later.
      if (es.readyState === 2 || failures >= 4) {
        es.close();
        startFallback();
        if (!retryTimer) retryTimer = setTimeout(function () { retryTimer = null; failures = 0; connect(); }, 120000);
      }
    };
  }
  connect();
  window.addEventListener('pagehide', function () { if (es) es.close(); });
  window.addEventListener('pageshow', function (e) { if (e.persisted && es && es.readyState === 2) connect(); });
}());

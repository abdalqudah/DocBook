/* Clinic website (builder sites): the hero slider and the entrance motion of sections. Everything is shown without
   JavaScript; visitors who ask for reduced motion get no autoplay and no animation. */
(function () {
  'use strict';
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------------------------------------------------------------- slider
  Array.prototype.forEach.call(document.querySelectorAll('[data-ws-slider]'), function (box) {
    var slides = box.querySelectorAll('.ws-slide');
    var dots = box.querySelectorAll('[data-ws-dot]');
    if (slides.length < 2) return;
    var i = 0; var timer = null;
    var wait = (Number(box.getAttribute('data-interval')) || 5) * 1000;
    var bar = box.querySelector('[data-ws-progress]');
    // The progress bar fills over each slide's time (restarted on every change).
    function progress() { if (!bar || reduce) return; bar.style.transition = 'none'; bar.style.width = '0'; void bar.offsetWidth; bar.style.transition = 'width ' + wait + 'ms linear'; bar.style.width = '100%'; }
    function show(n) {
      var was = i;
      i = (n + slides.length) % slides.length;
      Array.prototype.forEach.call(slides, function (s, k) { s.classList.toggle('is-on', k === i); s.classList.toggle('is-leaving', k === was && was !== i); if (k === i) s.removeAttribute('aria-hidden'); else s.setAttribute('aria-hidden', 'true'); });
      progress();
      Array.prototype.forEach.call(dots, function (d, k) { d.classList.toggle('is-on', k === i); d.setAttribute('aria-current', k === i ? 'true' : 'false'); });
    }
    function play() { if (reduce) return; stop(); progress(); timer = setInterval(function () { show(i + 1); }, wait); }
    function stop() { if (timer) clearInterval(timer); timer = null; }
    var rtl = document.documentElement.dir === 'rtl';
    var prev = box.querySelector('[data-ws-prev]'); var next = box.querySelector('[data-ws-next]');
    if (prev) prev.addEventListener('click', function () { show(i - 1); play(); });
    if (next) next.addEventListener('click', function () { show(i + 1); play(); });
    Array.prototype.forEach.call(dots, function (d) { d.addEventListener('click', function () { show(Number(d.getAttribute('data-ws-dot'))); play(); }); });
    if (!box.hasAttribute('data-no-pause')) { box.addEventListener('mouseenter', function () { stop(); if (bar) { bar.style.transition = 'none'; } }); box.addEventListener('mouseleave', play); }
    box.addEventListener('focusin', stop); box.addEventListener('focusout', play);
    box.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowLeft') { show(i + (rtl ? 1 : -1)); play(); }
      if (e.key === 'ArrowRight') { show(i + (rtl ? -1 : 1)); play(); }
    });
    var x0 = null;
    box.addEventListener('touchstart', function (e) { x0 = e.touches[0].clientX; }, { passive: true });
    box.addEventListener('touchend', function (e) {
      if (x0 === null) return;
      var dx = e.changedTouches[0].clientX - x0; x0 = null;
      if (Math.abs(dx) > 40) { show(i + ((dx < 0) !== rtl ? 1 : -1)); play(); }
    }, { passive: true });
    document.addEventListener('visibilitychange', function () { if (document.hidden) stop(); else play(); });
    play();
  });

  // ---------------------------------------------------------------- entrance motion
  var page = document.querySelector('[data-ws-motion]');
  if (!page || reduce || !('IntersectionObserver' in window)) return;
  var items = Array.prototype.slice.call(page.querySelectorAll('.ws-anim'));
  // Only what is still below the fold waits for its entrance: nothing visible disappears after loading.
  var below = items.filter(function (el) { return el.getBoundingClientRect().top > window.innerHeight * 0.92; });
  below.forEach(function (el) { el.classList.add('is-waiting'); });
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (en) {
      if (!en.isIntersecting) return;
      en.target.classList.add('is-in');
      en.target.classList.remove('is-waiting');
      io.unobserve(en.target);
    });
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
  below.forEach(function (el) { io.observe(el); });
}());

/* Carousel sections (settings "carousel"): the section's list of items (cards, doctors, reviews, logos…) becomes
   one sliding row. data-dir: auto = the page language (Arabic: items travel right, English: left), left, right.
   data-auto: s3/s4/s6 seconds between slides or off. Arrows move left / right on screen. Pauses on hover, focus
   and touch; no autoplay for visitors who ask for reduced motion. Without JavaScript the items stay a grid. */
(function () {
  'use strict';
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var TRACKS = '.ws-cards, .portal-doctors, .ws-features, .ws-columns, .ws-images, .ws-gallery, .ws-stats, .ws-steps, .svc-list, .rv-list, .ws-partners, .ws-team, .ws-ba-list, .ws-tm-cards, .ws-tm-bubbles';
  Array.prototype.forEach.call(document.querySelectorAll('[data-ws-carousel]'), function (block) {
    var tracks = block.querySelectorAll(TRACKS);
    var isRtl = (getComputedStyle(block).direction || document.documentElement.dir) === 'rtl';
    var dir = block.getAttribute('data-dir') || 'auto';
    if (dir === 'auto') dir = isRtl ? 'right' : 'left';
    var secs = { s3: 3, s4: 4, s6: 6 }[block.getAttribute('data-auto')] || 0;
    Array.prototype.forEach.call(tracks, function (track) {
      if (track.children.length < 2) return;
      track.classList.add('ws-track');
      var wrap = document.createElement('div');
      wrap.className = 'ws-car';
      track.parentNode.insertBefore(wrap, track);
      wrap.appendChild(track);
      // Position from the left edge, 0 … max, whatever the page direction (Chrome/Firefox: RTL scrollLeft ≤ 0).
      function max() { return Math.max(0, track.scrollWidth - track.clientWidth); }
      function leftPos() { var x = track.scrollLeft; return isRtl && x <= 0 ? max() + x : x; }
      function goLeftPos(p, smooth) { track.scrollTo({ left: isRtl ? p - max() : p, behavior: smooth ? 'smooth' : 'auto' }); }
      function step() { var c = track.children[0]; var gap = parseFloat(getComputedStyle(track).columnGap || getComputedStyle(track).gap) || 0; return c ? c.getBoundingClientRect().width + gap : track.clientWidth; }
      // way: +1 = the items travel left (we look further right), -1 = they travel right.
      function move(way) {
        var p = leftPos(); var m = max();
        if (m <= 2) return;
        if (way > 0 && p >= m - 2) return goLeftPos(0, true);
        if (way < 0 && p <= 2) return goLeftPos(m, true);
        goLeftPos(Math.min(m, Math.max(0, p + way * step())), true);
      }
      var nav = null;
      if (block.getAttribute('data-arrows') !== '0') {
        nav = document.createElement('div');
        nav.className = 'ws-car-nav';
        [['left', -1, 'chevron-left'], ['right', 1, 'chevron-right']].forEach(function (b) {
          var btn = document.createElement('button');
          btn.type = 'button'; btn.className = 'ws-car-btn ws-car-' + b[0];
          btn.setAttribute('aria-label', block.getAttribute('data-' + b[0]) || b[0]);
          btn.innerHTML = '<svg class="icon icon-sm" aria-hidden="true"><use href="/icons.svg#i-' + b[2] + '"></use></svg>';
          btn.addEventListener('click', function () { move(b[1]); restart(); });
          nav.appendChild(btn);
        });
        wrap.appendChild(nav);
      }
      var timer = null; var hold = false;
      function stop() { if (timer) clearInterval(timer); timer = null; }
      function restart() { stop(); if (!secs || reduce) return; timer = setInterval(function () { if (!hold && !document.hidden) move(dir === 'left' ? 1 : -1); }, secs * 1000); }
      ['mouseenter', 'focusin', 'touchstart'].forEach(function (e) { wrap.addEventListener(e, function () { hold = true; }, { passive: true }); });
      ['mouseleave', 'focusout', 'touchend'].forEach(function (e) { wrap.addEventListener(e, function () { hold = false; }, { passive: true }); });
      // Nothing to slide (all the items fit): no arrows, no autoplay — checked again when the window changes size.
      function fit() { var none = max() <= 2; if (nav) nav.hidden = none; if (none) stop(); else if (!timer) restart(); }
      // Start at the beginning of the row in the page's reading direction.
      goLeftPos(isRtl ? max() : 0, false);
      restart();
      fit();
      window.addEventListener('resize', fit);
    });
  });
}());

/* Before / after (data-ws-ba): the "after" picture under the "before" one; a range input (keyboard and screen
   readers) and dragging anywhere on the picture move the line. Vertical: the line moves up and down. */
(function () {
  'use strict';
  Array.prototype.forEach.call(document.querySelectorAll('[data-ws-ba]'), function (box) {
    var range = box.querySelector('.ws-ba-range');
    var vertical = box.classList.contains('is-vertical');
    function set(p) { p = Math.max(0, Math.min(100, p)); box.style.setProperty('--ba', p + '%'); if (range) range.value = String(Math.round(p)); }
    if (range) range.addEventListener('input', function () { set(Number(range.value)); });
    var dragging = false;
    function at(e) {
      var r = box.getBoundingClientRect();
      var pt = e.touches ? e.touches[0] : e;
      set(vertical ? ((pt.clientY - r.top) / r.height) * 100 : ((pt.clientX - r.left) / r.width) * 100);
    }
    box.addEventListener('pointerdown', function (e) { dragging = true; box.setPointerCapture && box.setPointerCapture(e.pointerId); at(e); box.classList.add('is-dragging'); });
    box.addEventListener('pointermove', function (e) { if (dragging) at(e); });
    ['pointerup', 'pointercancel'].forEach(function (k) { box.addEventListener(k, function () { dragging = false; box.classList.remove('is-dragging'); }); });
  });

  /* Tabs (data-ws-tabs): click or arrow keys choose a tab; the others hide. Without JS every panel shows. */
  Array.prototype.forEach.call(document.querySelectorAll('[data-ws-tabs]'), function (box) {
    var tabs = Array.prototype.slice.call(box.querySelectorAll('[role="tab"]'));
    var panels = Array.prototype.slice.call(box.querySelectorAll('[role="tabpanel"]'));
    function pick(n, focus) {
      tabs.forEach(function (t, k) { var on = k === n; t.classList.toggle('is-on', on); t.setAttribute('aria-selected', on ? 'true' : 'false'); t.tabIndex = on ? 0 : -1; if (on && focus) t.focus(); });
      panels.forEach(function (p, k) { p.hidden = k !== n; if (k === n) { p.classList.remove('is-shown'); void p.offsetWidth; p.classList.add('is-shown'); } });
    }
    tabs.forEach(function (t, k) {
      t.addEventListener('click', function () { pick(k); });
      t.addEventListener('keydown', function (e) {
        var rtl = (getComputedStyle(box).direction || 'ltr') === 'rtl';
        var next = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1, ArrowDown: 1, ArrowUp: -1 }[e.key];
        if (next) { e.preventDefault(); pick((k + next + tabs.length) % tabs.length, true); }
        if (e.key === 'Home') { e.preventDefault(); pick(0, true); }
        if (e.key === 'End') { e.preventDefault(); pick(tabs.length - 1, true); }
      });
    });
  });

  /* One quote at a time (data-ws-rotate): changes every 6 s, dots to choose; pauses on hover / focus. */
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  Array.prototype.forEach.call(document.querySelectorAll('[data-ws-rotate]'), function (list) {
    var items = list.children; var dots = list.parentNode.querySelectorAll('[data-ws-rotate-dots] button');
    var i = 0; var hold = false;
    function show(n) {
      i = (n + items.length) % items.length;
      Array.prototype.forEach.call(items, function (x, k) { x.classList.toggle('is-on', k === i); });
      Array.prototype.forEach.call(dots, function (d, k) { d.classList.toggle('is-on', k === i); d.setAttribute('aria-current', k === i ? 'true' : 'false'); });
    }
    Array.prototype.forEach.call(dots, function (d) { d.addEventListener('click', function () { show(Number(d.getAttribute('data-i'))); }); });
    ['mouseenter', 'focusin'].forEach(function (e) { list.addEventListener(e, function () { hold = true; }); });
    ['mouseleave', 'focusout'].forEach(function (e) { list.addEventListener(e, function () { hold = false; }); });
    if (!reduce) setInterval(function () { if (!hold && !document.hidden) show(i + 1); }, 6000);
  });
}());

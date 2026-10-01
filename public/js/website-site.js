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
    function show(n) {
      i = (n + slides.length) % slides.length;
      Array.prototype.forEach.call(slides, function (s, k) { s.classList.toggle('is-on', k === i); if (k === i) s.removeAttribute('aria-hidden'); else s.setAttribute('aria-hidden', 'true'); });
      Array.prototype.forEach.call(dots, function (d, k) { d.classList.toggle('is-on', k === i); d.setAttribute('aria-current', k === i ? 'true' : 'false'); });
    }
    function play() { if (reduce) return; stop(); timer = setInterval(function () { show(i + 1); }, wait); }
    function stop() { if (timer) clearInterval(timer); timer = null; }
    var rtl = document.documentElement.dir === 'rtl';
    var prev = box.querySelector('[data-ws-prev]'); var next = box.querySelector('[data-ws-next]');
    if (prev) prev.addEventListener('click', function () { show(i - 1); play(); });
    if (next) next.addEventListener('click', function () { show(i + 1); play(); });
    Array.prototype.forEach.call(dots, function (d) { d.addEventListener('click', function () { show(Number(d.getAttribute('data-ws-dot'))); play(); }); });
    box.addEventListener('mouseenter', stop); box.addEventListener('mouseleave', play);
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

// Admin → Activity: the page refreshes itself every 30 seconds while it is on screen (the counts and who is online).
(function () {
  var el = document.querySelector('[data-activity-live]');
  if (!el) return;
  var every = (Number(el.getAttribute('data-every')) || 30) * 1000;
  setInterval(function () { if (!document.hidden) window.location.reload(); }, every);
  document.addEventListener('visibilitychange', function () { if (!document.hidden && Date.now() - performance.timing.navigationStart > every) window.location.reload(); });
}());

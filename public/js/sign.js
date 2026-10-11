// A signature drawn with the finger, a pen or the mouse on the quotation's link: kept as a PNG in a hidden field.
(function () {
  var pad = document.querySelector('[data-sign-pad]');
  if (!pad) return;
  var form = pad.closest('form');
  var out = form.querySelector('[data-sign-value]');
  var ctx = pad.getContext('2d');
  var drawing = false; var drawn = false;
  ctx.lineWidth = 2.5; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || 'black';
  function pos(e) { var r = pad.getBoundingClientRect(); return { x: (e.clientX - r.left) * (pad.width / r.width), y: (e.clientY - r.top) * (pad.height / r.height) }; }
  pad.addEventListener('pointerdown', function (e) { drawing = true; pad.setPointerCapture(e.pointerId); var p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); });
  pad.addEventListener('pointermove', function (e) { if (!drawing) return; var p = pos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); drawn = true; });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(function (ev) { pad.addEventListener(ev, function () { drawing = false; }); });
  var clear = form.querySelector('[data-sign-clear]');
  if (clear) clear.addEventListener('click', function () { ctx.clearRect(0, 0, pad.width, pad.height); drawn = false; out.value = ''; });
  form.addEventListener('submit', function () { out.value = drawn ? pad.toDataURL('image/png') : ''; });
}());

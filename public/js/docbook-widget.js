/*
 * DocBook booking widget — served at /widget.js and loaded by a clinic's own website:
 *   <script src="https://<docbook-site>/widget.js" data-clinic="<clinic-address>" async></script>
 * Shows a floating "Book an appointment" button that opens the clinic's booking page in an overlay <iframe>.
 * Options (data-*): data-lang="ar|en", data-label="…", data-position="left|right", data-color="#hex" (button colour),
 * data-button="none" (no floating button: open it from your own elements with the data-docbook-book attribute).
 * Bookings made here are counted as "Website booking button" in the clinic's reports.
 */
(function () {
  'use strict';
  var script = document.currentScript || (function () {
    var all = document.getElementsByTagName('script');
    for (var i = all.length - 1; i >= 0; i -= 1) if (/\/widget\.js(\?|#|$)/.test(all[i].src)) return all[i];
    return null;
  }());
  if (!script || window.DocBookWidget) return;
  var slug = String(script.getAttribute('data-clinic') || '').toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(slug)) return;

  var a = document.createElement('a');
  a.href = script.src;
  var origin = a.protocol + '//' + a.host;
  var pageLang = String(document.documentElement.getAttribute('lang') || '').slice(0, 2).toLowerCase();
  var lang = script.getAttribute('data-lang') === 'en' || script.getAttribute('data-lang') === 'ar' ? script.getAttribute('data-lang') : (pageLang === 'en' ? 'en' : 'ar');
  var rtl = lang === 'ar';
  var text = {
    ar: { label: 'احجز موعدًا', close: 'إغلاق', title: 'حجز موعد' },
    en: { label: 'Book an appointment', close: 'Close', title: 'Book an appointment' }
  }[lang];
  var label = script.getAttribute('data-label') || text.label;
  var color = /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(script.getAttribute('data-color') || '') ? script.getAttribute('data-color') : '__DB_PRIMARY__';
  var ink = '__DB_PRIMARY_INK__';
  var side = script.getAttribute('data-position') === 'left' || script.getAttribute('data-position') === 'right' ? script.getAttribute('data-position') : (rtl ? 'left' : 'right');
  var url = origin + '/' + slug + '/book?embed=1&src=widget&lang=' + lang;

  var CAL = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/><path d="M10 16h4"/><path d="M12 14v4"/></svg>';
  var X = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
  var FONT = "system-ui,-apple-system,'Segoe UI',Roboto,'Noto Sans Arabic',Tahoma,Arial,sans-serif";

  function css(el, styles) { for (var k in styles) if (Object.prototype.hasOwnProperty.call(styles, k)) el.style.setProperty(k, styles[k], 'important'); }

  var overlay = null; var lastFocus = null; var prevOverflow = '';

  function close() {
    if (!overlay) return;
    overlay.parentNode.removeChild(overlay);
    overlay = null;
    document.documentElement.style.overflow = prevOverflow;
    document.removeEventListener('keydown', onKey, true);
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  function onKey(e) { if (e.key === 'Escape' || e.keyCode === 27) { e.preventDefault(); close(); } }

  function open() {
    if (overlay) return;
    lastFocus = document.activeElement;
    var phone = window.innerWidth < 600;
    overlay = document.createElement('div');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', text.title);
    css(overlay, { position: 'fixed', inset: '0', 'z-index': '2147483001', background: 'rgba(10,10,10,.45)', display: 'flex', 'align-items': 'center', 'justify-content': 'center', padding: phone ? '0' : '16px', margin: '0' });
    var panel = document.createElement('div');
    css(panel, { position: 'relative', width: '100%', 'max-width': phone ? '100%' : '560px', height: phone ? '100%' : 'min(820px, calc(100vh - 32px))', background: '#fff', 'border-radius': phone ? '0' : '14px', overflow: 'hidden', 'box-shadow': '0 20px 60px rgba(0,0,0,.25)' });
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('aria-label', text.close);
    btn.innerHTML = X;
    css(btn, { position: 'absolute', top: '8px', 'z-index': '2', width: '36px', height: '36px', 'border-radius': '50%', border: '0', background: 'rgba(255,255,255,.92)', color: '#161616', display: 'flex', 'align-items': 'center', 'justify-content': 'center', cursor: 'pointer', 'box-shadow': '0 1px 4px rgba(0,0,0,.2)', padding: '0' });
    btn.style.setProperty(rtl ? 'left' : 'right', '8px', 'important');
    btn.addEventListener('click', close);
    var frame = document.createElement('iframe');
    frame.src = url;
    frame.title = text.title;
    frame.setAttribute('allow', 'clipboard-write');
    css(frame, { width: '100%', height: '100%', border: '0', display: 'block', background: '#fff' });
    panel.appendChild(frame);
    panel.appendChild(btn);
    overlay.appendChild(panel);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    document.body.appendChild(overlay);
    prevOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    document.addEventListener('keydown', onKey, true);
    btn.focus();
  }

  window.addEventListener('message', function (e) {
    if (e.origin === origin && e.data === 'docbook:close') close();
  });

  function mount() {
    if (script.getAttribute('data-button') !== 'none') {
      var b = document.createElement('button');
      b.type = 'button';
      b.innerHTML = CAL + '<span></span>';
      b.lastChild.textContent = label;
      b.setAttribute('dir', rtl ? 'rtl' : 'ltr');
      css(b, { position: 'fixed', bottom: '20px', 'z-index': '2147483000', display: 'inline-flex', 'align-items': 'center', gap: '8px', padding: '12px 18px', 'border-radius': '999px', border: '0', background: color, color: ink, font: '600 15px/1.2 ' + FONT, cursor: 'pointer', 'box-shadow': '0 6px 20px rgba(0,0,0,.2)', margin: '0', 'letter-spacing': '0', 'text-transform': 'none' });
      b.style.setProperty(side, '20px', 'important');
      b.addEventListener('click', open);
      document.body.appendChild(b);
    }
    document.addEventListener('click', function (e) {
      var el = e.target && e.target.closest ? e.target.closest('[data-docbook-book]') : null;
      if (el) { e.preventDefault(); open(); }
    });
  }

  window.DocBookWidget = { open: open, close: close };
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
}());

/* Measurement pixels for DocBook's public marketing pages (Admin → Social & tracking).
   The server only adds <meta name="db-pixels"> and this file on the landing and cookie-preferences pages, and
   only after the visitor accepted on the cookie notice — never on clinic pages, booking, sign-in, /app or /admin.
   The vendors' usual snippets are inline scripts, which the site's security policy blocks, so they are rewritten here. */
(function () {
  'use strict';
  var tag = document.querySelector('meta[name="db-pixels"]');
  if (!tag) return;
  var cfg;
  try { cfg = JSON.parse(tag.getAttribute('content') || '{}'); } catch (e) { return; }
  var ids = (cfg && cfg.ids) || {};
  var w = window;
  var ok = {
    ga4: /^G-[A-Z0-9]{6,12}$/, gtm: /^GTM-[A-Z0-9]{5,10}$/, meta: /^\d{10,20}$/, tiktok: /^[A-Z0-9]{15,25}$/,
    snap: /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/, linkedin: /^\d{5,10}$/, x: /^[a-z0-9]{5,10}$/
  };
  Object.keys(ids).forEach(function (k) { if (!ok[k] || !ok[k].test(String(ids[k]))) delete ids[k]; });

  function load(src) {
    var s = document.createElement('script');
    s.async = true;
    s.src = src;
    document.head.appendChild(s);
  }

  // Google Analytics 4 and Google Tag Manager
  if (ids.ga4 || ids.gtm) {
    w.dataLayer = w.dataLayer || [];
    w.gtag = w.gtag || function () { w.dataLayer.push(arguments); };
  }
  if (ids.ga4) {
    load('https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(ids.ga4));
    w.gtag('js', new Date());
    w.gtag('config', ids.ga4, { anonymize_ip: true });
  }
  if (ids.gtm) {
    w.dataLayer.push({ 'gtm.start': new Date().getTime(), event: 'gtm.js' });
    load('https://www.googletagmanager.com/gtm.js?id=' + encodeURIComponent(ids.gtm));
  }

  // Meta (Facebook / Instagram)
  if (ids.meta && !w.fbq) {
    var fbq = w.fbq = function () { if (fbq.callMethod) fbq.callMethod.apply(fbq, arguments); else fbq.queue.push(arguments); };
    if (!w._fbq) w._fbq = fbq;
    fbq.push = fbq; fbq.loaded = true; fbq.version = '2.0'; fbq.queue = [];
    load('https://connect.facebook.net/en_US/fbevents.js');
    fbq('init', ids.meta);
    fbq('track', 'PageView');
  }

  // TikTok
  if (ids.tiktok && !w.ttq) {
    var ttq = w.ttq = [];
    ttq.methods = ['page', 'track', 'identify', 'instances', 'debug', 'on', 'off', 'once', 'ready', 'alias', 'group', 'enableCookie', 'disableCookie'];
    ttq.setAndDefer = function (t, e) { t[e] = function () { t.push([e].concat(Array.prototype.slice.call(arguments, 0))); }; };
    for (var i = 0; i < ttq.methods.length; i++) ttq.setAndDefer(ttq, ttq.methods[i]);
    ttq._i = {}; ttq._i[ids.tiktok] = []; ttq._t = {}; ttq._t[ids.tiktok] = +new Date(); ttq._o = {}; ttq._o[ids.tiktok] = {};
    load('https://analytics.tiktok.com/i18n/pixel/events.js?sdkid=' + encodeURIComponent(ids.tiktok) + '&lib=ttq');
    ttq.page();
  }

  // Snapchat
  if (ids.snap && !w.snaptr) {
    var snaptr = w.snaptr = function () { if (snaptr.handleRequest) snaptr.handleRequest.apply(snaptr, arguments); else snaptr.queue.push(arguments); };
    snaptr.queue = [];
    load('https://sc-static.net/scevent.min.js');
    snaptr('init', ids.snap, {});
    snaptr('track', 'PAGE_VIEW');
  }

  // LinkedIn Insight Tag
  if (ids.linkedin) {
    w._linkedin_partner_id = ids.linkedin;
    w._linkedin_data_partner_ids = w._linkedin_data_partner_ids || [];
    w._linkedin_data_partner_ids.push(ids.linkedin);
    if (!w.lintrk) { w.lintrk = function (a, b) { w.lintrk.q.push([a, b]); }; w.lintrk.q = []; }
    load('https://snap.licdn.com/li.lms-analytics/insight.min.js');
  }

  // X (Twitter)
  if (ids.x && !w.twq) {
    var twq = w.twq = function () { if (twq.exe) twq.exe.apply(twq, arguments); else twq.queue.push(arguments); };
    twq.version = '1.1'; twq.queue = [];
    load('https://static.ads-twitter.com/uwt.js');
    twq('config', ids.x);
  }
})();

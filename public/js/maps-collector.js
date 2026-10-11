/* Google Maps collector (CRM → Find clinics). It runs in the admin's own browser on google.com/maps, from a bookmark
   or pasted in the console: for each line the admin types it searches Maps, goes through the results one by one, reads
   each place's name, phone, website, address, category and rating, and saves them in a CSV file to upload in the CRM.
   Nothing is sent anywhere by this script; it only reads the page the admin has open and builds the file.
   No line comments here: the code is also used as a bookmarklet (one line). */
(function () {
  'use strict';
  if (!/(^|\.)google\.[a-z.]+$/.test(location.hostname) || location.pathname.indexOf('/maps') !== 0) {
    alert('Open Google Maps (google.com/maps) first, then click again.\nافتح خرائط جوجل (google.com/maps) أولاً ثم اضغط مرة ثانية.');
    return;
  }
  if (window.__mwCollector) { window.__mwCollector.panel.style.display = 'block'; return; }

  var AR = /^ar/i.test(document.documentElement.lang || navigator.language || '');
  var T = AR ? {
    title: 'جمع العيادات من خرائط جوجل', queries: 'ما تبحث عنه (سطر لكل بحث):', ph: 'عيادة أسنان عمّان\nمركز جلدية إربد',
    max: 'أقصى عدد لكل بحث:', start: 'ابدأ', stop: 'إيقاف', save: 'حفظ الملف', close: 'إخفاء', ready: 'جاهز.',
    searching: 'أبحث: ', reading: 'أقرأ ', of: ' من ', done: 'انتهى. احفظ الملف وارفعه في البحث عن العيادات.', stopped: 'توقف.',
    found: 'عدد الأماكن: ', none: 'لم تظهر نتائج لهذا البحث.', captcha: 'إذا ظهر لك تحقق من جوجل، أكمله ثم اضغط ابدأ مرة ثانية.'
  } : {
    title: 'Collect clinics from Google Maps', queries: 'What to search (one search per line):', ph: 'dental clinic Amman\ndermatology center Irbid',
    max: 'At most per search:', start: 'Start', stop: 'Stop', save: 'Save file', close: 'Hide', ready: 'Ready.',
    searching: 'Searching: ', reading: 'Reading ', of: ' of ', done: 'Done. Save the file and upload it in Find clinics.', stopped: 'Stopped.',
    found: 'Places: ', none: 'No results for this search.', captcha: 'If Google asks you to verify, finish it and press Start again.'
  };

  var rows = [];
  var seen = {};
  var running = false;
  var stopAsked = false;
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var pause = function (a, b) { return sleep(a + Math.random() * (b - a)); };
  var digits = function (s) { return String(s || '').replace(/[٠-٩]/g, function (d) { return String(d.charCodeAt(0) - 1632); }).replace(/[۰-۹]/g, function (d) { return String(d.charCodeAt(0) - 1776); }); };
  var clean = function (s) { return String(s || '').replace(/[‎‏‪-‮⁦-⁩]/g, '').replace(/\s+/g, ' ').trim(); };

  function el(tag, props, kids) {
    var e = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) { if (k === 'style') e.style.cssText = props[k]; else if (k === 'text') e.textContent = props[k]; else e.setAttribute(k, props[k]); });
    (kids || []).forEach(function (c) { e.appendChild(c); });
    return e;
  }
  var btnCss = 'border:0;border-radius:999px;padding:8px 14px;font:600 13px system-ui,sans-serif;cursor:pointer;';
  var status = el('div', { style: 'font:13px system-ui,sans-serif;color:rgb(60,72,90);margin-top:8px;min-height:18px', text: T.ready });
  var count = el('div', { style: 'font:600 13px system-ui,sans-serif;color:rgb(10,27,54);margin-top:4px', text: T.found + '0' });
  var area = el('textarea', { rows: '4', placeholder: T.ph, style: 'width:100%;box-sizing:border-box;margin-top:6px;padding:8px;border:1px solid rgb(200,210,225);border-radius:8px;font:13px system-ui,sans-serif;resize:vertical' });
  var max = el('input', { type: 'number', min: '1', max: '200', value: '60', style: 'width:70px;margin-inline-start:6px;padding:4px 6px;border:1px solid rgb(200,210,225);border-radius:6px' });
  var startB = el('button', { type: 'button', style: btnCss + 'background:rgb(14,139,255);color:white', text: T.start });
  var stopB = el('button', { type: 'button', style: btnCss + 'background:rgb(230,236,245);color:rgb(10,27,54)', text: T.stop });
  var saveB = el('button', { type: 'button', style: btnCss + 'background:rgb(10,27,54);color:white', text: T.save });
  var hideB = el('button', { type: 'button', style: btnCss + 'background:transparent;color:rgb(90,107,134)', text: T.close });
  var panel = el('div', { dir: AR ? 'rtl' : 'ltr', style: 'position:fixed;z-index:2147483647;bottom:24px;' + (AR ? 'right' : 'left') + ':24px;width:330px;background:white;border-radius:16px;box-shadow:0 12px 40px rgba(6,20,46,.28);padding:16px;font-family:system-ui,sans-serif;color:rgb(10,27,54)' }, [
    el('div', { style: 'font:700 15px system-ui,sans-serif', text: T.title }),
    el('div', { style: 'font:13px system-ui,sans-serif;margin-top:10px', text: T.queries }), area,
    el('label', { style: 'display:block;font:13px system-ui,sans-serif;margin-top:8px' }, [document.createTextNode(T.max), max]),
    el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;margin-top:10px' }, [startB, stopB, saveB, hideB]),
    status, count,
    el('div', { style: 'font:12px system-ui,sans-serif;color:rgb(118,118,118);margin-top:6px', text: T.captcha })
  ]);
  document.body.appendChild(panel);
  window.__mwCollector = { panel: panel, rows: rows };
  var say = function (s) { status.textContent = s; };
  var tally = function () { count.textContent = T.found + rows.length; };

  function waitFor(fn, ms) {
    var until = Date.now() + (ms || 8000);
    return new Promise(function (resolve) {
      (function tick() {
        var v = null;
        try { v = fn(); } catch (e) { v = null; }
        if (v || Date.now() > until) { resolve(v || null); return; }
        setTimeout(tick, 200);
      }());
    });
  }
  var feed = function () { return document.querySelector('div[role="feed"]'); };
  var links = function () { var f = feed(); return f ? Array.prototype.slice.call(f.querySelectorAll('a.hfpxzc, a[href*="/maps/place/"]')) : []; };
  var heading = function () { var hs = document.querySelectorAll('h1.DUwDvf, h1'); for (var i = hs.length - 1; i >= 0; i -= 1) { if (clean(hs[i].textContent)) return hs[i]; } return null; };

  async function search(q) {
    var input = document.querySelector('#searchboxinput, input[name="q"]');
    if (!input) return false;
    var before = links().map(function (a) { return a.href; }).join('|');
    var oldFeed = feed();
    var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    input.focus();
    setter.call(input, q);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    var go = document.querySelector('#searchbox-searchbutton, button[aria-label="Search"], button[aria-label="بحث"]');
    if (go) go.click(); else input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    await sleep(1500);
    var changed = await waitFor(function () { var now = links().map(function (a) { return a.href; }).join('|'); return (now && (now !== before || feed() !== oldFeed)) || (!feed() && heading()) ? true : null; }, 12000);
    return changed || links().length > 0 || Boolean(heading());
  }

  function placeId(href) {
    var m = String(href || '').match(/!19s(ChIJ[\w-]+)/) || String(href || '').match(/!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i);
    return m ? decodeURIComponent(m[1]) : '';
  }
  function read(q, link, want) {
    var h = heading();
    if (link && want && (!h || clean(h.textContent) !== want)) {
      return { name: want, phone: '', website: '', email: '', address: '', category: '', rating: '', reviews: '', maps_url: link.href.split('?')[0], place_id: placeId(link.href), query: q };
    }
    var scope = (h && (h.closest('div[role="main"]') || h.parentElement && h.parentElement.parentElement)) || document;
    var pick = function (sel) { return scope.querySelector(sel) || null; };
    var phoneEl = pick('[data-item-id^="phone:tel:"]');
    var addrEl = pick('[data-item-id="address"]');
    var webEl = pick('a[data-item-id="authority"]');
    var catEl = pick('button[jsaction*="category"]');
    var rateEl = pick('div.F7nice span[aria-hidden="true"]');
    var revEl = pick('div.F7nice span[aria-label]');
    var href = link ? link.href : location.href;
    var addr = addrEl ? clean(addrEl.getAttribute('aria-label') || addrEl.textContent) : '';
    return {
      name: clean(h ? h.textContent : (link && link.getAttribute('aria-label'))),
      phone: phoneEl ? clean(phoneEl.getAttribute('data-item-id').replace('phone:tel:', '')) : '',
      website: webEl ? webEl.href : '', email: '',
      address: addr.indexOf(':') > -1 && addr.indexOf(':') < 20 ? clean(addr.slice(addr.indexOf(':') + 1)) : addr,
      category: catEl ? clean(catEl.textContent) : '',
      rating: rateEl ? digits(rateEl.textContent).replace(/[٫,]/, '.').replace(/[^\d.]/g, '') : '',
      reviews: revEl ? digits(revEl.getAttribute('aria-label')).replace(/\D/g, '') : '',
      maps_url: href.split('?')[0], place_id: placeId(href), query: q
    };
  }
  function keep(r) {
    if (!r.name) return;
    var k = r.place_id || (r.name + '|' + r.address);
    if (seen[k]) return;
    seen[k] = true;
    rows.push(r);
    tally();
  }

  async function collect(q, limit) {
    say(T.searching + q);
    var ok = await search(q);
    if (!ok) { say(T.none); return; }
    if (!feed()) { keep(read(q, null)); return; }
    var done = {};
    var idle = 0;
    var taken = 0;
    while (!stopAsked && taken < limit && idle < 3) {
      var list = links().filter(function (a) { return !done[a.href]; });
      if (!list.length) {
        var f = feed();
        if (f) f.scrollTop = f.scrollHeight;
        await pause(1800, 2600);
        idle += 1;
        if (f && /(reached the end|نهاية القائمة)/i.test(f.textContent)) break;
        continue;
      }
      idle = 0;
      for (var i = 0; i < list.length && !stopAsked && taken < limit; i += 1) {
        var a = list[i];
        done[a.href] = true;
        var want = clean(a.getAttribute('aria-label'));
        say(T.reading + (taken + 1) + T.of + limit + ': ' + want);
        a.scrollIntoView({ block: 'center' });
        a.click();
        await waitFor(function () { var h = heading(); return h && clean(h.textContent) === want ? h : null; }, 6000);
        await pause(600, 1200);
        keep(read(q, a, want));
        taken += 1;
        await pause(700, 1500);
      }
    }
  }

  function csv() {
    var cols = ['name', 'phone', 'website', 'email', 'address', 'category', 'rating', 'reviews', 'maps_url', 'place_id', 'query'];
    var esc = function (v) { v = String(v === undefined || v === null ? '' : v); return /[",\n\r;]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    return '﻿' + [cols.join(',')].concat(rows.map(function (r) { return cols.map(function (c) { return esc(r[c]); }).join(','); })).join('\r\n');
  }
  function save() {
    if (!rows.length) return;
    var url = URL.createObjectURL(new Blob([csv()], { type: 'text/csv;charset=utf-8' }));
    var a = el('a', { href: url, download: 'google-maps-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.csv' });
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 2000);
  }

  startB.addEventListener('click', async function () {
    if (running) return;
    var queries = area.value.split(/\r?\n/).map(clean).filter(Boolean);
    if (!queries.length) { area.focus(); return; }
    var limit = Math.max(1, Math.min(200, parseInt(max.value, 10) || 60));
    running = true; stopAsked = false;
    for (var i = 0; i < queries.length && !stopAsked; i += 1) {
      try { await collect(queries[i], limit); } catch (e) { say(String(e && e.message || e)); }
    }
    running = false;
    say(stopAsked ? T.stopped : T.done);
    if (!stopAsked) save();
  });
  stopB.addEventListener('click', function () { stopAsked = true; });
  saveB.addEventListener('click', save);
  hideB.addEventListener('click', function () { panel.style.display = 'none'; });
}());

/*
 * Clinica — download the remaining attachments, in the clinic's own signed-in Clinica tab.
 *
 * How to use (the clinic's owner, on the computer where Clinica is open and signed in):
 *   1. Open https://dentalbh.clinicame.net and sign in as usual.
 *   2. Press F12 → Console, paste this whole file, press Enter. A panel opens at the top of the page.
 *   3. Choose the patients file (clinica-patients-*.json or clinica-patients-clean.json) and the previous
 *      attachments manifest (clinica-attachments-manifest-*.json, the 1,360 already downloaded), then press Start.
 *
 * What it does — only with the session already open in this tab (same-origin requests; it never signs in, never
 * changes anything in Clinica, only reads pages and files):
 *   • Discovery: for every patient of the file, reads the patient's pages (/dental/<id> and /edit_patient/<id>) and
 *     collects every attachment link (/system/files/…) — the real list from Clinica, not the old one.
 *   • Skips the files already downloaded (same address in the previous manifest, or downloaded by an earlier run of
 *     this script: kept in this browser, so a stopped run carries on).
 *   • Downloads the others in small groups with retries, and saves them to the Downloads folder as
 *     clinica-attachments-extra-NN-of-MM.zip: a folder per patient_id with the original file names and a
 *     manifest.json in the same shape as before — DocBook's Import Center takes them as they are.
 *   • Saves clinica-attachments-discovered.csv (Patient ID, Patient Number, Patient Name, Original Filename, Full
 *     Attachment URL, Status) and shows the real counts at the end.
 * Nothing is sent anywhere else.
 */
(() => {
  'use strict';
  const ORIGIN = location.origin;
  const PAGE_DELAY = 250; // ms between page reads
  const FILE_DELAY = 300; // ms between file downloads
  const RETRIES = 3;
  const ZIP_FILES = 100; // files per ZIP
  const ZIP_BYTES = 150 * 1024 * 1024; // or this many bytes, whichever first
  const STORE = 'clinica-extra-fetch-v1';

  // ------------------------------------------------------------------ panel
  const box = document.createElement('div');
  box.setAttribute('dir', 'auto');
  box.style.cssText = 'position:fixed;inset:12px 12px auto 12px;z-index:2147483647;background:white;color:black;border:2px solid black;border-radius:8px;padding:12px;font:14px system-ui,sans-serif;max-height:80vh;overflow:auto;box-shadow:0 8px 30px rgba(0,0,0,.3)';
  box.innerHTML = `
    <b>Clinica — remaining attachments</b>
    <div style="margin:8px 0">Patients file (JSON): <input type="file" accept=".json" data-pf></div>
    <div style="margin:8px 0">Previous manifest (1,360 files): <input type="file" accept=".json" data-mf></div>
    <button data-go style="padding:6px 14px">Start</button> <button data-stop style="padding:6px 14px">Stop</button> <button data-close style="padding:6px 14px">Close</button>
    <pre data-log style="white-space:pre-wrap;margin:10px 0 0;font:12px ui-monospace,monospace"></pre>`;
  document.body.appendChild(box);
  const $ = (s) => box.querySelector(s);
  const logEl = $('[data-log]');
  const log = (...a) => { logEl.textContent = `${a.join(' ')}\n${logEl.textContent}`.slice(0, 20000); console.log('[clinica-fetch]', ...a); };
  let stop = false;
  $('[data-stop]').onclick = () => { stop = true; log('Stopping after the current file…'); };
  $('[data-close]').onclick = () => box.remove();

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const readJson = (input) => new Promise((resolve, reject) => {
    const f = input.files && input.files[0];
    if (!f) return resolve(null);
    const r = new FileReader();
    r.onload = () => { try { resolve(JSON.parse(String(r.result).replace(/^﻿/, ''))); } catch (e) { reject(e); } };
    r.onerror = reject; r.readAsText(f);
    return undefined;
  });
  const saved = (() => { try { return JSON.parse(localStorage.getItem(STORE) || '{}'); } catch { return {}; } })();
  saved.done = saved.done || {}; // url → zip name
  const keep = () => { try { localStorage.setItem(STORE, JSON.stringify(saved)); } catch { /* full: the run still works */ } };

  // ------------------------------------------------------------------ links
  const norm = (u) => { try { const x = new URL(u, ORIGIN); return x.origin === ORIGIN ? decodeURI(x.pathname) : null; } catch { return null; } };
  const FILE_RE = /\/system\/files\/[^"'<>\s)]+/g;
  function linksIn(html) {
    const out = new Map(); // path → { url, label }
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('a[href],img[src],[data-href],[data-url],iframe[src],embed[src],object[data]').forEach((el) => {
      const raw = el.getAttribute('href') || el.getAttribute('src') || el.getAttribute('data-href') || el.getAttribute('data-url') || el.getAttribute('data');
      if (!raw || !raw.includes('/system/files/')) return;
      const p = norm(raw);
      if (p && !out.has(p)) out.set(p, { url: new URL(raw, ORIGIN).href, label: (el.textContent || '').trim() });
    });
    (html.match(FILE_RE) || []).forEach((raw) => { const p = norm(raw.replace(/&amp;/g, '&')); if (p && !out.has(p)) out.set(p, { url: ORIGIN + encodeURI(p), label: '' }); });
    return out;
  }
  const fileNameOf = (path) => { const s = path.split('/').pop() || 'file'; try { return decodeURIComponent(s); } catch { return s; } };

  async function get(url, type) {
    for (let i = 1; i <= RETRIES; i += 1) {
      try {
        const r = await fetch(url, { credentials: 'same-origin', redirect: 'follow' });
        if (r.status === 401 || r.status === 403 || /\/(user\/)?login/.test(new URL(r.url).pathname)) throw Object.assign(new Error('Signed out of Clinica — sign in again, then press Start (it carries on).'), { fatal: true });
        if (r.status === 404) return { missing: true };
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return { body: type === 'text' ? await r.text() : await r.blob(), type: r.headers.get('content-type') || '' };
      } catch (e) {
        if (e.fatal || i === RETRIES) throw e;
        await sleep(1000 * 2 ** i);
      }
    }
    return null;
  }

  // ------------------------------------------------------------------ zip (stored, UTF-8 names)
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = (u8) => { let c = 0xffffffff; for (let i = 0; i < u8.length; i += 1) c = CRC[(c ^ u8[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  function zip(entries) { // [{ name, data: Uint8Array }]
    const enc = new TextEncoder(); const parts = []; const central = []; let off = 0;
    const d = new Date(); const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1); const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    entries.forEach(({ name, data }) => {
      const n = enc.encode(name); const crc = crc32(data);
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true); h.setUint16(10, time, true); h.setUint16(12, date, true);
      h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, n.length, true); h.setUint16(28, 0, true);
      parts.push(h.buffer, n, data);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true); c.setUint16(12, time, true); c.setUint16(14, date, true);
      c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, n.length, true); c.setUint32(42, off, true);
      central.push(c.buffer, n);
      off += 30 + n.length + data.length;
    });
    const size = central.reduce((s, b) => s + (b.byteLength !== undefined ? b.byteLength : b.length), 0);
    const e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, entries.length, true); e.setUint16(10, entries.length, true); e.setUint32(12, size, true); e.setUint32(16, off, true);
    return new Blob([...parts, ...central, e.buffer], { type: 'application/zip' });
  }
  function save(blob, name) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }
  const csvCell = (v) => `"${String(v === null || v === undefined ? '' : v).replace(/"/g, '""')}"`;

  // ------------------------------------------------------------------ run
  $('[data-go]').onclick = async () => {
    stop = false;
    try {
      const data = await readJson($('[data-pf]'));
      if (!data) { log('Choose the patients file first.'); return; }
      const patients = (Array.isArray(data) ? data : data.patients || []).filter((p) => p && p.patient_id);
      const prev = await readJson($('[data-mf]'));
      const prevList = Array.isArray(prev) ? prev : (prev && (prev.files || prev.attachments)) || [];
      const had = new Set(prevList.map((m) => norm(m.url || m.source_url || '')).filter(Boolean));
      patients.forEach((p) => (p.attachments || []).forEach((a) => { const x = norm(a.url || ''); if (x && prevList.length === 0) had.add(x); }));
      log(`Patients: ${patients.length} · previously downloaded (manifest): ${had.size}`);

      // 1. Discovery (kept in this browser: a stopped run carries on)
      saved.found = saved.found || {}; // path → { url, pid, number, name, file }
      saved.scanned = saved.scanned || {};
      let i = 0;
      for (const p of patients) {
        i += 1;
        if (stop) { keep(); log('Stopped.'); return; }
        if (saved.scanned[p.patient_id]) continue;
        const pages = [`${ORIGIN}/dental/${encodeURIComponent(p.patient_id)}`, `${ORIGIN}/edit_patient/${encodeURIComponent(p.patient_id)}`];
        for (const u of pages) {
          const r = await get(u, 'text');
          if (r && r.body) linksIn(r.body).forEach((v, path) => {
            if (!saved.found[path]) saved.found[path] = { url: v.url, pid: String(p.patient_id), number: p.patient_number || '', name: p.name || p.patient_name || '', file: fileNameOf(path) };
          });
          await sleep(PAGE_DELAY);
        }
        saved.scanned[p.patient_id] = 1;
        if (i % 25 === 0) { keep(); log(`Read ${i}/${patients.length} patients · attachments found so far: ${Object.keys(saved.found).length}`); }
      }
      keep();
      const all = Object.entries(saved.found);
      const todo = all.filter(([path]) => !had.has(path) && !saved.done[path]);
      log(`Discovery done. Unique attachments in Clinica: ${all.length} · already downloaded: ${all.length - todo.length} · to download: ${todo.length}`);

      // 2. Download in small groups, a ZIP per group
      const total = Math.max(1, Math.ceil(todo.length / ZIP_FILES));
      const failed = []; let got = 0; let batch = 0; let entries = []; let manifest = []; let bytes = 0;
      const used = new Set();
      const flush = () => {
        if (!entries.length) return;
        batch += 1;
        const name = `clinica-attachments-extra-${String(batch).padStart(2, '0')}-of-${String(total).padStart(2, '0')}.zip`;
        const m = { generated_at: new Date().toISOString(), batch, total_batches: total, files_in_batch: manifest.length, downloaded: manifest.length, failed: 0, files: manifest };
        entries.push({ name: 'manifest.json', data: new TextEncoder().encode(JSON.stringify(m, null, 2)) });
        save(zip(entries), name);
        manifest.forEach((f) => { saved.done[f.__path] = name; delete f.__path; });
        keep(); log(`Saved ${name} (${manifest.length} files)`);
        entries = []; manifest = []; bytes = 0;
      };
      for (const [path, f] of todo) {
        if (stop) { flush(); log('Stopped — press Start to carry on.'); break; }
        try {
          const r = await get(f.url, 'blob');
          if (!r || r.missing) { failed.push({ ...f, why: 'not found (404)' }); continue; }
          const data = new Uint8Array(await r.body.arrayBuffer());
          let fname = f.file.replace(/[\\/:*?"<>|]+/g, '_') || 'file';
          let zp = `${f.pid}/${fname}`; let k = 2;
          while (used.has(zp)) { fname = fname.replace(/(\.[^.]*)?$/, ` (${k})$1`); zp = `${f.pid}/${fname}`; k += 1; }
          used.add(zp);
          entries.push({ name: zp, data });
          manifest.push({ patient_id: f.pid, patient_number: f.number, patient_name: f.name, original_filename: f.file, saved_filename: fname, zip_path: zp, source_url: f.url, content_type: r.type, size: data.length, status: 'downloaded', downloaded_at: new Date().toISOString(), __path: path });
          bytes += data.length; got += 1;
          if (manifest.length >= ZIP_FILES || bytes >= ZIP_BYTES) flush();
          if (got % 20 === 0) log(`Downloaded ${got}/${todo.length}`);
        } catch (e) {
          if (e.fatal) { flush(); log(e.message); return; }
          failed.push({ ...f, why: e.message });
        }
        await sleep(FILE_DELAY);
      }
      flush();

      // 3. The list and the real counts
      const failedSet = new Set(failed.map((f) => f.url));
      const rows = [['Patient ID', 'Patient Number', 'Patient Name', 'Original Filename', 'Full Attachment URL', 'Status'].map(csvCell).join(',')];
      all.forEach(([path, f]) => rows.push([f.pid, f.number, f.name, f.file, f.url, had.has(path) ? 'previously downloaded' : saved.done[path] ? `downloaded (${saved.done[path]})` : failedSet.has(f.url) ? 'failed' : 'remaining'].map(csvCell).join(',')));
      save(new Blob([`﻿${rows.join('\r\n')}\r\n`], { type: 'text/csv' }), 'clinica-attachments-discovered.csv');
      const newly = all.filter(([path]) => !had.has(path) && saved.done[path]).length;
      const remaining = all.filter(([path, f]) => !had.has(path) && !saved.done[path] && !failedSet.has(f.url)).length;
      log(`\nPreviously downloaded: ${had.size}\nTotal unique attachments discovered in Clinica: ${all.length}\nNewly downloaded: ${newly}\nFailed: ${failed.length}\nRemaining: ${remaining}${remaining === 0 && failed.length === 0 && !stop ? '\n\nDOWNLOAD FINISHED' : ''}`);
      if (failed.length) failed.slice(0, 50).forEach((f) => log(`  failed: ${f.pid} ${f.file} — ${f.why}`));
    } catch (e) { keep(); log(`Error: ${e.message}`); }
  };
  log('Ready. Choose the two files, then press Start.');
})();

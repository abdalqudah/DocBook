// Text from the old system that carries links ("كميل وائل عمارين.pdf https://…/files/…pdf", one per line, sometimes
// with "* " in front) → HTML where each link shows its NAME, and opens the file imported here (authorised download)
// when its address is known (patient_attachments.source_url), else the old address in a new tab. Everything else
// stays escaped text.
const URL_RE = /(https?:\/\/[^\s<>"']+)/i;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nameOf = (url) => { try { return decodeURIComponent(new URL(url).pathname.split('/').pop() || '') || url; } catch { return url; } };

/**
 * @param {string} text  the value
 * @param {(url: string) => string|null} local  the address of the imported copy of a link here (or null)
 * @returns {string} safe HTML
 */
function linkify(text, local = () => null) {
  if (text === null || text === undefined) return '';
  const s = String(text);
  if (!URL_RE.test(s)) return esc(s);
  return s.split(/\r?\n/).map((ln) => {
    const m = /^\s*(?:[*•\-–]\s*)?(.*?)\s*(https?:\/\/[^\s<>"']+)\s*$/i.exec(ln);
    if (!m) return esc(ln).replace(new RegExp(URL_RE.source, 'gi'), (u) => `<a class="link" href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(nameOf(u))}</a>`);
    const url = m[2]; const name = m[1] || nameOf(url);
    const here = local(url);
    return here
      ? `<a class="link" href="${esc(here)}" target="_blank" rel="noopener">${esc(name)}</a>`
      : `<a class="link" href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="${esc(url)}">${esc(name)}</a>`;
  }).join('<br>');
}

/** The local-address finder for one patient's imported files. */
function localFinder(patientId, attachments) {
  const by = new Map();
  (attachments || []).forEach((a) => { if (a.source_url) by.set(a.source_url, `/api/patients/${patientId}/attachments/${a.id}/download${a.inline ? '?inline=1' : ''}`); });
  return (url) => by.get(url) || by.get(encodeURI(decodeURI(url))) || null;
}

module.exports = { linkify, localFinder, nameOf };

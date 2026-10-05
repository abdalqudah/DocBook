// Minimal, safe Markdown for content written by staff (descriptions, articles): everything is escaped first, then
// a small set of formatting is applied. No raw HTML, links only to http(s), mailto, tel or site paths.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function inline(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*(?!\s)(.+?)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(((?:https?:\/\/|mailto:|tel:|\/)[^\s)]+)\)/g, (m, label, url) => `<a href="${url}"${/^https?:/.test(url) ? ' rel="noopener" target="_blank"' : ''}>${label}</a>`);
}

function markdown(src) {
  if (!src) return '';
  const lines = esc(String(src).replace(/\r\n/g, '\n')).split('\n');
  const out = [];
  let list = null;
  let para = [];
  const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`<${list.type}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.type}>`); list = null; } };
  for (const raw of lines) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) { flushPara(); flushList(); continue; } // eslint-disable-line no-continue
    if ((m = /^(#{2,4})\s+(.*)$/.exec(line))) { flushPara(); flushList(); const lvl = m[1].length; out.push(`<h${lvl}>${inline(m[2])}</h${lvl}>`); continue; } // eslint-disable-line no-continue
    if ((m = /^\s*[-*•]\s+(.*)$/.exec(line))) { flushPara(); if (!list || list.type !== 'ul') { flushList(); list = { type: 'ul', items: [] }; } list.items.push(m[1]); continue; } // eslint-disable-line no-continue
    if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) { flushPara(); if (!list || list.type !== 'ol') { flushList(); list = { type: 'ol', items: [] }; } list.items.push(m[1]); continue; } // eslint-disable-line no-continue
    if ((m = /^&gt;\s?(.*)$/.exec(line))) { flushPara(); flushList(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); continue; } // eslint-disable-line no-continue
    flushList();
    para.push(line.trim());
  }
  flushPara(); flushList();
  return out.join('\n');
}

/** Plain text excerpt (for meta descriptions and cards). */
const excerpt = (src, n = 180) => { const t = String(src || '').replace(/[#*>`_[\]()-]/g, ' ').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

module.exports = { markdown, excerpt, esc };

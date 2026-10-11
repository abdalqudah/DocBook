// Word templates (.docx): find the {placeholders} written in the document and fill them for one customer. Pictures,
// icons, links, tables and styles in the file are kept as they are — only the text of the placeholders changes.
// Word often splits typed text into several runs ("{comp" + "any_name}"), so a paragraph holding a placeholder is
// joined before replacing and keeps the formatting of its first run; other paragraphs are left untouched.
const AdmZip = require('adm-zip');

const PART = /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/;
const PLACEHOLDER = /\{([\p{L}\p{N}_]{1,40})\}/gu;
const MAX_PART = 30 * 1024 * 1024; // unpacked XML part (guards against zip bombs)
const MAX_ENTRIES = 2000;
const xmlEscape = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const xmlUnescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const T_RE = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:t(?:\s[^>]*)?\/>/g;
const P_RE = /<w:p[ >][\s\S]*?<\/w:p>/g;

function open(buffer) {
  let zip;
  try { zip = new AdmZip(buffer); } catch { return null; }
  const entries = zip.getEntries();
  if (entries.length > MAX_ENTRIES || !zip.getEntry('word/document.xml')) return null;
  if (entries.some((e) => PART.test(e.entryName) && Number(e.header.size) > MAX_PART)) return null;
  return zip;
}
const parts = (zip) => zip.getEntries().filter((e) => PART.test(e.entryName));
const paragraphText = (p) => [...p.matchAll(T_RE)].map((m) => xmlUnescape(m[1] || '')).join('');

/** The placeholder names used in a .docx (null when it is not a Word document). */
function placeholders(buffer) {
  const zip = open(buffer);
  if (!zip) return null;
  const names = new Set();
  parts(zip).forEach((e) => {
    (e.getData().toString('utf8').match(P_RE) || []).forEach((p) => { for (const m of paragraphText(p).matchAll(PLACEHOLDER)) names.add(m[1]); }); // eslint-disable-line no-restricted-syntax
  });
  return [...names];
}

function fillParagraph(p, values) {
  const text = paragraphText(p);
  if (!new RegExp(PLACEHOLDER.source, 'u').test(text)) return p;
  const filled = text.replace(PLACEHOLDER, (m, k) => (values[k] !== undefined ? String(values[k]) : m));
  let first = true;
  return p.replace(T_RE, () => {
    if (!first) return '<w:t xml:space="preserve"></w:t>';
    first = false;
    return `<w:t xml:space="preserve">${xmlEscape(filled)}</w:t>`;
  });
}

/** A copy of the .docx with the placeholders replaced by `values` (unknown ones are left as typed). */
function fill(buffer, values) {
  const zip = open(buffer);
  if (!zip) throw new Error('Not a Word document');
  parts(zip).forEach((e) => {
    const xml = e.getData().toString('utf8');
    const out = xml.replace(P_RE, (p) => fillParagraph(p, values));
    if (out !== xml) zip.updateFile(e.entryName, Buffer.from(out, 'utf8'));
  });
  return zip.toBuffer();
}

/** The document's plain text, paragraph by paragraph (a preview on the page). */
function text(buffer) {
  const zip = open(buffer);
  if (!zip) return '';
  const e = zip.getEntry('word/document.xml');
  return (e.getData().toString('utf8').match(P_RE) || []).map(paragraphText).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

module.exports = { placeholders, fill, text, PLACEHOLDER };

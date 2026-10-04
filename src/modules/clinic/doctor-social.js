// A doctor's social-media profiles (shown as icons on the doctor's card and page of the clinic website).
// Each address must be https on the network's own site; "website" may be any https address. A bare
// "instagram.com/name" gets https:// in front. Stored as JSON in doctors.social_links: { facebook: 'https://…', … }.
const NETWORKS = {
  facebook: /^(www\.|m\.)?(facebook|fb)\.com$/,
  instagram: /^(www\.)?instagram\.com$/,
  x: /^(www\.)?(x|twitter)\.com$/,
  linkedin: /^([a-z]{2,3}\.)?linkedin\.com$/,
  youtube: /^(www\.|m\.)?youtube\.com$|^youtu\.be$/,
  tiktok: /^(www\.)?tiktok\.com$/,
  snapchat: /^(www\.)?snapchat\.com$/,
  website: /./,
};
const KEYS = Object.keys(NETWORKS);
// The icon of each network (from the site's icon sprite).
const ICONS = { facebook: 'facebook', instagram: 'instagram', x: 'twitter', linkedin: 'linkedin', youtube: 'youtube', tiktok: 'music', snapchat: 'ghost', website: 'globe' };

/** One address, or '' when it is empty; throws { key } when it is not a valid address of that network. */
function cleanOne(key, raw) {
  let v = String(raw === undefined || raw === null ? '' : raw).trim().slice(0, 300);
  if (!v) return '';
  if (!/^[a-z][a-z0-9+.-]*:/i.test(v)) v = `https://${v.replace(/^\/+/, '')}`;
  let u;
  try { u = new URL(v); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || !NETWORKS[key].test(u.hostname.toLowerCase())) return null;
  return u.toString();
}

/** { links, errors } from form fields social_<key>. */
function parse(input = {}) {
  const links = {}; const errors = {};
  for (const k of KEYS) {
    const v = cleanOne(k, input[`social_${k}`]);
    if (v === null) errors[`social_${k}`] = 'Enter the full address of the profile (https://…).';
    else if (v) links[k] = v;
  }
  return { links, errors };
}

/** The stored JSON → { key: url } (only valid entries). */
function read(raw) {
  let o = raw;
  if (typeof raw === 'string') { try { o = JSON.parse(raw || '{}'); } catch { o = {}; } }
  const out = {};
  for (const k of KEYS) { const v = o && cleanOne(k, o[k]); if (v) out[k] = v; }
  return out;
}

/** [{ key, url, icon }] in a fixed order, for the website. */
const list = (raw) => { const m = read(raw); return KEYS.filter((k) => m[k]).map((k) => ({ key: k, url: m[k], icon: ICONS[k] })); };

module.exports = { KEYS, ICONS, parse, read, list, cleanOne };

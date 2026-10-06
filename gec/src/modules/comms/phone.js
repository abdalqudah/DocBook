// Phone numbers for SMS / WhatsApp: E.164 ("+962791234567"). A local number starting with a single 0 gets the
// default country calling code from the channel settings; anything else that is not international is refused.
const digits = (v) => String(v || '').replace(/[^\d+]/g, '');

function toE164(raw, defaultCode = '') {
  let d = digits(raw);
  if (!d) return null;
  if (d.startsWith('+')) d = d.slice(1).replace(/\+/g, '');
  else if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0')) { if (!/^\d{1,4}$/.test(String(defaultCode || ''))) return null; d = `${defaultCode}${d.slice(1)}`; }
  else if (!/^\d{1,4}$/.test(String(defaultCode || '')) && d.length < 11) return null;
  d = d.replace(/\D/g, '');
  return d.length >= 8 && d.length <= 15 ? `+${d}` : null;
}

module.exports = { toE164 };

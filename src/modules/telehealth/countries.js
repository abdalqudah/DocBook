// Countries with their international dialling codes, for the online-consultation booking form
// (patients abroad pick their country of residence and the code of their phone number).
// Names come from Intl.DisplayNames in the visitor's language.
const RAW = `JO:962 SA:966 AE:971 KW:965 QA:974 BH:973 OM:968 IQ:964 LB:961 SY:963 PS:970 YE:967 EG:20 SD:249 LY:218 TN:216 DZ:213 MA:212
MR:222 DJ:253 SO:252 KM:269 TR:90 IR:98 IL:972 CY:357 GR:30 GB:44 IE:353 DE:49 AT:43 CH:41 FR:33 BE:32 NL:31 LU:352 IT:39 ES:34 PT:351
SE:46 NO:47 DK:45 FI:358 IS:354 PL:48 CZ:420 SK:421 HU:36 RO:40 BG:359 RS:381 HR:385 SI:386 BA:387 ME:382 MK:389 AL:355 XK:383 UA:380
MD:373 BY:375 LT:370 LV:371 EE:372 RU:7 GE:995 AM:374 AZ:994 KZ:7 UZ:998 TM:993 KG:996 TJ:992 AF:93 PK:92 IN:91 BD:880 LK:94 NP:977
MV:960 CN:86 HK:852 TW:886 JP:81 KR:82 MY:60 SG:65 ID:62 PH:63 TH:66 VN:84 KH:855 MM:95 BN:673 AU:61 NZ:64 US:1 CA:1 MX:52 BR:55
AR:54 CL:56 CO:57 PE:51 VE:58 EC:593 UY:598 PY:595 BO:591 CU:53 DO:1 PR:1 JM:1 PA:507 CR:506 GT:502 HN:504 SV:503 NI:505 NG:234 GH:233
KE:254 ET:251 ER:291 TZ:255 UG:256 RW:250 ZA:27 ZW:263 ZM:260 MZ:258 AO:244 CM:237 CI:225 SN:221 ML:223 NE:227 TD:235 BF:226 GN:224
CD:243 CG:242 GA:241 MG:261 MU:230 SC:248 NA:264 BW:267 MW:265 SS:211 MT:356 MC:377 LI:423 AD:376 SM:378`;

const LIST = RAW.split(/\s+/).filter(Boolean).map((p) => { const [cc, dial] = p.split(':'); return { cc, dial }; });
const BY_CODE = Object.fromEntries(LIST.map((c) => [c.cc, c]));
const DIALS = [...new Set(LIST.map((c) => c.dial))];

function regionName(code, locale) {
  try { return new Intl.DisplayNames([locale], { type: 'region' }).of(code) || code; } catch { return code; }
}

const cache = {};
/** [{ value: 'DE', label: 'Germany', dial: '49' }] sorted by name in the visitor's language. */
function options(locale) {
  if (!cache[locale]) {
    cache[locale] = LIST.map((c) => ({ value: c.cc, label: regionName(c.cc, locale), dial: c.dial }))
      .sort((a, b) => a.label.localeCompare(b.label, locale));
  }
  return cache[locale];
}

const isCountry = (cc) => Boolean(BY_CODE[String(cc || '').toUpperCase()]);
const dialOf = (cc) => (BY_CODE[String(cc || '').toUpperCase()] || {}).dial || null;
const isDial = (d) => DIALS.includes(String(d || ''));

module.exports = { LIST, options, isCountry, dialOf, isDial, regionName };

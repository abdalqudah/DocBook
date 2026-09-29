// Small helpers shared by the patient pages (/r/<token> and /review/<token>).
const clinicView = (req, b) => {
  const en = req.locale === 'en';
  return { ...b, displayName: (en && b.name_en) || b.name, telHref: b.phone ? `tel:${String(b.phone).replace(/[^0-9+]/g, '')}` : null };
};

const noStore = (res) => res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' });

const notFound = (req, res) => res.status(404).page('pages/error', {
  layout: 'public', title: req.t('messaging.link_invalid_title'), status: 404, message: req.t('messaging.link_invalid_text'), noindex: true, stack: null,
});

/** Error text for an AppError: this area's table first, then the shared one. */
const errText = (req, err) => {
  const k = `errors_engage.${err.code}`;
  const own = req.t(k);
  if (own !== k) return own;
  const shared = req.t(`errors.${err.code}`);
  return shared !== `errors.${err.code}` ? shared : err.message;
};

module.exports = { clinicView, noStore, notFound, errText };

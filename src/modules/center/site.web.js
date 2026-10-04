// A medical centre's website (the centre's administration account): booking goes to the doctor's own clinic.
//   /<centre>/book[?doctor=]         with a doctor: that doctor's clinic booking; else a page to choose the doctor
//   /<centre>/book/online[?doctor=]  the same for online consultations
// The doctor is always looked up among the centre's own clinics (never taken from the address as is).
const portal = require('../site/portal.web');

async function centerBook(req, res, clinic, { online = false } = {}) {
  const suffix = online ? '/online' : '';
  if (req.query.doctor) {
    const found = portal.doctorByRef(await portal.listDoctors(req, clinic, 'booking'), req.query.doctor);
    const p = found ? await portal.centerPracticeOf(clinic, found.id) : null;
    if (p) return res.redirect(302, `/${p.slug}/book${suffix}?doctor=${found.id}`);
  }
  const [practices, doctors] = await Promise.all([portal.centerPractices(clinic), portal.listDoctors(req, clinic, 'booking')]);
  const look = await portal.siteChromeFor(req, res, clinic);
  const L = (p) => (req.locale === 'en' && p.name_en) || p.name;
  const groups = practices.map((p) => ({ name: L(p), slug: p.slug, booking: Boolean(p.booking_enabled), doctors: doctors.filter((d) => d.practiceId === p.id).filter((d) => !online || d.online) }))
    .filter((g) => g.doctors.length);
  return res.page('pages/portal/center-book', {
    layout: 'public', title: req.t(online ? 'telehealth.book_online_cta' : 'booking.title'), pageTitle: `${req.t('booking.title')} · ${clinic.displayName}`,
    clinic, groups, suffix, hideBookCta: true, bodyClass: look.bodyClass, pageStyles: look.styles,
  });
}

module.exports = { centerBook };

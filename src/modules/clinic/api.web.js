// JSON used by the booking forms: free slots and the services a doctor offers.
const express = require('express');
const { wrap } = require('../../routes/helpers');
const { can } = require('../../middleware/context');
const scheduling = require('./scheduling');
const doctors = require('./doctors.service');

const router = express.Router();

router.get('/slots', can('appointments.view'), wrap(async (req, res) => {
  const doctorId = Number(req.query.doctor);
  if (!doctorId || !scheduling.isDate(req.query.date)) return res.json({ data: [] });
  if (req.ctx.ownDoctorId && doctorId !== req.ctx.ownDoctorId) return res.json({ data: [] });
  try {
    const slots = await scheduling.availableSlots({
      businessId: req.ctx.businessId, timezone: req.ctx.timezone, doctorId, date: req.query.date,
      serviceId: req.query.service ? Number(req.query.service) : null, durationOverride: req.query.duration ? Number(req.query.duration) : null,
      excludeAppointmentId: req.query.exclude ? Number(req.query.exclude) : null,
    });
    return res.json({ data: slots });
  } catch (e) {
    return res.json({ data: [], error: req.t(`errors.${e.code}`) !== `errors.${e.code}` ? req.t(`errors.${e.code}`) : e.message });
  }
}));

router.get('/services', can('appointments.view'), wrap(async (req, res) => {
  const rows = await doctors.servicesFor(req.ctx, req.query.doctor ? Number(req.query.doctor) : null);
  res.json({ data: rows.map((s) => ({ id: s.id, name: req.locale === 'en' && s.name_en ? s.name_en : s.name, duration: s.duration_minutes, price: Number(s.price) })) });
}));

module.exports = router;

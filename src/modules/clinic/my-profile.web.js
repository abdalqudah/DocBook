// My profile (/app/my-profile): a doctor's own login edits the doctor's public profile (bio, specialty, education,
// full profile, social media) and the doctor's own services (name, description, price, length or no fixed time,
// category, shown on the website). Only for a login linked to a doctor; never another doctor's profile or services.
const express = require('express');
const { wrap, form, flash } = require('../../routes/helpers');
const svc = require('./doctors.service');
const ops = require('../platformops/ops.service'); // service categories
const media = require('../integrations/media.service');

const router = express.Router();
router.use((req, res, next) => (req.ctx && req.ctx.doctorId ? next() : res.redirect('/app')));

async function render(req, res, extra = {}) {
  const doctor = await svc.doctors.get(req.ctx, req.ctx.doctorId);
  const [services, categories, photos] = await Promise.all([svc.ownServices(req.ctx), ops.listCategories(req.ctx.businessId), media.doctorPhotos(req.ctx.businessId, [doctor.id])]);
  res.page('pages/clinic/my-profile', {
    title: req.t('myprofile.title'), doctor, d: doctor, services, categories: categories.filter((c) => c.is_active), photo: photos[doctor.id] || null,
    profile: require('./doctor-profile').clean(doctor.profile), // eslint-disable-line global-require
    socialKeys: require('./doctor-social').KEYS, socialOf: require('./doctor-social').read, // eslint-disable-line global-require
    specialtyOptions: require('../specialty/catalogue').doctorOptions(req.t), // eslint-disable-line global-require
    ...extra,
  });
}

router.get('/', wrap((req, res) => render(req, res)));
router.post('/', form(async (req, res) => {
  await svc.saveOwnProfile(req.ctx, req.body);
  flash(req, 'success', req.t('myprofile.saved'));
  res.redirect('/app/my-profile');
}, render));

const rerender = (req, res, extra) => render(req, res, { ...extra, openDialog: 'my-service-dialog', formAction: req.originalUrl });
async function saveService(req, id) {
  await ops.checkCategory(req.ctx, req.body.category_id); // before saving, so a bad category saves nothing
  const saved = await svc.saveOwnService(req.ctx, id, req.body);
  await ops.setServiceCategory(req.ctx, Number(saved || id), req.body.category_id);
}
router.post('/services', form(async (req, res) => { await saveService(req, null); flash(req, 'success', req.t('services.saved')); res.redirect('/app/my-profile#my-services'); }, rerender));
router.post('/services/:id(\\d+)', form(async (req, res) => { await saveService(req, Number(req.params.id)); flash(req, 'success', req.t('common.updated')); res.redirect('/app/my-profile#my-services'); }, rerender));
router.post('/services/:id(\\d+)/delete', wrap(async (req, res) => {
  await svc.removeOwnService(req.ctx, Number(req.params.id));
  flash(req, 'success', req.t('common.deleted'));
  res.redirect('/app/my-profile#my-services');
}));

module.exports = router;

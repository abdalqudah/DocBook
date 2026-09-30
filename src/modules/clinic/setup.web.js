// Clinic → Clinical setup (/app/clinic/setup): one place for the lists the clinical team keeps up to date — medications,
// diagnosis codes, insurance companies, signatures & stamp, specialty records. Each card opens the existing screen at its
// own address; a card shows only to members who may open that screen.
const express = require('express');
const knex = require('../../db/knex');
const { wrap } = require('../../routes/helpers');
const { canAny } = require('../../middleware/context');

const CARDS = [
  { key: 'medications', href: '/app/settings/medications', icon: 'pill', perms: ['settings.manage', 'prescriptions.create'], count: (b) => knex('medications').where({ business_id: b }).count({ n: '*' }) },
  { key: 'diagnosis_codes', href: '/app/settings/diagnosis-codes', icon: 'stethoscope', perms: ['settings.manage', 'clinical.edit'], count: (b) => knex('icd_custom_codes').where({ business_id: b }).count({ n: '*' }) },
  { key: 'insurance', href: '/app/settings/insurance', icon: 'shield-plus', perms: ['settings.manage'], count: (b) => knex('insurance_providers').where({ business_id: b }).count({ n: '*' }) },
  { key: 'signatures', href: '/app/settings/signatures', icon: 'pen-line', perms: ['settings.manage', 'prescriptions.create'] },
  { key: 'specialty', href: '/app/specialty/settings', icon: 'heart-pulse', perms: ['settings.manage'], module: 'specialty_records' },
];
const PERMS = [...new Set(CARDS.flatMap((c) => c.perms))];

const router = express.Router();

router.get('/', canAny(...PERMS), wrap(async (req, res) => {
  const { permissions, businessId } = req.ctx;
  const off = permissions.pagesOff;
  const moduleOn = res.locals.moduleOn || (() => true);
  const cards = CARDS.filter((c) => c.perms.some((p) => permissions.has(p)) && !(off && off.has(`settings_${c.key}`)) && (!c.module || moduleOn(c.module)));
  const counts = await Promise.all(cards.map((c) => (c.count ? c.count(businessId).then((r) => Number(r[0].n)).catch(() => null) : null)));
  res.page('pages/clinic/setup/index', {
    title: req.t('nav.clinical_setup'),
    cards: cards.map((c, i) => ({ key: c.key, href: c.href, icon: c.icon, count: counts[i] })),
  });
}));

module.exports = router;
module.exports.CARDS = CARDS;

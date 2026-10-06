// Settings → Sign-in (Google / Microsoft): client credentials and which portals may use each provider.
const express = require('express');
const config = require('../../config');
const secrets = require('../../core/secrets');
const settings = require('../settings/settings.service');
const { can } = require('../../middleware/auth');
const { flash } = require('../../middleware/web');
const { ah } = require('../../core/http');
const { E } = require('../../core/errors');
const { validate, z, bool, str } = require('../../core/validate');
const sso = require('./sso');

require('../settings/web').addSection({ key: 'sign_in', icon: 'key-round', href: '/staff/settings/sign-in', perms: ['integrations.manage'] }, { after: 'payments' });

const router = express.Router();

router.get('/settings/sign-in', can('integrations.manage'), ah(async (req, res) => {
  const all = (await settings.get('integration.sso')) || {};
  const providers = {};
  for (const p of sso.NAMES) providers[p] = { ...(all[p] || {}), connected: !!(await sso.providerSettings(p)), hasSecret: !!(all[p] || {}).client_secret_enc, redirect: sso.redirectUri(p) }; // eslint-disable-line no-await-in-loop
  res.page('pages/staff/settings/sign-in', { layout: 'staff', narrow: true, title: req.t('settings.sign_in'), providers, appUrl: config.appUrl });
}));

const schema = z.object({
  provider: z.enum(['google', 'microsoft']), enabled: bool(), students: bool(), staff: bool(),
  client_id: z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().max(200).regex(/^[A-Za-z0-9._-]+$/, 'Paste the client ID exactly as shown.').optional()),
  client_secret: str(300),
  tenant: z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().max(100).regex(/^[A-Za-z0-9.-]+$/, 'Use common, organizations, consumers, a tenant ID or your domain.').optional()),
});

router.post('/settings/sign-in', can('integrations.manage'), ah(async (req, res) => {
  const d = validate(schema, req.body);
  const all = (await settings.get('integration.sso')) || {};
  const cur = all[d.provider] || {};
  const next = {
    enabled: d.enabled, students: d.students, staff: d.staff, client_id: d.client_id || cur.client_id || '',
    client_secret_enc: d.client_secret ? secrets.encrypt(d.client_secret) : cur.client_secret_enc || null,
    ...(d.provider === 'microsoft' ? { tenant: d.tenant || cur.tenant || 'common' } : {}),
  };
  if (d.enabled && (!next.client_id || !next.client_secret_enc)) throw E.validation({ client_id: 'Client ID and client secret are required to switch this on.' });
  if (d.enabled && !d.students && !d.staff) throw E.validation({ students: 'Choose who may use it: students, staff or both.' });
  await settings.set(req.ctx, 'integration.sso', { ...all, [d.provider]: next });
  flash(req, 'ok', req.t('common.saved'));
  res.redirect(`/staff/settings/sign-in#${d.provider}`);
}));

module.exports = router;

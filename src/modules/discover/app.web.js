// Clinic side of "discover" (mounted at /app by one line in src/routes/app.js):
//   /app/settings/booking-links — DocBook directory listing, website booking button (widget), tracked links, QR code
//   /app/reports/bookings       — no-shows by doctor, bookings by channel, weekly online vs staff bookings
const express = require('express');
const QRCode = require('qrcode');
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const charts = require('../../core/charts');
const exporter = require('../../core/exporter');
const fmtCore = require('../../core/format');
const cache = require('../../core/cache');
const { wrap, flash } = require('../../routes/helpers');
const { can, canAny } = require('../../middleware/context');
const { publicBase } = require('../../middleware/web');
const businesses = require('../businesses/business.service');
const { render } = require('../settings/common');
const lib = require('../clinic/records.lib');
const channels = require('./channels');
const embed = require('./embed');
const dir = require('./directory.service');
const reports = require('./reports.service');

const router = express.Router();
const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------------------------------------------------------------- settings: booking button & links
async function renderLinks(req, res, extra = {}) {
  const b = req.business;
  const base = publicBase(req);
  const [ready, row] = await Promise.all([dir.readiness(req.ctx.businessId), knex('businesses').where({ id: req.ctx.businessId }).first('widget_origins')]);
  const slug = b.slug;
  const links = slug ? channels.SHARE_LINKS.map((l) => ({ ...l, url: channels.link(base, slug, l.key) })) : [];
  const qrUrl = slug ? channels.link(base, slug, 'qr') : null;
  const c = require('../../config/brand').colors.light; // eslint-disable-line global-require
  return render(req, res, '../discover/booking-links', 'booking_links', {
    title: req.t('widget.title'), b, base, ready,
    origins: extra.origins !== undefined ? extra.origins : (row.widget_origins || ''),
    scriptCode: slug ? `<script src="${base}/widget.js" data-clinic="${slug}" async></script>` : '',
    buttonCode: slug ? `<a href="${esc(channels.link(base, slug, 'widget'))}" target="_blank" rel="noopener" style="display:inline-block;padding:12px 20px;border-radius:999px;background:${c.primary};color:${c.primaryInk};font:600 15px system-ui,sans-serif;text-decoration:none">${esc(req.t('widget.button_text'))}</a>` : '',
    links, qr: qrUrl ? await QRCode.toDataURL(qrUrl, { margin: 1, width: 320, errorCorrectionLevel: 'M' }) : null, qrUrl,
    pageStyles: ['/css/admin.css', '/css/discover.css'], errors: {}, ...extra,
  });
}

router.get(['/settings/booking-links', '/website/booking/links'], canAny('website.edit', 'settings.manage'), wrap((req, res) => renderLinks(req, res)));

router.post('/settings/booking-links/directory', canAny('website.edit', 'settings.manage'), wrap(async (req, res) => {
  const on = req.body.directory_listed === '1';
  const before = await knex('businesses').where({ id: req.ctx.businessId }).first('directory_listed');
  await knex('businesses').where({ id: req.ctx.businessId }).update({ directory_listed: on, updated_at: new Date() });
  businesses.forget(req.ctx.businessId);
  dir.forget(req.ctx.businessId);
  await audit.record(req.ctx, on ? 'clinic.directory_listed' : 'clinic.directory_unlisted', { entityType: 'clinic', entityId: req.ctx.businessId, oldValues: { directory_listed: Boolean(before.directory_listed) }, newValues: { directory_listed: on } });
  flash(req, 'success', req.t(on ? 'directory.on_done' : 'directory.off_done'));
  res.redirect('/app/website/booking/links');
}));

router.post('/settings/booking-links/origins', canAny('website.edit', 'settings.manage'), wrap(async (req, res) => {
  const text = String(req.body.widget_origins || '').slice(0, 4000);
  const { origins, invalid } = embed.parseOrigins(text);
  if (invalid.length) {
    res.status(422);
    const msg = req.t('errors_discover.ORIGINS_INVALID', { list: invalid.slice(0, 5).join(', ') });
    return renderLinks(req, res, { origins: text, errors: { widget_origins: msg }, formError: { code: 'ORIGINS_INVALID', message: msg } });
  }
  const before = await knex('businesses').where({ id: req.ctx.businessId }).first('widget_origins');
  const value = origins.join('\n') || null;
  await knex('businesses').where({ id: req.ctx.businessId }).update({ widget_origins: value, updated_at: new Date() });
  cache.forgetPrefix(`discover:origins:${req.ctx.businessId}`);
  await audit.record(req.ctx, 'clinic.widget_origins_changed', { entityType: 'clinic', entityId: req.ctx.businessId, oldValues: { widget_origins: before.widget_origins }, newValues: { widget_origins: value } });
  flash(req, 'success', req.t('widget.origins_saved'));
  return res.redirect('/app/website/booking/links#widget');
}));

router.get('/settings/booking-links/qr.:ext(png|svg)', canAny('website.edit', 'settings.manage'), wrap(async (req, res) => {
  const slug = req.business.slug;
  if (!slug) return res.redirect('/app/website/booking/links');
  const url = channels.link(publicBase(req), slug, 'qr');
  const name = `${slug}-booking-qr.${req.params.ext}`;
  res.set({ 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'private, no-store' });
  if (req.params.ext === 'svg') return res.type('image/svg+xml').send(await QRCode.toString(url, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' }));
  return res.type('image/png').send(await QRCode.toBuffer(url, { margin: 2, width: 1024, errorCorrectionLevel: 'M' }));
}));

// ---------------------------------------------------------------- reports: bookings & no-shows
const pct1 = (v) => (v === null || v === undefined ? '' : Math.round(v * 10) / 10);
const channelName = (req, k) => { const s = req.t(`channels.names.${k}`); return s === `channels.names.${k}` ? k : s; };

router.get('/reports/bookings', can('reports.view'), wrap(async (req, res) => {
  const range = lib.resolveRange(req.query, req.ctx.today);
  const data = await reports.build(req.ctx, range, { locale: req.locale });
  const t = req.t;
  const L = (d, o) => fmtCore.formatDate(d, req.locale, o);

  if (req.query.export) {
    const tables = {
      doctors: { name: t('channels.export_doctors'), header: [t('common.doctor'), t('channels.bookings'), t('channels.completed'), t('channels.no_shows'), t('channels.cancelled'), `${t('channels.no_show_rate')} %`],
        rows: data.doctors.map((d) => [d.name || t('channels.no_doctor'), d.n, d.completed, d.noShow, d.cancelled, pct1(d.rate)]) },
      channels: { name: t('channels.export_channels'), header: [t('channels.channel'), t('channels.bookings'), `${t('channels.share')} %`, t('channels.completed'), t('channels.no_shows'), t('channels.cancelled'), `${t('channels.no_show_rate')} %`],
        rows: data.channels.map((c) => [channelName(req, c.key), c.n, pct1(c.share), c.completed, c.noShow, c.cancelled, pct1(c.rate)]) },
      weekly: { name: t('channels.export_weekly'), header: [t('common.date'), t('channels.online'), t('channels.staff')], rows: data.weeks.map((w) => [w.week, w.online, w.staff]) },
    };
    const tb = tables[req.query.export] || tables.channels;
    return exporter.send(req, res, { name: `${tb.name} ${range.from}_${range.to}`, header: tb.header, rows: tb.rows });
  }

  const nf = (v) => fmtCore.formatNumber(v, req.locale, 0);
  const points = data.weeks.map((w) => ({ label: t('channels.week_of', { date: L(w.week, { day: 'numeric', month: 'short' }) }), short: L(w.week, { day: 'numeric', month: 'numeric' }), online: w.online, staff: w.staff }));
  const chartsHtml = {
    weekly: points.some((p) => p.online || p.staff) ? charts.columns({
      points, title: t('channels.trend'), fmt: nf, height: 220, width: 720, labelMax: false,
      series: [{ key: 'online', cls: '' }, { key: 'staff', cls: 's2' }], tipFmt: (p) => `${t('channels.online')} ${nf(p.online)} · ${t('channels.staff')} ${nf(p.staff)}`,
    }) : null,
    channels: data.channels.length ? charts.bars({ items: data.channels.map((c) => ({ label: channelName(req, c.key), value: c.n, note: fmtCore.formatPercent(c.share, req.locale, 0) })), fmt: nf }) : null,
  };
  const months = [];
  for (let i = 0; i < 24; i += 1) months.push(lib.addMonths(req.ctx.today.slice(0, 7), -i));
  return res.page('pages/discover/reports', {
    title: t('channels.title'), range, data, charts: chartsHtml, months, channelName: (k) => channelName(req, k),
    printable: true, pageScripts: ['/js/records.js'], pageStyles: ['/css/records.css', '/css/discover.css'],
  });
}));

module.exports = router;

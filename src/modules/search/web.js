// ⌘K record search across modules the member may see.
const express = require('express');
const knex = require('../../db/knex');
const { wrap } = require('../../routes/helpers');

const router = express.Router();
router.get('/', wrap(async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 80);
  if (q.length < 2) return res.json({ data: [] });
  const like = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
  const b = req.ctx.businessId; const p = req.ctx.permissions; const out = [];
  const add = (rows, fn) => rows.forEach((r) => out.push(fn(r)));
  if (p.has('sales.view')) add(await knex('orders').where({ business_id: b }).andWhere((w) => w.where('order_number', 'like', like).orWhere('customer_name', 'like', like).orWhere('customer_phone', 'like', like)).limit(5), (r) => ({ title: `${r.order_number} · ${r.customer_name}`, subtitle: req.t('sales.order'), href: `/app/sales/${r.id}`, icon: 'shopping-cart' }));
  if (p.has('customers.view')) add(await knex('customers').where({ business_id: b }).andWhere((w) => w.where('name', 'like', like).orWhere('phone', 'like', like).orWhere('email', 'like', like)).limit(5), (r) => ({ title: r.name, subtitle: req.t('customers.customer'), href: `/app/customers/${r.id}`, icon: 'user' }));
  if (p.has('payroll.view')) add(await knex('employees').where({ business_id: b }).andWhere((w) => w.where('name', 'like', like).orWhere('phone', 'like', like)).limit(5), (r) => ({ title: r.name, subtitle: req.t('payroll.employee'), href: `/app/payroll/employees/${r.id}`, icon: 'id-card' }));
  if (p.has('partners.view')) add(await knex('partners').where({ business_id: b }).andWhere('name', 'like', like).limit(5), (r) => ({ title: r.name, subtitle: req.t('partners.partner'), href: `/app/partners/${r.id}`, icon: 'handshake' }));
  if (p.has('expenses.view')) add(await knex('expenses').where({ business_id: b }).andWhere((w) => w.where('title', 'like', like).orWhere('invoice_number', 'like', like)).orderBy('date', 'desc').limit(5), (r) => ({ title: r.title, subtitle: `${req.t('nav.expenses')} · ${r.date}`, href: `/app/expenses?q=${encodeURIComponent(r.title)}`, icon: 'receipt' }));
  if (p.has('purchases.view')) add(await knex('purchases').where({ business_id: b }).andWhere((w) => w.where('item_name', 'like', like).orWhere('supplier_name', 'like', like).orWhere('sku', 'like', like)).limit(5), (r) => ({ title: `${r.item_name} · ${r.supplier_name}`, subtitle: req.t('nav.purchases'), href: `/app/purchases?q=${encodeURIComponent(r.item_name)}`, icon: 'package' }));
  if (p.has('delivery.view')) add(await knex('deliveries').where({ business_id: b }).andWhere((w) => w.where('tracking_number', 'like', like).orWhere('customer_name', 'like', like)).limit(5), (r) => ({ title: `${r.tracking_number || '—'} · ${r.customer_name}`, subtitle: req.t('nav.delivery'), href: `/app/delivery?q=${encodeURIComponent(r.tracking_number || r.customer_name)}`, icon: 'truck' }));
  if (p.has('marketing.view')) add(await knex('campaigns').where({ business_id: b }).andWhere('campaign_name', 'like', like).limit(5), (r) => ({ title: r.campaign_name, subtitle: req.t('nav.marketing'), href: `/app/marketing?q=${encodeURIComponent(r.campaign_name)}`, icon: 'megaphone' }));
  return res.json({ data: out.slice(0, 20) });
}));
module.exports = router;

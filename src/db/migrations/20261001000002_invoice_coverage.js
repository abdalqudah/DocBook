// Insurance coverage % captured at the cashier, so the receipt can show the insurer's and the patient's share.
exports.up = (knex) => knex.schema.alterTable('invoices', (t) => { t.decimal('insurance_coverage_percent', 5, 2).nullable(); });
exports.down = (knex) => knex.schema.alterTable('invoices', (t) => { t.dropColumn('insurance_coverage_percent'); });

// AI finance & management assistant (uses the platform AI settings of the clinical assistant: key, model, caps).
//  • ai_finance_settings: clinic opt-in (off by default), acknowledgement of the notice, allowed roles
//    (JSON role keys; default owner / clinic_manager / accountant — each must also hold finance.view).
//  • ai_finance_runs: saved monthly analyses (structured result + the aggregated figures that were sent).
//  • ai_finance_messages: chat history per user and clinic (only the visible text; the last turns are resent).
//  • ai_finance_actions: actions proposed by the assistant (add expense / add supplier). They are NEVER executed by
//    the model — only when the user presses Confirm (permission re-checked, validated by the normal services).
// Requests themselves are logged in ai_requests (kind fin_analysis | fin_chat) so they count toward the same caps.
exports.up = async (knex) => {
  await knex.schema.createTable('ai_finance_settings', (t) => {
    t.integer('business_id').unsigned().primary().references('businesses.id').onDelete('CASCADE');
    t.boolean('enabled').notNullable().defaultTo(false);
    t.json('allowed_roles').nullable();
    t.timestamp('acknowledged_at').nullable();
    t.integer('acknowledged_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamps(true, true);
  });

  await knex.schema.createTable('ai_finance_runs', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('user_id').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.integer('request_id').unsigned().nullable();
    t.string('month', 7).notNullable();                 // YYYY-MM
    t.string('model', 80).nullable();
    t.string('locale', 2).notNullable().defaultTo('ar');
    t.specificType('result', 'MEDIUMTEXT').notNullable(); // JSON: summary, strengths, warnings, action_steps, metrics_notes
    t.specificType('figures', 'MEDIUMTEXT').nullable();   // JSON: the aggregated figures sent (no patient data)
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['business_id', 'month', 'id']);
  });

  await knex.schema.createTable('ai_finance_messages', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('user_id').unsigned().notNullable().references('users.id').onDelete('CASCADE');
    t.string('role', 10).notNullable();                  // user | assistant
    t.text('content').notNullable();
    t.string('status', 20).notNullable().defaultTo('ok'); // ok | refused | truncated | error
    t.boolean('in_context').notNullable().defaultTo(true); // resent to the model on the next turn
    t.json('action_ids').nullable();
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['business_id', 'user_id', 'id']);
  });

  await knex.schema.createTable('ai_finance_actions', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('user_id').unsigned().notNullable().references('users.id').onDelete('CASCADE');
    t.string('kind', 20).notNullable();                  // add_expense | add_supplier
    t.json('payload').notNullable();
    t.string('status', 20).notNullable().defaultTo('pending'); // pending | confirming | done | cancelled | failed
    t.integer('entity_id').unsigned().nullable();         // expense / supplier id once done
    t.string('error_code', 40).nullable();
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('decided_at').nullable();
    t.index(['business_id', 'user_id', 'status']);
  });
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('ai_finance_actions');
  await knex.schema.dropTableIfExists('ai_finance_messages');
  await knex.schema.dropTableIfExists('ai_finance_runs');
  await knex.schema.dropTableIfExists('ai_finance_settings');
};

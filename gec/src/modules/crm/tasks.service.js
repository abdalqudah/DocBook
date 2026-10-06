// Tasks for staff: follow-ups linked to a lead / student / application, with priorities, statuses and recurrence.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const events = require('../../core/events');
const { E } = require('../../core/errors');
const activity = require('./activity.service');

const STATUSES = ['todo', 'in_progress', 'waiting', 'completed'];
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const RECURRENCE = ['none', 'daily', 'weekly', 'monthly', 'every_n_days'];

/** Tasks visible to this employee: their own, or everyone's with tasks.view_all (within their branch scope). */
function visible(staff, q = knex('tasks')) {
  if (staff.permissions.has('tasks.view_all')) {
    if (staff.employee.dataScope === 'branch' && staff.employee.branchId) {
      return q.leftJoin('employees as te', 'te.id', 'tasks.assignee_id').where((w) => w.where('te.branch_id', staff.employee.branchId).orWhere('tasks.assignee_id', staff.employee.id).orWhereNull('tasks.assignee_id'));
    }
    if (staff.employee.dataScope === 'all') return q;
  }
  return q.where((w) => w.where('tasks.assignee_id', staff.employee.id).orWhere('tasks.created_by', staff.user.id));
}

function withLinks(q) {
  return q.leftJoin('leads as l', 'l.id', 'tasks.lead_id').leftJoin('students as s', 's.id', 'tasks.student_id')
    .leftJoin('employees as ae', 'ae.id', 'tasks.assignee_id').leftJoin('users as au', 'au.id', 'ae.user_id')
    .select('tasks.*', 'l.first_name as lead_first', 'l.last_name as lead_last', 'l.ref as lead_ref', 's.first_name as student_first', 's.last_name as student_last', 's.ref as student_ref', 'au.name as assignee_name');
}

async function list(staff, params = {}) {
  const q = withLinks(visible(staff));
  const view = params.view || 'open';
  const now = new Date();
  const endOfDay = new Date(); endOfDay.setUTCHours(23, 59, 59, 999);
  if (view === 'completed') q.where('tasks.status', 'completed').orderBy('tasks.completed_at', 'desc').limit(100);
  else {
    q.whereNot('tasks.status', 'completed');
    if (view === 'overdue') q.where('tasks.due_at', '<', now);
    if (view === 'today') q.whereBetween('tasks.due_at', [new Date(now.getTime() - 86400000 * 365), endOfDay]);
    q.orderByRaw('tasks.due_at IS NULL, tasks.due_at ASC').orderByRaw("FIELD(tasks.priority, 'urgent', 'high', 'normal', 'low')").limit(300);
  }
  if (params.mine === '1') q.where('tasks.assignee_id', staff.employee.id);
  if (/^\d+$/.test(params.assignee || '')) q.where('tasks.assignee_id', Number(params.assignee));
  if (STATUSES.includes(params.status)) q.where('tasks.status', params.status);
  return q;
}

async function forRecord({ leadId, studentId, applicationId }) {
  const leadIds = leadId ? [leadId] : [];
  if (studentId) (await knex('leads').where({ student_id: studentId }).select('id')).forEach((l) => leadIds.push(l.id));
  const q = withLinks(knex('tasks')).where((w) => {
    if (leadIds.length) w.orWhereIn('tasks.lead_id', leadIds);
    if (studentId) w.orWhere('tasks.student_id', studentId);
    if (applicationId) w.orWhere('tasks.application_id', applicationId);
  });
  return q.orderByRaw("tasks.status = 'completed', tasks.due_at IS NULL, tasks.due_at ASC").limit(100);
}

async function get(staff, id) {
  const t = await visible(staff).where('tasks.id', id).first('tasks.*');
  if (!t) throw E.notFound('Task');
  return t;
}

async function create(ctx, data) {
  // A task can only point at an application of the same student.
  if (data.application_id) {
    const app = await knex('applications').where({ id: data.application_id }).first('student_id');
    if (!app || (data.student_id && app.student_id !== Number(data.student_id))) data = { ...data, application_id: null }; // eslint-disable-line no-param-reassign
    else if (!data.student_id) data = { ...data, student_id: app.student_id }; // eslint-disable-line no-param-reassign
  }
  const row = {
    title: String(data.title).slice(0, 190), description: data.description || null,
    lead_id: data.lead_id || null, student_id: data.student_id || null, application_id: data.application_id || null,
    assignee_id: data.assignee_id || null, created_by: ctx.userId || null, due_at: data.due_at || null,
    priority: PRIORITIES.includes(data.priority) ? data.priority : 'normal', status: 'todo',
    recurrence: RECURRENCE.includes(data.recurrence) ? data.recurrence : 'none', recurrence_days: data.recurrence === 'every_n_days' ? Math.max(1, Number(data.recurrence_days) || 1) : null,
    previous_id: data.previous_id || null, origin: data.origin || 'manual', is_demo: Boolean(data.is_demo),
  };
  const [id] = await knex('tasks').insert(row);
  if (row.lead_id || row.student_id) await activity.log({ leadId: row.lead_id, studentId: row.student_id, applicationId: row.application_id }, { type: 'task', title: 'task_created', meta: { task_id: id, title: row.title, due_at: row.due_at }, actorId: ctx.userId || null });
  await audit.record(ctx, 'task.created', { entityType: 'task', entityId: id, newValues: { title: row.title, assignee_id: row.assignee_id, due_at: row.due_at } });
  const task = await knex('tasks').where({ id }).first();
  await events.emit('task.created', { task, by: ctx.userId || null });
  return task;
}

function nextDue(task) {
  if (!task.due_at || task.recurrence === 'none') return null;
  const d = new Date(task.due_at);
  if (task.recurrence === 'daily') d.setUTCDate(d.getUTCDate() + 1);
  else if (task.recurrence === 'weekly') d.setUTCDate(d.getUTCDate() + 7);
  else if (task.recurrence === 'monthly') d.setUTCMonth(d.getUTCMonth() + 1);
  else if (task.recurrence === 'every_n_days') d.setUTCDate(d.getUTCDate() + (task.recurrence_days || 1));
  // never schedule the next one in the past
  const now = new Date();
  while (d < now) d.setUTCDate(d.getUTCDate() + (task.recurrence === 'weekly' ? 7 : task.recurrence === 'monthly' ? 30 : (task.recurrence_days || 1)));
  return d;
}

async function setStatus(ctx, staff, id, status) {
  if (!STATUSES.includes(status)) throw E.validation({ status: 'Choose a valid option.' });
  const t = await get(staff, id);
  if (t.status === status) return t;
  await knex('tasks').where({ id }).update({ status, completed_at: status === 'completed' ? new Date() : null, updated_at: new Date() });
  await audit.record(ctx, 'task.status_changed', { entityType: 'task', entityId: id, oldValues: { status: t.status }, newValues: { status } });
  if (status === 'completed') {
    if (t.lead_id || t.student_id) await activity.log({ leadId: t.lead_id, studentId: t.student_id, applicationId: t.application_id }, { type: 'task', title: 'task_completed', meta: { task_id: id, title: t.title }, actorId: ctx.userId });
    const due = nextDue(t);
    if (due) await create(ctx, { ...t, due_at: due, previous_id: t.id, origin: t.origin });
    await events.emit('task.completed', { task: t, by: ctx.userId });
  }
  return knex('tasks').where({ id }).first();
}

async function update(ctx, staff, id, data) {
  const t = await get(staff, id);
  const row = {};
  for (const k of ['title', 'description', 'assignee_id', 'due_at', 'priority', 'recurrence', 'recurrence_days']) if (data[k] !== undefined) row[k] = data[k] === '' ? null : data[k];
  const d = audit.diff(t, row);
  if (!d.changed) return false;
  await knex('tasks').where({ id }).update({ ...row, updated_at: new Date() });
  await audit.record(ctx, 'task.updated', { entityType: 'task', entityId: id, oldValues: d.oldValues, newValues: d.newValues });
  if (row.assignee_id && row.assignee_id !== t.assignee_id) await events.emit('task.created', { task: { ...t, ...row }, by: ctx.userId });
  return true;
}

async function remove(ctx, staff, id) {
  const t = await get(staff, id);
  await knex('tasks').where({ id }).del();
  await audit.record(ctx, 'task.deleted', { entityType: 'task', entityId: id, oldValues: { title: t.title } });
}

module.exports = { list, forRecord, get, create, setStatus, update, remove, visible, STATUSES, PRIORITIES, RECURRENCE, nextDue };

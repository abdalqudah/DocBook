// Human text for timeline entries, in the viewer's language (entries store keys + data, not sentences).
function activityText(a, t, locale) {
  const m = a.meta || {};
  const L = (en, ar) => (locale === 'ar' ? ar || en : en || ar);
  const [kind, detail] = String(a.title || '').split(':');
  switch (a.type) {
    case 'created':
      if (kind === 'student_from_lead') return t('activity.student_from_lead');
      if (kind === 'student_created') return t('activity.student_created');
      return t('activity.lead_created', { source: t(`sources.${detail || m.source || 'manual'}`) });
    case 'form': return t('activity.form_submitted', { source: t(`sources.${detail || m.source || 'contact_form'}`) });
    case 'assigned': return m.to_name ? t('activity.assigned_to', { name: m.to_name }) : (kind === 'unassigned' ? t('activity.unassigned') : t('activity.assigned_auto'));
    case 'stage':
      if (kind === 'journey') return t('activity.journey_moved', { to: t(`journey.${m.to}`) });
      return t('activity.stage_moved', { from: L(m.from_en, m.from_ar) || '—', to: L(m.to_en, m.to_ar) });
    case 'lost': return t('activity.marked_lost', { reason: m.reason || '' });
    case 'converted': return t('activity.converted', { ref: m.student_ref || '' });
    case 'merged': return t('activity.merged', { ref: m.from_ref || '' });
    case 'note': return t('activity.note');
    case 'task': return kind === 'task_completed' ? t('activity.task_completed', { title: m.title || '' }) : t('activity.task_created', { title: m.title || '' });
    case 'call': case 'whatsapp': case 'email': case 'sms': case 'meeting':
      if (kind === 'contact') return t(`activity.contact_${a.type}`, { outcome: t(`outcomes.${m.outcome || 'reached'}`) });
      return a.title.includes(':') ? t(`activity.msg_${m.direction || 'out'}_${a.type}`, { subject: m.subject || '' }) : a.title;
    default:
      return t(`activity.${a.title}`, m) !== `activity.${a.title}` ? t(`activity.${a.title}`, m) : a.title;
  }
}
module.exports = { activityText };

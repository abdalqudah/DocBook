// E-mails to university staff: the invitation (set-password link) to the partner portal.
const email = require('../comms/email');
const { translator } = require('../../core/i18n');

async function sendInvite(to, name, link, universityName, locale = 'en') {
  const t = translator(locale);
  const html = await email.layout({ locale, title: t('partnerp.mail_invite_title'), body: t('partnerp.mail_invite_body', { name, university: universityName }), cta: t('partnerp.mail_invite_cta'), href: link });
  return email.send({ to, subject: t('partnerp.mail_invite_title'), html }).catch(() => null);
}

module.exports = { sendInvite };

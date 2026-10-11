// The platform's public Privacy Policy (/privacy) and Terms of Service (/terms), in Arabic and English. They cover
// the clinics' accounts, the patients' data the clinics keep in the system, and — as Google requires of apps that use
// its sign-in and APIs — exactly which Google data the system uses and how (sign-in; sending from a clinic's own Gmail;
// Google Sheets files it creates in a clinic's Drive). {brand} and {email} are filled in when the page is shown.
const UPDATED = '2026-10-11';

const privacy = {
  ar: {
    title: 'سياسة الخصوصية',
    intro: '{brand} نظام سحابي لإدارة العيادات والمراكز الطبية. توضّح هذه السياسة ما نجمعه من بيانات، ولماذا، وكيف نحميها، وما حقوقك عليها.',
    sections: [
      ['من نحن ودور كل طرف', [
        'نقدّم {brand} للعيادات والمراكز الطبية. بالنسبة لبيانات حسابات العيادات ومستخدميها نحن المسؤولون عنها.',
        'أما بيانات المرضى التي تدخلها العيادة في النظام فالعيادة هي المسؤولة عنها، ونحن نعالجها نيابةً عنها ووفق تعليماتها فقط لتقديم الخدمة. على المريض الذي يريد الوصول إلى بياناته أو تعديلها أن يتواصل مع عيادته.',
      ]],
      ['البيانات التي نجمعها', [
        'بيانات الحساب: الاسم والبريد الإلكتروني ورقم الهاتف وكلمة المرور (محفوظة مشفّرة بطريقة لا يمكن استرجاعها).',
        'بيانات العيادة: اسمها وعنوانها وأطباؤها وخدماتها ودوامها وأسعارها وإعداداتها.',
        'بيانات المرضى التي تُدخلها العيادة: المواعيد والملف الطبي والوصفات والفحوصات والفواتير والملفات المرفقة، والحجوزات التي يقوم بها المرضى من موقع العيادة.',
        'بيانات تقنية: عنوان IP ونوع المتصفح وسجلات الدخول والاستخدام، لحماية الحسابات وتشغيل الخدمة.',
        'ملفات تعريف الارتباط (الكوكيز) الضرورية لتسجيل الدخول واللغة، وأدوات القياس فقط بعد موافقتك. التفاصيل في صفحة تفضيلات الكوكيز.',
        'المدفوعات تتم عبر بوابات دفع معتمدة، ولا نحفظ أرقام البطاقات.',
      ]],
      ['كيف نستخدم البيانات', [
        'لتقديم الخدمة وتشغيلها: الحجز والملفات والفواتير والتقارير والتذكيرات التي ترسلها العيادة لمرضاها بالواتساب أو الرسائل أو البريد.',
        'لحماية الحسابات ومنع إساءة الاستخدام، وللدعم الفني، وللفوترة.',
        'لإرسال رسائل تتعلق بالحساب والخدمة. الرسائل الترويجية تحمل دائماً رابطاً لإلغاء الاشتراك.',
        'لا نبيع البيانات، ولا نستخدم بيانات المرضى للإعلان أبداً.',
      ]],
      ['بيانات جوجل', [
        'تسجيل الدخول بجوجل: نستخدم اسمك وبريدك وصورتك (openid, email, profile) فقط للتعرّف عليك وتسجيل دخولك.',
        'الإرسال من بريد العيادة على Gmail: إذا ربطت العيادة بريدها، نستخدم صلاحية الإرسال فقط (gmail.send) لإرسال الرسائل التي تكتبها العيادة أو يرسلها النظام نيابةً عنها، مثل التذكيرات والوصفات والفواتير. لا نقرأ صندوق البريد ولا نصل إلى محتواه ولا نحفظه.',
        'Google Drive وجداول جوجل: إذا فعّلت العيادة التصدير إلى جداول جوجل، نستخدم صلاحية drive.file فقط، فيصل النظام إلى الملفات التي ينشئها هو فقط، ولا يصل إلى أي ملف آخر في حسابك.',
        'استخدام {brand} للمعلومات التي يتلقاها من واجهات Google ونقلها إلى أي تطبيق آخر يلتزم بسياسة بيانات مستخدمي خدمات Google API، بما في ذلك متطلبات الاستخدام المحدود (Limited Use).',
        'لا نبيع بيانات جوجل ولا ننقلها لأي طرف، ولا نستخدمها للإعلانات ولا لتدريب نماذج الذكاء الاصطناعي، ولا يطّلع عليها أحد من فريقنا إلا بموافقتك، أو لأسباب أمنية، أو بطلب من القانون.',
        'يمكنك إلغاء الربط في أي وقت من إعدادات العيادة، أو من صفحة أذونات حسابك في جوجل: myaccount.google.com/permissions',
      ]],
      ['مع من نشارك البيانات', [
        'مع مزوّدي خدمات نعتمد عليهم لتشغيل النظام (الاستضافة، والبريد، والرسائل والواتساب، والدفع)، وبموجب اتفاقيات تلزمهم بحمايتها واستخدامها لهذا الغرض فقط.',
        'إذا طلب القانون أو جهة رسمية مختصة ذلك.',
        'بطلب من العيادة أو موافقتها، مثل نقل ملف مريض إلى جهة أخرى.',
      ]],
      ['حماية البيانات', [
        'الاتصال مشفّر (HTTPS)، وكلمات المرور ومفاتيح الربط محفوظة مشفّرة، وصلاحيات الموظفين يحددها مالك العيادة، وكل عملية حساسة تُسجّل في سجل التدقيق، ونأخذ نسخاً احتياطية دورية.',
        'لا توجد طريقة حماية كاملة على الإنترنت، لكننا نعمل باستمرار على تقليل المخاطر، ونبلغ العيادات المتأثرة إذا حدث اختراق يمس بياناتها.',
      ]],
      ['مدة الاحتفاظ', [
        'نحتفظ بالبيانات ما دام حساب العيادة قائماً. بعد إغلاق الحساب تستطيع العيادة تصدير بياناتها، ثم تُحذف خلال 90 يوماً، إلا ما يلزمنا القانون بالاحتفاظ به، وتُحذف من النسخ الاحتياطية مع دورتها.',
      ]],
      ['حقوقك', [
        'لك أن تطلب الاطلاع على بياناتك أو تصحيحها أو حذفها أو الحصول على نسخة منها، وأن تعترض على الرسائل الترويجية في أي وقت.',
        'المرضى يتواصلون مع عيادتهم مباشرة، ونحن نساعد العيادة على تنفيذ الطلب.',
      ]],
      ['الأطفال', [
        'الخدمة موجّهة للعيادات وليس للأطفال. بيانات المرضى القُصّر تُدخلها العيادة وتكون مسؤولة عن الحصول على موافقة وليّ الأمر.',
      ]],
      ['التعديلات على هذه السياسة', [
        'قد نحدّث هذه السياسة، وننشر التاريخ الجديد في أعلى الصفحة، ونبلغ العيادات بالبريد عند أي تغيير جوهري.',
      ]],
    ],
    contact: 'للاستفسار أو لأي طلب يخص بياناتك راسلنا على: {email}',
  },
  en: {
    title: 'Privacy Policy',
    intro: '{brand} is a cloud system for running clinics and medical centres. This policy explains what data we collect, why, how we protect it, and your rights over it.',
    sections: [
      ['Who we are and who does what', [
        'We provide {brand} to clinics and medical centres. For the data of the clinics\' accounts and their users, we are responsible for it.',
        'For the patients\' data a clinic enters in the system, the clinic is responsible for it; we process it on the clinic\'s behalf and only on its instructions, to provide the service. A patient who wants to see or change their data should contact their clinic.',
      ]],
      ['The data we collect', [
        'Account data: name, e-mail, phone number and password (stored hashed, so it cannot be read back).',
        'Clinic data: its name, address, doctors, services, hours, prices and settings.',
        'Patients\' data entered by the clinic: appointments, medical records, prescriptions, tests, invoices and attached files, and the bookings patients make on the clinic\'s website.',
        'Technical data: IP address, browser, sign-in and usage logs, to protect accounts and run the service.',
        'Cookies needed for signing in and the language, and measurement tools only after you agree. Details on the cookie preferences page.',
        'Payments go through approved payment gateways; we do not store card numbers.',
      ]],
      ['How we use the data', [
        'To provide and run the service: bookings, records, invoices, reports, and the reminders a clinic sends its patients by WhatsApp, SMS or e-mail.',
        'To protect accounts and prevent misuse, for support, and for billing.',
        'To send messages about the account and the service. Promotional e-mails always carry an unsubscribe link.',
        'We do not sell data, and we never use patients\' data for advertising.',
      ]],
      ['Google user data', [
        'Sign in with Google: we use your name, e-mail and picture (openid, email, profile) only to identify you and sign you in.',
        'Sending from a clinic\'s Gmail: if a clinic connects its mailbox, we use the send-only permission (gmail.send) to send the messages the clinic writes or the system sends on its behalf, such as reminders, prescriptions and invoices. We do not read the mailbox, access its contents or store them.',
        'Google Drive and Google Sheets: if a clinic turns on the export to Google Sheets, we use the drive.file permission only, so the system can reach only the files it creates and no other file in your account.',
        '{brand}\'s use and transfer to any other app of information received from Google APIs will adhere to the Google API Services User Data Policy, including the Limited Use requirements.',
        'We do not sell Google user data or transfer it to anyone, we do not use it for advertising or to train AI models, and no one on our team reads it except with your consent, for security reasons, or when the law requires it.',
        'You can disconnect at any time in the clinic\'s settings, or from your Google account\'s permissions page: myaccount.google.com/permissions',
      ]],
      ['Who we share data with', [
        'Service providers we rely on to run the system (hosting, e-mail, SMS and WhatsApp, payments), under agreements that bind them to protect it and use it only for that purpose.',
        'When the law or a competent authority requires it.',
        'At the clinic\'s request or with its consent, such as transferring a patient\'s file to another provider.',
      ]],
      ['How we protect data', [
        'Connections are encrypted (HTTPS), passwords and connection keys are stored encrypted, the clinic owner sets each staff member\'s permissions, every sensitive action is written to an audit log, and we take regular backups.',
        'No method of protection on the internet is perfect, but we keep working to reduce the risks, and we tell the affected clinics if a breach touches their data.',
      ]],
      ['How long we keep data', [
        'We keep data while the clinic\'s account is open. After the account is closed, the clinic can export its data; it is then deleted within 90 days, except what the law obliges us to keep, and it leaves the backups as they rotate.',
      ]],
      ['Your rights', [
        'You can ask to see, correct or delete your data or to get a copy of it, and object to promotional e-mails at any time.',
        'Patients contact their clinic directly, and we help the clinic carry out the request.',
      ]],
      ['Children', [
        'The service is meant for clinics, not for children. Minors\' data is entered by the clinic, which is responsible for the guardian\'s consent.',
      ]],
      ['Changes to this policy', [
        'We may update this policy; the new date is shown at the top of the page, and clinics are told by e-mail of any significant change.',
      ]],
    ],
    contact: 'For questions or any request about your data, write to us at: {email}',
  },
};

const terms = {
  ar: {
    title: 'شروط الخدمة',
    intro: 'هذه الشروط تنظّم استخدامك لنظام {brand}. بإنشاء حساب أو استخدام الخدمة فإنك توافق عليها، وإذا كنت تسجّل نيابةً عن عيادة أو مركز فأنت تقرّ بأنك مخوّل بذلك.',
    sections: [
      ['الخدمة', [
        '{brand} نظام سحابي لإدارة العيادات: الحجز والاستقبال والملف الطبي والفوترة والمحاسبة والرواتب وموقع العيادة والتواصل مع المرضى.',
        'نطوّر الخدمة باستمرار، وقد نضيف مزايا أو نغيّرها، ونبلغك مسبقاً بأي تغيير يؤثر جوهرياً على استخدامك.',
      ]],
      ['الحساب', [
        'عليك تقديم معلومات صحيحة والحفاظ على سرية كلمة المرور، وأنت مسؤول عما يتم من حسابك ومن حسابات موظفيك وعن الصلاحيات التي تمنحها لهم.',
        'أبلغنا فوراً إذا اشتبهت باستخدام غير مصرح به لحسابك.',
      ]],
      ['التجربة المجانية والاشتراك', [
        'تبدأ العيادة بفترة تجربة مجانية بدون بطاقة، ثم تختار باقة شهرية أو سنوية حسب الأسعار المعلنة في صفحة الأسعار.',
        'يُدفع الاشتراك مقدماً عن كل فترة. إذا لم يُدفع بعد فترة السماح يُقيَّد الحساب حتى الدفع دون حذف البيانات.',
        'لا نرد قيمة الفترات الجزئية إلا إذا أوجب القانون ذلك. يمكنك إلغاء التجديد في أي وقت ويبقى الاشتراك فعّالاً حتى نهاية الفترة المدفوعة.',
      ]],
      ['بيانات العيادة والمرضى', [
        'بيانات العيادة ومرضاها ملك للعيادة، وتستطيع تصديرها في أي وقت.',
        'العيادة مسؤولة عن جمع بيانات مرضاها بشكل قانوني والحصول على موافقاتهم اللازمة، ونحن نعالجها وفق سياسة الخصوصية.',
      ]],
      ['الاستخدام المقبول', [
        'لا يجوز استخدام الخدمة لأي غرض غير قانوني، ولا لإرسال رسائل لمن لم يوافق على استقبالها، ولا لمحاولة اختراق النظام أو تعطيله أو الوصول إلى بيانات الآخرين، ولا لإعادة بيع الخدمة دون اتفاق معنا.',
      ]],
      ['إخلاء المسؤولية الطبية', [
        'النظام أداة إدارة وتنظيم، ولا يقدّم استشارة طبية. القرارات الطبية والتشخيص والعلاج مسؤولية الطبيب وحده، وأي اقتراحات يعرضها النظام (بما فيها مزايا الذكاء الاصطناعي) هي للمساعدة فقط وتحتاج مراجعة الطبيب.',
      ]],
      ['توفر الخدمة', [
        'نسعى لأن تعمل الخدمة باستمرار، وقد تتوقف لفترات قصيرة للصيانة أو لأسباب خارجة عن إرادتنا، ونبلغ مسبقاً عن الصيانة المخطط لها قدر الإمكان.',
      ]],
      ['خدمات الأطراف الأخرى', [
        'بعض المزايا تعمل عبر خدمات أطراف أخرى مثل واتساب وجوجل وبوابات الدفع، ويخضع استخدامها لشروط تلك الجهات أيضاً.',
      ]],
      ['الملكية الفكرية', [
        'النظام وتصميمه وبرمجياته ملك لنا. المحتوى الذي تضيفه العيادة ملك لها، وتمنحنا الإذن باستضافته ومعالجته بالقدر اللازم لتقديم الخدمة فقط.',
      ]],
      ['حدود المسؤولية', [
        'إلى أقصى حد يسمح به القانون، لا نتحمّل مسؤولية الأضرار غير المباشرة أو فوات الربح، ولا تتجاوز مسؤوليتنا الإجمالية ما دفعته العيادة لنا خلال الأشهر الاثني عشر السابقة.',
      ]],
      ['إنهاء الخدمة', [
        'يمكنك إلغاء حسابك في أي وقت. قد نعلّق حساباً يخالف هذه الشروط بعد إبلاغه حيثما أمكن. بعد الإنهاء تبقى البيانات متاحة للتصدير مدة 30 يوماً.',
      ]],
      ['التعديلات على الشروط', [
        'قد نعدّل هذه الشروط، وننشر التاريخ الجديد في أعلى الصفحة، ونبلغ العيادات بالبريد عند أي تغيير جوهري. استمرارك في الاستخدام بعدها يعني موافقتك عليها.',
      ]],
      ['القانون المطبّق', [
        'تخضع هذه الشروط لقوانين المملكة الأردنية الهاشمية، وتختص محاكم عمّان بأي نزاع ينشأ عنها.',
      ]],
    ],
    contact: 'للتواصل بخصوص هذه الشروط: {email}',
  },
  en: {
    title: 'Terms of Service',
    intro: 'These terms govern your use of {brand}. By creating an account or using the service you agree to them, and if you sign up on behalf of a clinic or centre you confirm that you are authorised to do so.',
    sections: [
      ['The service', [
        '{brand} is a cloud system for running clinics: bookings, front desk, medical records, billing, accounting, payroll, the clinic\'s website and messages to patients.',
        'We keep improving the service and may add or change features; we tell you in advance of any change that significantly affects how you use it.',
      ]],
      ['Your account', [
        'You must give accurate information and keep your password secret; you are responsible for what is done from your account and your staff\'s accounts, and for the permissions you give them.',
        'Tell us at once if you suspect unauthorised use of your account.',
      ]],
      ['Free trial and subscription', [
        'A clinic starts with a free trial without a card, then chooses a monthly or yearly plan at the prices on the pricing page.',
        'The subscription is paid in advance for each period. If it is not paid after the grace period, the account is restricted until payment, without deleting data.',
        'We do not refund partial periods unless the law requires it. You can cancel the renewal at any time; the subscription stays active until the end of the paid period.',
      ]],
      ['Clinic and patient data', [
        'The data of a clinic and its patients belongs to the clinic, which can export it at any time.',
        'The clinic is responsible for collecting its patients\' data lawfully and obtaining their consents; we process it as the Privacy Policy describes.',
      ]],
      ['Acceptable use', [
        'You may not use the service for anything unlawful, to send messages to people who did not agree to receive them, to try to break into, disrupt or reach others\' data in the system, or to resell the service without an agreement with us.',
      ]],
      ['Medical disclaimer', [
        'The system is a management tool and does not give medical advice. Medical decisions, diagnosis and treatment are the practitioner\'s responsibility alone; any suggestions the system shows (including AI features) are only an aid and need the doctor\'s review.',
      ]],
      ['Availability', [
        'We aim to keep the service running at all times; it may stop for short periods for maintenance or for reasons beyond our control, and we announce planned maintenance in advance where we can.',
      ]],
      ['Third-party services', [
        'Some features work through third-party services such as WhatsApp, Google and payment gateways, and using them is also subject to those providers\' terms.',
      ]],
      ['Intellectual property', [
        'The system, its design and software are ours. The content a clinic adds is the clinic\'s, and it allows us to host and process it only as needed to provide the service.',
      ]],
      ['Limitation of liability', [
        'To the extent the law allows, we are not liable for indirect damages or lost profits, and our total liability does not exceed what the clinic paid us in the previous twelve months.',
      ]],
      ['Ending the service', [
        'You can close your account at any time. We may suspend an account that breaches these terms, after notice where possible. After the account ends, its data stays available for export for 30 days.',
      ]],
      ['Changes to these terms', [
        'We may change these terms; the new date is shown at the top of the page, and clinics are told by e-mail of any significant change. Continuing to use the service afterwards means you accept them.',
      ]],
      ['Governing law', [
        'These terms are governed by the laws of the Hashemite Kingdom of Jordan, and the courts of Amman have jurisdiction over any dispute arising from them.',
      ]],
    ],
    contact: 'To contact us about these terms: {email}',
  },
};

const fill = (s, v) => String(s).replace(/\{(brand|email)\}/g, (m, k) => v[k] || '');
/** The page in a language, with the brand and contact e-mail filled in. kind: 'privacy' | 'terms'. */
function page(kind, locale, vars) {
  const src = (kind === 'terms' ? terms : privacy)[locale === 'en' ? 'en' : 'ar'];
  return {
    kind, updated: UPDATED, title: fill(src.title, vars), intro: fill(src.intro, vars),
    sections: src.sections.map(([h, ps]) => ({ h: fill(h, vars), ps: ps.map((p) => fill(p, vars)) })),
    contact: vars.email ? fill(src.contact, vars) : null,
  };
}

module.exports = { UPDATED, page };

// A starter sales kit: a service agreement template (Arabic and English) with {placeholders}, the quotation services
// made from the platform's active plans (monthly and yearly) plus onboarding services, and default quotation terms in
// Seller details. Only what is missing is added: nothing the admin wrote or changed is touched.
const AGREEMENT_AR = `# اتفاقية اشتراك في خدمة {seller_name}

أُبرمت هذه الاتفاقية بتاريخ {date} بين:
- **مقدّم الخدمة:** {seller_name}.
- **المشترك:** {company_name}، ويمثّله {customer_name}.

## 1. الخدمة
يوفّر مقدّم الخدمة للمشترك نظام إدارة العيادات عبر الإنترنت، ويشمل بحسب الباقة: المواعيد والحجز الإلكتروني، والاستقبال والصندوق، وملفات المرضى، والفوترة، وموقع العيادة، والتذكيرات، والتقارير.

## 2. الباقة والرسوم
- الباقة: **{plan}**.
- الرسوم: **{price}** عن كل {period}، وتُدفع مقدّماً.
- تبدأ الخدمة بتاريخ {start_date}، وتتجدد تلقائياً لمدة مماثلة ما لم يُبلّغ أحد الطرفين الآخر برغبته في عدم التجديد قبل نهاية المدة.

## 3. البيانات والخصوصية
- بيانات العيادة والمرضى ملك للمشترك، ويستخدمها مقدّم الخدمة فقط لتقديم الخدمة.
- يستطيع المشترك تصدير بياناته في أي وقت، وتُسلَّم له نسخة منها عند انتهاء الاتفاقية بناءً على طلبه.
- يلتزم الطرفان بالمحافظة على سرية المعلومات التي يطّلعان عليها بموجب هذه الاتفاقية.

## 4. الدعم والتوفّر
- يقدّم مقدّم الخدمة الدعم الفني عبر البريد الإلكتروني وواتساب خلال أيام العمل.
- تُجرى أعمال الصيانة المجدولة في أوقات قليلة الاستخدام قدر الإمكان، مع إشعار مسبق.

## 5. الإنهاء
- يحق لأي من الطرفين إنهاء الاتفاقية بإشعار خطي مدته 30 يوماً.
- لا تُستردّ الرسوم المدفوعة عن مدة بدأت، ما لم يتفق الطرفان على غير ذلك.

## 6. أحكام عامة
تخضع هذه الاتفاقية للقوانين المعمول بها في {jurisdiction}، وأي تعديل عليها يكون كتابياً وبموافقة الطرفين.

**عن مقدّم الخدمة:** {seller_name}
**عن المشترك:** {customer_name} — {company_name}`;

const AGREEMENT_EN = `# {seller_name} service subscription agreement

This agreement is made on {date} between:
- **Provider:** {seller_name}.
- **Subscriber:** {company_name}, represented by {customer_name}.

## 1. The service
The provider gives the subscriber access to its online clinic management system, including, depending on the plan: appointments and online booking, front desk and cashier, patient records, billing, the clinic website, reminders and reports.

## 2. Plan and fees
- Plan: **{plan}**.
- Fees: **{price}** per {period}, paid in advance.
- The service starts on {start_date} and renews for the same period unless either party gives notice before the period ends.

## 3. Data and privacy
- The clinic's and its patients' data belong to the subscriber; the provider uses it only to deliver the service.
- The subscriber can export its data at any time, and receives a copy on request when the agreement ends.
- Both parties keep confidential the information they receive under this agreement.

## 4. Support and availability
- The provider offers technical support by e-mail and WhatsApp on working days.
- Planned maintenance is done at low-usage times where possible, with notice.

## 5. Termination
- Either party may end the agreement with 30 days' written notice.
- Fees paid for a period already started are not refunded unless agreed otherwise.

## 6. General
This agreement is governed by the laws in force in {jurisdiction}; any change must be in writing and agreed by both parties.

**For the provider:** {seller_name}
**For the subscriber:** {customer_name} — {company_name}`;

const TERMS_AR = `- الأسعار غير شاملة ضريبة القيمة المضافة إلا إذا ذُكرت.
- يسري عرض السعر حتى تاريخ صلاحيته المذكور أعلاه.
- يبدأ الاشتراك عند استلام الدفعة الأولى، ويُجدَّد تلقائياً ما لم يُطلب غير ذلك.
- يشمل الاشتراك التحديثات والدعم الفني خلال مدته.`;
const TERMS_EN = `- Prices exclude VAT unless stated.
- This quotation is valid until the date shown above.
- The subscription starts when the first payment is received and renews unless cancelled.
- Updates and technical support are included during the subscription.`;

const NAMES = ['اتفاقية اشتراك في الخدمة', 'Service subscription agreement'];

exports.up = async (knex) => {
  if (await knex.schema.hasTable('document_templates')) {
    for (const [name, locale, body] of [[NAMES[0], 'ar', AGREEMENT_AR], [NAMES[1], 'en', AGREEMENT_EN]]) { // eslint-disable-line no-restricted-syntax
      if (!(await knex('document_templates').where({ name }).first('id'))) await knex('document_templates').insert({ name, locale, body, active: true, kind: 'text' }); // eslint-disable-line no-await-in-loop
    }
  }
  if (await knex.schema.hasTable('sales_services') && await knex.schema.hasTable('subscription_plans')) {
    const plans = await knex('subscription_plans').where({ is_active: true, is_public: true }).orderBy('sort_order').select('name', 'name_en', 'price_monthly', 'price_yearly');
    const rows = [];
    plans.forEach((p, i) => {
      if (Number(p.price_monthly) > 0) rows.push({ name_ar: `باقة ${p.name} — اشتراك شهري`, name_en: `${p.name_en || p.name} plan — monthly`, unit_ar: 'شهر', unit_en: 'month', price: p.price_monthly, sort: i * 10 + 1 });
      if (Number(p.price_yearly) > 0) rows.push({ name_ar: `باقة ${p.name} — اشتراك سنوي`, name_en: `${p.name_en || p.name} plan — yearly`, unit_ar: 'سنة', unit_en: 'year', price: p.price_yearly, sort: i * 10 + 2 });
    });
    rows.push(
      { name_ar: 'الإعداد وتدريب الفريق', name_en: 'Setup and team training', description_ar: 'إعداد الأطباء والخدمات والدوام، وتدريب الاستقبال والأطباء على النظام.', description_en: 'Setting up doctors, services and hours, and training the front desk and doctors.', unit_ar: 'مرة واحدة', unit_en: 'one time', price: 0, sort: 900 },
      { name_ar: 'نقل البيانات من النظام السابق', name_en: 'Data migration from the previous system', description_ar: 'استيراد المرضى والمواعيد والملفات من النظام السابق.', description_en: 'Importing patients, appointments and files from the previous system.', unit_ar: 'مرة واحدة', unit_en: 'one time', price: 0, sort: 910 },
    );
    for (const r of rows) { // eslint-disable-line no-restricted-syntax
      if (!(await knex('sales_services').where({ name_ar: r.name_ar }).orWhere({ name_en: r.name_en }).first('id'))) await knex('sales_services').insert({ active: true, ...r }); // eslint-disable-line no-await-in-loop
    }
  }
  if (await knex.schema.hasTable('platform_settings')) {
    const row = await knex('platform_settings').where({ key: 'sales_profile' }).first('value');
    let p = {};
    try { p = JSON.parse((row && row.value) || '{}') || {}; } catch { p = {}; }
    let changed = false;
    if (!p.terms_ar) { p.terms_ar = TERMS_AR; changed = true; }
    if (!p.terms_en) { p.terms_en = TERMS_EN; changed = true; }
    if (changed) {
      const value = JSON.stringify(p);
      await knex('platform_settings').insert({ key: 'sales_profile', value }).onConflict('key').merge({ value, updated_at: new Date() });
    }
  }
};

exports.down = async (knex) => {
  if (await knex.schema.hasTable('document_templates')) await knex('document_templates').whereIn('name', NAMES).del();
};

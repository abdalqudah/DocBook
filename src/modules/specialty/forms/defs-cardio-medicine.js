// Heart, lungs and internal medicine: cardiac assessment (ECG / echo, QTc), CHA2DS2-VASc, HAS-BLED, spirometry,
// CURB-65, qSOFA, diabetes review, thyroid, kidney function (CKD-EPI 2021 + KDIGO), liver scores, full blood count.
const { result, sum, num, round } = require('./engine');

const yes = (ar, en, pts = 1) => ({ t: 'sel', ar, en, opts: [[0, 'لا', 'No'], [pts, `نعم (+${pts})`, `Yes (+${pts})`]] });
const sexField = { k: 'sex', t: 'sel', ar: 'الجنس', en: 'Sex', opts: [['male', 'ذكر', 'Male'], ['female', 'أنثى', 'Female']], prefill: (p) => (p.sex === 'male' || p.sex === 'female' ? p.sex : undefined) };
const ageField = { k: 'age', t: 'int', ar: 'العمر', en: 'Age', unit: 'y', min: 0, max: 120, prefill: (p) => (p.ageYears ?? undefined) };
const bmiOf = (w, h) => (w && h ? w / ((h / 100) ** 2) : null);
const BMI_BANDS = [[18.5, 'warn', 'نقص وزن', 'Underweight'], [25, 'ok', 'وزن طبيعي', 'Normal weight'], [30, 'mild', 'زيادة وزن', 'Overweight'],
  [35, 'warn', 'سمنة درجة 1', 'Obesity class I'], [40, 'bad', 'سمنة درجة 2', 'Obesity class II'], [null, 'bad', 'سمنة درجة 3', 'Obesity class III']];

const cardio = {
  key: 'cardiac_assessment', v: 1, icon: 'heart-pulse', ar: 'تقييم القلب (تخطيط وإيكو)', en: 'Cardiac assessment (ECG & echo)',
  specialties: ['cardiology'],
  cite: 'QTc by Bazett (QT ÷ √RR); heart failure by LVEF (ESC 2021: reduced ≤ 40%, mildly reduced 41–49%); NYHA functional class.',
  sections: [
    { ar: 'العلامات والأعراض', en: 'Signs and symptoms', fields: [
      { k: 'sbp', t: 'int', ar: 'الضغط الانقباضي', en: 'Systolic BP', unit: 'mmHg', min: 50, max: 300, trend: true },
      { k: 'dbp', t: 'int', ar: 'الضغط الانبساطي', en: 'Diastolic BP', unit: 'mmHg', min: 20, max: 200 },
      { k: 'hr', t: 'int', ar: 'النبض', en: 'Heart rate', unit: 'bpm', min: 20, max: 250, trend: true },
      { k: 'nyha', t: 'sel', ar: 'التصنيف الوظيفي NYHA', en: 'NYHA class', opts: [['I', 'I — لا قيود', 'I — no limitation'], ['II', 'II — قيود خفيفة', 'II — slight limitation'], ['III', 'III — قيود واضحة', 'III — marked limitation'], ['IV', 'IV — أعراض أثناء الراحة', 'IV — symptoms at rest']] },
      { k: 'ccs', t: 'sel', ar: 'الذبحة (CCS)', en: 'Angina (CCS)', opts: [['0', 'لا يوجد', 'None'], ['I', 'I', 'I'], ['II', 'II', 'II'], ['III', 'III', 'III'], ['IV', 'IV', 'IV']] },
    ] },
    { ar: 'تخطيط القلب', en: 'ECG', fields: [
      { k: 'rhythm', t: 'sel', ar: 'النظم', en: 'Rhythm', opts: [['sinus', 'نظم جيبي', 'Sinus rhythm'], ['af', 'رجفان أذيني', 'Atrial fibrillation'], ['flutter', 'رفرفة أذينية', 'Atrial flutter'], ['svt', 'تسرّع فوق بطيني', 'SVT'], ['paced', 'منظّم', 'Paced'], ['other', 'آخر', 'Other']] },
      { k: 'rate', t: 'int', ar: 'المعدل', en: 'Rate', unit: 'bpm', min: 20, max: 250 },
      { k: 'pr', t: 'int', ar: 'PR', en: 'PR', unit: 'ms', min: 40, max: 500 },
      { k: 'qrs', t: 'int', ar: 'QRS', en: 'QRS', unit: 'ms', min: 40, max: 250 },
      { k: 'qt', t: 'int', ar: 'QT', en: 'QT', unit: 'ms', min: 200, max: 700 },
      { k: 'ecg_notes', t: 'text', ar: 'ملاحظات التخطيط', en: 'ECG findings' },
    ] },
    { ar: 'الإيكو', en: 'Echocardiogram', fields: [
      { k: 'ef', t: 'int', ar: 'الكسر القذفي (EF)', en: 'LVEF', unit: '%', min: 5, max: 85, trend: true },
      { k: 'lvedd', t: 'int', ar: 'قطر البطين الأيسر الانبساطي', en: 'LVEDD', unit: 'mm', min: 20, max: 90 },
      { k: 'la', t: 'int', ar: 'الأذين الأيسر', en: 'Left atrium', unit: 'mm', min: 15, max: 80 },
      { k: 'pasp', t: 'int', ar: 'ضغط الشريان الرئوي', en: 'PASP', unit: 'mmHg', min: 10, max: 120 },
      { k: 'valves', t: 'area', ar: 'الصمامات وملاحظات أخرى', en: 'Valves and other findings', wide: true },
    ] },
    { ar: 'بيانات للحساب', en: 'For calculation', fields: [sexField] },
  ],
  compute(d) {
    const rate = num(d.rate) ?? num(d.hr); const qt = num(d.qt);
    const female = d.sex === 'female';
    const qtc = rate && qt ? qt / Math.sqrt(60 / rate) : null;
    const ef = num(d.ef);
    return [
      result('qtc', 'QTc (بازيت)', 'QTc (Bazett)', qtc, { unit: 'ms', d: 0, bands: [[female ? 461 : 451, 'ok', 'طبيعي', 'Normal'], [501, 'warn', 'مطوّل', 'Prolonged'], [null, 'bad', 'مطوّل جدًا (> 500)', 'Markedly prolonged (> 500)']] }),
      result('ef', 'الكسر القذفي', 'LVEF', ef, { unit: '%', d: 0, bands: [[41, 'bad', 'منخفض (HFrEF ≤ 40%)', 'Reduced (≤ 40%)'], [50, 'warn', 'منخفض قليلًا (41–49%)', 'Mildly reduced (41–49%)'], [null, 'ok', 'محفوظ (≥ 50%)', 'Preserved (≥ 50%)']] }),
      num(d.sbp) !== null && num(d.dbp) !== null ? result('bp', 'الضغط', 'Blood pressure', `${d.sbp}/${d.dbp}`, { unit: 'mmHg', level: d.sbp >= 180 || d.dbp >= 110 ? 'bad' : d.sbp >= 140 || d.dbp >= 90 ? 'warn' : 'ok' }) : null,
      d.rhythm === 'af' || d.rhythm === 'flutter' ? result('af', 'النظم', 'Rhythm', d.rhythm === 'af' ? 'AF' : 'Flutter', { level: 'warn', text: { ar: 'احسب CHA₂DS₂-VASc', en: 'Assess CHA₂DS₂-VASc' } }) : null,
    ];
  },
};

const chads = {
  key: 'cha2ds2vasc', v: 1, icon: 'activity', ar: 'خطر الجلطة في الرجفان الأذيني (CHA₂DS₂-VASc)', en: 'Stroke risk in AF (CHA₂DS₂-VASc)',
  specialties: ['cardiology', 'internal', 'neurology', 'geriatrics', 'family'],
  cite: 'Lip GY et al. Chest 2010;137:263–72. Oral anticoagulation recommended at ≥ 2 (men) / ≥ 3 (women), considered at 1 / 2 (ESC 2020).',
  sections: [{ ar: 'العوامل', en: 'Risk factors', fields: [
    { k: 'chf', ...yes('قصور القلب / ضعف البطين', 'Heart failure / LV dysfunction') },
    { k: 'htn', ...yes('ارتفاع ضغط الدم', 'Hypertension') },
    { k: 'age', t: 'sel', ar: 'العمر', en: 'Age', opts: [[0, 'أقل من 65', 'Under 65'], [1, '65–74 (+1)', '65–74 (+1)'], [2, '75 فأكثر (+2)', '75 or over (+2)']], prefill: (p) => (p.ageYears == null ? undefined : p.ageYears >= 75 ? 2 : p.ageYears >= 65 ? 1 : 0) },
    { k: 'dm', ...yes('السكري', 'Diabetes') },
    { k: 'stroke', ...yes('جلطة دماغية / نقص تروية عابر / انصمام سابق', 'Prior stroke / TIA / thromboembolism', 2) },
    { k: 'vasc', ...yes('مرض وعائي (جلطة قلبية، شرايين طرفية، لويحة أبهرية)', 'Vascular disease (MI, PAD, aortic plaque)') },
    { k: 'sex', t: 'sel', ar: 'الجنس', en: 'Sex', opts: [[0, 'ذكر', 'Male'], [1, 'أنثى (+1)', 'Female (+1)']], prefill: (p) => (p.sex === 'female' ? 1 : p.sex === 'male' ? 0 : undefined) },
  ] }],
  compute(d) {
    const s = sum(d, ['chf', 'htn', 'age', 'dm', 'stroke', 'vasc', 'sex']);
    if (s === null) return [];
    const f = d.sex === 1;
    const lvl = s >= (f ? 3 : 2) ? 'bad' : s >= (f ? 2 : 1) ? 'warn' : 'ok';
    const text = { ok: { ar: 'خطر منخفض — لا يلزم مضاد تخثر', en: 'Low risk — no anticoagulation' }, warn: { ar: 'يُنظر في مضاد التخثر', en: 'Consider anticoagulation' }, bad: { ar: 'يوصى بمضاد التخثر الفموي', en: 'Oral anticoagulation recommended' } }[lvl];
    return [result('score', 'المجموع', 'Score', s, { unit: '/9', level: lvl, text })];
  },
};

const hasbled = {
  key: 'has_bled', v: 1, icon: 'droplet', ar: 'خطر النزيف (HAS-BLED)', en: 'Bleeding risk (HAS-BLED)',
  specialties: ['cardiology', 'haematology', 'internal'],
  cite: 'Pisters R et al. Chest 2010;138:1093–100. A score ≥ 3 means high bleeding risk: address modifiable factors and review more often.',
  sections: [{ ar: 'العوامل (نقطة لكل منها)', en: 'Factors (1 point each)', fields: [
    { k: 'h', ...yes('ضغط غير منضبط (انقباضي > 160)', 'Uncontrolled hypertension (SBP > 160)') },
    { k: 'renal', ...yes('خلل كلوي', 'Abnormal renal function') },
    { k: 'liver', ...yes('خلل كبدي', 'Abnormal liver function') },
    { k: 's', ...yes('جلطة دماغية سابقة', 'Prior stroke') },
    { k: 'b', ...yes('نزيف سابق أو استعداد للنزيف', 'Bleeding history or predisposition') },
    { k: 'l', ...yes('INR غير مستقر', 'Labile INR') },
    { k: 'e', ...yes('العمر فوق 65', 'Elderly (> 65)'), prefill: (p) => (p.ageYears == null ? undefined : p.ageYears > 65 ? 1 : 0) },
    { k: 'drugs', ...yes('أدوية (مضادات الصفائح / مسكنات NSAID)', 'Drugs (antiplatelets / NSAIDs)') },
    { k: 'alcohol', ...yes('كحول', 'Alcohol') },
  ] }],
  compute(d) {
    const s = sum(d, ['h', 'renal', 'liver', 's', 'b', 'l', 'e', 'drugs', 'alcohol'], { partial: true });
    return [result('score', 'المجموع', 'Score', s, { unit: '/9', bands: [[3, 'ok', 'خطر نزيف منخفض إلى متوسط', 'Low to moderate bleeding risk'], [null, 'warn', 'خطر نزيف مرتفع — عالج العوامل القابلة للتعديل', 'High bleeding risk — address modifiable factors']] })];
  },
};

const spirometry = {
  key: 'spirometry', v: 1, icon: 'wind', ar: 'فحص وظائف الرئة', en: 'Spirometry',
  specialties: ['pulmonology', 'allergy'],
  cite: 'Obstruction when FEV1/FVC < 0.70 and GOLD grade by FEV1 % predicted (GOLD 2024); significant bronchodilator response ≥ 12% and ≥ 200 mL.',
  sections: [
    { ar: 'القياسات', en: 'Measurements', fields: [
      { k: 'fev1', t: 'num', ar: 'FEV1', en: 'FEV1', unit: 'L', min: 0.1, max: 8, step: 0.01, trend: true },
      { k: 'fvc', t: 'num', ar: 'FVC', en: 'FVC', unit: 'L', min: 0.1, max: 10, step: 0.01 },
      { k: 'fev1_pred', t: 'int', ar: 'FEV1 من المتوقع', en: 'FEV1 % predicted', unit: '%', min: 5, max: 200 },
      { k: 'fvc_pred', t: 'int', ar: 'FVC من المتوقع', en: 'FVC % predicted', unit: '%', min: 5, max: 200 },
      { k: 'pef', t: 'int', ar: 'ذروة التدفق (PEF)', en: 'Peak flow (PEF)', unit: 'L/min', min: 30, max: 900, trend: true },
      { k: 'fev1_post', t: 'num', ar: 'FEV1 بعد موسّع القصبات', en: 'FEV1 after bronchodilator', unit: 'L', min: 0.1, max: 8, step: 0.01 },
    ] },
    { ar: 'الأعراض', en: 'Symptoms', fields: [
      { k: 'spo2', t: 'int', ar: 'تشبع الأكسجين', en: 'SpO₂', unit: '%', min: 50, max: 100 },
      { k: 'mmrc', t: 'sel', ar: 'ضيق النفس (mMRC)', en: 'Breathlessness (mMRC)', opts: [[0, '0 — مع الجهد الشديد فقط', '0 — only with strenuous exercise'], [1, '1 — عند الإسراع أو صعود مرتفع', '1 — hurrying or walking up a slight hill'], [2, '2 — أبطأ من أقرانه', '2 — slower than people of same age'], [3, '3 — يتوقف بعد 100 متر', '3 — stops after 100 m'], [4, '4 — لا يغادر البيت', '4 — too breathless to leave the house']] },
      { k: 'notes', t: 'area', ar: 'ملاحظات', en: 'Notes', wide: true },
    ] },
  ],
  compute(d) {
    const fev1 = num(d.fev1); const fvc = num(d.fvc); const pred = num(d.fev1_pred); const post = num(d.fev1_post);
    const ratio = fev1 && fvc ? fev1 / fvc : null;
    const out = [result('ratio', 'FEV1/FVC', 'FEV1/FVC', ratio, { d: 2, bands: [[0.7, 'warn', 'انسداد في مجرى الهواء', 'Airflow obstruction'], [null, 'ok', 'لا انسداد', 'No obstruction']] })];
    if (ratio !== null && ratio < 0.7 && pred !== null) {
      const g = pred >= 80 ? 1 : pred >= 50 ? 2 : pred >= 30 ? 3 : 4;
      out.push(result('gold', 'درجة GOLD', 'GOLD grade', `GOLD ${g}`, { level: g <= 1 ? 'mild' : g === 2 ? 'warn' : 'bad', text: { ar: ['', 'خفيف', 'متوسط', 'شديد', 'شديد جدًا'][g], en: ['', 'Mild', 'Moderate', 'Severe', 'Very severe'][g] } }));
    }
    if (fev1 && post) {
      const pct = ((post - fev1) / fev1) * 100;
      out.push(result('bdr', 'الاستجابة لموسّع القصبات', 'Bronchodilator response', pct, { unit: '%', d: 0, level: pct >= 12 && post - fev1 >= 0.2 ? 'mild' : 'ok', text: pct >= 12 && post - fev1 >= 0.2 ? { ar: 'استجابة واضحة (≥ 12% و ≥ 200 مل)', en: 'Significant (≥ 12% and ≥ 200 mL)' } : { ar: 'غير واضحة', en: 'Not significant' } }));
    }
    const spo2 = num(d.spo2);
    if (spo2 !== null && spo2 < 92) out.push(result('spo2', 'تشبع الأكسجين', 'SpO₂', spo2, { unit: '%', level: spo2 < 88 ? 'bad' : 'warn', text: { ar: 'منخفض', en: 'Low' } }));
    return out;
  },
};

const curb = {
  key: 'curb65', v: 1, icon: 'thermometer', ar: 'شدة ذات الرئة (CURB-65)', en: 'Pneumonia severity (CURB-65)',
  specialties: ['pulmonology', 'infectious', 'internal', 'general', 'family'],
  cite: 'Lim WS et al. Thorax 2003;58:377–82.',
  sections: [{ ar: 'المعايير (نقطة لكل منها)', en: 'Criteria (1 point each)', fields: [
    { k: 'c', ...yes('تشوّش ذهني جديد', 'New confusion') },
    { k: 'u', ...yes('اليوريا > 7 ملمول/ل (BUN > 19 ملغ/دل)', 'Urea > 7 mmol/L (BUN > 19 mg/dL)') },
    { k: 'r', ...yes('معدل التنفس ≥ 30/دقيقة', 'Respiratory rate ≥ 30/min') },
    { k: 'b', ...yes('ضغط انقباضي < 90 أو انبساطي ≤ 60', 'SBP < 90 or DBP ≤ 60') },
    { k: 'a', ...yes('العمر ≥ 65', 'Age ≥ 65'), prefill: (p) => (p.ageYears == null ? undefined : p.ageYears >= 65 ? 1 : 0) },
  ] }],
  compute(d) {
    const s = sum(d, ['c', 'u', 'r', 'b', 'a'], { partial: true });
    return [result('score', 'المجموع', 'Score', s, { unit: '/5', bands: [[2, 'ok', 'خطر منخفض — يُنظر في العلاج المنزلي', 'Low risk — consider home treatment'], [3, 'warn', 'خطر متوسط — يُنظر في الإدخال', 'Moderate — consider hospital care'], [null, 'bad', 'خطر مرتفع — إدخال المستشفى (العناية عند 4–5)', 'High — hospital care (ICU at 4–5)']] })];
  },
};

const qsofa = {
  key: 'qsofa', v: 1, icon: 'triangle-alert', ar: 'خطر الإنتان (qSOFA)', en: 'Sepsis risk (qSOFA)',
  specialties: ['infectious', 'internal', 'general', 'family'],
  cite: 'Seymour CW et al. JAMA 2016;315:762–74. A score ≥ 2 with suspected infection means a higher risk of a poor outcome.',
  sections: [{ ar: 'المعايير', en: 'Criteria', fields: [
    { k: 'rr', ...yes('معدل التنفس ≥ 22/دقيقة', 'Respiratory rate ≥ 22/min') },
    { k: 'ms', ...yes('تغيّر في الوعي (GCS < 15)', 'Altered mentation (GCS < 15)') },
    { k: 'sbp', ...yes('ضغط انقباضي ≤ 100', 'Systolic BP ≤ 100') },
  ] }],
  compute(d) {
    const s = sum(d, ['rr', 'ms', 'sbp'], { partial: true });
    return [result('score', 'المجموع', 'Score', s, { unit: '/3', bands: [[2, 'ok', 'خطر أقل', 'Lower risk'], [null, 'bad', 'خطر مرتفع — قيّم للإنتان فورًا', 'High risk — assess for sepsis now']] })];
  },
};

const diabetes = {
  key: 'diabetes_review', v: 1, icon: 'droplet', ar: 'متابعة السكري', en: 'Diabetes review',
  specialties: ['endocrinology', 'internal', 'family', 'general'],
  cite: 'Glycaemic target HbA1c < 7% for most adults; foot risk by the IWGDF 2023 screening (monofilament, pulses, ulcer).',
  sections: [
    { ar: 'السكر', en: 'Glucose', fields: [
      { k: 'type', t: 'sel', ar: 'النوع', en: 'Type', opts: [['t1', 'النوع الأول', 'Type 1'], ['t2', 'النوع الثاني', 'Type 2'], ['gdm', 'سكري الحمل', 'Gestational'], ['pre', 'ما قبل السكري', 'Prediabetes'], ['other', 'آخر', 'Other']] },
      { k: 'hba1c', t: 'num', ar: 'السكر التراكمي (HbA1c)', en: 'HbA1c', unit: '%', min: 3, max: 20, step: 0.1, trend: true },
      { k: 'fpg', t: 'int', ar: 'سكر صائم', en: 'Fasting glucose', unit: 'mg/dL', min: 20, max: 800, trend: true },
      { k: 'hypos', t: 'int', ar: 'نوبات هبوط منذ آخر زيارة', en: 'Hypos since last visit', min: 0, max: 200 },
      { k: 'regimen', t: 'multi', ar: 'العلاج', en: 'Treatment', opts: [['diet', 'حمية', 'Diet'], ['metformin', 'ميتفورمين', 'Metformin'], ['su', 'سلفونيل يوريا', 'Sulfonylurea'], ['dpp4', 'مثبطات DPP-4', 'DPP-4 inhibitor'], ['sglt2', 'مثبطات SGLT2', 'SGLT2 inhibitor'], ['glp1', 'محفزات GLP-1', 'GLP-1 agonist'], ['basal', 'إنسولين قاعدي', 'Basal insulin'], ['bolus', 'إنسولين قاعدي ووجبات', 'Basal-bolus insulin'], ['pump', 'مضخة إنسولين', 'Insulin pump']] },
    ] },
    { ar: 'الجسم والضغط والدهون', en: 'Body, BP and lipids', fields: [
      { k: 'weight', t: 'num', ar: 'الوزن', en: 'Weight', unit: 'kg', min: 2, max: 400, step: 0.1, trend: true },
      { k: 'height', t: 'num', ar: 'الطول', en: 'Height', unit: 'cm', min: 40, max: 250, step: 0.5 },
      { k: 'sbp', t: 'int', ar: 'الضغط الانقباضي', en: 'Systolic BP', unit: 'mmHg', min: 50, max: 300 },
      { k: 'dbp', t: 'int', ar: 'الضغط الانبساطي', en: 'Diastolic BP', unit: 'mmHg', min: 20, max: 200 },
      { k: 'ldl', t: 'int', ar: 'الكوليسترول الضار (LDL)', en: 'LDL cholesterol', unit: 'mg/dL', min: 10, max: 600 },
      { k: 'acr', t: 'num', ar: 'الألبومين/الكرياتينين في البول', en: 'Urine albumin/creatinine', unit: 'mg/g', min: 0, max: 10000, step: 0.1 },
    ] },
    { ar: 'القدم والعين', en: 'Feet and eyes', fields: [
      { k: 'mono', t: 'sel', side: 'lr', ar: 'خيط الإحساس (مونوفيلامنت)', en: 'Monofilament', opts: [['felt', 'يشعر', 'Felt'], ['not', 'لا يشعر', 'Not felt']] },
      { k: 'pulses', t: 'sel', side: 'lr', ar: 'نبض القدم', en: 'Foot pulses', opts: [['present', 'موجود', 'Present'], ['reduced', 'ضعيف', 'Reduced'], ['absent', 'غائب', 'Absent']] },
      { k: 'ulcer', t: 'bool', ar: 'قرحة أو بتر سابق', en: 'Ulcer or previous amputation' },
      { k: 'retina', t: 'sel', ar: 'فحص الشبكية', en: 'Retinal screening', opts: [['none', 'لا اعتلال', 'No retinopathy'], ['npdr', 'اعتلال غير تكاثري', 'NPDR'], ['pdr', 'اعتلال تكاثري', 'PDR'], ['dme', 'وذمة بقعية', 'Macular oedema'], ['not_done', 'لم يُفحص بعد', 'Not done yet']] },
    ] },
  ],
  compute(d) {
    const out = [result('hba1c', 'HbA1c', 'HbA1c', num(d.hba1c), { unit: '%', bands: [[7, 'ok', 'ضمن الهدف المعتاد (< 7%)', 'At the usual target (< 7%)'], [9, 'warn', 'أعلى من الهدف', 'Above target'], [null, 'bad', 'مرتفع كثيرًا', 'Well above target']] })];
    out.push(result('bmi', 'مؤشر كتلة الجسم', 'BMI', bmiOf(num(d.weight), num(d.height)), { unit: 'kg/m²', bands: BMI_BANDS }));
    const loss = d.mono_r === 'not' || d.mono_l === 'not';
    const pad = ['reduced', 'absent'].includes(d.pulses_r) || ['reduced', 'absent'].includes(d.pulses_l);
    if (d.ulcer) out.push(result('foot', 'خطر القدم', 'Foot risk', 'IWGDF 3', { level: 'bad', text: { ar: 'خطر مرتفع جدًا — متابعة كل 1–3 أشهر', en: 'Very high risk — review every 1–3 months' } }));
    else if (loss && pad) out.push(result('foot', 'خطر القدم', 'Foot risk', 'IWGDF 2', { level: 'bad', text: { ar: 'خطر مرتفع — متابعة كل 3–6 أشهر', en: 'High risk — review every 3–6 months' } }));
    else if (loss || pad) out.push(result('foot', 'خطر القدم', 'Foot risk', 'IWGDF 1', { level: 'warn', text: { ar: 'خطر متوسط — متابعة كل 6–12 شهرًا', en: 'Moderate risk — review every 6–12 months' } }));
    else if (d.mono_r || d.mono_l) out.push(result('foot', 'خطر القدم', 'Foot risk', 'IWGDF 0', { level: 'ok', text: { ar: 'خطر منخفض — فحص سنوي', en: 'Low risk — yearly check' } }));
    if (['pdr', 'dme'].includes(d.retina)) out.push(result('retina', 'الشبكية', 'Retina', d.retina.toUpperCase(), { level: 'bad', text: { ar: 'تحويل لطبيب العيون', en: 'Refer to ophthalmology' } }));
    return out;
  },
};

// ACR TI-RADS (2017): fine-needle aspiration / follow-up size thresholds by level, in mm.
const TIRADS = { TR3: [25, 15], TR4: [15, 10], TR5: [10, 5] };
const thyroid = {
  key: 'thyroid', v: 1, icon: 'activity', ar: 'الغدة الدرقية', en: 'Thyroid',
  specialties: ['endocrinology'],
  cite: 'Usual adult TSH reference 0.4–4.0 mIU/L (check your laboratory); nodules by ACR TI-RADS (Tessler FN et al. JACR 2017).',
  sections: [
    { ar: 'التحاليل', en: 'Tests', fields: [
      { k: 'tsh', t: 'num', ar: 'TSH', en: 'TSH', unit: 'mIU/L', min: 0, max: 500, step: 0.01, trend: true },
      { k: 'ft4', t: 'num', ar: 'FT4', en: 'Free T4', unit: 'pmol/L', min: 0, max: 200, step: 0.1, trend: true },
      { k: 'ft3', t: 'num', ar: 'FT3', en: 'Free T3', unit: 'pmol/L', min: 0, max: 60, step: 0.1 },
      { k: 'tpo', t: 'num', ar: 'أجسام مضادة TPO', en: 'Anti-TPO', unit: 'IU/mL', min: 0, max: 10000, step: 0.1 },
    ] },
    { ar: 'الألتراساوند', en: 'Ultrasound', fields: [
      { k: 'nodule_mm', t: 'num', ar: 'أكبر عقدة', en: 'Largest nodule', unit: 'mm', min: 1, max: 120, step: 0.5, trend: true },
      { k: 'tirads', t: 'sel', ar: 'تصنيف TI-RADS', en: 'TI-RADS', opts: [['TR1', 'TR1 — حميد', 'TR1 — benign'], ['TR2', 'TR2 — غير مشبوه', 'TR2 — not suspicious'], ['TR3', 'TR3 — مشبوه قليلًا', 'TR3 — mildly suspicious'], ['TR4', 'TR4 — مشبوه بدرجة متوسطة', 'TR4 — moderately suspicious'], ['TR5', 'TR5 — مشبوه جدًا', 'TR5 — highly suspicious']] },
      { k: 'notes', t: 'area', ar: 'ملاحظات', en: 'Notes', wide: true },
    ] },
  ],
  compute(d) {
    const out = [result('tsh', 'TSH', 'TSH', num(d.tsh), { unit: 'mIU/L', d: 2, bands: [[0.1, 'bad', 'منخفض جدًا', 'Suppressed'], [0.4, 'warn', 'منخفض', 'Low'], [4.01, 'ok', 'ضمن المعتاد', 'Within usual range'], [10, 'warn', 'مرتفع', 'Raised'], [null, 'bad', 'مرتفع كثيرًا', 'Markedly raised']] })];
    const t = TIRADS[d.tirads]; const mm = num(d.nodule_mm);
    if (t && mm !== null) {
      if (mm >= t[0]) out.push(result('fna', 'العقدة', 'Nodule', d.tirads, { level: 'bad', text: { ar: `يوصى بالخزعة بالإبرة (≥ ${t[0] / 10} سم)`, en: `FNA recommended (≥ ${t[0] / 10} cm)` } }));
      else if (mm >= t[1]) out.push(result('fna', 'العقدة', 'Nodule', d.tirads, { level: 'warn', text: { ar: `متابعة بالألتراساوند (≥ ${t[1] / 10} سم)`, en: `Ultrasound follow-up (≥ ${t[1] / 10} cm)` } }));
      else out.push(result('fna', 'العقدة', 'Nodule', d.tirads, { level: 'ok', text: { ar: 'لا خزعة ولا متابعة حسب الحجم', en: 'No FNA or follow-up by size' } }));
    }
    return out;
  },
};

/** eGFR by CKD-EPI 2021 (race-free), creatinine in mg/dL. */
function egfr2021(scr, age, female) {
  if (!scr || !age || age < 18) return null;
  const k = female ? 0.7 : 0.9; const a = female ? -0.241 : -0.302;
  return 142 * Math.min(scr / k, 1) ** a * Math.max(scr / k, 1) ** -1.2 * 0.9938 ** age * (female ? 1.012 : 1);
}
const G_STAGES = [[15, 'bad', 'G5 — فشل كلوي', 'G5 — kidney failure'], [30, 'bad', 'G4 — انخفاض شديد', 'G4 — severely decreased'], [45, 'warn', 'G3b — انخفاض متوسط إلى شديد', 'G3b — moderately to severely decreased'],
  [60, 'warn', 'G3a — انخفاض خفيف إلى متوسط', 'G3a — mildly to moderately decreased'], [90, 'mild', 'G2 — انخفاض خفيف', 'G2 — mildly decreased'], [null, 'ok', 'G1 — طبيعي أو مرتفع', 'G1 — normal or high']];
const gStage = (e) => (e < 15 ? 5 : e < 30 ? 4 : e < 45 ? 3.5 : e < 60 ? 3 : e < 90 ? 2 : 1);
const aStage = (acr) => (acr < 30 ? 1 : acr <= 300 ? 2 : 3);
// KDIGO 2024 heat map: risk by G and A category.
function kdigoRisk(g, a) {
  if (g >= 4) return 'bad';
  if (g === 3.5) return a === 1 ? 'warn' : 'bad';
  if (g === 3) return a === 1 ? 'mild' : a === 2 ? 'warn' : 'bad';
  return a === 1 ? 'ok' : a === 2 ? 'mild' : 'warn';
}
const kidney = {
  key: 'kidney', v: 1, icon: 'flask-conical', ar: 'وظائف الكلى (eGFR وتصنيف KDIGO)', en: 'Kidney function (eGFR & KDIGO)',
  specialties: ['nephrology', 'internal', 'urology', 'geriatrics', 'endocrinology'],
  cite: 'eGFR by the race-free CKD-EPI 2021 creatinine equation (Inker LA et al. NEJM 2021); CKD G and A categories and risk by KDIGO 2024.',
  sections: [{ ar: 'التحاليل', en: 'Tests', fields: [
    { k: 'scr', t: 'num', ar: 'الكرياتينين', en: 'Creatinine', min: 0.1, max: 2000, step: 0.01 },
    { k: 'scr_unit', t: 'sel', ar: 'وحدة الكرياتينين', en: 'Creatinine unit', opts: [['mgdl', 'ملغ/دل (mg/dL)', 'mg/dL'], ['umol', 'ميكرومول/ل (µmol/L)', 'µmol/L']] },
    { k: 'acr', t: 'num', ar: 'الألبومين/الكرياتينين في البول', en: 'Urine albumin/creatinine (ACR)', unit: 'mg/g', min: 0, max: 20000, step: 0.1, trend: true },
    { k: 'k', t: 'num', ar: 'البوتاسيوم', en: 'Potassium', unit: 'mmol/L', min: 1, max: 10, step: 0.1 },
    { k: 'hb', t: 'num', ar: 'الهيموغلوبين', en: 'Haemoglobin', unit: 'g/dL', min: 2, max: 25, step: 0.1 },
    ageField, sexField,
    { k: 'dialysis', t: 'sel', ar: 'غسيل الكلى', en: 'Dialysis', opts: [['none', 'لا', 'None'], ['hd', 'غسيل دموي', 'Haemodialysis'], ['pd', 'غسيل بريتوني', 'Peritoneal dialysis'], ['tx', 'زراعة كلية', 'Kidney transplant']] },
  ] }],
  compute(d) {
    let scr = num(d.scr);
    if (scr !== null && (d.scr_unit === 'umol' || (!d.scr_unit && scr > 20))) scr /= 88.4;
    const e = egfr2021(scr, num(d.age), d.sex === 'female');
    const out = [result('egfr', 'eGFR', 'eGFR', e, { unit: 'mL/min/1.73m²', d: 0, bands: G_STAGES })];
    const acr = num(d.acr);
    if (acr !== null) out.push(result('a', 'فئة الألبومين', 'Albuminuria', `A${aStage(acr)}`, { level: ['ok', 'warn', 'bad'][aStage(acr) - 1], text: [{ ar: 'طبيعي إلى خفيف (< 30)', en: 'Normal to mild (< 30)' }, { ar: 'متوسط (30–300)', en: 'Moderate (30–300)' }, { ar: 'شديد (> 300)', en: 'Severe (> 300)' }][aStage(acr) - 1] }));
    if (e !== null && acr !== null) {
      const r = kdigoRisk(gStage(e), aStage(acr));
      out.push(result('kdigo', 'خطر KDIGO', 'KDIGO risk', { ok: 'Low', mild: 'Moderate', warn: 'High', bad: 'Very high' }[r], { level: r, text: { ok: { ar: 'منخفض', en: 'Low' }, mild: { ar: 'متوسط', en: 'Moderately increased' }, warn: { ar: 'مرتفع', en: 'High' }, bad: { ar: 'مرتفع جدًا', en: 'Very high' } }[r] }));
    }
    const k = num(d.k);
    if (k !== null && (k >= 5.5 || k < 3.5)) out.push(result('k', 'البوتاسيوم', 'Potassium', k, { unit: 'mmol/L', level: k >= 6 || k < 3 ? 'bad' : 'warn', text: k >= 5.5 ? { ar: 'مرتفع', en: 'High' } : { ar: 'منخفض', en: 'Low' } }));
    return out;
  },
};

const liver = {
  key: 'liver_scores', v: 1, icon: 'activity', ar: 'شدة أمراض الكبد (Child-Pugh و MELD)', en: 'Liver disease severity (Child-Pugh & MELD)',
  specialties: ['gastroenterology'],
  cite: 'Child-Turcotte-Pugh classification; MELD (UNOS) and MELD-Na (Kim WR et al. NEJM 2008).',
  sections: [{ ar: 'القيم', en: 'Values', fields: [
    { k: 'bili', t: 'num', ar: 'البيليروبين الكلي', en: 'Total bilirubin', unit: 'mg/dL', min: 0.1, max: 60, step: 0.1, trend: true },
    { k: 'alb', t: 'num', ar: 'الألبومين', en: 'Albumin', unit: 'g/dL', min: 0.5, max: 7, step: 0.1 },
    { k: 'inr', t: 'num', ar: 'INR', en: 'INR', min: 0.5, max: 15, step: 0.01 },
    { k: 'cr', t: 'num', ar: 'الكرياتينين', en: 'Creatinine', unit: 'mg/dL', min: 0.1, max: 20, step: 0.01 },
    { k: 'na', t: 'int', ar: 'الصوديوم', en: 'Sodium', unit: 'mmol/L', min: 100, max: 170 },
    { k: 'dialysis', t: 'bool', ar: 'غسيل كلى مرتين أو أكثر خلال الأسبوع', en: 'Dialysis twice or more in the past week' },
    { k: 'ascites', t: 'sel', ar: 'الاستسقاء', en: 'Ascites', opts: [[1, 'لا يوجد', 'None'], [2, 'خفيف', 'Mild'], [3, 'متوسط إلى شديد', 'Moderate to severe']] },
    { k: 'enceph', t: 'sel', ar: 'اعتلال الدماغ الكبدي', en: 'Encephalopathy', opts: [[1, 'لا يوجد', 'None'], [2, 'درجة 1–2', 'Grade 1–2'], [3, 'درجة 3–4', 'Grade 3–4']] },
  ] }],
  compute(d) {
    const bili = num(d.bili); const alb = num(d.alb); const inr = num(d.inr);
    const out = [];
    if ([bili, alb, inr, d.ascites, d.enceph].every((v) => v !== null && v !== undefined)) {
      const s = (bili < 2 ? 1 : bili <= 3 ? 2 : 3) + (alb > 3.5 ? 1 : alb >= 2.8 ? 2 : 3) + (inr < 1.7 ? 1 : inr <= 2.3 ? 2 : 3) + d.ascites + d.enceph;
      const c = s <= 6 ? 'A' : s <= 9 ? 'B' : 'C';
      out.push(result('cp', 'Child-Pugh', 'Child-Pugh', `${c} (${s})`, { level: { A: 'mild', B: 'warn', C: 'bad' }[c], text: { A: { ar: 'مرض معوَّض', en: 'Well-compensated' }, B: { ar: 'خلل وظيفي واضح', en: 'Significant compromise' }, C: { ar: 'مرض غير معوَّض', en: 'Decompensated' } }[c] }));
    }
    let cr = num(d.cr);
    if (bili !== null && inr !== null && (cr !== null || d.dialysis)) {
      if (d.dialysis || cr > 4) cr = 4;
      const c1 = (v) => Math.max(v, 1);
      let meld = Math.round(10 * (0.957 * Math.log(c1(cr)) + 0.378 * Math.log(c1(bili)) + 1.12 * Math.log(c1(inr)) + 0.643));
      meld = Math.min(Math.max(meld, 6), 40);
      const bands = [[10, 'mild', 'منخفض', 'Low'], [20, 'warn', 'متوسط', 'Intermediate'], [null, 'bad', 'مرتفع', 'High']];
      out.push(result('meld', 'MELD', 'MELD', meld, { d: 0, bands }));
      const na = num(d.na);
      if (na !== null && meld > 11) {
        const n = Math.min(Math.max(na, 125), 137);
        out.push(result('meldna', 'MELD-Na', 'MELD-Na', Math.min(40, Math.round(meld + 1.32 * (137 - n) - 0.033 * meld * (137 - n))), { d: 0, bands }));
      }
    }
    return out;
  },
};

const cbc = {
  key: 'cbc', v: 1, icon: 'test-tube', ar: 'صورة الدم الكاملة', en: 'Full blood count',
  specialties: ['haematology', 'internal', 'oncology', 'infectious', 'paediatrics'],
  cite: 'Anaemia by WHO haemoglobin thresholds (2024) for adults; usual adult reference ranges — check your laboratory.',
  sections: [{ ar: 'القيم', en: 'Values', fields: [
    { k: 'hb', t: 'num', ar: 'الهيموغلوبين', en: 'Haemoglobin', unit: 'g/dL', min: 1, max: 25, step: 0.1, trend: true },
    { k: 'hct', t: 'num', ar: 'الهيماتوكريت', en: 'Haematocrit', unit: '%', min: 5, max: 75, step: 0.1 },
    { k: 'mcv', t: 'num', ar: 'حجم الكرية (MCV)', en: 'MCV', unit: 'fL', min: 40, max: 150, step: 0.1 },
    { k: 'rdw', t: 'num', ar: 'RDW', en: 'RDW', unit: '%', min: 5, max: 40, step: 0.1 },
    { k: 'wbc', t: 'num', ar: 'كريات الدم البيضاء', en: 'White cells', unit: '×10⁹/L', min: 0, max: 500, step: 0.1, trend: true },
    { k: 'neut', t: 'num', ar: 'العدلات', en: 'Neutrophils', unit: '×10⁹/L', min: 0, max: 300, step: 0.01 },
    { k: 'lymph', t: 'num', ar: 'اللمفاويات', en: 'Lymphocytes', unit: '×10⁹/L', min: 0, max: 300, step: 0.01 },
    { k: 'plt', t: 'int', ar: 'الصفائح', en: 'Platelets', unit: '×10⁹/L', min: 0, max: 3000, trend: true },
    { k: 'ferritin', t: 'num', ar: 'الفيريتين', en: 'Ferritin', unit: 'ng/mL', min: 0, max: 100000, step: 0.1 },
    sexField,
  ] }],
  compute(d) {
    const out = [];
    const hb = num(d.hb);
    if (hb !== null) {
      const cut = d.sex === 'male' ? 13 : 12;
      out.push(result('hb', 'الهيموغلوبين', 'Haemoglobin', hb, { unit: 'g/dL', bands: [[8, 'bad', 'فقر دم شديد', 'Severe anaemia'], [11, 'warn', 'فقر دم متوسط', 'Moderate anaemia'], [cut, 'mild', 'فقر دم خفيف', 'Mild anaemia'], [null, 'ok', 'ضمن الطبيعي', 'Normal']] }));
    }
    const mcv = num(d.mcv);
    if (mcv !== null && (mcv < 80 || mcv > 100)) out.push(result('mcv', 'MCV', 'MCV', mcv, { unit: 'fL', level: 'mild', text: mcv < 80 ? { ar: 'كريات صغيرة', en: 'Microcytic' } : { ar: 'كريات كبيرة', en: 'Macrocytic' } }));
    const wbc = num(d.wbc);
    if (wbc !== null && (wbc < 4 || wbc > 11)) out.push(result('wbc', 'البيضاء', 'White cells', wbc, { unit: '×10⁹/L', level: wbc < 2 || wbc > 30 ? 'bad' : 'warn', text: wbc < 4 ? { ar: 'نقص', en: 'Low' } : { ar: 'ارتفاع', en: 'High' } }));
    const n = num(d.neut);
    if (n !== null && n < 1.5) out.push(result('neut', 'العدلات', 'Neutrophils', n, { unit: '×10⁹/L', bands: [[0.5, 'bad', 'نقص شديد', 'Severe neutropenia'], [1, 'warn', 'نقص متوسط', 'Moderate neutropenia'], [null, 'mild', 'نقص خفيف', 'Mild neutropenia']] }));
    const p = num(d.plt);
    if (p !== null && (p < 150 || p > 450)) out.push(result('plt', 'الصفائح', 'Platelets', p, { unit: '×10⁹/L', d: 0, level: p < 50 || p > 1000 ? 'bad' : 'warn', text: p < 150 ? { ar: 'نقص', en: 'Low' } : { ar: 'ارتفاع', en: 'High' } }));
    const f = num(d.ferritin);
    if (f !== null && f < 30) out.push(result('ferritin', 'الفيريتين', 'Ferritin', f, { unit: 'ng/mL', level: 'warn', text: { ar: 'مخزون حديد منخفض', en: 'Low iron stores' } }));
    return out;
  },
};

module.exports = [cardio, chads, hasbled, spirometry, curb, qsofa, diabetes, thyroid, kidney, liver, cbc];
module.exports.egfr2021 = egfr2021;
module.exports.bmiOf = bmiOf;
module.exports.BMI_BANDS = BMI_BANDS;
module.exports.round = round;

// Surgery, cancer, allergy, teeth and the rest: pre-operative assessment (ASA), wound, ankle-brachial index, cancer
// staging (TNM, ECOG), endoscopy (Boston bowel preparation), skin prick test, orthodontic assessment, oral surgery,
// nutrition assessment, daily-living independence (Katz), speech and language, newborn (Apgar).
const { result, sum, num } = require('./engine');
const { bmiOf, BMI_BANDS } = require('./defs-cardio-medicine');

const preop = {
  key: 'preop', v: 1, icon: 'clipboard-check', ar: 'تقييم ما قبل العملية', en: 'Pre-operative assessment',
  specialties: ['general_surgery', 'plastic', 'vascular', 'neurosurgery', 'oral_surgery', 'orthopaedics'],
  cite: 'ASA Physical Status Classification (American Society of Anesthesiologists, 2020); airway by the modified Mallampati class.',
  sections: [
    { ar: 'العملية', en: 'Procedure', fields: [
      { k: 'procedure', t: 'text', ar: 'العملية المقررة', en: 'Planned procedure', req: true },
      { k: 'date', t: 'date', ar: 'التاريخ', en: 'Date' },
      { k: 'anaesthesia', t: 'sel', ar: 'التخدير', en: 'Anaesthesia', opts: [['local', 'موضعي', 'Local'], ['sedation', 'تهدئة', 'Sedation'], ['regional', 'ناحي / نصفي', 'Regional'], ['general', 'عام', 'General']] },
    ] },
    { ar: 'التقييم', en: 'Assessment', fields: [
      { k: 'asa', t: 'sel', ar: 'تصنيف ASA', en: 'ASA class', opts: [[1, 'I — سليم', 'I — healthy'], [2, 'II — مرض جهازي خفيف', 'II — mild systemic disease'], [3, 'III — مرض جهازي شديد', 'III — severe systemic disease'], [4, 'IV — مرض يهدد الحياة باستمرار', 'IV — constant threat to life'], [5, 'V — محتضر', 'V — moribund'], [6, 'VI — متوفى دماغيًا (متبرع)', 'VI — brain-dead donor']] },
      { k: 'emergency', t: 'bool', ar: 'عملية طارئة (E)', en: 'Emergency (E)' },
      { k: 'mallampati', t: 'sel', ar: 'مالامباتي', en: 'Mallampati', opts: [['1', 'I', 'I'], ['2', 'II', 'II'], ['3', 'III', 'III'], ['4', 'IV', 'IV']] },
      { k: 'weight', t: 'num', ar: 'الوزن', en: 'Weight', unit: 'kg', min: 1, max: 400, step: 0.1 },
      { k: 'height', t: 'num', ar: 'الطول', en: 'Height', unit: 'cm', min: 30, max: 250, step: 0.5 },
      { k: 'allergies', t: 'text', ar: 'الحساسية', en: 'Allergies' },
      { k: 'anticoag', t: 'sel', ar: 'مميعات الدم', en: 'Anticoagulants', opts: [['none', 'لا يوجد', 'None'], ['aspirin', 'أسبرين', 'Aspirin'], ['p2y12', 'كلوبيدوغريل وما يشبهه', 'Clopidogrel or similar'], ['warfarin', 'وارفارين', 'Warfarin'], ['doac', 'مميع فموي حديث', 'DOAC'], ['heparin', 'هيبارين', 'Heparin']] },
      { k: 'stopped', t: 'date', ar: 'تاريخ إيقاف المميع', en: 'Anticoagulant stopped on' },
      { k: 'vte', t: 'sel', ar: 'خطر الجلطات الوريدية', en: 'VTE risk', opts: [['low', 'منخفض', 'Low'], ['moderate', 'متوسط', 'Moderate'], ['high', 'مرتفع', 'High']] },
    ] },
    { ar: 'الجاهزية', en: 'Readiness', fields: [
      { k: 'labs', t: 'multi', ar: 'الفحوصات المنجزة', en: 'Tests done', opts: [['cbc', 'صورة دم', 'CBC'], ['coag', 'تخثر', 'Coagulation'], ['rft', 'كلى وأملاح', 'Renal & electrolytes'], ['glucose', 'سكر', 'Glucose'], ['ecg', 'تخطيط قلب', 'ECG'], ['cxr', 'صورة صدر', 'Chest X-ray'], ['group', 'فصيلة دم', 'Group & save'], ['preg', 'فحص حمل', 'Pregnancy test']] },
      { k: 'fasting', t: 'text', ar: 'الصيام منذ', en: 'Fasting since' },
      { k: 'consent', t: 'bool', ar: 'تم توقيع الموافقة', en: 'Consent signed' },
      { k: 'marked', t: 'bool', ar: 'تم تعليم موضع العملية', en: 'Site marked' },
      { k: 'notes', t: 'area', ar: 'ملاحظات', en: 'Notes', wide: true },
    ] },
  ],
  compute(d) {
    const out = [];
    if (d.asa) out.push(result('asa', 'ASA', 'ASA', `${['', 'I', 'II', 'III', 'IV', 'V', 'VI'][d.asa]}${d.emergency ? 'E' : ''}`, { level: d.asa <= 2 ? 'ok' : d.asa === 3 ? 'warn' : 'bad' }));
    out.push(result('bmi', 'مؤشر كتلة الجسم', 'BMI', bmiOf(num(d.weight), num(d.height)), { unit: 'kg/m²', bands: BMI_BANDS }));
    if (['3', '4'].includes(d.mallampati)) out.push(result('airway', 'مجرى الهواء', 'Airway', `Mallampati ${d.mallampati === '3' ? 'III' : 'IV'}`, { level: 'warn', text: { ar: 'تنبيب قد يكون صعبًا', en: 'Possible difficult intubation' } }));
    if (!d.consent) out.push(result('consent', 'الموافقة', 'Consent', '—', { level: 'warn', text: { ar: 'لم تُوقّع بعد', en: 'Not signed yet' } }));
    return out;
  },
};

const wound = {
  key: 'wound', v: 1, icon: 'bandage', ar: 'تقييم الجرح', en: 'Wound assessment',
  specialties: ['general_surgery', 'vascular', 'plastic', 'geriatrics', 'endocrinology'],
  cite: 'Pressure injuries by the NPIAP staging (2016); area = length × width.',
  sections: [
    { ar: 'الجرح', en: 'Wound', fields: [
      { k: 'site', t: 'text', ar: 'المكان', en: 'Site', req: true },
      { k: 'type', t: 'sel', ar: 'النوع', en: 'Aetiology', opts: [['surgical', 'جرح عملية', 'Surgical'], ['traumatic', 'إصابة', 'Traumatic'], ['pressure', 'قرحة فراش', 'Pressure injury'], ['venous', 'قرحة وريدية', 'Venous ulcer'], ['arterial', 'قرحة شريانية', 'Arterial ulcer'], ['diabetic', 'قدم سكري', 'Diabetic foot'], ['burn', 'حرق', 'Burn']] },
      { k: 'stage', t: 'sel', ar: 'درجة قرحة الفراش', en: 'Pressure injury stage', opts: [['1', 'المرحلة 1', 'Stage 1'], ['2', 'المرحلة 2', 'Stage 2'], ['3', 'المرحلة 3', 'Stage 3'], ['4', 'المرحلة 4', 'Stage 4'], ['u', 'غير قابلة للتصنيف', 'Unstageable'], ['dti', 'إصابة أنسجة عميقة', 'Deep tissue injury']] },
      { k: 'length', t: 'num', ar: 'الطول', en: 'Length', unit: 'cm', min: 0, max: 100, step: 0.1 },
      { k: 'width', t: 'num', ar: 'العرض', en: 'Width', unit: 'cm', min: 0, max: 100, step: 0.1 },
      { k: 'depth', t: 'num', ar: 'العمق', en: 'Depth', unit: 'cm', min: 0, max: 30, step: 0.1 },
    ] },
    { ar: 'السرير والإفرازات', en: 'Bed and exudate', fields: [
      { k: 'gran', t: 'int', ar: 'نسيج حبيبي', en: 'Granulation', unit: '%', min: 0, max: 100 },
      { k: 'slough', t: 'int', ar: 'نسيج متموّت رطب', en: 'Slough', unit: '%', min: 0, max: 100 },
      { k: 'necrosis', t: 'int', ar: 'نسيج ميت', en: 'Necrosis', unit: '%', min: 0, max: 100 },
      { k: 'exudate', t: 'sel', ar: 'كمية الإفرازات', en: 'Exudate', opts: [['none', 'لا يوجد', 'None'], ['low', 'قليلة', 'Low'], ['moderate', 'متوسطة', 'Moderate'], ['high', 'كثيرة', 'High']] },
      { k: 'infection', t: 'multi', ar: 'علامات الالتهاب', en: 'Signs of infection', opts: [['erythema', 'احمرار', 'Erythema'], ['warmth', 'سخونة', 'Warmth'], ['swelling', 'تورم', 'Swelling'], ['pus', 'صديد', 'Pus'], ['odour', 'رائحة', 'Odour'], ['pain', 'ألم متزايد', 'Increasing pain']] },
      { k: 'dressing', t: 'text', ar: 'الغيار المستخدم', en: 'Dressing' },
    ] },
  ],
  check(d) { return (num(d.gran) || 0) + (num(d.slough) || 0) + (num(d.necrosis) || 0) > 100 ? { gran: 'The total is more than 100%.' } : {}; },
  compute(d) {
    const l = num(d.length); const w = num(d.width); const dep = num(d.depth);
    const inf = [].concat(d.infection || []);
    return [
      l !== null && w !== null ? result('area', 'المساحة', 'Area', l * w, { unit: 'cm²', d: 1 }) : null,
      l !== null && w !== null && dep !== null ? result('volume', 'الحجم', 'Volume', l * w * dep, { unit: 'cm³', d: 1 }) : null,
      inf.length >= 2 || inf.includes('pus') ? result('infection', 'الالتهاب', 'Infection', inf.length, { level: 'bad', text: { ar: 'علامات التهاب — يُقيَّم', en: 'Signs of infection — assess' } }) : null,
    ];
  },
};

const abi = {
  key: 'abi', v: 1, icon: 'activity', ar: 'مؤشر الكاحل والعضد (ABI)', en: 'Ankle-brachial index (ABI)',
  specialties: ['vascular', 'cardiology', 'endocrinology'],
  cite: 'ABI = higher ankle pressure (DP or PT) ÷ higher brachial pressure (AHA/ACC 2024): > 1.40 non-compressible, 1.00–1.40 normal, 0.91–0.99 borderline, ≤ 0.90 PAD, ≤ 0.40 severe.',
  sections: [{ ar: 'الضغط الانقباضي (mmHg)', en: 'Systolic pressure (mmHg)', fields: [
    { k: 'brachial', t: 'int', side: 'lr', ar: 'العضد', en: 'Brachial', unit: 'mmHg', min: 30, max: 300 },
    { k: 'dp', t: 'int', side: 'lr', ar: 'الظهرية القدمية (DP)', en: 'Dorsalis pedis (DP)', unit: 'mmHg', min: 0, max: 350 },
    { k: 'pt', t: 'int', side: 'lr', ar: 'الظنبوبية الخلفية (PT)', en: 'Posterior tibial (PT)', unit: 'mmHg', min: 0, max: 350 },
  ] }],
  compute(d) {
    const arm = Math.max(num(d.brachial_r) || 0, num(d.brachial_l) || 0);
    if (!arm) return [];
    const bands = [[0.41, 'bad', 'مرض شرياني شديد', 'Severe PAD'], [0.91, 'warn', 'مرض الشرايين الطرفية', 'PAD'], [1, 'mild', 'حدّي', 'Borderline'], [1.41, 'ok', 'طبيعي', 'Normal'], [null, 'warn', 'شرايين متكلسة (غير قابلة للضغط)', 'Non-compressible']];
    return [['r', 'اليمين', 'right'], ['l', 'اليسار', 'left']].map(([s, ar, en]) => {
      const ankle = Math.max(num(d[`dp_${s}`]) || 0, num(d[`pt_${s}`]) || 0);
      return ankle ? result(`abi_${s}`, `ABI ${ar}`, `ABI ${en}`, ankle / arm, { d: 2, bands }) : null;
    });
  },
};

const onc = {
  key: 'cancer_staging', v: 1, icon: 'target', ar: 'تصنيف الورم والعلاج', en: 'Cancer staging & treatment',
  specialties: ['oncology', 'general_surgery', 'haematology'],
  cite: 'TNM classification (UICC/AJCC 8th edition); ECOG performance status (Oken MM et al. 1982); response by RECIST 1.1.',
  sections: [
    { ar: 'الورم', en: 'Tumour', fields: [
      { k: 'site', t: 'text', ar: 'المكان الأولي', en: 'Primary site', req: true },
      { k: 'histology', t: 'text', ar: 'النوع النسيجي', en: 'Histology' },
      { k: 'grade', t: 'sel', ar: 'الدرجة', en: 'Grade', opts: [['GX', 'GX', 'GX'], ['G1', 'G1 — جيد التمايز', 'G1 — well differentiated'], ['G2', 'G2 — متوسط', 'G2 — moderately'], ['G3', 'G3 — ضعيف التمايز', 'G3 — poorly differentiated'], ['G4', 'G4 — غير متمايز', 'G4 — undifferentiated']] },
      { k: 't', t: 'sel', ar: 'T', en: 'T', opts: ['TX', 'T0', 'Tis', 'T1', 'T1a', 'T1b', 'T1c', 'T2', 'T2a', 'T2b', 'T3', 'T3a', 'T3b', 'T4', 'T4a', 'T4b'].map((v) => [v, v, v]) },
      { k: 'n', t: 'sel', ar: 'N', en: 'N', opts: ['NX', 'N0', 'N1', 'N1a', 'N1b', 'N2', 'N2a', 'N2b', 'N3'].map((v) => [v, v, v]) },
      { k: 'm', t: 'sel', ar: 'M', en: 'M', opts: ['M0', 'M1', 'M1a', 'M1b', 'M1c'].map((v) => [v, v, v]) },
      { k: 'stage', t: 'sel', ar: 'المرحلة', en: 'Stage group', opts: ['0', 'I', 'IA', 'IB', 'II', 'IIA', 'IIB', 'IIC', 'III', 'IIIA', 'IIIB', 'IIIC', 'IV', 'IVA', 'IVB'].map((v) => [v, v, v]) },
      { k: 'markers', t: 'text', ar: 'الواسمات (مثل ER/PR/HER2)', en: 'Markers (e.g. ER/PR/HER2)' },
    ] },
    { ar: 'الحالة والعلاج', en: 'Status and treatment', fields: [
      { k: 'ecog', t: 'sel', ar: 'الحالة الوظيفية (ECOG)', en: 'Performance status (ECOG)', opts: [[0, '0 — نشاط كامل', '0 — fully active'], [1, '1 — مقيد بالأعمال الشاقة', '1 — restricted in strenuous activity'], [2, '2 — يعتني بنفسه، لا يعمل', '2 — self-care, unable to work'], [3, '3 — رعاية ذاتية محدودة', '3 — limited self-care'], [4, '4 — طريح الفراش', '4 — completely disabled'], [5, '5 — متوفى', '5 — dead']] },
      { k: 'intent', t: 'sel', ar: 'هدف العلاج', en: 'Intent', opts: [['curative', 'شفائي', 'Curative'], ['palliative', 'تلطيفي', 'Palliative']] },
      { k: 'setting', t: 'sel', ar: 'خط العلاج', en: 'Setting', opts: [['neoadjuvant', 'قبل الجراحة', 'Neoadjuvant'], ['adjuvant', 'بعد الجراحة', 'Adjuvant'], ['first', 'الخط الأول', 'First line'], ['second', 'الخط الثاني فما بعد', 'Second line or later'], ['maintenance', 'علاج مداومة', 'Maintenance']] },
      { k: 'regimen', t: 'text', ar: 'البروتوكول', en: 'Regimen' },
      { k: 'cycle', t: 'int', ar: 'رقم الجرعة (الدورة)', en: 'Cycle number', min: 1, max: 200 },
      { k: 'response', t: 'sel', ar: 'الاستجابة (RECIST)', en: 'Response (RECIST)', opts: [['CR', 'استجابة كاملة (CR)', 'Complete response'], ['PR', 'استجابة جزئية (PR)', 'Partial response'], ['SD', 'مرض مستقر (SD)', 'Stable disease'], ['PD', 'تقدم المرض (PD)', 'Progressive disease']] },
      { k: 'notes', t: 'area', ar: 'ملاحظات', en: 'Notes', wide: true },
    ] },
  ],
  compute(d) {
    const tnm = [d.t, d.n, d.m].filter(Boolean).join(' ');
    return [
      tnm ? result('tnm', 'TNM', 'TNM', tnm, { level: String(d.m || '').startsWith('M1') ? 'bad' : null }) : null,
      d.stage ? result('stage', 'المرحلة', 'Stage', d.stage) : null,
      typeof d.ecog === 'number' ? result('ecog', 'ECOG', 'ECOG', d.ecog, { d: 0, bands: [[2, 'ok', 'جيدة', 'Good'], [3, 'warn', 'متوسطة', 'Fair'], [null, 'bad', 'ضعيفة', 'Poor']] }) : null,
      d.response === 'PD' ? result('response', 'الاستجابة', 'Response', 'PD', { level: 'bad', text: { ar: 'تقدم المرض', en: 'Progressive disease' } }) : null,
    ];
  },
};

const BBPS = [[0, '0 — لا يمكن رؤية الغشاء', '0 — mucosa not seen'], [1, '1 — رؤية جزئية', '1 — portion seen'], [2, '2 — رؤية جيدة مع بقايا قليلة', '2 — minor residue'], [3, '3 — نظيف تمامًا', '3 — entire mucosa seen']];
const endoscopy = {
  key: 'endoscopy', v: 1, icon: 'scan-search', ar: 'تقرير المنظار', en: 'Endoscopy report',
  specialties: ['gastroenterology', 'general_surgery'],
  cite: 'Bowel preparation by the Boston Bowel Preparation Scale (Lai EJ et al. 2009): adequate when total ≥ 6 and every segment ≥ 2.',
  sections: [
    { ar: 'الإجراء', en: 'Procedure', fields: [
      { k: 'type', t: 'sel', ar: 'النوع', en: 'Type', req: true, opts: [['ogd', 'منظار علوي', 'Gastroscopy (OGD)'], ['colon', 'منظار قولون', 'Colonoscopy'], ['sigmoid', 'منظار سيني', 'Sigmoidoscopy'], ['ercp', 'ERCP', 'ERCP'], ['eus', 'منظار بالموجات (EUS)', 'EUS']] },
      { k: 'indication', t: 'text', ar: 'سبب الإجراء', en: 'Indication' },
      { k: 'sedation', t: 'sel', ar: 'التخدير', en: 'Sedation', opts: [['none', 'بدون', 'None'], ['conscious', 'تهدئة واعية', 'Conscious sedation'], ['propofol', 'بروبوفول', 'Propofol'], ['general', 'تخدير عام', 'General']] },
    ] },
    { ar: 'تحضير الأمعاء (للقولون)', en: 'Bowel preparation (colon)', fields: [
      { k: 'bb_r', t: 'sel', ar: 'القولون الأيمن', en: 'Right colon', opts: BBPS },
      { k: 'bb_t', t: 'sel', ar: 'القولون المستعرض', en: 'Transverse colon', opts: BBPS },
      { k: 'bb_l', t: 'sel', ar: 'القولون الأيسر', en: 'Left colon', opts: BBPS },
    ] },
    { ar: 'النتائج', en: 'Findings', fields: [
      { k: 'findings', t: 'area', ar: 'الموجودات', en: 'Findings', wide: true },
      { k: 'polyps', t: 'int', ar: 'عدد السلائل', en: 'Polyps', min: 0, max: 200 },
      { k: 'biopsy', t: 'bool', ar: 'أُخذت خزعات', en: 'Biopsies taken' },
      { k: 'hp', t: 'sel', ar: 'جرثومة المعدة (فحص سريع)', en: 'H. pylori (rapid test)', opts: [['pos', 'إيجابي', 'Positive'], ['neg', 'سلبي', 'Negative'], ['not_done', 'لم يُجرَ', 'Not done']] },
      { k: 'complications', t: 'text', ar: 'مضاعفات', en: 'Complications' },
      { k: 'followup', t: 'text', ar: 'التوصية والمتابعة', en: 'Recommendation and follow-up' },
    ] },
  ],
  compute(d) {
    const out = [];
    const t = sum(d, ['bb_r', 'bb_t', 'bb_l']);
    if (t !== null) {
      const ok = t >= 6 && [d.bb_r, d.bb_t, d.bb_l].every((v) => v >= 2);
      out.push(result('bbps', 'تحضير الأمعاء (BBPS)', 'Bowel prep (BBPS)', t, { unit: '/9', d: 0, level: ok ? 'ok' : 'warn', text: ok ? { ar: 'كافٍ', en: 'Adequate' } : { ar: 'غير كافٍ — يُعاد مبكرًا', en: 'Inadequate — repeat early' } }));
    }
    if (d.hp === 'pos') out.push(result('hp', 'جرثومة المعدة', 'H. pylori', '+', { level: 'warn', text: { ar: 'إيجابي — علاج القضاء', en: 'Positive — eradication' } }));
    return out;
  },
};

const ALLERGENS = [['hist', 'الهيستامين (ضابط موجب)', 'Histamine (positive control)'], ['saline', 'محلول ملحي (ضابط سالب)', 'Saline (negative control)'],
  ['dpt', 'عث الغبار (D. pteronyssinus)', 'House dust mite (D. pteronyssinus)'], ['df', 'عث الغبار (D. farinae)', 'House dust mite (D. farinae)'],
  ['cat', 'القطط', 'Cat'], ['dog', 'الكلاب', 'Dog'], ['cockroach', 'الصراصير', 'Cockroach'], ['grass', 'حبوب لقاح الأعشاب', 'Grass pollen'],
  ['olive', 'حبوب لقاح الزيتون', 'Olive pollen'], ['cypress', 'السرو', 'Cypress'], ['chenopodium', 'الرغل (Chenopodium)', 'Chenopodium'], ['parietaria', 'الحشيشة الجدارية', 'Parietaria'],
  ['alternaria', 'فطر الألترناريا', 'Alternaria'], ['aspergillus', 'فطر الأسبرجيلس', 'Aspergillus'], ['milk', 'حليب البقر', 'Cow’s milk'], ['egg', 'البيض', 'Egg'],
  ['peanut', 'الفول السوداني', 'Peanut'], ['wheat', 'القمح', 'Wheat'], ['fish', 'السمك', 'Fish'], ['shrimp', 'الروبيان', 'Shrimp'], ['sesame', 'السمسم', 'Sesame']];
const skinPrick = {
  key: 'skin_prick', v: 1, icon: 'layout-grid', ar: 'اختبار وخز الجلد للحساسية', en: 'Skin prick test',
  specialties: ['allergy', 'dermatology', 'ent'],
  cite: 'A wheal ≥ 3 mm larger than the negative control is positive; the test is valid only when the histamine control is ≥ 3 mm (EAACI).',
  sections: [{ ar: 'النتائج (مم)', en: 'Results (mm)', fields: [
    { k: 'spt', t: 'grid', ar: 'القياسات', en: 'Readings', rows: ALLERGENS, cols: [['w', 'الانتفاخ', 'Wheal'], ['f', 'الاحمرار', 'Flare']], cell: { t: 'num', min: 0, max: 60, step: 0.5, unit: 'mm' } },
    { k: 'antihistamine', t: 'bool', ar: 'أُوقفت مضادات الهيستامين قبل الفحص', en: 'Antihistamines stopped beforehand' },
    { k: 'notes', t: 'area', ar: 'ملاحظات', en: 'Notes', wide: true },
  ] }],
  compute(d) {
    const neg = num(d.spt__saline__w) || 0; const hist = num(d.spt__hist__w);
    const out = [];
    if (hist !== null && hist < 3) out.push(result('valid', 'صلاحية الفحص', 'Validity', hist, { unit: 'mm', level: 'warn', text: { ar: 'الضابط الموجب سلبي — النتيجة غير موثوقة', en: 'Negative histamine control — not interpretable' } }));
    const pos = ALLERGENS.slice(2).filter(([k]) => num(d[`spt__${k}__w`]) !== null && d[`spt__${k}__w`] - neg >= 3);
    const tested = ALLERGENS.slice(2).some(([k]) => num(d[`spt__${k}__w`]) !== null);
    if (pos.length) out.unshift(result('positive', 'مسببات إيجابية', 'Positive allergens', pos.length, { d: 0, level: 'warn', text: { ar: pos.map((x) => x[1]).join('، '), en: pos.map((x) => x[2]).join(', ') } }));
    else if (tested) out.unshift(result('positive', 'مسببات إيجابية', 'Positive allergens', 0, { d: 0, level: 'ok', text: { ar: 'لا يوجد', en: 'None' } }));
    return out;
  },
};

const orthoDental = {
  key: 'orthodontic', v: 1, icon: 'smile', ar: 'تقييم التقويم', en: 'Orthodontic assessment',
  specialties: ['orthodontics'],
  cite: 'Angle classification; Index of Orthodontic Treatment Need — Dental Health Component (Brook & Shaw 1989).',
  sections: [
    { ar: 'الإطباق', en: 'Occlusion', fields: [
      { k: 'molar', t: 'sel', side: 'lr', ar: 'علاقة الأرحاء (أنجل)', en: 'Molar relationship (Angle)', opts: [['I', 'الصنف الأول', 'Class I'], ['II1', 'الصنف الثاني — 1', 'Class II div 1'], ['II2', 'الصنف الثاني — 2', 'Class II div 2'], ['III', 'الصنف الثالث', 'Class III']] },
      { k: 'canine', t: 'sel', side: 'lr', ar: 'علاقة الأنياب', en: 'Canine relationship', opts: [['I', 'الصنف الأول', 'Class I'], ['II', 'الصنف الثاني', 'Class II'], ['III', 'الصنف الثالث', 'Class III']] },
      { k: 'overjet', t: 'num', ar: 'البروز الأفقي (Overjet)', en: 'Overjet', unit: 'mm', min: -15, max: 20, step: 0.5, trend: true },
      { k: 'overbite', t: 'num', ar: 'التغطية العمودية (Overbite)', en: 'Overbite', unit: 'mm', min: -15, max: 15, step: 0.5 },
      { k: 'crossbite', t: 'sel', ar: 'العضة المعكوسة', en: 'Crossbite', opts: [['none', 'لا يوجد', 'None'], ['anterior', 'أمامية', 'Anterior'], ['post_r', 'خلفية يمنى', 'Posterior right'], ['post_l', 'خلفية يسرى', 'Posterior left'], ['bilateral', 'خلفية ثنائية', 'Bilateral posterior']] },
      { k: 'crowd_u', t: 'num', ar: 'الازدحام العلوي', en: 'Upper crowding', unit: 'mm', min: 0, max: 30, step: 0.5 },
      { k: 'crowd_l', t: 'num', ar: 'الازدحام السفلي', en: 'Lower crowding', unit: 'mm', min: 0, max: 30, step: 0.5 },
      { k: 'midline', t: 'num', ar: 'انحراف خط المنتصف', en: 'Midline shift', unit: 'mm', min: 0, max: 15, step: 0.5 },
      { k: 'iotn', t: 'sel', ar: 'حاجة العلاج (IOTN DHC)', en: 'Treatment need (IOTN DHC)', opts: [[1, '1 — لا حاجة', '1 — none'], [2, '2 — حاجة بسيطة', '2 — little'], [3, '3 — حاجة حدّية', '3 — borderline'], [4, '4 — حاجة كبيرة', '4 — great'], [5, '5 — حاجة كبيرة جدًا', '5 — very great']] },
    ] },
    { ar: 'العلاج', en: 'Treatment', fields: [
      { k: 'appliance', t: 'sel', ar: 'الجهاز', en: 'Appliance', opts: [['metal', 'تقويم ثابت معدني', 'Fixed metal'], ['ceramic', 'تقويم ثابت شفاف', 'Fixed ceramic'], ['lingual', 'تقويم لساني', 'Lingual'], ['aligners', 'تقويم شفاف متحرك (Aligners)', 'Clear aligners'], ['removable', 'جهاز متحرك', 'Removable'], ['functional', 'جهاز وظيفي', 'Functional'], ['retainer', 'مثبّت', 'Retainer']] },
      { k: 'stage', t: 'sel', ar: 'المرحلة', en: 'Stage', opts: [['records', 'سجلات وتخطيط', 'Records and planning'], ['levelling', 'تسوية ورصف', 'Levelling and aligning'], ['working', 'مرحلة العمل', 'Working'], ['finishing', 'إنهاء', 'Finishing'], ['retention', 'تثبيت', 'Retention']] },
      { k: 'wire', t: 'text', ar: 'السلك/الخطوة الحالية', en: 'Current wire / step' },
      { k: 'notes', t: 'area', ar: 'ملاحظات وخطة الزيارة القادمة', en: 'Notes and next visit', wide: true },
    ] },
  ],
  compute(d) {
    const out = [];
    const oj = num(d.overjet);
    if (oj !== null) out.push(result('overjet', 'البروز الأفقي', 'Overjet', oj, { unit: 'mm', bands: [[0, 'warn', 'معكوس (سالب)', 'Reverse'], [1, 'mild', 'قليل', 'Reduced'], [3.6, 'ok', 'طبيعي (1–3.5)', 'Normal (1–3.5)'], [6.1, 'mild', 'زائد', 'Increased'], [null, 'warn', 'زائد كثيرًا (> 6)', 'Markedly increased (> 6)']] }));
    if (typeof d.iotn === 'number') out.push(result('iotn', 'IOTN', 'IOTN', d.iotn, { d: 0, bands: [[3, 'ok', 'لا حاجة أو حاجة بسيطة', 'No or little need'], [4, 'mild', 'حدّية', 'Borderline'], [null, 'warn', 'حاجة كبيرة للعلاج', 'Great need']] }));
    return out;
  },
};

const FDI = /^(?:[1-4][1-8]|[5-8][1-5])$/;
const oralSurgery = {
  key: 'oral_surgery', v: 1, icon: 'scissors', ar: 'تقرير جراحة الفم', en: 'Oral surgery note',
  specialties: ['oral_surgery', 'dentistry'],
  cite: 'Teeth in FDI (ISO 3950) notation; impacted third molars by Winter’s classification.',
  sections: [
    { ar: 'الإجراء', en: 'Procedure', fields: [
      { k: 'procedure', t: 'sel', ar: 'الإجراء', en: 'Procedure', req: true, opts: [['simple', 'خلع بسيط', 'Simple extraction'], ['surgical', 'خلع جراحي', 'Surgical extraction'], ['impacted', 'ضرس عقل مطمور', 'Impacted third molar'], ['implant', 'زراعة سن', 'Implant placement'], ['graft', 'تطعيم عظم', 'Bone graft'], ['sinus', 'رفع الجيب الأنفي', 'Sinus lift'], ['apicectomy', 'قطع ذروة الجذر', 'Apicectomy'], ['biopsy', 'خزعة', 'Biopsy'], ['cyst', 'استئصال كيس', 'Cyst enucleation'], ['frenectomy', 'قص اللجام', 'Frenectomy'], ['fracture', 'تثبيت كسر', 'Fracture fixation']] },
      { k: 'teeth', t: 'text', ar: 'الأسنان (ترقيم FDI، مثل 38 48)', en: 'Teeth (FDI, e.g. 38 48)' },
      { k: 'winter', t: 'sel', ar: 'وضعية الضرس المطمور (Winter)', en: 'Impaction (Winter)', opts: [['mesio', 'مائل للأمام', 'Mesioangular'], ['disto', 'مائل للخلف', 'Distoangular'], ['vertical', 'عمودي', 'Vertical'], ['horizontal', 'أفقي', 'Horizontal']] },
      { k: 'anaesthesia', t: 'sel', ar: 'التخدير', en: 'Anaesthesia', opts: [['local', 'موضعي', 'Local'], ['sedation', 'تهدئة وريدية', 'IV sedation'], ['general', 'عام', 'General']] },
      { k: 'la', t: 'text', ar: 'المخدر وعدد الأمبولات', en: 'Local anaesthetic and cartridges' },
      { k: 'implant', t: 'text', ar: 'الزرعة (النوع، القطر × الطول، LOT)', en: 'Implant (system, Ø × length, lot)' },
    ] },
    { ar: 'التفاصيل', en: 'Details', fields: [
      { k: 'flap', t: 'bool', ar: 'رفع شريحة لثوية', en: 'Flap raised' },
      { k: 'bone', t: 'bool', ar: 'إزالة عظم', en: 'Bone removal' },
      { k: 'section', t: 'bool', ar: 'تقسيم السن', en: 'Tooth sectioned' },
      { k: 'sutures', t: 'sel', ar: 'الغرز', en: 'Sutures', opts: [['none', 'بدون', 'None'], ['resorbable', 'تذوب', 'Resorbable'], ['non', 'لا تذوب (تُفك)', 'Non-resorbable']] },
      { k: 'opening', t: 'int', ar: 'فتحة الفم', en: 'Mouth opening', unit: 'mm', min: 0, max: 80 },
      { k: 'complications', t: 'text', ar: 'مضاعفات', en: 'Complications' },
      { k: 'instructions', t: 'bool', ar: 'أُعطيت تعليمات ما بعد العملية', en: 'Post-operative instructions given' },
      { k: 'review', t: 'date', ar: 'موعد المراجعة / فك الغرز', en: 'Review / suture removal' },
    ] },
  ],
  check(d) {
    const bad = String(d.teeth || '').split(/[\s,،;]+/).filter(Boolean).filter((x) => !FDI.test(x.replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x660))));
    return bad.length ? { teeth: 'Use FDI tooth numbers (11–48, 51–85).' } : {};
  },
  compute(d) {
    const o = num(d.opening);
    return [
      d.teeth ? result('teeth', 'الأسنان', 'Teeth', d.teeth) : null,
      o !== null ? result('opening', 'فتحة الفم', 'Mouth opening', o, { unit: 'mm', d: 0, bands: [[20, 'bad', 'تقيّد شديد', 'Severe trismus'], [35, 'warn', 'تقيّد', 'Limited'], [null, 'ok', 'طبيعية', 'Normal']] }) : null,
    ];
  },
};

const ACTIVITY = [[1.2, 'خامل (عمل مكتبي)', 'Sedentary'], [1.375, 'نشاط خفيف (1–3 أيام)', 'Light (1–3 days/week)'], [1.55, 'متوسط (3–5 أيام)', 'Moderate (3–5 days/week)'], [1.725, 'عالٍ (6–7 أيام)', 'High (6–7 days/week)'], [1.9, 'عالٍ جدًا', 'Very high']];
const nutrition = {
  key: 'nutrition', v: 1, icon: 'apple', ar: 'التقييم الغذائي', en: 'Nutrition assessment',
  specialties: ['nutrition', 'endocrinology', 'family'],
  cite: 'BMI by WHO classes; waist-to-hip ratio risk ≥ 0.90 men / ≥ 0.85 women (WHO 2008); energy by the Mifflin-St Jeor equation × activity factor.',
  sections: [
    { ar: 'القياسات', en: 'Measurements', fields: [
      { k: 'weight', t: 'num', ar: 'الوزن', en: 'Weight', unit: 'kg', min: 2, max: 400, step: 0.1, trend: true },
      { k: 'height', t: 'num', ar: 'الطول', en: 'Height', unit: 'cm', min: 40, max: 250, step: 0.5 },
      { k: 'waist', t: 'num', ar: 'محيط الخصر', en: 'Waist', unit: 'cm', min: 30, max: 250, step: 0.5, trend: true },
      { k: 'hip', t: 'num', ar: 'محيط الورك', en: 'Hip', unit: 'cm', min: 30, max: 250, step: 0.5 },
      { k: 'fat', t: 'num', ar: 'نسبة الدهون', en: 'Body fat', unit: '%', min: 2, max: 75, step: 0.1, trend: true },
      { k: 'muscle', t: 'num', ar: 'الكتلة العضلية', en: 'Muscle mass', unit: 'kg', min: 1, max: 150, step: 0.1 },
      { k: 'sex', t: 'sel', ar: 'الجنس', en: 'Sex', opts: [['male', 'ذكر', 'Male'], ['female', 'أنثى', 'Female']], prefill: (p) => (p.sex === 'male' || p.sex === 'female' ? p.sex : undefined) },
      { k: 'age', t: 'int', ar: 'العمر', en: 'Age', unit: 'y', min: 1, max: 120, prefill: (p) => (p.ageYears ?? undefined) },
    ] },
    { ar: 'الخطة', en: 'Plan', fields: [
      { k: 'activity', t: 'sel', ar: 'مستوى النشاط', en: 'Activity level', opts: ACTIVITY },
      { k: 'goal', t: 'sel', ar: 'الهدف', en: 'Goal', opts: [['lose', 'إنقاص الوزن', 'Lose weight'], ['maintain', 'تثبيت الوزن', 'Maintain'], ['gain', 'زيادة الوزن', 'Gain weight']] },
      { k: 'target', t: 'num', ar: 'الوزن المستهدف', en: 'Target weight', unit: 'kg', min: 2, max: 400, step: 0.1 },
      { k: 'diet', t: 'area', ar: 'النظام الغذائي والتوصيات', en: 'Diet plan and advice', wide: true },
    ] },
  ],
  compute(d) {
    const w = num(d.weight); const h = num(d.height); const age = num(d.age);
    const out = [result('bmi', 'مؤشر كتلة الجسم', 'BMI', bmiOf(w, h), { unit: 'kg/m²', bands: BMI_BANDS })];
    const waist = num(d.waist); const hip = num(d.hip);
    if (waist && hip) { const r = waist / hip; const cut = d.sex === 'female' ? 0.85 : 0.9; out.push(result('whr', 'نسبة الخصر للورك', 'Waist-to-hip ratio', r, { d: 2, bands: [[cut, 'ok', 'ضمن الحد', 'Below risk threshold'], [null, 'warn', 'خطر قلبي استقلابي مرتفع', 'Raised cardiometabolic risk']] })); }
    if (w && h && age && (d.sex === 'male' || d.sex === 'female')) {
      const bmr = 10 * w + 6.25 * h - 5 * age + (d.sex === 'male' ? 5 : -161);
      out.push(result('bmr', 'معدل الأيض الأساسي', 'Basal metabolic rate', bmr, { unit: 'kcal/d', d: 0 }));
      if (typeof d.activity === 'number') {
        const tdee = bmr * d.activity;
        out.push(result('tdee', 'الاحتياج اليومي', 'Daily energy need', tdee, { unit: 'kcal/d', d: 0 }));
        if (d.goal) out.push(result('kcal', 'السعرات المقترحة', 'Suggested intake', Math.max(d.sex === 'male' ? 1500 : 1200, tdee + { lose: -500, maintain: 0, gain: 300 }[d.goal]), { unit: 'kcal/d', d: 0 }));
      }
    }
    return out;
  },
};

const KATZ = [['bathing', 'الاستحمام', 'Bathing'], ['dressing', 'ارتداء الملابس', 'Dressing'], ['toileting', 'استخدام الحمام', 'Toileting'], ['transferring', 'الانتقال من السرير/الكرسي', 'Transferring'], ['continence', 'التحكم بالبول والبراز', 'Continence'], ['feeding', 'تناول الطعام', 'Feeding']];
const katz = {
  key: 'katz_adl', v: 1, icon: 'user-check', ar: 'الاستقلالية اليومية (كاتز)', en: 'Daily-living independence (Katz ADL)',
  specialties: ['geriatrics', 'physiotherapy', 'neurology'],
  cite: 'Katz S et al. JAMA 1963;185:914–9. 6 = full function, 4 = moderate impairment, ≤ 2 = severe impairment.',
  sections: [{ ar: 'الأنشطة', en: 'Activities', fields: KATZ.map(([k, ar, en]) => ({ k, t: 'sel', ar, en, opts: [[1, 'مستقل (1)', 'Independent (1)'], [0, 'يحتاج مساعدة (0)', 'Dependent (0)']] })) }],
  compute(d) {
    const s = sum(d, KATZ.map(([k]) => k));
    return [result('score', 'المجموع', 'Score', s, { unit: '/6', d: 0, bands: [[3, 'bad', 'قصور شديد', 'Severe impairment'], [5, 'warn', 'قصور متوسط', 'Moderate impairment'], [6, 'mild', 'قصور بسيط', 'Mild impairment'], [null, 'ok', 'مستقل تمامًا', 'Fully independent']] })];
  },
};

const LEVEL4 = [['typical', 'مناسب للعمر', 'Age-appropriate'], ['mild', 'تأخر خفيف', 'Mild delay'], ['moderate', 'تأخر متوسط', 'Moderate delay'], ['severe', 'تأخر شديد', 'Severe delay']];
const speech = {
  key: 'speech_assessment', v: 1, icon: 'message-circle', ar: 'تقييم النطق واللغة', en: 'Speech & language assessment',
  specialties: ['speech', 'paediatrics', 'neurology'],
  cite: 'Stuttering frequency as percentage of syllables stuttered (%SS); intelligibility as the share of speech understood by an unfamiliar listener.',
  sections: [
    { ar: 'المجالات', en: 'Areas', fields: [
      { k: 'concerns', t: 'multi', ar: 'سبب التحويل', en: 'Concerns', opts: [['articulation', 'لفظ الأصوات', 'Articulation'], ['phonology', 'العمليات الصوتية', 'Phonology'], ['language', 'تأخر لغوي', 'Language delay'], ['fluency', 'تلعثم', 'Fluency / stuttering'], ['voice', 'الصوت', 'Voice'], ['resonance', 'الرنين', 'Resonance'], ['swallowing', 'البلع', 'Swallowing'], ['autism', 'تواصل اجتماعي', 'Social communication'], ['aac', 'تواصل بديل', 'AAC']] },
      { k: 'receptive', t: 'sel', ar: 'اللغة الاستقبالية', en: 'Receptive language', opts: LEVEL4 },
      { k: 'expressive', t: 'sel', ar: 'اللغة التعبيرية', en: 'Expressive language', opts: LEVEL4 },
      { k: 'errors', t: 'text', ar: 'الأصوات الخاطئة', en: 'Sound errors' },
      { k: 'intelligibility', t: 'int', ar: 'وضوح الكلام', en: 'Intelligibility', unit: '%', min: 0, max: 100, trend: true },
      { k: 'ss', t: 'num', ar: 'نسبة المقاطع المتلعثمة', en: 'Syllables stuttered', unit: '%', min: 0, max: 100, step: 0.1, trend: true },
      { k: 'hearing', t: 'sel', ar: 'فحص السمع', en: 'Hearing screen', opts: [['pass', 'سليم', 'Pass'], ['refer', 'يحتاج تحويلًا', 'Refer'], ['not_done', 'لم يُجرَ', 'Not done']] },
    ] },
    { ar: 'الخطة', en: 'Plan', fields: [
      { k: 'goals', t: 'area', ar: 'الأهداف', en: 'Goals', wide: true },
      { k: 'home', t: 'area', ar: 'تمارين البيت', en: 'Home programme', wide: true },
    ] },
  ],
  compute(d) {
    const out = [];
    const i = num(d.intelligibility);
    out.push(result('intel', 'وضوح الكلام', 'Intelligibility', i, { unit: '%', d: 0, bands: [[50, 'bad', 'ضعيف', 'Poor'], [75, 'warn', 'مقبول', 'Fair'], [90, 'mild', 'جيد', 'Good'], [null, 'ok', 'واضح', 'Clear']] }));
    const ss = num(d.ss);
    out.push(result('ss', 'التلعثم', 'Stuttering', ss, { unit: '%SS', d: 1, bands: [[3, 'ok', 'ضمن المعتاد', 'Typical range'], [10, 'warn', 'تلعثم', 'Stuttering'], [null, 'bad', 'تلعثم شديد', 'Severe stuttering']] }));
    if (d.hearing === 'refer') out.push(result('hearing', 'السمع', 'Hearing', 'refer', { level: 'warn', text: { ar: 'تحويل لفحص سمع كامل', en: 'Refer for full audiology' } }));
    return out;
  },
};

const APGAR = [['a', 'اللون', 'Appearance (colour)', [['أزرق/شاحب', 'Blue / pale'], ['الأطراف زرقاء', 'Blue extremities'], ['وردي', 'Pink']]],
  ['p', 'النبض', 'Pulse', [['غائب', 'Absent'], ['أقل من 100', '< 100'], ['100 فأكثر', '≥ 100']]],
  ['g', 'الاستجابة للتنبيه', 'Grimace (reflex)', [['لا استجابة', 'None'], ['تكشيرة', 'Grimace'], ['بكاء/عطاس', 'Cry / sneeze']]],
  ['ac', 'قوة العضلات', 'Activity (tone)', [['رخو', 'Limp'], ['بعض الانثناء', 'Some flexion'], ['حركة نشطة', 'Active motion']]],
  ['r', 'التنفس', 'Respiration', [['غائب', 'Absent'], ['ضعيف/غير منتظم', 'Weak / irregular'], ['بكاء قوي', 'Strong cry']]]];
const newborn = {
  key: 'newborn', v: 1, icon: 'baby', ar: 'فحص المولود (أبغار)', en: 'Newborn check (Apgar)',
  specialties: ['paediatrics', 'obgyn'],
  cite: 'Apgar V. Curr Res Anesth Analg 1953;32:260–7: 7–10 reassuring, 4–6 moderately abnormal, 0–3 low.',
  sections: [
    { ar: 'أبغار عند الدقيقة 1', en: 'Apgar at 1 minute', fields: APGAR.map(([k, ar, en, o]) => ({ k: `${k}1`, t: 'sel', ar, en, opts: o.map(([a, e], v) => [v, `${v} — ${a}`, `${v} — ${e}`]) })) },
    { ar: 'أبغار عند الدقيقة 5', en: 'Apgar at 5 minutes', fields: APGAR.map(([k, ar, en, o]) => ({ k: `${k}5`, t: 'sel', ar, en, opts: o.map(([a, e], v) => [v, `${v} — ${a}`, `${v} — ${e}`]) })) },
    { ar: 'القياسات عند الولادة', en: 'Birth measurements', fields: [
      { k: 'ga', t: 'int', ar: 'عمر الحمل', en: 'Gestational age', unit: 'wk', min: 20, max: 44 },
      { k: 'bw', t: 'int', ar: 'وزن الولادة', en: 'Birth weight', unit: 'g', min: 300, max: 7000 },
      { k: 'length', t: 'num', ar: 'الطول', en: 'Length', unit: 'cm', min: 20, max: 65, step: 0.5 },
      { k: 'hc', t: 'num', ar: 'محيط الرأس', en: 'Head circumference', unit: 'cm', min: 18, max: 45, step: 0.5 },
      { k: 'exam', t: 'area', ar: 'الفحص السريري', en: 'Examination', wide: true },
    ] },
  ],
  compute(d) {
    const bands = [[4, 'bad', 'منخفض', 'Low'], [7, 'warn', 'غير طبيعي بشكل متوسط', 'Moderately abnormal'], [null, 'ok', 'مطمئن', 'Reassuring']];
    const bw = num(d.bw); const ga = num(d.ga);
    return [
      result('apgar1', 'أبغار 1 دقيقة', 'Apgar 1 min', sum(d, APGAR.map(([k]) => `${k}1`)), { unit: '/10', d: 0, bands }),
      result('apgar5', 'أبغار 5 دقائق', 'Apgar 5 min', sum(d, APGAR.map(([k]) => `${k}5`)), { unit: '/10', d: 0, bands }),
      bw !== null ? result('bw', 'وزن الولادة', 'Birth weight', bw, { unit: 'g', d: 0, bands: [[1500, 'bad', 'منخفض جدًا (< 1500 غ)', 'Very low (< 1500 g)'], [2500, 'warn', 'منخفض (< 2500 غ)', 'Low (< 2500 g)'], [4001, 'ok', 'طبيعي', 'Normal'], [null, 'mild', 'كبير (> 4000 غ)', 'Large (> 4000 g)']] }) : null,
      ga !== null && ga < 37 ? result('ga', 'عمر الحمل', 'Gestation', ga, { unit: 'wk', level: ga < 32 ? 'bad' : 'warn', text: { ar: 'خديج', en: 'Preterm' } }) : null,
    ];
  },
};

module.exports = [preop, wound, abi, onc, endoscopy, skinPrick, orthoDental, oralSurgery, nutrition, katz, speech, newborn];

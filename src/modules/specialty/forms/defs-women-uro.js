// Women's health, fertility and urology: gynaecological assessment (Bethesda), Bishop score, follicle tracking,
// semen analysis (WHO 2021), prostate symptom score (IPSS).
const { result, sum, num } = require('./engine');

const gyn = {
  key: 'gyn_exam', v: 1, icon: 'heart', ar: 'التقييم النسائي', en: 'Gynaecological assessment',
  specialties: ['obgyn', 'fertility'],
  cite: 'Cervical cytology reported by the Bethesda System (2014); management by ASCCP risk-based guidelines.',
  sections: [
    { ar: 'الدورة والتاريخ', en: 'Cycle and history', fields: [
      { k: 'lmp', t: 'date', ar: 'أول يوم في آخر دورة', en: 'Last menstrual period' },
      { k: 'cycle', t: 'int', ar: 'طول الدورة', en: 'Cycle length', unit: 'd', min: 10, max: 120 },
      { k: 'regular', t: 'sel', ar: 'انتظام الدورة', en: 'Regularity', opts: [['regular', 'منتظمة', 'Regular'], ['irregular', 'غير منتظمة', 'Irregular'], ['amenorrhoea', 'انقطاع', 'Amenorrhoea'], ['menopause', 'سن اليأس', 'Postmenopausal']] },
      { k: 'g', t: 'int', ar: 'عدد مرات الحمل (G)', en: 'Gravida', min: 0, max: 30 },
      { k: 'p', t: 'int', ar: 'عدد الولادات (P)', en: 'Para', min: 0, max: 30 },
      { k: 'a', t: 'int', ar: 'الإجهاضات (A)', en: 'Abortions', min: 0, max: 30 },
      { k: 'contraception', t: 'sel', ar: 'وسيلة منع الحمل', en: 'Contraception', opts: [['none', 'لا يوجد', 'None'], ['coc', 'حبوب مركبة', 'Combined pill'], ['pop', 'حبوب البروجستين', 'Progestogen pill'], ['iud_cu', 'لولب نحاسي', 'Copper IUD'], ['iud_lng', 'لولب هرموني', 'Hormonal IUD'], ['implant', 'غرسة', 'Implant'], ['injection', 'إبرة', 'Injection'], ['condom', 'واقٍ', 'Condom'], ['sterilisation', 'ربط', 'Sterilisation']] },
    ] },
    { ar: 'المسحة', en: 'Screening', fields: [
      { k: 'pap', t: 'sel', ar: 'نتيجة مسحة عنق الرحم', en: 'Cervical cytology', opts: [['nilm', 'سلبية (NILM)', 'NILM'], ['ascus', 'ASC-US', 'ASC-US'], ['lsil', 'LSIL', 'LSIL'], ['asch', 'ASC-H', 'ASC-H'], ['hsil', 'HSIL', 'HSIL'], ['agc', 'AGC', 'AGC'], ['scc', 'سرطان شائك (SCC)', 'Squamous cell carcinoma'], ['unsat', 'عينة غير كافية', 'Unsatisfactory']] },
      { k: 'hpv', t: 'sel', ar: 'فحص HPV', en: 'HPV test', opts: [['neg', 'سلبي', 'Negative'], ['pos1618', 'إيجابي 16/18', 'Positive 16/18'], ['pos_other', 'إيجابي لأنواع أخرى عالية الخطورة', 'Positive, other high-risk'], ['not_done', 'لم يُجرَ', 'Not done']] },
      { k: 'breast', t: 'text', ar: 'فحص الثدي', en: 'Breast examination' },
    ] },
    { ar: 'الفحص والألتراساوند', en: 'Examination and ultrasound', fields: [
      { k: 'pelvic', t: 'area', ar: 'الفحص الحوضي', en: 'Pelvic examination', wide: true },
      { k: 'uterus', t: 'text', ar: 'الرحم (الأبعاد)', en: 'Uterus (size)' },
      { k: 'endometrium', t: 'num', ar: 'سماكة بطانة الرحم', en: 'Endometrial thickness', unit: 'mm', min: 0, max: 40, step: 0.1, trend: true },
      { k: 'fibroids', t: 'text', ar: 'أورام ليفية', en: 'Fibroids' },
      { k: 'ovary', t: 'text', side: 'lr', ar: 'المبيض', en: 'Ovary' },
    ] },
  ],
  compute(d) {
    const out = [];
    const PAP = { nilm: ['ok', 'سلبية', 'Negative'], ascus: ['warn', 'تحتاج متابعة/فحص HPV', 'Needs HPV triage / follow-up'], lsil: ['warn', 'تحتاج متابعة أو تنظيرًا', 'Follow-up or colposcopy'],
      asch: ['bad', 'تنظير مهبلي', 'Colposcopy'], hsil: ['bad', 'تنظير مهبلي عاجل', 'Colposcopy (urgent)'], agc: ['bad', 'تنظير وخزعة بطانة', 'Colposcopy and endometrial sampling'],
      scc: ['bad', 'تحويل للأورام', 'Refer to gynae-oncology'], unsat: ['warn', 'تُعاد خلال 2–4 أشهر', 'Repeat in 2–4 months'] };
    if (d.pap) { const [lvl, ar, en] = PAP[d.pap]; out.push(result('pap', 'المسحة', 'Cytology', d.pap.toUpperCase(), { level: lvl, text: { ar, en } })); }
    if (d.hpv === 'pos1618') out.push(result('hpv', 'HPV', 'HPV', '16/18', { level: 'bad', text: { ar: 'تنظير مهبلي', en: 'Colposcopy' } }));
    const e = num(d.endometrium);
    if (e !== null && d.regular === 'menopause' && e > 4) out.push(result('endo', 'بطانة الرحم', 'Endometrium', e, { unit: 'mm', level: 'warn', text: { ar: 'أكثر من 4 مم بعد سن اليأس — تقييم', en: '> 4 mm after menopause — evaluate' } }));
    if (d.lmp && num(d.cycle) && d.regular !== 'menopause') {
      const next = new Date(Date.parse(`${d.lmp}T00:00:00Z`) + d.cycle * 86400000).toISOString().slice(0, 10);
      out.push(result('next', 'الدورة القادمة المتوقعة', 'Next period expected', next));
    }
    return out;
  },
};

const bishop = {
  key: 'bishop', v: 1, icon: 'baby', ar: 'تهيئة عنق الرحم (مقياس بيشوب)', en: 'Cervical ripeness (Bishop score)',
  specialties: ['obgyn'],
  cite: 'Bishop EH. Obstet Gynecol 1964;24:266–8. A score ≥ 8 is favourable for induction; ≤ 6 unfavourable.',
  sections: [{ ar: 'عنق الرحم', en: 'Cervix', fields: [
    { k: 'dil', t: 'sel', ar: 'التوسع', en: 'Dilation', opts: [[0, 'مغلق (0)', 'Closed (0)'], [1, '1–2 سم (1)', '1–2 cm (1)'], [2, '3–4 سم (2)', '3–4 cm (2)'], [3, '5 سم فأكثر (3)', '≥ 5 cm (3)']] },
    { k: 'eff', t: 'sel', ar: 'الامّحاء', en: 'Effacement', opts: [[0, '0–30% (0)', '0–30% (0)'], [1, '40–50% (1)', '40–50% (1)'], [2, '60–70% (2)', '60–70% (2)'], [3, '80% فأكثر (3)', '≥ 80% (3)']] },
    { k: 'sta', t: 'sel', ar: 'مستوى الرأس', en: 'Station', opts: [[0, '−3 (0)', '−3 (0)'], [1, '−2 (1)', '−2 (1)'], [2, '−1 أو 0 (2)', '−1 or 0 (2)'], [3, '+1 أو +2 (3)', '+1 or +2 (3)']] },
    { k: 'con', t: 'sel', ar: 'القوام', en: 'Consistency', opts: [[0, 'صلب (0)', 'Firm (0)'], [1, 'متوسط (1)', 'Medium (1)'], [2, 'طري (2)', 'Soft (2)']] },
    { k: 'pos', t: 'sel', ar: 'الموضع', en: 'Position', opts: [[0, 'خلفي (0)', 'Posterior (0)'], [1, 'وسطي (1)', 'Mid (1)'], [2, 'أمامي (2)', 'Anterior (2)']] },
  ] }],
  compute(d) {
    const s = sum(d, ['dil', 'eff', 'sta', 'con', 'pos']);
    return [result('score', 'المجموع', 'Score', s, { unit: '/13', d: 0, bands: [[7, 'warn', 'غير مهيأ — قد يحتاج إنضاجًا', 'Unfavourable — ripening may be needed'], [8, 'mild', 'متوسط', 'Intermediate'], [null, 'ok', 'مهيأ للتحريض', 'Favourable for induction']] })];
  },
};

const sizes = (s) => String(s || '').replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x660)).split(/[^0-9.]+/).map(Number).filter((n) => Number.isFinite(n) && n > 0 && n < 60);
const follicles = {
  key: 'follicle_scan', v: 1, icon: 'circle-dot', ar: 'متابعة البويضات (تحفيز)', en: 'Follicle tracking',
  specialties: ['fertility', 'obgyn'],
  cite: 'Follicle sizes in mm (mean diameter), one list per ovary; mature follicles usually ≥ 17–18 mm.',
  sections: [
    { ar: 'الدورة والهرمونات', en: 'Cycle and hormones', fields: [
      { k: 'day', t: 'int', ar: 'يوم الدورة', en: 'Cycle day', min: 1, max: 60 },
      { k: 'protocol', t: 'sel', ar: 'البروتوكول', en: 'Protocol', opts: [['natural', 'دورة طبيعية', 'Natural cycle'], ['oi', 'تحفيز إباضة', 'Ovulation induction'], ['iui', 'تلقيح صناعي (IUI)', 'IUI'], ['antagonist', 'أنتاغونيست', 'Antagonist'], ['long', 'بروتوكول طويل', 'Long agonist'], ['short', 'بروتوكول قصير', 'Short agonist'], ['fet', 'نقل أجنة مجمّدة', 'Frozen embryo transfer']] },
      { k: 'meds', t: 'text', ar: 'الأدوية والجرعات', en: 'Medication and doses' },
      { k: 'e2', t: 'int', ar: 'الإستراديول (E2)', en: 'Oestradiol (E2)', unit: 'pg/mL', min: 0, max: 20000, trend: true },
      { k: 'lh', t: 'num', ar: 'LH', en: 'LH', unit: 'IU/L', min: 0, max: 300, step: 0.1 },
      { k: 'p4', t: 'num', ar: 'البروجسترون', en: 'Progesterone', unit: 'ng/mL', min: 0, max: 100, step: 0.1 },
    ] },
    { ar: 'الألتراساوند', en: 'Ultrasound', fields: [
      { k: 'fol', t: 'text', side: 'lr', ar: 'أحجام البويضات (مم، مفصولة بمسافة)', en: 'Follicle sizes (mm, space separated)' },
      { k: 'endo', t: 'num', ar: 'سماكة بطانة الرحم', en: 'Endometrial thickness', unit: 'mm', min: 0, max: 30, step: 0.1, trend: true },
      { k: 'pattern', t: 'sel', ar: 'شكل البطانة', en: 'Endometrial pattern', opts: [['triple', 'ثلاثي الطبقات', 'Trilaminar'], ['homogeneous', 'متجانس', 'Homogeneous']] },
      { k: 'plan', t: 'area', ar: 'الخطة (موعد الإبرة التفجيرية/السحب)', en: 'Plan (trigger / retrieval)', wide: true },
    ] },
  ],
  compute(d) {
    const all = [...sizes(d.fol_r), ...sizes(d.fol_l)];
    const out = [];
    if (all.length) {
      out.push(result('count', 'عدد البويضات', 'Follicles', all.length, { d: 0 }));
      out.push(result('lead', 'أكبر بويضة', 'Leading follicle', Math.max(...all), { unit: 'mm', d: 1 }));
      out.push(result('mature', 'بويضات ≥ 17 مم', 'Follicles ≥ 17 mm', all.filter((x) => x >= 17).length, { d: 0 }));
      out.push(result('mid', 'بويضات 14–16 مم', 'Follicles 14–16 mm', all.filter((x) => x >= 14 && x < 17).length, { d: 0 }));
      if (all.filter((x) => x >= 12).length >= 20 || num(d.e2) >= 4000) out.push(result('ohss', 'خطر فرط التحفيز', 'OHSS risk', '↑', { level: 'bad', text: { ar: 'خطر فرط تحفيز المبايض', en: 'Risk of ovarian hyperstimulation' } }));
    }
    const e = num(d.endo);
    if (e !== null) out.push(result('endo', 'البطانة', 'Endometrium', e, { unit: 'mm', bands: [[7, 'warn', 'رقيقة (< 7 مم)', 'Thin (< 7 mm)'], [null, 'ok', 'مناسبة', 'Adequate']] }));
    return out;
  },
};

// WHO laboratory manual (6th edition, 2021): lower reference limits (5th centile).
const WHO21 = { volume: 1.4, conc: 16, total: 39, motility: 42, progressive: 30, morphology: 4, vitality: 54 };
const semen = {
  key: 'semen_analysis', v: 1, icon: 'flask-conical', ar: 'تحليل السائل المنوي', en: 'Semen analysis',
  specialties: ['fertility', 'urology'],
  cite: 'WHO Laboratory Manual for the Examination and Processing of Human Semen, 6th ed. (2021): lower reference limits.',
  sections: [{ ar: 'النتائج', en: 'Results', fields: [
    { k: 'abstinence', t: 'int', ar: 'أيام الامتناع', en: 'Abstinence', unit: 'd', min: 0, max: 30 },
    { k: 'volume', t: 'num', ar: 'الحجم', en: 'Volume', unit: 'mL', min: 0, max: 20, step: 0.1 },
    { k: 'ph', t: 'num', ar: 'الحموضة (pH)', en: 'pH', min: 5, max: 10, step: 0.1 },
    { k: 'conc', t: 'num', ar: 'التركيز', en: 'Concentration', unit: '×10⁶/mL', min: 0, max: 500, step: 0.1, trend: true },
    { k: 'motility', t: 'int', ar: 'الحركة الكلية', en: 'Total motility', unit: '%', min: 0, max: 100 },
    { k: 'progressive', t: 'int', ar: 'الحركة التقدمية', en: 'Progressive motility', unit: '%', min: 0, max: 100, trend: true },
    { k: 'morphology', t: 'num', ar: 'الأشكال الطبيعية', en: 'Normal forms', unit: '%', min: 0, max: 100, step: 0.5 },
    { k: 'vitality', t: 'int', ar: 'الحيوية', en: 'Vitality', unit: '%', min: 0, max: 100 },
    { k: 'wbc', t: 'num', ar: 'كريات الدم البيضاء', en: 'Leucocytes', unit: '×10⁶/mL', min: 0, max: 50, step: 0.1 },
  ] }],
  compute(d) {
    const out = [];
    const vol = num(d.volume); const conc = num(d.conc);
    const total = vol !== null && conc !== null ? vol * conc : null;
    if (total !== null) out.push(result('total', 'العدد الكلي', 'Total sperm number', total, { unit: '×10⁶', d: 1, bands: [[WHO21.total, 'warn', 'أقل من الحد المرجعي', 'Below reference'], [null, 'ok', 'ضمن المرجع', 'Within reference']] }));
    const terms = [];
    if (conc === 0) terms.push(['azoospermia', 'انعدام النطاف (Azoospermia)', 'Azoospermia']);
    else {
      if ((conc !== null && conc < WHO21.conc) || (total !== null && total < WHO21.total)) terms.push(['oligo', 'قلة النطاف (Oligozoospermia)', 'Oligozoospermia']);
      if (num(d.progressive) !== null && d.progressive < WHO21.progressive) terms.push(['astheno', 'ضعف الحركة (Asthenozoospermia)', 'Asthenozoospermia']);
      if (num(d.morphology) !== null && d.morphology < WHO21.morphology) terms.push(['terato', 'تشوّه الأشكال (Teratozoospermia)', 'Teratozoospermia']);
    }
    if (vol !== null && vol < WHO21.volume) terms.push(['hypo', 'قلة الحجم (Hypospermia)', 'Hypospermia']);
    if (num(d.vitality) !== null && d.vitality < WHO21.vitality) terms.push(['necro', 'حيوية منخفضة', 'Low vitality']);
    if (num(d.wbc) !== null && d.wbc >= 1) terms.push(['leuco', 'كريات بيضاء ≥ 1 مليون/مل', 'Leucocytospermia']);
    const measured = ['volume', 'conc', 'progressive', 'morphology'].some((k) => num(d[k]) !== null);
    if (terms.length) out.unshift(result('dx', 'النتيجة', 'Finding', terms.map((t) => t[0]).join(' + '), { level: conc === 0 ? 'bad' : 'warn', text: { ar: terms.map((t) => t[1]).join('، '), en: terms.map((t) => t[2]).join(', ') } }));
    else if (measured) out.unshift(result('dx', 'النتيجة', 'Finding', 'normozoospermia', { level: 'ok', text: { ar: 'ضمن الحدود المرجعية لمنظمة الصحة العالمية 2021', en: 'Within WHO 2021 reference limits' } }));
    return out;
  },
};

const FREQ6 = [['أبدًا', 'Not at all'], ['أقل من مرة من كل 5', 'Less than 1 time in 5'], ['أقل من نصف المرات', 'Less than half the time'], ['حوالي نصف المرات', 'About half the time'], ['أكثر من نصف المرات', 'More than half the time'], ['دائمًا تقريبًا', 'Almost always']];
const IPSS = [
  ['الشعور بعدم إفراغ المثانة بالكامل', 'Incomplete emptying'], ['الحاجة للتبول مرة أخرى خلال أقل من ساعتين', 'Frequency (again within 2 hours)'],
  ['توقف وبدء البول عدة مرات', 'Intermittency'], ['صعوبة تأجيل التبول', 'Urgency'], ['ضعف مجرى البول', 'Weak stream'], ['الحاجة للدفع أو الشد لبدء التبول', 'Straining'],
];
const ipss = {
  key: 'ipss', v: 1, icon: 'droplet', ar: 'أعراض البروستاتا (IPSS)', en: 'Prostate symptoms (IPSS)',
  specialties: ['urology'],
  cite: 'International Prostate Symptom Score (AUA symptom index). Mild 0–7, moderate 8–19, severe 20–35; quality of life 0–6. Over the past month.',
  sections: [
    { ar: 'خلال الشهر الماضي', en: 'Over the past month', fields: [
      ...IPSS.map(([ar, en], i) => ({ k: `q${i + 1}`, t: 'sel', ar: `${i + 1}. ${ar}`, en: `${i + 1}. ${en}`, opts: FREQ6.map(([a, e], v) => [v, `${v} — ${a}`, `${v} — ${e}`]) })),
      { k: 'q7', t: 'sel', ar: '7. عدد مرات الاستيقاظ ليلًا للتبول', en: '7. Nocturia (times per night)', opts: [0, 1, 2, 3, 4, 5].map((v) => [v, v === 5 ? '5 مرات أو أكثر' : `${v}`, v === 5 ? '5 or more' : `${v}`]) },
      { k: 'qol', t: 'sel', ar: 'جودة الحياة لو بقيت الأعراض هكذا', en: 'Quality of life if symptoms stayed', opts: [[0, '0 — مسرور جدًا', '0 — delighted'], [1, '1 — مسرور', '1 — pleased'], [2, '2 — راضٍ غالبًا', '2 — mostly satisfied'], [3, '3 — بين الرضا وعدمه', '3 — mixed'], [4, '4 — غير راضٍ غالبًا', '4 — mostly dissatisfied'], [5, '5 — غير سعيد', '5 — unhappy'], [6, '6 — سيئ جدًا', '6 — terrible']] },
    ] },
    { ar: 'الفحوصات', en: 'Tests', fields: [
      { k: 'psa', t: 'num', ar: 'PSA', en: 'PSA', unit: 'ng/mL', min: 0, max: 5000, step: 0.01, trend: true },
      { k: 'volume', t: 'int', ar: 'حجم البروستاتا', en: 'Prostate volume', unit: 'mL', min: 5, max: 400 },
      { k: 'pvr', t: 'int', ar: 'البول المتبقي بعد التبول', en: 'Post-void residual', unit: 'mL', min: 0, max: 3000 },
      { k: 'qmax', t: 'num', ar: 'أقصى تدفق (Qmax)', en: 'Max flow (Qmax)', unit: 'mL/s', min: 0, max: 60, step: 0.1 },
    ] },
  ],
  compute(d) {
    const s = sum(d, ['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7']);
    const out = [result('score', 'مجموع IPSS', 'IPSS', s, { unit: '/35', d: 0, bands: [[8, 'ok', 'أعراض خفيفة', 'Mild'], [20, 'warn', 'أعراض متوسطة', 'Moderate'], [null, 'bad', 'أعراض شديدة', 'Severe']] })];
    const psa = num(d.psa); const vol = num(d.volume);
    if (psa !== null && vol) out.push(result('psad', 'كثافة PSA', 'PSA density', psa / vol, { unit: 'ng/mL/mL', d: 2, bands: [[0.15, 'ok', 'أقل من 0.15', 'Below 0.15'], [null, 'warn', '0.15 أو أكثر', '0.15 or more']] }));
    const q = num(d.qmax);
    if (q !== null && q < 10) out.push(result('qmax', 'Qmax', 'Qmax', q, { unit: 'mL/s', level: 'warn', text: { ar: 'تدفق ضعيف (< 10)', en: 'Low flow (< 10)' } }));
    return out;
  },
};

module.exports = [gyn, bishop, follicles, semen, ipss];

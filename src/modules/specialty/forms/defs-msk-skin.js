// Bones, joints, pain and skin: range of motion and muscle testing, pain assessment, DAS28, orthopaedic examination,
// skin lesion (ABCDE), PASI, aesthetic injections.
const { result, num, sum } = require('./engine');

// Normal active ranges in degrees (American Academy of Orthopaedic Surgeons).
const MOTIONS = [
  ['sh_flex', 'ثني الكتف', 'Shoulder flexion', 180], ['sh_abd', 'إبعاد الكتف', 'Shoulder abduction', 180], ['sh_er', 'دوران الكتف الخارجي', 'Shoulder external rotation', 90],
  ['sh_ir', 'دوران الكتف الداخلي', 'Shoulder internal rotation', 70], ['el_flex', 'ثني المرفق', 'Elbow flexion', 150], ['wr_flex', 'ثني الرسغ', 'Wrist flexion', 80],
  ['wr_ext', 'بسط الرسغ', 'Wrist extension', 70], ['hip_flex', 'ثني الورك', 'Hip flexion', 120], ['hip_abd', 'إبعاد الورك', 'Hip abduction', 45],
  ['hip_ir', 'دوران الورك الداخلي', 'Hip internal rotation', 45], ['knee_flex', 'ثني الركبة', 'Knee flexion', 135], ['ank_df', 'رفع القدم', 'Ankle dorsiflexion', 20],
  ['ank_pf', 'ثني القدم للأسفل', 'Ankle plantarflexion', 50], ['cx_rot', 'دوران الرقبة', 'Cervical rotation', 80], ['lx_flex', 'ثني أسفل الظهر', 'Lumbar flexion', 60],
];
const LR = [['r', 'يمين', 'Right'], ['l', 'يسار', 'Left']];

const rom = {
  key: 'rom_mmt', v: 1, icon: 'move', ar: 'مدى الحركة وقوة العضلات', en: 'Range of motion & muscle testing',
  specialties: ['physiotherapy', 'orthopaedics', 'sports', 'rheumatology', 'pain'],
  cite: 'Goniometric normal values of the American Academy of Orthopaedic Surgeons; manual muscle testing on the Oxford scale (0–5).',
  sections: [
    { ar: 'مدى الحركة الفعّال (درجات)', en: 'Active range of motion (degrees)', fields: [
      { k: 'rom', t: 'grid', ar: 'مدى الحركة', en: 'Range of motion', rows: MOTIONS.map(([k, ar, en, n]) => [k, `${ar} (${n}°)`, `${en} (${n}°)`]), cols: LR, cell: { t: 'int', min: 0, max: 200, unit: '°' } },
    ] },
    { ar: 'قوة العضلات (أكسفورد 0–5)', en: 'Muscle strength (Oxford 0–5)', fields: [
      { k: 'mmt', t: 'grid', ar: 'القوة', en: 'Strength', rows: MOTIONS.map(([k, ar, en]) => [k, ar, en]), cols: LR, cell: { t: 'int', min: 0, max: 5 } },
    ] },
    { ar: 'الوظيفة والأهداف', en: 'Function and goals', fields: [
      { k: 'pain', t: 'int', ar: 'الألم الآن (0–10)', en: 'Pain now (0–10)', min: 0, max: 10, trend: true },
      { k: 'function', t: 'area', ar: 'القيود الوظيفية', en: 'Functional limitations', wide: true },
      { k: 'goals', t: 'area', ar: 'أهداف العلاج', en: 'Treatment goals', wide: true },
      { k: 'plan', t: 'multi', ar: 'العلاج', en: 'Treatment', opts: [['exercise', 'تمارين علاجية', 'Therapeutic exercise'], ['manual', 'علاج يدوي', 'Manual therapy'], ['electro', 'علاج كهربائي', 'Electrotherapy'], ['us', 'موجات فوق صوتية', 'Ultrasound'], ['heat', 'حرارة/برودة', 'Heat / cold'], ['needling', 'إبر جافة', 'Dry needling'], ['taping', 'لاصق علاجي', 'Taping'], ['traction', 'شدّ', 'Traction'], ['education', 'تثقيف وتمارين منزلية', 'Education and home exercise']] },
    ] },
  ],
  compute(d) {
    const out = [];
    const limited = [];
    for (const [k, ar, en, n] of MOTIONS) {
      for (const [c, car, cen] of LR) {
        const v = num(d[`rom__${k}__${c}`]);
        if (v !== null && v < 0.75 * n) limited.push({ ar: `${ar} (${car}) ${Math.round((v / n) * 100)}%`, en: `${en} (${cen}) ${Math.round((v / n) * 100)}%` });
      }
    }
    if (limited.length) out.push(result('limited', 'حركة محدودة (< 75% من الطبيعي)', 'Limited motion (< 75% of normal)', limited.length, { level: 'warn', text: { ar: limited.map((x) => x.ar).join('، '), en: limited.map((x) => x.en).join(', ') } }));
    const weak = [];
    for (const [k, ar, en] of MOTIONS) for (const [c, car, cen] of LR) { const v = num(d[`mmt__${k}__${c}`]); if (v !== null && v < 4) weak.push({ ar: `${ar} (${car}) ${v}/5`, en: `${en} (${cen}) ${v}/5` }); }
    if (weak.length) out.push(result('weak', 'ضعف عضلي', 'Weakness', weak.length, { level: 'warn', text: { ar: weak.map((x) => x.ar).join('، '), en: weak.map((x) => x.en).join(', ') } }));
    out.push(result('pain', 'الألم', 'Pain', num(d.pain), { unit: '/10', d: 0, bands: [[1, 'ok', 'لا ألم', 'No pain'], [4, 'mild', 'خفيف', 'Mild'], [7, 'warn', 'متوسط', 'Moderate'], [null, 'bad', 'شديد', 'Severe']] }));
    return out;
  },
};

const pain = {
  key: 'pain_assessment', v: 1, icon: 'zap', ar: 'تقييم الألم', en: 'Pain assessment',
  specialties: ['pain', 'physiotherapy', 'oncology', 'orthopaedics', 'rheumatology', 'sports', 'neurosurgery'],
  cite: 'Numeric Rating Scale 0–10 (mild 1–3, moderate 4–6, severe 7–10); red flags for serious spinal pathology.',
  sections: [
    { ar: 'الشدة', en: 'Intensity', fields: [
      { k: 'now', t: 'int', ar: 'الآن (0–10)', en: 'Now (0–10)', min: 0, max: 10, trend: true },
      { k: 'worst', t: 'int', ar: 'الأسوأ خلال 24 ساعة', en: 'Worst in 24 h', min: 0, max: 10 },
      { k: 'least', t: 'int', ar: 'الأقل خلال 24 ساعة', en: 'Least in 24 h', min: 0, max: 10 },
      { k: 'interference', t: 'int', ar: 'التأثير على الأنشطة (0–10)', en: 'Interference with activity (0–10)', min: 0, max: 10 },
    ] },
    { ar: 'الوصف', en: 'Description', fields: [
      { k: 'site', t: 'text', ar: 'المكان', en: 'Site' },
      { k: 'character', t: 'multi', ar: 'طبيعة الألم', en: 'Character', opts: [['aching', 'وجع', 'Aching'], ['sharp', 'حاد', 'Sharp'], ['burning', 'حارق', 'Burning'], ['throbbing', 'نابض', 'Throbbing'], ['shooting', 'منتشر كالكهرباء', 'Shooting'], ['stabbing', 'طاعن', 'Stabbing'], ['cramping', 'تقلّصي', 'Cramping'], ['tingling', 'تنميل', 'Tingling / numbness']] },
      { k: 'duration', t: 'sel', ar: 'المدة', en: 'Duration', opts: [['acute', 'حاد (أقل من 6 أسابيع)', 'Acute (< 6 weeks)'], ['subacute', 'تحت الحاد (6–12 أسبوعًا)', 'Subacute (6–12 weeks)'], ['chronic', 'مزمن (أكثر من 3 أشهر)', 'Chronic (> 3 months)']] },
      { k: 'pattern', t: 'multi', ar: 'النمط', en: 'Pattern', opts: [['constant', 'مستمر', 'Constant'], ['intermittent', 'متقطع', 'Intermittent'], ['night', 'ليلي', 'At night'], ['morning', 'تيبّس صباحي', 'Morning stiffness'], ['activity', 'مع الحركة', 'With activity']] },
      { k: 'aggravating', t: 'text', ar: 'ما يزيده', en: 'Aggravating factors' },
      { k: 'relieving', t: 'text', ar: 'ما يخففه', en: 'Relieving factors' },
      { k: 'flags', t: 'multi', ar: 'علامات الخطر', en: 'Red flags', opts: [['fever', 'حرارة أو تعرّق ليلي', 'Fever or night sweats'], ['weight', 'نقص وزن غير مبرر', 'Unexplained weight loss'], ['saddle', 'خدر في منطقة السرج', 'Saddle anaesthesia'], ['sphincter', 'تغيّر في البول أو الإخراج', 'Bladder or bowel change'], ['weakness', 'ضعف متزايد', 'Progressive weakness'], ['trauma', 'إصابة شديدة', 'Significant trauma'], ['cancer', 'تاريخ ورم', 'History of cancer']] },
      { k: 'notes', t: 'area', ar: 'ملاحظات', en: 'Notes', wide: true },
    ] },
  ],
  compute(d) {
    const out = [result('now', 'الألم الآن', 'Pain now', num(d.now), { unit: '/10', d: 0, bands: [[1, 'ok', 'لا ألم', 'No pain'], [4, 'mild', 'خفيف', 'Mild'], [7, 'warn', 'متوسط', 'Moderate'], [null, 'bad', 'شديد', 'Severe']] })];
    const flags = [].concat(d.flags || []);
    if (flags.length) out.push(result('flags', 'علامات خطر', 'Red flags', flags.length, { level: 'bad', text: { ar: 'تحتاج تقييمًا عاجلًا', en: 'Need urgent assessment' } }));
    return out;
  },
};

const das28 = {
  key: 'das28', v: 1, icon: 'activity', ar: 'نشاط الروماتويد (DAS28)', en: 'Rheumatoid activity (DAS28)',
  specialties: ['rheumatology'],
  cite: 'Prevoo ML et al. Arthritis Rheum 1995;38:44–8. Remission < 2.6, low ≤ 3.2, moderate ≤ 5.1, high > 5.1.',
  sections: [{ ar: 'القيم', en: 'Values', fields: [
    { k: 'tjc', t: 'int', ar: 'عدد المفاصل المؤلمة (من 28)', en: 'Tender joints (of 28)', min: 0, max: 28 },
    { k: 'sjc', t: 'int', ar: 'عدد المفاصل المتورمة (من 28)', en: 'Swollen joints (of 28)', min: 0, max: 28 },
    { k: 'esr', t: 'int', ar: 'سرعة الترسيب (ESR)', en: 'ESR', unit: 'mm/h', min: 1, max: 150 },
    { k: 'crp', t: 'num', ar: 'CRP', en: 'CRP', unit: 'mg/L', min: 0, max: 500, step: 0.1 },
    { k: 'gh', t: 'int', ar: 'تقييم المريض العام (0–100)', en: 'Patient global health (0–100)', min: 0, max: 100 },
    { k: 'morning', t: 'int', ar: 'التيبّس الصباحي', en: 'Morning stiffness', unit: 'min', min: 0, max: 1440 },
  ] }],
  compute(d) {
    const tjc = num(d.tjc); const sjc = num(d.sjc); const gh = num(d.gh); const esr = num(d.esr); const crp = num(d.crp);
    if (tjc === null || sjc === null || gh === null) return [];
    const bands = [[2.6, 'ok', 'هدأة', 'Remission'], [3.21, 'mild', 'نشاط منخفض', 'Low activity'], [5.11, 'warn', 'نشاط متوسط', 'Moderate activity'], [null, 'bad', 'نشاط مرتفع', 'High activity']];
    const base = 0.56 * Math.sqrt(tjc) + 0.28 * Math.sqrt(sjc) + 0.014 * gh;
    return [
      esr !== null ? result('esr', 'DAS28-ESR', 'DAS28-ESR', base + 0.7 * Math.log(esr), { d: 2, bands }) : null,
      crp !== null ? result('crp', 'DAS28-CRP', 'DAS28-CRP', base + 0.36 * Math.log(crp + 1) + 0.96, { d: 2, bands }) : null,
    ];
  },
};

const ortho = {
  key: 'ortho_exam', v: 1, icon: 'bone', ar: 'فحص العظام والمفاصل', en: 'Orthopaedic examination',
  specialties: ['orthopaedics', 'sports'],
  cite: 'Fractures may be coded with the AO/OTA classification.',
  sections: [
    { ar: 'المكان والإصابة', en: 'Site and injury', fields: [
      { k: 'region', t: 'sel', ar: 'المنطقة', en: 'Region', opts: [['shoulder', 'الكتف', 'Shoulder'], ['elbow', 'المرفق', 'Elbow'], ['wrist_hand', 'الرسغ واليد', 'Wrist and hand'], ['spine_c', 'الرقبة', 'Cervical spine'], ['spine_l', 'أسفل الظهر', 'Lumbar spine'], ['hip', 'الورك', 'Hip'], ['knee', 'الركبة', 'Knee'], ['ankle_foot', 'الكاحل والقدم', 'Ankle and foot']] },
      { k: 'side', t: 'sel', ar: 'الجهة', en: 'Side', opts: [['right', 'يمين', 'Right'], ['left', 'يسار', 'Left'], ['both', 'الجهتان', 'Both']] },
      { k: 'mechanism', t: 'text', ar: 'آلية الإصابة', en: 'Mechanism of injury' },
    ] },
    { ar: 'الفحص', en: 'Examination', fields: [
      { k: 'swelling', t: 'sel', ar: 'التورم', en: 'Swelling', opts: [['none', 'لا يوجد', 'None'], ['mild', 'خفيف', 'Mild'], ['moderate', 'متوسط', 'Moderate'], ['severe', 'شديد', 'Severe']] },
      { k: 'effusion', t: 'bool', ar: 'انصباب في المفصل', en: 'Joint effusion' },
      { k: 'deformity', t: 'text', ar: 'تشوّه', en: 'Deformity' },
      { k: 'tests', t: 'area', ar: 'الاختبارات الخاصة ونتائجها', en: 'Special tests and results', wide: true },
      { k: 'nv', t: 'sel', ar: 'الأعصاب والدورة الدموية', en: 'Neurovascular status', opts: [['intact', 'سليمة', 'Intact'], ['impaired', 'متأثرة', 'Impaired']] },
    ] },
    { ar: 'الصور والخطة', en: 'Imaging and plan', fields: [
      { k: 'imaging', t: 'area', ar: 'نتائج الأشعة', en: 'Imaging findings', wide: true },
      { k: 'ao', t: 'text', ar: 'تصنيف الكسر (AO/OTA)', en: 'Fracture class (AO/OTA)' },
      { k: 'plan', t: 'sel', ar: 'العلاج', en: 'Management', opts: [['conservative', 'تحفظي', 'Conservative'], ['cast', 'جبيرة', 'Cast / splint'], ['injection', 'حقنة', 'Injection'], ['physio', 'علاج طبيعي', 'Physiotherapy'], ['surgery', 'جراحة', 'Surgery']] },
    ] },
  ],
  compute(d) {
    return [d.nv === 'impaired' ? result('nv', 'الأعصاب والدورة', 'Neurovascular', 'impaired', { level: 'bad', text: { ar: 'متأثرة — تحتاج تدخلًا عاجلًا', en: 'Impaired — urgent action' } }) : null];
  },
};

const lesion = {
  key: 'skin_lesion', v: 1, icon: 'scan-line', ar: 'وصف آفة جلدية', en: 'Skin lesion',
  specialties: ['dermatology', 'plastic', 'oncology'],
  cite: 'ABCDE checklist for melanoma (Asymmetry, Border, Colour, Diameter > 6 mm, Evolving); Fitzpatrick skin type.',
  sections: [
    { ar: 'الآفة', en: 'Lesion', fields: [
      { k: 'site', t: 'text', ar: 'المكان', en: 'Site', req: true },
      { k: 'morphology', t: 'sel', ar: 'الشكل', en: 'Morphology', opts: [['macule', 'بقعة', 'Macule'], ['patch', 'لطخة', 'Patch'], ['papule', 'حطاطة', 'Papule'], ['plaque', 'لويحة', 'Plaque'], ['nodule', 'عقدة', 'Nodule'], ['vesicle', 'حويصلة', 'Vesicle'], ['bulla', 'فقاعة', 'Bulla'], ['pustule', 'بثرة', 'Pustule'], ['wheal', 'شرية', 'Wheal'], ['erosion', 'تآكل', 'Erosion'], ['ulcer', 'قرحة', 'Ulcer'], ['scale', 'قشور', 'Scale'], ['crust', 'قشرة', 'Crust']] },
      { k: 'size', t: 'num', ar: 'القطر', en: 'Diameter', unit: 'mm', min: 0.5, max: 500, step: 0.5, trend: true },
      { k: 'colour', t: 'multi', ar: 'اللون', en: 'Colour', opts: [['skin', 'بلون الجلد', 'Skin-coloured'], ['red', 'أحمر', 'Red'], ['brown', 'بني', 'Brown'], ['black', 'أسود', 'Black'], ['blue', 'أزرق-رمادي', 'Blue-grey'], ['white', 'أبيض', 'White'], ['yellow', 'أصفر', 'Yellow']] },
      { k: 'distribution', t: 'sel', ar: 'التوزع', en: 'Distribution', opts: [['localised', 'موضعي', 'Localised'], ['generalised', 'منتشر', 'Generalised'], ['symmetrical', 'متناظر', 'Symmetrical'], ['dermatomal', 'على مسار عصب', 'Dermatomal'], ['flexural', 'في الثنيات', 'Flexural'], ['extensor', 'على الأسطح الباسطة', 'Extensor'], ['photo', 'في المناطق المعرضة للشمس', 'Photo-exposed']] },
      { k: 'fitz', t: 'sel', ar: 'نوع البشرة (فيتزباتريك)', en: 'Skin type (Fitzpatrick)', opts: [['I', 'I', 'I'], ['II', 'II', 'II'], ['III', 'III', 'III'], ['IV', 'IV', 'IV'], ['V', 'V', 'V'], ['VI', 'VI', 'VI']] },
    ] },
    { ar: 'ABCDE والخطة', en: 'ABCDE and plan', fields: [
      { k: 'a', t: 'bool', ar: 'عدم التناظر (A)', en: 'Asymmetry (A)' },
      { k: 'b', t: 'bool', ar: 'حواف غير منتظمة (B)', en: 'Irregular border (B)' },
      { k: 'c', t: 'bool', ar: 'تعدد الألوان (C)', en: 'Colour variation (C)' },
      { k: 'e', t: 'bool', ar: 'تغيّر حديث (E)', en: 'Evolving (E)' },
      { k: 'dermoscopy', t: 'area', ar: 'المنظار الجلدي', en: 'Dermoscopy', wide: true },
      { k: 'plan', t: 'sel', ar: 'الخطة', en: 'Plan', opts: [['observe', 'مراقبة', 'Observe'], ['photo', 'متابعة بالصور', 'Photo follow-up'], ['biopsy', 'خزعة', 'Biopsy'], ['excision', 'استئصال', 'Excision'], ['treat', 'علاج دوائي', 'Medical treatment'], ['refer', 'تحويل', 'Refer']] },
    ] },
  ],
  compute(d) {
    const n = ['a', 'b', 'c', 'e'].filter((k) => d[k]).length + (num(d.size) !== null && d.size > 6 ? 1 : 0);
    if (!n && !['a', 'b', 'c', 'e'].some((k) => d[k]) && num(d.size) === null) return [];
    return [result('abcde', 'علامات ABCDE', 'ABCDE signs', n, { unit: '/5', d: 0, bands: [[1, 'ok', 'لا علامات', 'None'], [2, 'mild', 'علامة واحدة', 'One sign'], [null, 'warn', 'علامتان أو أكثر — منظار جلدي/خزعة', 'Two or more — dermoscopy / biopsy']] })];
  },
};

const REGIONS = [['head', 'الرأس والرقبة (×0.1)', 'Head and neck (×0.1)', 0.1], ['upper', 'الأطراف العلوية (×0.2)', 'Upper limbs (×0.2)', 0.2], ['trunk', 'الجذع (×0.3)', 'Trunk (×0.3)', 0.3], ['lower', 'الأطراف السفلية (×0.4)', 'Lower limbs (×0.4)', 0.4]];
const pasi = {
  key: 'pasi', v: 1, icon: 'scan-line', ar: 'شدة الصدفية (PASI)', en: 'Psoriasis severity (PASI)',
  specialties: ['dermatology'],
  cite: 'Fredriksson T, Pettersson U. Dermatologica 1978;157:238–44. Erythema, induration and scaling 0–4; area 0–6 (0 = none, 1 < 10%, 2 = 10–29%, 3 = 30–49%, 4 = 50–69%, 5 = 70–89%, 6 = 90–100%).',
  sections: [{ ar: 'كل منطقة', en: 'Each region', fields: [
    { k: 'p', t: 'grid', ar: 'PASI', en: 'PASI', rows: REGIONS.map(([k, ar, en]) => [k, ar, en]), cols: [['e', 'احمرار (0–4)', 'Erythema (0–4)'], ['i', 'سماكة (0–4)', 'Induration (0–4)'], ['s', 'قشور (0–4)', 'Scaling (0–4)'], ['a', 'المساحة (0–6)', 'Area (0–6)']], cell: { t: 'int', min: 0, max: 6 } },
    { k: 'bsa', t: 'num', ar: 'نسبة سطح الجسم المصاب', en: 'Body surface area', unit: '%', min: 0, max: 100, step: 0.5 },
    { k: 'notes', t: 'area', ar: 'ملاحظات', en: 'Notes', wide: true },
  ] }],
  check(d) {
    const e = {};
    for (const [r] of REGIONS) for (const c of ['e', 'i', 's']) if (num(d[`p__${r}__${c}`]) !== null && d[`p__${r}__${c}`] > 4) e[`p__${r}__${c}`] = 'Too large.';
    return e;
  },
  compute(d) {
    let total = 0; let any = false;
    for (const [r, , , w] of REGIONS) {
      const [e, i, s, a] = ['e', 'i', 's', 'a'].map((c) => num(d[`p__${r}__${c}`]));
      if ([e, i, s, a].some((v) => v !== null)) any = true;
      total += w * ((e || 0) + (i || 0) + (s || 0)) * (a || 0);
    }
    return any ? [result('pasi', 'PASI', 'PASI', total, { unit: '/72', d: 1, bands: [[5, 'mild', 'خفيف', 'Mild'], [10.1, 'warn', 'متوسط', 'Moderate'], [null, 'bad', 'شديد (> 10)', 'Severe (> 10)']] })] : [];
  },
};

const AREAS = [['forehead', 'الجبهة', 'Forehead'], ['glabella', 'بين الحاجبين', 'Glabella'], ['crows', 'حول العينين', 'Crow’s feet'], ['bunny', 'جانبي الأنف', 'Bunny lines'],
  ['tear', 'تحت العين', 'Tear trough'], ['cheeks', 'الخدين', 'Cheeks'], ['nasolabial', 'خط الابتسامة', 'Nasolabial folds'], ['lips', 'الشفاه', 'Lips'],
  ['marionette', 'خطوط الماريونيت', 'Marionette lines'], ['chin', 'الذقن', 'Chin'], ['jaw', 'خط الفك', 'Jawline'], ['masseter', 'عضلة الفك', 'Masseter'],
  ['neck', 'الرقبة', 'Neck'], ['axillae', 'الإبطين (تعرّق)', 'Axillae (sweating)'], ['other', 'أخرى', 'Other']];
const injection = {
  key: 'aesthetic_injection', v: 1, icon: 'syringe', ar: 'جلسة حقن تجميلي', en: 'Aesthetic injection',
  specialties: ['cosmetic', 'dermatology', 'plastic'],
  cite: 'Product, lot and expiry are recorded for traceability.',
  sections: [
    { ar: 'المنتج', en: 'Product', fields: [
      { k: 'product', t: 'sel', ar: 'النوع', en: 'Type', req: true, opts: [['toxin', 'توكسين البوتولينوم', 'Botulinum toxin'], ['ha', 'فيلر حمض الهيالورونيك', 'Hyaluronic acid filler'], ['booster', 'معزز البشرة', 'Skin booster'], ['prp', 'بلازما (PRP)', 'PRP'], ['pn', 'بولي نيوكليوتيدات', 'Polynucleotides'], ['caha', 'هيدروكسيأباتيت الكالسيوم', 'Calcium hydroxylapatite'], ['plla', 'حمض البولي لاكتيك', 'Poly-L-lactic acid'], ['other', 'أخرى', 'Other']] },
      { k: 'brand', t: 'text', ar: 'الاسم التجاري', en: 'Brand' },
      { k: 'lot', t: 'text', ar: 'رقم التشغيلة (LOT)', en: 'Lot number' },
      { k: 'expiry', t: 'date', ar: 'تاريخ الانتهاء', en: 'Expiry date' },
      { k: 'dilution', t: 'text', ar: 'التخفيف', en: 'Dilution' },
      { k: 'unit', t: 'sel', ar: 'وحدة الكمية', en: 'Amount unit', opts: [['U', 'وحدة (U)', 'Units (U)'], ['mL', 'مل (mL)', 'mL']] },
    ] },
    { ar: 'المناطق والكميات', en: 'Areas and amounts', fields: [
      { k: 'amt', t: 'grid', ar: 'الكمية', en: 'Amount', rows: AREAS, cols: [['q', 'الكمية', 'Amount']], cell: { t: 'num', min: 0, max: 500, step: 0.05 } },
    ] },
    { ar: 'السلامة والمتابعة', en: 'Safety and follow-up', fields: [
      { k: 'consent', t: 'bool', ar: 'تم أخذ الموافقة', en: 'Consent taken' },
      { k: 'photos', t: 'bool', ar: 'تم التصوير قبل الجلسة', en: 'Before photos taken' },
      { k: 'complications', t: 'text', ar: 'مضاعفات', en: 'Complications' },
      { k: 'review', t: 'date', ar: 'موعد المراجعة', en: 'Review date' },
    ] },
  ],
  compute(d) {
    const total = sum(d, AREAS.map(([k]) => `amt__${k}__q`), { partial: true });
    const out = [result('total', 'الكمية الكلية', 'Total amount', total, { unit: d.unit || null, d: 2 })];
    if (d.expiry && d.expiry < new Date().toISOString().slice(0, 10)) out.push(result('expired', 'المنتج', 'Product', d.expiry, { level: 'bad', text: { ar: 'منتهي الصلاحية', en: 'Expired' } }));
    if (!d.consent) out.push(result('consent', 'الموافقة', 'Consent', '—', { level: 'warn', text: { ar: 'لم تُسجَّل', en: 'Not recorded' } }));
    return out;
  },
};

module.exports = [rom, pain, das28, ortho, lesion, pasi, injection];

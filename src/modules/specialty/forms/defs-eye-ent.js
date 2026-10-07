// Eye, ear, nose and throat: eye examination, glasses prescription, pure-tone audiogram, ENT examination.
const { result, num, opts, round } = require('./engine');

const SNELLEN = opts(...['6/5', '6/6', '6/7.5', '6/9', '6/12', '6/18', '6/24', '6/36', '6/60', '3/60', '1/60'],
  ['CF', 'عدّ الأصابع (CF)', 'Counting fingers (CF)'], ['HM', 'حركة اليد (HM)', 'Hand movements (HM)'],
  ['PL', 'إدراك الضوء (PL)', 'Perception of light (PL)'], ['NPL', 'لا إدراك للضوء (NPL)', 'No perception of light (NPL)']);

const eyeExam = {
  key: 'eye_exam', v: 1, icon: 'eye', ar: 'فحص العيون', en: 'Eye examination',
  specialties: ['ophthalmology', 'optometry'],
  cite: 'Visual acuity in Snellen metric notation; diabetic retinopathy by the International Clinical DR Severity Scale (AAO 2002).',
  sections: [
    { ar: 'حدة الإبصار', en: 'Visual acuity', fields: [
      { k: 'ucva', t: 'sel', side: 'eye', ar: 'بدون تصحيح (UCVA)', en: 'Uncorrected (UCVA)', opts: SNELLEN },
      { k: 'bcva', t: 'sel', side: 'eye', ar: 'أفضل تصحيح (BCVA)', en: 'Best corrected (BCVA)', opts: SNELLEN },
    ] },
    { ar: 'الانكسار', en: 'Refraction', fields: [
      { k: 'sph', t: 'num', side: 'eye', ar: 'كروي (SPH)', en: 'Sphere (SPH)', unit: 'D', min: -30, max: 30, step: 0.25 },
      { k: 'cyl', t: 'num', side: 'eye', ar: 'أسطواني (CYL)', en: 'Cylinder (CYL)', unit: 'D', min: -12, max: 12, step: 0.25 },
      { k: 'axis', t: 'int', side: 'eye', ar: 'المحور (AXIS)', en: 'Axis', unit: '°', min: 0, max: 180 },
    ] },
    { ar: 'ضغط العين', en: 'Intraocular pressure', fields: [
      { k: 'iop', t: 'num', side: 'eye', ar: 'ضغط العين (IOP)', en: 'IOP', unit: 'mmHg', min: 0, max: 80, step: 1, trend: true },
      { k: 'iop_method', t: 'sel', ar: 'طريقة القياس', en: 'Method', opts: [['gat', 'تونومتر غولدمان', 'Goldmann applanation'], ['nct', 'نفخة هواء (NCT)', 'Non-contact (air puff)'], ['rebound', 'ارتدادي (iCare)', 'Rebound (iCare)'], ['tonopen', 'Tono-Pen', 'Tono-Pen']] },
    ] },
    { ar: 'الفحص', en: 'Examination', fields: [
      { k: 'pupil', t: 'sel', side: 'eye', ar: 'الحدقة', en: 'Pupil', opts: [['normal', 'طبيعية وتتفاعل', 'Normal, reactive'], ['rapd', 'عيب حدقي وارد نسبي (RAPD)', 'RAPD'], ['sluggish', 'تفاعل بطيء', 'Sluggish'], ['fixed', 'ثابتة لا تتفاعل', 'Fixed']] },
      { k: 'lens', t: 'sel', side: 'eye', ar: 'العدسة', en: 'Lens', opts: [['clear', 'شفافة', 'Clear'], ['cataract', 'ساد (كاتاراكت)', 'Cataract'], ['iol', 'عدسة مزروعة', 'Pseudophakic (IOL)'], ['aphakic', 'بلا عدسة', 'Aphakic']] },
      { k: 'anterior', t: 'text', side: 'eye', ar: 'الجزء الأمامي', en: 'Anterior segment' },
      { k: 'fundus', t: 'text', side: 'eye', ar: 'قاع العين', en: 'Fundus' },
      { k: 'cdr', t: 'num', side: 'eye', ar: 'نسبة الكأس للقرص (C/D)', en: 'Cup/disc ratio', min: 0, max: 1, step: 0.05 },
      { k: 'dr', t: 'sel', side: 'eye', ar: 'اعتلال الشبكية السكري', en: 'Diabetic retinopathy', opts: [['none', 'لا يوجد', 'No apparent retinopathy'], ['mild', 'غير تكاثري خفيف', 'Mild NPDR'], ['moderate', 'غير تكاثري متوسط', 'Moderate NPDR'], ['severe', 'غير تكاثري شديد', 'Severe NPDR'], ['pdr', 'تكاثري (PDR)', 'Proliferative DR']] },
      { k: 'dme', t: 'sel', side: 'eye', ar: 'وذمة البقعة السكرية', en: 'Diabetic macular oedema', opts: [['no', 'لا', 'Absent'], ['yes', 'نعم', 'Present']] },
    ] },
  ],
  compute(d) {
    const out = [];
    for (const [s, ar, en] of [['r', 'اليمنى', 'right'], ['l', 'اليسرى', 'left']]) {
      const iop = num(d[`iop_${s}`]);
      out.push(result(`iop_${s}`, `ضغط العين ${ar}`, `IOP ${en}`, iop, { unit: 'mmHg', d: 0, bands: [[10, 'mild', 'منخفض', 'Low'], [22, 'ok', 'ضمن الطبيعي (10–21)', 'Normal (10–21)'], [30, 'warn', 'مرتفع', 'Raised'], [null, 'bad', 'مرتفع جدًا', 'Markedly raised']] }));
      const cdr = num(d[`cdr_${s}`]);
      if (cdr !== null && cdr >= 0.6) out.push(result(`cdr_${s}`, `C/D ${ar}`, `C/D ${en}`, cdr, { d: 2, level: 'warn', text: { ar: 'كبير — يُقيَّم للزرق', en: 'Large — assess for glaucoma' } }));
      if (['severe', 'pdr'].includes(d[`dr_${s}`]) || d[`dme_${s}`] === 'yes') out.push(result(`dr_${s}`, `الشبكية ${ar}`, `Retina ${en}`, d[`dr_${s}`] === 'pdr' ? 'PDR' : d[`dme_${s}`] === 'yes' ? 'DME' : 'Severe NPDR', { level: 'bad', text: { ar: 'يحتاج تحويلًا/علاجًا', en: 'Needs referral / treatment' } }));
    }
    const a = num(d.cdr_r); const b = num(d.cdr_l);
    if (a !== null && b !== null && Math.abs(a - b) > 0.2) out.push(result('cdr_asym', 'تفاوت C/D بين العينين', 'C/D asymmetry', round(Math.abs(a - b), 2), { level: 'warn', text: { ar: 'أكثر من 0.2', en: 'More than 0.2' } }));
    return out;
  },
};

const glassesRx = {
  key: 'glasses_rx', v: 1, icon: 'glasses', ar: 'وصفة نظارة', en: 'Glasses prescription', printable: true,
  specialties: ['optometry', 'ophthalmology'],
  cite: 'Spherical equivalent = sphere + cylinder ÷ 2.',
  sections: [
    { ar: 'للبعيد', en: 'Distance', fields: [
      { k: 'sph', t: 'num', side: 'eye', ar: 'كروي (SPH)', en: 'Sphere (SPH)', unit: 'D', min: -30, max: 30, step: 0.25 },
      { k: 'cyl', t: 'num', side: 'eye', ar: 'أسطواني (CYL)', en: 'Cylinder (CYL)', unit: 'D', min: -12, max: 12, step: 0.25 },
      { k: 'axis', t: 'int', side: 'eye', ar: 'المحور', en: 'Axis', unit: '°', min: 0, max: 180 },
      { k: 'va', t: 'sel', side: 'eye', ar: 'الإبصار بالوصفة', en: 'VA with Rx', opts: SNELLEN },
    ] },
    { ar: 'للقريب والقياسات', en: 'Near and measurements', fields: [
      { k: 'add', t: 'num', side: 'eye', ar: 'الإضافة (ADD)', en: 'Add', unit: 'D', min: 0, max: 4, step: 0.25 },
      { k: 'pd', t: 'num', ar: 'المسافة بين الحدقتين (PD)', en: 'Pupillary distance (PD)', unit: 'mm', min: 40, max: 80, step: 0.5 },
      { k: 'lens', t: 'sel', ar: 'نوع العدسة', en: 'Lens type', opts: [['single', 'أحادية البؤرة', 'Single vision'], ['bifocal', 'ثنائية البؤرة', 'Bifocal'], ['progressive', 'متعددة البؤر (بروغرسف)', 'Progressive'], ['office', 'للمكتب', 'Office / computer']] },
      { k: 'coat', t: 'multi', ar: 'الإضافات', en: 'Coatings', opts: [['ar', 'مضاد للانعكاس', 'Anti-reflective'], ['blue', 'حماية من الضوء الأزرق', 'Blue-light filter'], ['photo', 'متغيرة اللون', 'Photochromic'], ['tint', 'ملونة', 'Tinted']] },
      { k: 'notes', t: 'area', ar: 'ملاحظات', en: 'Notes', wide: true },
    ] },
  ],
  compute(d) {
    const out = [];
    for (const [s, ar, en] of [['r', 'اليمنى', 'right'], ['l', 'اليسرى', 'left']]) {
      const sph = num(d[`sph_${s}`]);
      if (sph !== null) out.push(result(`se_${s}`, `المكافئ الكروي ${ar}`, `Spherical equivalent ${en}`, sph + (num(d[`cyl_${s}`]) || 0) / 2, { unit: 'D', d: 2 }));
    }
    return out;
  },
};

const FREQ = [['250', '250 Hz', '250 Hz'], ['500', '500 Hz', '500 Hz'], ['1000', '1 kHz', '1 kHz'], ['2000', '2 kHz', '2 kHz'], ['3000', '3 kHz', '3 kHz'], ['4000', '4 kHz', '4 kHz'], ['6000', '6 kHz', '6 kHz'], ['8000', '8 kHz', '8 kHz']];
const EARS = [['r', 'الأذن اليمنى', 'Right ear'], ['l', 'الأذن اليسرى', 'Left ear']];
// WHO World Report on Hearing (2021) grades of the better/each ear's 4-frequency average.
const WHO_HEARING = [[20, 'ok', 'سمع طبيعي', 'Normal hearing'], [35, 'mild', 'فقدان خفيف', 'Mild loss'], [50, 'warn', 'فقدان متوسط', 'Moderate loss'],
  [65, 'warn', 'فقدان متوسط إلى شديد', 'Moderately severe loss'], [80, 'bad', 'فقدان شديد', 'Severe loss'], [95, 'bad', 'فقدان عميق', 'Profound loss'], [null, 'bad', 'فقدان تام', 'Complete loss']];
const pta = (d, prefix, ear) => {
  const v = ['500', '1000', '2000', '4000'].map((f) => num(d[`${prefix}__${f}__${ear}`]));
  return v.every((x) => x !== null) ? v.reduce((a, b) => a + b, 0) / 4 : null;
};

const audiogram = {
  key: 'audiogram', v: 1, icon: 'ear', ar: 'تخطيط السمع', en: 'Pure-tone audiogram',
  specialties: ['audiology', 'ent'],
  cite: 'Four-frequency pure-tone average (0.5, 1, 2, 4 kHz); grades of the WHO World Report on Hearing (2021).',
  sections: [
    { ar: 'التوصيل الهوائي (dB HL)', en: 'Air conduction (dB HL)', fields: [
      { k: 'ac', t: 'grid', ar: 'التوصيل الهوائي', en: 'Air conduction', rows: FREQ, cols: EARS, cell: { t: 'int', min: -10, max: 120, unit: 'dB' } },
    ] },
    { ar: 'التوصيل العظمي (dB HL)', en: 'Bone conduction (dB HL)', fields: [
      { k: 'bc', t: 'grid', ar: 'التوصيل العظمي', en: 'Bone conduction', rows: FREQ.slice(1, 6), cols: EARS, cell: { t: 'int', min: -10, max: 80, unit: 'dB' } },
    ] },
    { ar: 'الكلام وطبلة الأذن', en: 'Speech and tympanometry', fields: [
      { k: 'srt', t: 'int', side: 'ear', ar: 'عتبة استقبال الكلام (SRT)', en: 'Speech reception threshold', unit: 'dB', min: -10, max: 120 },
      { k: 'wrs', t: 'int', side: 'ear', ar: 'تمييز الكلمات', en: 'Word recognition', unit: '%', min: 0, max: 100 },
      { k: 'tymp', t: 'sel', side: 'ear', ar: 'مخطط الطبلة', en: 'Tympanogram', opts: [['A', 'A — طبيعي', 'A — normal'], ['As', 'As — صلابة', 'As — stiff'], ['Ad', 'Ad — ارتخاء', 'Ad — flaccid'], ['B', 'B — مسطّح (سوائل/ثقب)', 'B — flat (fluid / perforation)'], ['C', 'C — ضغط سالب', 'C — negative pressure']] },
      { k: 'notes', t: 'area', ar: 'ملاحظات', en: 'Notes', wide: true },
    ] },
  ],
  compute(d) {
    const out = [];
    for (const [e, ar, en] of EARS) {
      const p = pta(d, 'ac', e);
      out.push(result(`pta_${e}`, `متوسط السمع — ${ar}`, `PTA — ${en}`, p, { unit: 'dB', d: 0, bands: WHO_HEARING }));
      const b = pta(d, 'bc', e) ?? (() => { const v = ['500', '1000', '2000'].map((f) => num(d[`bc__${f}__${e}`])); return v.every((x) => x !== null) ? v.reduce((x, y) => x + y, 0) / 3 : null; })();
      const a3 = ['500', '1000', '2000'].map((f) => num(d[`ac__${f}__${e}`]));
      if (b !== null && a3.every((x) => x !== null)) {
        const gap = a3.reduce((x, y) => x + y, 0) / 3 - b;
        if (gap > 10) out.push(result(`abg_${e}`, `فجوة هوائية-عظمية — ${ar}`, `Air–bone gap — ${en}`, gap, { unit: 'dB', d: 0, level: 'warn', text: { ar: 'مكوّن توصيلي', en: 'Conductive component' } }));
      }
      if (d[`tymp_${e}`] === 'B') out.push(result(`tymp_${e}`, `الطبلة — ${ar}`, `Tympanogram — ${en}`, 'B', { level: 'warn', text: { ar: 'مسطّح: سوائل خلف الطبلة أو ثقب', en: 'Flat: effusion or perforation' } }));
    }
    return out;
  },
};

const entExam = {
  key: 'ent_exam', v: 1, icon: 'stethoscope', ar: 'فحص الأنف والأذن والحنجرة', en: 'ENT examination',
  specialties: ['ent'],
  cite: 'Tonsil size by the Brodsky grading scale (0–4).',
  sections: [
    { ar: 'الأذن', en: 'Ear', fields: [
      { k: 'oto', t: 'sel', side: 'ear', ar: 'تنظير الأذن', en: 'Otoscopy', opts: [['normal', 'طبيعي', 'Normal'], ['wax', 'شمع', 'Wax'], ['oe', 'التهاب أذن خارجية', 'Otitis externa'], ['aom', 'التهاب أذن وسطى حاد', 'Acute otitis media'], ['ome', 'سوائل خلف الطبلة', 'Effusion (OME)'], ['perf', 'ثقب في الطبلة', 'Perforation'], ['retracted', 'طبلة منسحبة', 'Retracted drum']] },
      { k: 'rinne', t: 'sel', side: 'ear', ar: 'اختبار رينيه', en: 'Rinne', opts: [['pos', 'موجب (طبيعي)', 'Positive'], ['neg', 'سالب', 'Negative']] },
      { k: 'weber', t: 'sel', ar: 'اختبار ويبر', en: 'Weber', opts: [['central', 'في المنتصف', 'Central'], ['right', 'ينحاز لليمين', 'Lateralises right'], ['left', 'ينحاز لليسار', 'Lateralises left']] },
    ] },
    { ar: 'الأنف', en: 'Nose', fields: [
      { k: 'septum', t: 'sel', ar: 'الحاجز الأنفي', en: 'Septum', opts: [['straight', 'مستقيم', 'Straight'], ['dev_r', 'منحرف لليمين', 'Deviated right'], ['dev_l', 'منحرف لليسار', 'Deviated left'], ['s_shape', 'انحراف مزدوج', 'S-shaped deviation']] },
      { k: 'turbinates', t: 'sel', ar: 'القرينات', en: 'Turbinates', opts: [['normal', 'طبيعية', 'Normal'], ['hypertrophy', 'متضخمة', 'Hypertrophied']] },
      { k: 'polyps', t: 'sel', side: 'lr', ar: 'لحميات أنفية', en: 'Nasal polyps', opts: [['0', 'لا يوجد', 'None'], ['1', 'درجة 1', 'Grade 1'], ['2', 'درجة 2', 'Grade 2'], ['3', 'درجة 3', 'Grade 3']] },
    ] },
    { ar: 'الحلق والرقبة', en: 'Throat and neck', fields: [
      { k: 'tonsils', t: 'sel', ar: 'اللوزتان (برودسكي)', en: 'Tonsils (Brodsky)', opts: [[0, '0 — مستأصلة', '0 — removed'], [1, '1 — أقل من 25%', '1 — < 25%'], [2, '2 — 25–50%', '2 — 25–50%'], [3, '3 — 50–75%', '3 — 50–75%'], [4, '4 — أكثر من 75%', '4 — > 75%']] },
      { k: 'larynx', t: 'text', ar: 'الحنجرة', en: 'Larynx' },
      { k: 'neck', t: 'text', ar: 'الرقبة والغدد', en: 'Neck and nodes' },
      { k: 'notes', t: 'area', ar: 'ملاحظات', en: 'Notes', wide: true },
    ] },
  ],
  compute(d) {
    const t = num(d.tonsils);
    return [t !== null && t >= 3 ? result('tonsils', 'اللوزتان', 'Tonsils', `${t}/4`, { level: 'warn', text: { ar: 'تضخم واضح', en: 'Marked enlargement' } }) : null];
  },
};

module.exports = [eyeExam, glassesRx, audiogram, entExam];

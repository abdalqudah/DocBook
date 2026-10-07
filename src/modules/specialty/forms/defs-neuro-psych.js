// Nervous system and mental health: neurological examination (GCS, MRC power, reflexes), NIHSS, PHQ-9, GAD-7,
// mental state examination.
const { result, sum, num, points } = require('./engine');

const LIMBS = [['shoulder_abd', 'إبعاد الكتف', 'Shoulder abduction'], ['elbow_flex', 'ثني المرفق', 'Elbow flexion'], ['elbow_ext', 'بسط المرفق', 'Elbow extension'],
  ['wrist_ext', 'بسط الرسغ', 'Wrist extension'], ['grip', 'قبضة اليد', 'Grip'], ['hip_flex', 'ثني الورك', 'Hip flexion'], ['knee_ext', 'بسط الركبة', 'Knee extension'],
  ['ankle_df', 'رفع القدم', 'Ankle dorsiflexion'], ['ankle_pf', 'ثني القدم للأسفل', 'Ankle plantarflexion']];
const LR = [['r', 'يمين', 'Right'], ['l', 'يسار', 'Left']];

const neuro = {
  key: 'neuro_exam', v: 1, icon: 'brain', ar: 'الفحص العصبي', en: 'Neurological examination',
  specialties: ['neurology', 'neurosurgery'],
  cite: 'Glasgow Coma Scale (Teasdale & Jennett 1974); muscle power by the MRC scale (0–5).',
  sections: [
    { ar: 'مقياس غلاسكو للغيبوبة', en: 'Glasgow Coma Scale', fields: [
      { k: 'gcs_e', t: 'sel', ar: 'فتح العينين (E)', en: 'Eye opening (E)', opts: [[4, '4 — تلقائي', '4 — spontaneous'], [3, '3 — للصوت', '3 — to sound'], [2, '2 — للألم', '2 — to pressure'], [1, '1 — لا يفتح', '1 — none']] },
      { k: 'gcs_v', t: 'sel', ar: 'الاستجابة الكلامية (V)', en: 'Verbal (V)', opts: [[5, '5 — واعٍ ومدرك', '5 — oriented'], [4, '4 — مشوّش', '4 — confused'], [3, '3 — كلمات', '3 — words'], [2, '2 — أصوات', '2 — sounds'], [1, '1 — لا يستجيب', '1 — none']] },
      { k: 'gcs_m', t: 'sel', ar: 'الاستجابة الحركية (M)', en: 'Motor (M)', opts: [[6, '6 — ينفذ الأوامر', '6 — obeys commands'], [5, '5 — يحدد مكان الألم', '5 — localising'], [4, '4 — ينسحب طبيعيًا', '4 — normal flexion'], [3, '3 — ثني غير طبيعي', '3 — abnormal flexion'], [2, '2 — بسط', '2 — extension'], [1, '1 — لا يتحرك', '1 — none']] },
    ] },
    { ar: 'قوة العضلات (MRC 0–5)', en: 'Muscle power (MRC 0–5)', fields: [
      { k: 'power', t: 'grid', ar: 'القوة', en: 'Power', rows: LIMBS, cols: LR, cell: { t: 'int', min: 0, max: 5 } },
    ] },
    { ar: 'المنعكسات والإحساس', en: 'Reflexes and sensation', fields: [
      { k: 'pupils', t: 'sel', side: 'eye', ar: 'الحدقة', en: 'Pupil', opts: [['reactive', 'تتفاعل', 'Reactive'], ['sluggish', 'بطيئة', 'Sluggish'], ['fixed', 'ثابتة', 'Fixed']] },
      { k: 'biceps', t: 'sel', side: 'lr', ar: 'منعكس ذات الرأسين', en: 'Biceps reflex', opts: [['0', '0 — غائب', '0 — absent'], ['1', '+1 — ضعيف', '1+ — reduced'], ['2', '+2 — طبيعي', '2+ — normal'], ['3', '+3 — زائد', '3+ — brisk'], ['4', '+4 — رمع', '4+ — clonus']] },
      { k: 'knee', t: 'sel', side: 'lr', ar: 'منعكس الركبة', en: 'Knee reflex', opts: [['0', '0 — غائب', '0 — absent'], ['1', '+1 — ضعيف', '1+ — reduced'], ['2', '+2 — طبيعي', '2+ — normal'], ['3', '+3 — زائد', '3+ — brisk'], ['4', '+4 — رمع', '4+ — clonus']] },
      { k: 'plantar', t: 'sel', side: 'lr', ar: 'منعكس أخمص القدم', en: 'Plantar response', opts: [['flexor', 'انثناء (طبيعي)', 'Flexor'], ['extensor', 'انبساط (بابنسكي)', 'Extensor (Babinski)'], ['equivocal', 'غير واضح', 'Equivocal']] },
      { k: 'sensation', t: 'text', ar: 'الإحساس', en: 'Sensation' },
      { k: 'coordination', t: 'text', ar: 'التوازن والتناسق', en: 'Coordination' },
      { k: 'gait', t: 'sel', ar: 'المشية', en: 'Gait', opts: [['normal', 'طبيعية', 'Normal'], ['antalgic', 'مشية ألم', 'Antalgic'], ['ataxic', 'ترنّح', 'Ataxic'], ['hemiplegic', 'شلل نصفي', 'Hemiplegic'], ['parkinsonian', 'باركنسونية', 'Parkinsonian'], ['unable', 'لا يمشي', 'Unable to walk']] },
      { k: 'cranial', t: 'area', ar: 'الأعصاب القحفية وملاحظات', en: 'Cranial nerves and notes', wide: true },
    ] },
  ],
  compute(d) {
    const out = [];
    const g = sum(d, ['gcs_e', 'gcs_v', 'gcs_m']);
    out.push(result('gcs', 'GCS', 'GCS', g, { unit: '/15', d: 0, bands: [[9, 'bad', 'شديد (≤ 8)', 'Severe (≤ 8)'], [13, 'warn', 'متوسط (9–12)', 'Moderate (9–12)'], [15, 'mild', 'خفيف (13–14)', 'Mild (13–14)'], [null, 'ok', 'طبيعي', 'Normal']] }));
    const weak = LIMBS.filter(([r]) => LR.some(([c]) => num(d[`power__${r}__${c}`]) !== null && d[`power__${r}__${c}`] < 4)).length;
    if (weak) out.push(result('power', 'ضعف عضلي', 'Weakness', weak, { level: 'warn', text: { ar: 'مجموعات عضلية أقل من 4/5', en: 'muscle groups below 4/5' } }));
    if (d.plantar_r === 'extensor' || d.plantar_l === 'extensor') out.push(result('babinski', 'بابنسكي', 'Babinski', '+', { level: 'warn', text: { ar: 'علامة عصبون حركي علوي', en: 'Upper motor neuron sign' } }));
    if (d.pupils_r === 'fixed' || d.pupils_l === 'fixed') out.push(result('pupil', 'الحدقة', 'Pupil', 'fixed', { level: 'bad', text: { ar: 'حدقة ثابتة', en: 'Fixed pupil' } }));
    return out;
  },
};

const NIH = [
  ['1a', 'مستوى الوعي', 'Level of consciousness', [['متيقظ', 'Alert'], ['يستيقظ بتنبيه بسيط', 'Arousable by minor stimulation'], ['يحتاج تنبيهًا متكررًا', 'Requires repeated stimulation'], ['لا يستجيب', 'Unresponsive']]],
  ['1b', 'أسئلة الوعي (الشهر والعمر)', 'LOC questions (month, age)', [['يجيب على الاثنين', 'Answers both'], ['يجيب على واحد', 'Answers one'], ['لا يجيب', 'Answers neither']]],
  ['1c', 'أوامر الوعي (العينين واليد)', 'LOC commands (eyes, grip)', [['ينفذ الاثنين', 'Performs both'], ['ينفذ واحدًا', 'Performs one'], ['لا ينفذ', 'Performs neither']]],
  ['2', 'حركة العين الأفقية', 'Best gaze', [['طبيعية', 'Normal'], ['شلل جزئي', 'Partial gaze palsy'], ['انحراف قسري', 'Forced deviation']]],
  ['3', 'الساحة البصرية', 'Visual fields', [['لا فقدان', 'No loss'], ['عمى شقي جزئي', 'Partial hemianopia'], ['عمى شقي كامل', 'Complete hemianopia'], ['عمى شقي ثنائي', 'Bilateral hemianopia']]],
  ['4', 'شلل الوجه', 'Facial palsy', [['طبيعي', 'Normal'], ['بسيط', 'Minor'], ['جزئي', 'Partial'], ['كامل', 'Complete']]],
  ['5a', 'حركة الذراع اليسرى', 'Motor arm — left', [['لا انحراف', 'No drift'], ['انحراف', 'Drift'], ['جهد ضد الجاذبية', 'Some effort against gravity'], ['لا جهد ضد الجاذبية', 'No effort against gravity'], ['لا حركة', 'No movement']]],
  ['5b', 'حركة الذراع اليمنى', 'Motor arm — right', [['لا انحراف', 'No drift'], ['انحراف', 'Drift'], ['جهد ضد الجاذبية', 'Some effort against gravity'], ['لا جهد ضد الجاذبية', 'No effort against gravity'], ['لا حركة', 'No movement']]],
  ['6a', 'حركة الساق اليسرى', 'Motor leg — left', [['لا انحراف', 'No drift'], ['انحراف', 'Drift'], ['جهد ضد الجاذبية', 'Some effort against gravity'], ['لا جهد ضد الجاذبية', 'No effort against gravity'], ['لا حركة', 'No movement']]],
  ['6b', 'حركة الساق اليمنى', 'Motor leg — right', [['لا انحراف', 'No drift'], ['انحراف', 'Drift'], ['جهد ضد الجاذبية', 'Some effort against gravity'], ['لا جهد ضد الجاذبية', 'No effort against gravity'], ['لا حركة', 'No movement']]],
  ['7', 'ترنّح الأطراف', 'Limb ataxia', [['غائب', 'Absent'], ['في طرف واحد', 'Present in one limb'], ['في طرفين', 'Present in two limbs']]],
  ['8', 'الإحساس', 'Sensory', [['طبيعي', 'Normal'], ['فقدان خفيف إلى متوسط', 'Mild to moderate loss'], ['فقدان شديد أو كامل', 'Severe or total loss']]],
  ['9', 'اللغة', 'Best language', [['لا حبسة', 'No aphasia'], ['حبسة خفيفة إلى متوسطة', 'Mild to moderate aphasia'], ['حبسة شديدة', 'Severe aphasia'], ['أبكم / حبسة شاملة', 'Mute / global aphasia']]],
  ['10', 'عسر النطق', 'Dysarthria', [['طبيعي', 'Normal'], ['خفيف إلى متوسط', 'Mild to moderate'], ['شديد', 'Severe']]],
  ['11', 'الإهمال والانطفاء', 'Extinction and inattention', [['لا يوجد', 'None'], ['في حاسة واحدة', 'In one modality'], ['شديد', 'Profound']]],
];
const nihss = {
  key: 'nihss', v: 1, icon: 'brain', ar: 'مقياس الجلطة الدماغية (NIHSS)', en: 'Stroke scale (NIHSS)',
  specialties: ['neurology'],
  cite: 'NIH Stroke Scale (National Institute of Neurological Disorders and Stroke; public domain).',
  sections: [{ ar: 'البنود', en: 'Items', fields: NIH.map(([k, ar, en, o]) => ({ k: `i${k}`, t: 'sel', ar: `${k}. ${ar}`, en: `${k}. ${en}`, opts: points(o) })) }],
  compute(d) {
    const s = sum(d, NIH.map(([k]) => `i${k}`));
    return [result('score', 'المجموع', 'Total', s, { unit: '/42', d: 0, bands: [[1, 'ok', 'لا أعراض جلطة', 'No stroke symptoms'], [5, 'mild', 'جلطة بسيطة', 'Minor stroke'], [16, 'warn', 'جلطة متوسطة', 'Moderate stroke'], [21, 'bad', 'متوسطة إلى شديدة', 'Moderate to severe'], [null, 'bad', 'جلطة شديدة', 'Severe stroke']] })];
  },
};

const FREQ4 = [['أبدًا', 'Not at all'], ['عدة أيام', 'Several days'], ['أكثر من نصف الأيام', 'More than half the days'], ['تقريبًا كل يوم', 'Nearly every day']];
const PHQ = [
  ['قلة الاهتمام أو المتعة في فعل الأشياء', 'Little interest or pleasure in doing things'],
  ['الشعور بالحزن أو الاكتئاب أو اليأس', 'Feeling down, depressed, or hopeless'],
  ['صعوبة في النوم أو البقاء نائمًا، أو النوم أكثر من اللازم', 'Trouble falling or staying asleep, or sleeping too much'],
  ['الشعور بالتعب أو قلة الطاقة', 'Feeling tired or having little energy'],
  ['ضعف الشهية أو الإفراط في الأكل', 'Poor appetite or overeating'],
  ['الشعور بالسوء تجاه نفسك، أو أنك فاشل أو خذلت نفسك أو عائلتك', 'Feeling bad about yourself — or that you are a failure or have let yourself or your family down'],
  ['صعوبة في التركيز، مثل القراءة أو مشاهدة التلفاز', 'Trouble concentrating on things, such as reading the newspaper or watching television'],
  ['البطء في الحركة أو الكلام لدرجة يلاحظها الآخرون، أو العكس: التململ والحركة أكثر من المعتاد', 'Moving or speaking so slowly that other people could have noticed, or the opposite — being so fidgety or restless that you have been moving around a lot more than usual'],
  ['أفكار بأنك ستكون أفضل حالًا لو متّ، أو بإيذاء نفسك بطريقة ما', 'Thoughts that you would be better off dead, or of hurting yourself in some way'],
];
const phq9 = {
  key: 'phq9', v: 1, icon: 'smile', ar: 'مقياس الاكتئاب (PHQ-9)', en: 'Depression (PHQ-9)',
  specialties: ['psychiatry', 'psychology', 'family', 'general', 'internal', 'neurology', 'geriatrics', 'obgyn'],
  cite: 'Kroenke K, Spitzer RL, Williams JB. J Gen Intern Med 2001;16:606–13 (free to use). Over the last 2 weeks. The Arabic wording here is a working translation; use a validated version for research.',
  sections: [{ ar: 'خلال الأسبوعين الماضيين، كم مرة انزعجت من:', en: 'Over the last 2 weeks, how often have you been bothered by:', fields: PHQ.map(([ar, en], i) => ({ k: `q${i + 1}`, t: 'sel', ar: `${i + 1}. ${ar}`, en: `${i + 1}. ${en}`, opts: points(FREQ4) })) }],
  compute(d) {
    const s = sum(d, PHQ.map((_, i) => `q${i + 1}`));
    const out = [result('score', 'المجموع', 'Total', s, { unit: '/27', d: 0, bands: [[5, 'ok', 'لا اكتئاب أو أدنى حد', 'Minimal'], [10, 'mild', 'اكتئاب خفيف', 'Mild'], [15, 'warn', 'اكتئاب متوسط', 'Moderate'], [20, 'bad', 'متوسط إلى شديد', 'Moderately severe'], [null, 'bad', 'اكتئاب شديد', 'Severe']] })];
    if (typeof d.q9 === 'number' && d.q9 > 0) out.push(result('q9', 'البند 9', 'Item 9', d.q9, { level: 'bad', text: { ar: 'أفكار إيذاء النفس — قيّم خطر الانتحار الآن', en: 'Self-harm thoughts — assess suicide risk now' } }));
    return out;
  },
};

const GAD = [
  ['الشعور بالتوتر أو القلق أو العصبية', 'Feeling nervous, anxious, or on edge'],
  ['عدم القدرة على إيقاف القلق أو التحكم فيه', 'Not being able to stop or control worrying'],
  ['القلق الزائد بشأن أمور مختلفة', 'Worrying too much about different things'],
  ['صعوبة في الاسترخاء', 'Trouble relaxing'],
  ['التململ لدرجة صعوبة الجلوس بهدوء', 'Being so restless that it is hard to sit still'],
  ['الانزعاج أو الغضب بسهولة', 'Becoming easily annoyed or irritable'],
  ['الشعور بالخوف كأن شيئًا فظيعًا قد يحدث', 'Feeling afraid, as if something awful might happen'],
];
const gad7 = {
  key: 'gad7', v: 1, icon: 'smile', ar: 'مقياس القلق (GAD-7)', en: 'Anxiety (GAD-7)',
  specialties: ['psychiatry', 'psychology', 'family', 'general'],
  cite: 'Spitzer RL et al. Arch Intern Med 2006;166:1092–7 (free to use). Over the last 2 weeks. The Arabic wording here is a working translation; use a validated version for research.',
  sections: [{ ar: 'خلال الأسبوعين الماضيين، كم مرة انزعجت من:', en: 'Over the last 2 weeks, how often have you been bothered by:', fields: GAD.map(([ar, en], i) => ({ k: `q${i + 1}`, t: 'sel', ar: `${i + 1}. ${ar}`, en: `${i + 1}. ${en}`, opts: points(FREQ4) })) }],
  compute(d) {
    const s = sum(d, GAD.map((_, i) => `q${i + 1}`));
    return [result('score', 'المجموع', 'Total', s, { unit: '/21', d: 0, bands: [[5, 'ok', 'قلق أدنى', 'Minimal'], [10, 'mild', 'قلق خفيف', 'Mild'], [15, 'warn', 'قلق متوسط', 'Moderate'], [null, 'bad', 'قلق شديد', 'Severe']] })];
  },
};

const mse = {
  key: 'mental_state', v: 1, icon: 'brain', ar: 'فحص الحالة العقلية', en: 'Mental state examination',
  specialties: ['psychiatry', 'psychology'],
  sections: [
    { ar: 'المظهر والسلوك', en: 'Appearance and behaviour', fields: [
      { k: 'appearance', t: 'sel', ar: 'المظهر', en: 'Appearance', opts: [['appropriate', 'مناسب ومرتب', 'Appropriate, well kept'], ['unkempt', 'مهمل', 'Unkempt'], ['bizarre', 'غريب', 'Bizarre']] },
      { k: 'behaviour', t: 'sel', ar: 'السلوك', en: 'Behaviour', opts: [['cooperative', 'متعاون', 'Cooperative'], ['guarded', 'متحفظ', 'Guarded'], ['agitated', 'مهتاج', 'Agitated'], ['withdrawn', 'منسحب', 'Withdrawn'], ['hostile', 'عدائي', 'Hostile']] },
      { k: 'speech', t: 'sel', ar: 'الكلام', en: 'Speech', opts: [['normal', 'طبيعي', 'Normal'], ['pressured', 'متسارع', 'Pressured'], ['slow', 'بطيء', 'Slow'], ['poverty', 'قليل', 'Poverty of speech'], ['incoherent', 'غير مترابط', 'Incoherent']] },
    ] },
    { ar: 'المزاج والتفكير', en: 'Mood and thought', fields: [
      { k: 'mood', t: 'text', ar: 'المزاج (بكلمات المريض)', en: 'Mood (patient’s words)' },
      { k: 'affect', t: 'sel', ar: 'الوجدان', en: 'Affect', opts: [['euthymic', 'معتدل', 'Euthymic'], ['depressed', 'مكتئب', 'Depressed'], ['anxious', 'قلق', 'Anxious'], ['elevated', 'مرتفع', 'Elevated'], ['irritable', 'متهيج', 'Irritable'], ['flat', 'متبلّد', 'Flat'], ['labile', 'متقلب', 'Labile'], ['incongruent', 'غير متطابق', 'Incongruent']] },
      { k: 'form', t: 'sel', ar: 'شكل التفكير', en: 'Thought form', opts: [['logical', 'منطقي ومترابط', 'Logical, goal-directed'], ['circumstantial', 'إسهابي', 'Circumstantial'], ['tangential', 'مماسّي', 'Tangential'], ['flight', 'تطاير الأفكار', 'Flight of ideas'], ['loosening', 'تفكك الترابط', 'Loosening of associations']] },
      { k: 'content', t: 'multi', ar: 'محتوى التفكير', en: 'Thought content', opts: [['none', 'لا شيء غير طبيعي', 'Nothing abnormal'], ['preoccupation', 'انشغال', 'Preoccupations'], ['obsessions', 'وساوس', 'Obsessions'], ['delusions', 'ضلالات', 'Delusions'], ['si', 'أفكار انتحارية', 'Suicidal ideation'], ['hi', 'أفكار بإيذاء الآخرين', 'Homicidal ideation']] },
      { k: 'perception', t: 'multi', ar: 'الإدراك', en: 'Perception', opts: [['none', 'طبيعي', 'Normal'], ['auditory', 'هلاوس سمعية', 'Auditory hallucinations'], ['visual', 'هلاوس بصرية', 'Visual hallucinations'], ['other', 'هلاوس أخرى', 'Other hallucinations'], ['illusions', 'خداع حسي', 'Illusions']] },
    ] },
    { ar: 'الإدراك والبصيرة والخطر', en: 'Cognition, insight and risk', fields: [
      { k: 'cognition', t: 'sel', ar: 'التوجه والذاكرة', en: 'Orientation and memory', opts: [['intact', 'سليم', 'Intact'], ['impaired', 'ضعيف', 'Impaired']] },
      { k: 'insight', t: 'sel', ar: 'البصيرة', en: 'Insight', opts: [['good', 'جيدة', 'Good'], ['partial', 'جزئية', 'Partial'], ['poor', 'ضعيفة', 'Poor']] },
      { k: 'judgement', t: 'sel', ar: 'الحكم', en: 'Judgement', opts: [['good', 'جيد', 'Good'], ['fair', 'مقبول', 'Fair'], ['poor', 'ضعيف', 'Poor']] },
      { k: 'risk', t: 'sel', ar: 'تقدير الخطر', en: 'Risk', opts: [['low', 'منخفض', 'Low'], ['moderate', 'متوسط', 'Moderate'], ['high', 'مرتفع', 'High']] },
      { k: 'plan', t: 'area', ar: 'الخطة وملاحظات', en: 'Plan and notes', wide: true },
    ] },
  ],
  compute(d) {
    const out = [];
    if (d.risk) out.push(result('risk', 'الخطر', 'Risk', d.risk === 'high' ? 'High' : d.risk === 'moderate' ? 'Moderate' : 'Low', { level: { low: 'ok', moderate: 'warn', high: 'bad' }[d.risk], text: { low: { ar: 'منخفض', en: 'Low' }, moderate: { ar: 'متوسط', en: 'Moderate' }, high: { ar: 'مرتفع', en: 'High' } }[d.risk] }));
    const c = [].concat(d.content || []);
    if (c.includes('si') || c.includes('hi')) out.push(result('ideation', 'أفكار الإيذاء', 'Harm ideation', c.filter((x) => x === 'si' || x === 'hi').map((x) => x.toUpperCase()).join(' + '), { level: 'bad', text: { ar: 'تحتاج خطة سلامة', en: 'Needs a safety plan' } }));
    return out;
  },
};

module.exports = [neuro, nihss, phq9, gad7, mse];

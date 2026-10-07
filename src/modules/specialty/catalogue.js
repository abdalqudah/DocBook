// The specialties a clinic (or a doctor in a centre) can have: one list for sign-up, settings, the doctor's profile,
// the specialty records, the diagnosis table, the website template and the marketplace.
//   key     stored in businesses.specialty / doctors.specialty_key
//   parent  a broader specialty whose website template, suggested services, icons and marketplace catalog it shares
//   ld      schema.org medicalSpecialty for the clinic's site (when one fits)
// Names live in locales (auth.json → specialties.<key>); `ar`/`en` here are the fallback used by scripts and tests.
const S = (key, ar, en, extra = {}) => ({ key, ar, en, parent: null, ld: null, ...extra });

const LIST = [
  S('general', 'طب عام', 'General practice', { ld: 'PrimaryCare' }),
  S('family', 'طب الأسرة', 'Family medicine', { parent: 'general', ld: 'PrimaryCare' }),
  S('internal', 'الأمراض الباطنية', 'Internal medicine', { parent: 'general' }),
  S('geriatrics', 'طب المسنين', 'Geriatrics', { parent: 'internal', ld: 'Geriatric' }),
  S('paediatrics', 'طب الأطفال', 'Paediatrics', { ld: 'Pediatric' }),
  S('obgyn', 'النسائية والتوليد', 'Obstetrics & gynaecology', { ld: 'Obstetric' }),
  S('fertility', 'الإخصاب وأطفال الأنابيب', 'Fertility & IVF', { parent: 'obgyn', ld: 'Gynecologic' }),
  S('dentistry', 'طب الأسنان', 'Dentistry', { ld: 'Dentistry' }),
  S('orthodontics', 'تقويم الأسنان', 'Orthodontics', { parent: 'dentistry', ld: 'Dentistry' }),
  S('oral_surgery', 'جراحة الفم والفكين', 'Oral & maxillofacial surgery', { parent: 'dentistry', ld: 'Dentistry' }),
  S('dermatology', 'الأمراض الجلدية', 'Dermatology', { ld: 'Dermatology' }),
  S('cosmetic', 'التجميل والليزر', 'Aesthetics & laser'),
  S('plastic', 'الجراحة التجميلية والترميمية', 'Plastic & reconstructive surgery', { parent: 'cosmetic', ld: 'PlasticSurgery' }),
  S('ophthalmology', 'طب العيون', 'Ophthalmology', { ld: 'Optometric' }),
  S('optometry', 'فحص النظر والبصريات', 'Optometry', { parent: 'ophthalmology', ld: 'Optometric' }),
  S('ent', 'الأنف والأذن والحنجرة', 'ENT', { ld: 'Otolaryngologic' }),
  S('audiology', 'السمعيات', 'Audiology', { parent: 'ent', ld: 'Otolaryngologic' }),
  S('speech', 'علاج النطق واللغة', 'Speech & language therapy', { parent: 'ent', ld: 'SpeechPathology' }),
  S('cardiology', 'أمراض القلب', 'Cardiology', { ld: 'Cardiovascular' }),
  S('pulmonology', 'الأمراض الصدرية والتنفسية', 'Pulmonology', { parent: 'internal', ld: 'Pulmonary' }),
  S('gastroenterology', 'الجهاز الهضمي والكبد', 'Gastroenterology & hepatology', { parent: 'internal', ld: 'Gastroenterologic' }),
  S('endocrinology', 'الغدد الصماء والسكري', 'Endocrinology & diabetes', { parent: 'internal', ld: 'Endocrine' }),
  S('nephrology', 'أمراض الكلى', 'Nephrology', { parent: 'internal', ld: 'Renal' }),
  S('urology', 'المسالك البولية', 'Urology', { ld: 'Urologic' }),
  S('neurology', 'الأعصاب', 'Neurology', { ld: 'Neurologic' }),
  S('neurosurgery', 'جراحة الدماغ والأعصاب', 'Neurosurgery', { parent: 'neurology', ld: 'Neurologic' }),
  S('psychiatry', 'الطب النفسي', 'Psychiatry', { ld: 'Psychiatric' }),
  S('psychology', 'العلاج والإرشاد النفسي', 'Psychology & counselling', { parent: 'psychiatry', ld: 'Psychiatric' }),
  S('orthopaedics', 'جراحة العظام والمفاصل', 'Orthopaedics', { ld: 'Musculoskeletal' }),
  S('sports', 'الطب الرياضي', 'Sports medicine', { parent: 'orthopaedics', ld: 'Musculoskeletal' }),
  S('rheumatology', 'الروماتيزم', 'Rheumatology', { parent: 'internal', ld: 'Rheumatologic' }),
  S('physiotherapy', 'العلاج الطبيعي', 'Physiotherapy', { ld: 'PhysicalTherapy' }),
  S('pain', 'علاج الألم', 'Pain management', { parent: 'physiotherapy', ld: 'Anesthesia' }),
  S('oncology', 'الأورام', 'Oncology', { parent: 'internal', ld: 'Oncologic' }),
  S('haematology', 'أمراض الدم', 'Haematology', { parent: 'internal', ld: 'Hematologic' }),
  S('infectious', 'الأمراض المعدية', 'Infectious diseases', { parent: 'internal', ld: 'Infectious' }),
  S('allergy', 'الحساسية والمناعة', 'Allergy & immunology', { parent: 'internal' }),
  S('general_surgery', 'الجراحة العامة', 'General surgery', { ld: 'Surgical' }),
  S('vascular', 'جراحة الأوعية الدموية', 'Vascular surgery', { parent: 'general_surgery', ld: 'Surgical' }),
  S('nutrition', 'التغذية العلاجية', 'Clinical nutrition', { ld: 'DietNutrition' }),
  S('multi', 'متعددة التخصصات', 'Multi-specialty'),
  S('other', 'أخرى', 'Other'),
];

const BY_KEY = new Map(LIST.map((s) => [s.key, s]));
const KEYS = LIST.map((s) => s.key);
// Clinics that see every specialty's records, diagnoses and catalog (they choose per doctor).
const BROAD = new Set(['general', 'multi', 'other']);

const get = (key) => BY_KEY.get(key) || null;
const has = (key) => BY_KEY.has(key);

/** The key itself and its broader specialties: ['orthodontics', 'dentistry']. */
function lineage(key) {
  const out = [];
  let s = get(key);
  while (s && !out.includes(s.key)) { out.push(s.key); s = s.parent ? get(s.parent) : null; }
  return out;
}

/** The first of the key's lineage found in `map` (an object or Set), else `fallback`. */
function pick(key, map, fallback = null) {
  for (const k of lineage(key)) if (map instanceof Set ? map.has(k) : Object.prototype.hasOwnProperty.call(map, k)) return map instanceof Set ? k : map[k];
  return fallback;
}

/** The top-level specialty a key belongs to ('orthodontics' → 'dentistry'). */
const root = (key) => { const l = lineage(key); return l.length ? l[l.length - 1] : key; };

/** A doctor's specialty choices (a doctor has one field; "multi-specialty" and "other" describe clinics). */
const doctorOptions = (t) => LIST.filter((s) => s.key !== 'multi' && s.key !== 'other').map((s) => ({ value: s.key, label: t(`specialties.${s.key}`) }));

module.exports = { LIST, KEYS, BROAD, get, has, lineage, pick, root, doctorOptions };

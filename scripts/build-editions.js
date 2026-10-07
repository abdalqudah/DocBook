// Two ready-to-upload packages from the release build (run `npm run build` first):
//   dist/single-clinic-<version>.zip    one clinic: its website at the domain, its management at /admin
//   dist/medical-center-<version>.zip   one medical centre: the centre's website at the domain, each doctor's clinic
//                                       with its own site, the management at /admin
// Each carries a ready .env (fresh secrets; the database and domain left to fill) and a short install guide, and no
// trace of the platform's own name (texts, file names, package name).
//   npm run build:editions
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'dist', 'docbook');
const { version } = require('../package.json');

const NAME = Buffer.from('ZG9jYm9vaw==', 'base64').toString(); // the platform's name, written so this file never carries it
const TEXT = /\.(js|cjs|mjs|ejs|json|css|md|txt|svg|html|xml|example|env)$/i;
const swap = (s) => s.replace(new RegExp(NAME, 'gi'), (m) => (m === m.toUpperCase() ? 'CLINIC' : m[0] === m[0].toUpperCase() ? 'Clinic' : 'clinic'));

function scrub(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    let p = path.join(dir, e.name);
    if (new RegExp(NAME, 'i').test(e.name)) { const to = path.join(dir, swap(e.name)); fs.renameSync(p, to); p = to; }
    if (e.isDirectory()) scrub(p);
    else if (TEXT.test(p) || path.basename(p).startsWith('.env')) {
      const s = fs.readFileSync(p, 'utf8');
      const t = swap(s);
      if (t !== s) fs.writeFileSync(p, t);
    }
  }
}

const secret = () => crypto.randomBytes(48).toString('hex');
const catalogue = require('../src/modules/specialty/catalogue');
/** .env of an edition; `spec` = a specialty of the catalogue for a clinic made for one specialty. */
function envFor(edition, spec = null) {
  const center = edition === 'center';
  const sp = spec ? catalogue.get(spec) : null;
  return `# ============================================================================
# ${center ? 'المركز الطبي' : 'العيادة'} — إعدادات السيرفر. عبّئ الأسطر المعلَّمة بـ «←» ثم شغّل التطبيق.
# ============================================================================
NODE_ENV=production
PORT=3000
# ← رابط الموقع كما يكتبه الزوار (https)
APP_URL=https://your-domain.com
# نوع التثبيت: ${center ? 'center = مركز طبي واحد بعدة أطباء' : 'clinic = عيادة واحدة'} (لا تغيّره)
APP_EDITION=${edition}

# ---- ${center ? 'المركز' : 'العيادة'} (تُنشأ تلقائيًا عند أول تشغيل) ----
# ← الاسم كما يظهر في الموقع والنظام
CLINIC_NAME=${center ? 'المركز الطبي' : sp ? `عيادة ${sp.ar}` : 'العيادة'}
CLINIC_NAME_EN=${center ? 'Medical Center' : sp ? `${sp.en} Clinic` : 'Clinic'}
# ← رابط مختصر بالإنجليزية (حروف وأرقام وشرطة فقط)، مثل alnoor
CLINIC_SLUG=${center ? 'center' : sp ? sp.key.replace(/_/g, '-') : 'clinic'}
# التخصص: يحدد السجلات التخصصية، وجدول التشخيصات (ICD-10)، وقالب الموقع والخدمات المقترحة.
# ${center ? 'المركز متعدد التخصصات: كل طبيب يختار تخصصه عند إضافته، وتظهر له سجلات تخصصه.' : `القيم: ${catalogue.KEYS.join(' ')}`}
CLINIC_SPECIALTY=${center ? 'multi' : sp ? sp.key : 'general'}
CLINIC_CURRENCY=JOD
CLINIC_TIMEZONE=Asia/Amman
CLINIC_CITY=
# اسم النظام في كل الصفحات (فارغ = اسم ${center ? 'المركز' : 'العيادة'})
BRAND_NAME=

# ---- حساب الإدارة (يدخل من /admin) ----
# ← بريدك وكلمة مرور قوية (8 أحرف على الأقل)
SUPER_ADMIN_EMAIL=admin@your-domain.com
SUPER_ADMIN_PASSWORD=
SUPER_ADMIN_NAME=${center ? 'إدارة المركز' : 'مدير العيادة'}

# ---- قاعدة البيانات (MySQL / MariaDB) ----
DB_HOST=localhost
DB_PORT=3306
# ← من cPanel → MySQL Databases
DB_NAME=
DB_USER=
DB_PASSWORD=

# ---- أمان (أُنشئت عشوائيًا لهذه النسخة — لا تغيّر APP_KEY بعد التشغيل) ----
SESSION_SECRET=${secret()}
APP_KEY=${secret()}

AUTO_MIGRATE=true
TRUST_PROXY=true
DEFAULT_LOCALE=ar
ALLOW_SIGNUP=false

# ---- البريد الإلكتروني (اختياري: استرجاع كلمة المرور، التذكيرات) ----
# SMTP_HOST=
# SMTP_PORT=465
# SMTP_USER=
# SMTP_PASSWORD=
# MAIL_FROM=${center ? 'المركز' : 'العيادة'} <no-reply@your-domain.com>
`;
}

function guideFor(edition) {
  const center = edition === 'center';
  return `# تثبيت ${center ? 'المركز الطبي' : 'العيادة'}

## ما الذي ستحصل عليه
- **الدومين الرئيسي** (https://your-domain.com) يفتح موقع ${center ? 'المركز، وفيه أطباء كل العيادات والحجز مع كل طبيب' : 'العيادة مع الحجز الإلكتروني'}.
- **/admin** يفتح لوحة الإدارة (تسجيل الدخول ثم ${center ? 'إدارة المركز: الأطباء، الاستقبال والمحاسبة المشتركة، المصاريف، الموقع' : 'إدارة العيادة: المواعيد، المرضى، المحاسبة، الموقع'}).
${center ? '- **كل طبيب** له عيادة مستقلة وموقع خاص على /رابط-عيادته (يضيفه المركز من «الأطباء والعيادات»).\n- **كل التخصصات:** عند إضافة الطبيب اختر تخصصه؛ تظهر في عيادته سجلات تخصصه (العيون، السمع، القلب، الأسنان، النسائية…) وجدول تشخيصاته من ICD-10 تلقائيًا.\n' : ''}- **/admin/platform** إعدادات النظام العامة (البريد، الدفع…) لحساب الإدارة.

## الخطوات على cPanel
1. **قاعدة البيانات:** cPanel ← MySQL Databases ← أنشئ قاعدة ومستخدمًا وأعطه **ALL PRIVILEGES** على القاعدة.
2. **الملفات:** File Manager ← افتح مجلد الدومين ← ارفع ملف الـ zip ← Extract (يجب أن يكون \`app.js\` مباشرة داخل المجلد) ← احذف الـ zip.
3. **الإعدادات:** افتح ملف \`.env\` (Settings ← Show Hidden Files) وعبّئ الأسطر المعلَّمة بـ «←»: \`APP_URL\`، \`CLINIC_NAME\`، \`CLINIC_SLUG\`، \`SUPER_ADMIN_EMAIL\`، \`SUPER_ADMIN_PASSWORD\`، \`DB_NAME\`، \`DB_USER\`، \`DB_PASSWORD\`.
4. **التطبيق:** cPanel ← Setup Node.js App ← Create Application: Node.js 20 أو أحدث، Application root = مجلد الدومين، Application URL = الدومين، Startup file = \`app.js\` ← Create ← **Restart**.
5. افتح الدومين: يظهر الموقع. ادخل على **/admin** بالبريد وكلمة المرور من \`.env\`${center ? ' وابدأ بإضافة الأطباء.' : ' وأكمل معالج إعداد العيادة.'}

جداول قاعدة البيانات تُنشأ تلقائيًا عند أول تشغيل، و${center ? 'المركز' : 'العيادة'} يُنشأ تلقائيًا من \`.env\`.

## ملاحظات
- احتفظ بنسخة من ملف \`.env\` في مكان آمن، ولا تغيّر \`APP_KEY\` بعد التشغيل.
- للتحديث لاحقًا: ارفع النسخة الجديدة فوق القديمة **دون** حذف \`.env\`، ثم Restart.
- رسالة خطأ عند التشغيل؟ راجع ملف \`stderr.log\` في مجلد التطبيق.
`;
}

function sourceGuideFor(edition) {
  const center = edition === 'center';
  return `# ${center ? 'المركز الطبي' : 'العيادة'} — الكود المصدري الكامل

هذا الكود الكامل للنظام (للتطوير أو للتشغيل من المصدر). ملف \`.env\` جاهز بنفس إعدادات النسخة الجاهزة.

## التشغيل على cPanel من الكود المصدري
1. أنشئ قاعدة بيانات ومستخدمًا (ALL PRIVILEGES).
2. ارفع الملف وفكّه في مجلد الدومين، وعبّئ \`.env\` (الأسطر المعلَّمة بـ «←»).
3. Setup Node.js App ← Create Application: Node.js 20+، Startup file = \`app.js\` ← Create.
4. اضغط **Run NPM Install** (يثبّت المكتبات)، ثم **Restart**.
5. افتح الدومين للموقع، و **/admin** للإدارة.

## التحديث من لوحة الإدارة
**/admin/platform** ← «تحديث النظام»: ارفع ملف التحديث الجاهز (update-….zip) واكتب كلمة مرورك. تُحفظ نسخة احتياطية من ملفاتك أولًا، ويمكن الرجوع إليها من نفس الصفحة. بعد أول تحديث يعمل الموقع بالنسخة الجاهزة (لا يحتاج npm install).

## وضع الصيانة
**/admin/platform** ← «وضع الصيانة»: إغلاق الموقع العام (أو كل النظام) برسالة للزوار، وفتحه بضغطة. للطوارئ: أضف \`MAINTENANCE=site\` أو \`MAINTENANCE=all\` إلى \`.env\` وأعد التشغيل.

## للمطوّر
- \`npm test\` الاختبارات (تحتاج قاعدة اختبار: DB_NAME_TEST).
- \`npm run build\` يبني النسخة الجاهزة وملف التحديث في \`dist/\`.
`;
}

// The full source (tracked files), scrubbed the same way, with the edition's .env.
function buildSource(edition, file) {
  const out = path.join(ROOT, 'dist', file);
  fs.rmSync(out, { recursive: true, force: true });
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean)
    .filter((f) => f !== 'scripts/build-editions.js' && fs.existsSync(path.join(ROOT, f)));
  for (const f of files) { fs.mkdirSync(path.join(out, path.dirname(f)), { recursive: true }); fs.copyFileSync(path.join(ROOT, f), path.join(out, f)); }
  scrub(out);
  fs.writeFileSync(path.join(out, '.env'), envFor(edition));
  fs.writeFileSync(path.join(out, 'INSTALL.md'), sourceGuideFor(edition));
  const left = spawnSync('grep', ['-ril', NAME, '.'], { cwd: out, encoding: 'utf8' }).stdout.trim();
  if (left) throw new Error(`${file}: still mentions the platform's name:\n${left}`);
  const zip = path.join(ROOT, 'dist', `${file}.zip`);
  fs.rmSync(zip, { force: true });
  execFileSync('zip', ['-qr', zip, '.'], { cwd: out });
  console.log(`Built dist/${file}.zip`);
}

// The update file for the admin page (System update): the ready build without .env — the same for both editions.
{
  const out = path.join(ROOT, 'dist', `update-${version}`);
  fs.rmSync(out, { recursive: true, force: true });
  fs.cpSync(SRC, out, { recursive: true });
  for (const f of ['INSTALL.md', '.env.example']) fs.rmSync(path.join(out, f), { force: true });
  scrub(out);
  const zip = path.join(ROOT, 'dist', `update-${version}.zip`);
  fs.rmSync(zip, { force: true });
  execFileSync('zip', ['-qr', zip, '.'], { cwd: out });
  console.log(`Built dist/update-${version}.zip`);
}

for (const [edition, file] of [['clinic', `single-clinic-source-${version}`], ['center', `medical-center-source-${version}`]]) buildSource(edition, file);

for (const [edition, file] of [['clinic', `single-clinic-${version}`], ['center', `medical-center-${version}`]]) {
  const out = path.join(ROOT, 'dist', file);
  fs.rmSync(out, { recursive: true, force: true });
  fs.cpSync(SRC, out, { recursive: true });
  for (const f of ['INSTALL.md', '.env.example']) fs.rmSync(path.join(out, f), { force: true });
  scrub(out);
  fs.writeFileSync(path.join(out, '.env'), envFor(edition));
  fs.writeFileSync(path.join(out, 'INSTALL.md'), guideFor(edition));
  const left = spawnSync('grep', ['-ril', NAME, '.'], { cwd: out, encoding: 'utf8' }).stdout.trim(); // binary files too
  if (left) throw new Error(`${file}: still mentions the platform's name:\n${left}`);
  const zip = path.join(ROOT, 'dist', `${file}.zip`);
  fs.rmSync(zip, { force: true });
  execFileSync('zip', ['-qr', zip, '.'], { cwd: out });
  console.log(`Built dist/${file}.zip`);
}

// One ready clinic per specialty (npm run build:specialties): the single-clinic build with a .env made for that
// specialty — its name, its specialty records and diagnosis table switch on at first start — and one bundle with
// every specialty's .env (each with its own fresh secrets) for those who already have the build.
//   dist/specialties-<version>/clinic-<specialty>-<version>.zip     dist/clinic-env-files-<version>.zip
if (process.env.SPECIALTIES === '1') {
  const forms = require('../src/modules/specialty/forms');
  const icd = require('../src/modules/clinicalplus/icd.service');
  const base = path.join(ROOT, 'dist', `single-clinic-${version}`);
  const outDir = path.join(ROOT, 'dist', `specialties-${version}`);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  // The common part once (without .env / INSTALL.md), then each specialty adds its own two files.
  const common = path.join(outDir, '.common.zip');
  execFileSync('zip', ['-qr', common, '.', '-x', '.env', 'INSTALL.md'], { cwd: base });
  const envDir = path.join(ROOT, 'dist', `clinic-env-files-${version}`);
  fs.rmSync(envDir, { recursive: true, force: true });
  fs.mkdirSync(envDir, { recursive: true });
  const rows = [];
  const tmp = path.join(outDir, '.tmp');
  for (const sp of catalogue.LIST.filter((x) => !['multi', 'other'].includes(x.key))) {
    const recs = forms.forSpecialty(sp.key).map((k) => forms.get(k));
    const modules = ['dental', 'growth', 'pregnancy'].filter((m) => forms.moduleFor(m, sp.key));
    const moduleNames = { dental: ['مخطط الأسنان', 'Dental chart'], growth: ['منحنيات النمو', 'Growth charts'], pregnancy: ['متابعة الحمل', 'Pregnancy follow-up'] };
    const codes = icd.specialtyTable(sp.key).length;
    const env = envFor('clinic', sp.key);
    const list = [...modules.map((m) => moduleNames[m]), ...recs.map((f) => [f.ar, f.en])];
    const guide = `${guideFor('clinic')}
## تخصص هذه النسخة: ${sp.ar} (${sp.en})
- \`CLINIC_SPECIALTY=${sp.key}\` في ملف \`.env\`: يتفعّل تلقائيًا عند أول تشغيل.
- **السجلات التخصصية:** ${list.map(([ar]) => ar).join('، ') || '—'}.
- **جدول التشخيصات:** ${codes} تشخيصًا من ICD-10 خاصًا بالتخصص، تظهر أولًا عند البحث، مع إمكانية إضافة أكواد خاصة.
- يمكن تشغيل أي سجل من تخصص آخر أو إيقافه من: الإعدادات ← السجلات التخصصية.
`;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp);
    fs.writeFileSync(path.join(tmp, '.env'), env);
    fs.writeFileSync(path.join(tmp, 'INSTALL.md'), guide);
    const name = `clinic-${sp.key.replace(/_/g, '-')}-${version}.zip`;
    const zip = path.join(outDir, name);
    fs.copyFileSync(common, zip);
    execFileSync('zip', ['-q', zip, '.env', 'INSTALL.md'], { cwd: tmp });
    fs.writeFileSync(path.join(envDir, `${sp.key}.env`), envFor('clinic', sp.key));
    rows.push(`| ${sp.ar} | ${sp.en} | \`${sp.key}\` | ${name} | ${list.map(([, en]) => en).join(', ') || '—'} | ${codes} |`);
  }
  fs.writeFileSync(path.join(envDir, 'center.env'), envFor('center'));
  const table = `# ملفات الإعدادات لكل تخصص — Settings files per specialty

كل ملف \`.env\` هنا جاهز لعيادة بتخصص واحد (أسرار جديدة مختلفة لكل ملف). انسخ الملف المناسب إلى مجلد التطبيق باسم \`.env\`
وعبّئ الأسطر المعلَّمة بـ «←». \`center.env\` للمركز الطبي متعدد التخصصات.
Each \`.env\` here is ready for a one-specialty clinic (fresh secrets in each). Copy it next to app.js as \`.env\` and fill the
lines marked «←». \`center.env\` is for the multi-specialty medical centre.

| التخصص | Specialty | CLINIC_SPECIALTY | Ready package | Specialty records | ICD-10 |
|---|---|---|---|---|---|
${rows.join('\n')}
`;
  fs.writeFileSync(path.join(envDir, 'README.md'), table);
  fs.writeFileSync(path.join(outDir, 'README.md'), table);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(common, { force: true });
  const envZip = path.join(ROOT, 'dist', `clinic-env-files-${version}.zip`);
  fs.rmSync(envZip, { force: true });
  execFileSync('zip', ['-qr', envZip, '.'], { cwd: envDir });
  const left = spawnSync('grep', ['-ril', NAME, '.'], { cwd: envDir, encoding: 'utf8' }).stdout.trim();
  if (left) throw new Error(`env files still mention the platform's name:\n${left}`);
  console.log(`Built dist/specialties-${version}/ (${rows.length} clinics) and dist/clinic-env-files-${version}.zip`);
}

#!/usr/bin/env node
// Rebuilds the screenshots of the landing and features pages (public/img/landing/<lang>/*.webp) from the real app:
// a sample clinic is created in the TEST database (never a live one) under the MedWorks name and logo, the pages are
// opened in Chromium in Arabic and English, and the stills and the two animated tours ("a visit", "a surgery") are
// written as WebP.
// Usage: NODE_ENV=test node scripts/landing-shots.js   (needs Playwright + Chromium, Python 3 with Pillow)
process.env.NODE_ENV = 'test';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const rbac = require('../src/modules/rbac/rbac.service');
const doctorsSvc = require('../src/modules/clinic/doctors.service');
const setup = require('../src/modules/onboarding/setup.service');
const appts = require('../src/modules/clinic/appointments.service');
const scheduling = require('../src/modules/clinic/scheduling');

let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require(path.join(execFileSync('npm', ['root', '-g']).toString().trim(), 'playwright'))); } // eslint-disable-line global-require

const T = {
  ar: {
    clinic: 'MedWorks', owner: 'Laila Mansour',
    doctors: [{ name: 'د. سارة الأحمد', spec: 'طب عام', color: '#0A6FD6' }, { name: 'د. خالد المصري', spec: 'طب أسنان', color: '#7C3AED' }],
    services: [['كشفية عامة', 15, 20, 0], ['استشارة متابعة', 10, 15, 0], ['تنظيف أسنان', 25, 30, 1]],
    patients: ['أحمد يوسف', 'ريم الخطيب', 'ليان خالد', 'محمد سالم', 'سلمى العمري', 'عمر الزعبي', 'كريم ناصر', 'دانة البطاينة', 'يوسف حداد', 'زيد المومني'],
    hospitals: ['المستشفى التخصصي', 'مستشفى الأمل'],
    procedures: ['خلع ضرس عقل جراحي', 'زراعة سن', 'قلع التحام'],
    complaint: 'ألم في الأسنان', note: 'ألم منذ يومين عند المضغ',
  },
  en: {
    clinic: 'MedWorks', owner: 'Laila Mansour',
    doctors: [{ name: 'Dr. Sara Ahmad', spec: 'General practice', color: '#0A6FD6' }, { name: 'Dr. Khaled Masri', spec: 'Dentistry', color: '#7C3AED' }],
    services: [['General consultation', 15, 20, 0], ['Follow-up visit', 10, 15, 0], ['Dental cleaning', 25, 30, 1]],
    patients: ['Ahmad Yousef', 'Reem Khatib', 'Layan Khaled', 'Mohammad Salem', 'Salma Omari', 'Omar Zoubi', 'Karim Nasser', 'Dana Bataineh', 'Yousef Haddad', 'Zaid Momani'],
    hospitals: ['Specialty Hospital', 'Al Amal Hospital'],
    procedures: ['Surgical wisdom tooth extraction', 'Dental implant', 'Gum surgery'],
    complaint: 'Toothache', note: 'Pain when chewing for two days',
  },
};
const PASSWORD = 'Passw0rd!x';
const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

async function seed(lang, tag, logos) {
  const L = T[lang];
  const email = `shots-${lang}-${tag}@medworks.test`;
  const userId = await knex.transaction(async (trx) => {
    const id = await auth.createUser(trx, { name: L.owner, email, password: PASSWORD });
    await businesses.create(id, { name: L.clinic, currency: 'JOD', timezone: 'Asia/Amman' }, trx);
    return id;
  });
  await knex('users').where({ id: userId }).update({ email_verified_at: new Date(), locale: lang });
  const b = (await knex('users').where({ id: userId }).first('last_business_id')).last_business_id;
  await knex('businesses').where({ id: b }).update({ onboarding_completed_at: new Date(), setup_dismissed_at: new Date(), slug: `medworks-${lang}-${tag}`.slice(0, 40), name_en: 'MedWorks', logo: logos.wide, logo_mime: 'image/png', logo_version: 2, logo_square: logos.square, logo_square_mime: 'image/png', logo_square_version: 2, booking_enabled: true, phone: '0790000001', city: lang === 'ar' ? 'عمّان' : 'Amman' });
  businesses.forget(b);
  const ctx = { businessId: b, userId, roleKey: 'owner', permissions: await rbac.getUserPermissions(b, userId), locale: lang, timezone: 'Asia/Amman', currency: 'JOD', ip: '127.0.0.1', today: scheduling.clinicNow('Asia/Amman').date, workBranch: '' };
  await setup.saveHours(ctx, { days: ['sat', 'sun', 'mon', 'tue', 'wed', 'thu'], s1: '09:00', e1: '17:00' });
  const docs = [];
  for (const d of L.doctors) docs.push(await doctorsSvc.saveDoctor(ctx, null, { full_name: d.name, specialization: d.spec, slot_duration_minutes: '30', consultation_fee: '15', is_active: '1', color: d.color })); // eslint-disable-line no-await-in-loop
  const services = [];
  for (const [name, price, min, doc] of L.services) { // eslint-disable-line no-restricted-syntax
    const [sid] = await knex('services').insert({ business_id: b, name, price, duration_minutes: min, doctor_id: doc ? docs[1] : null, is_active: true }); // eslint-disable-line no-await-in-loop
    services.push(sid);
  }
  const hospitals = [];
  for (const [i, name] of L.hospitals.entries()) { // eslint-disable-line no-restricted-syntax
    const [hid] = await knex('clinic_partners').insert({ business_id: b, kind: 'hospital', name, email: i ? 'or@alamal-hospital.jo' : 'surgery@specialty-hospital.jo', phone: `079555666${i}` }); // eslint-disable-line no-await-in-loop
    hospitals.push(hid);
  }
  const pats = [];
  for (const [i, name] of L.patients.entries()) { // eslint-disable-line no-restricted-syntax
    const [pid] = await knex('patients').insert({ business_id: b, full_name: name, phone: `07912345${String(60 + i)}`, gender: i % 3 === 1 ? 'female' : 'male', date_of_birth: `${1975 + i * 3}-0${(i % 9) + 1}-12` }); // eslint-disable-line no-await-in-loop
    pats.push({ id: pid, name, phone: `07912345${String(60 + i)}` });
  }
  const today = ctx.today;
  const now = Date.now();
  const mins = (m) => new Date(now - m * 60000);
  const ap = (date, time, doc, p, extra = {}) => ({ business_id: b, appointment_date: date, appointment_time: time, doctor_id: docs[doc], patient_id: p.id, patient_name: p.name, patient_phone: p.phone, status: 'confirmed', appointment_type: 'in_person', source: 'staff', payment_status: 'unpaid', service_id: services[doc ? 2 : 0], ...extra });
  const P = pats;
  const rows = [
    ap(today, '09:00', 0, P[0], { status: 'completed', checked_in: true, arrived_at: mins(240), doctor_finished_at: mins(200), payment_status: 'paid', paid_at: mins(195) }),
    ap(today, '09:30', 1, P[1], { checked_in: true, arrived_at: mins(40), with_doctor: true, called_at: mins(18) }),
    ap(today, '10:00', 0, P[2], { status: 'completed', checked_in: true, arrived_at: mins(150), doctor_finished_at: mins(120), payment_status: 'paid', paid_at: mins(118) }),
    ap(today, '10:30', 1, P[3], { status: 'completed', checked_in: true, arrived_at: mins(90), doctor_finished_at: mins(6), amount_due: 25 }),
    ap(today, '11:00', 0, P[4], { checked_in: true, arrived_at: mins(14) }),
    ap(today, '11:30', 0, P[5], { checked_in: true, arrived_at: mins(8), service_id: services[1] }),
    ap(today, '12:00', 1, P[6]),
    ap(today, '12:30', 0, P[7], { status: 'pending', source: 'website' }),
    ap(today, '13:00', 1, P[8]),
    ap(today, '14:00', 0, P[9]),
    ap(today, '15:00', 1, P[2], { service_id: services[2] }),
  ];
  for (let k = 1; k <= 6; k += 1) {
    const day = addDays(today, k);
    rows.push(ap(day, '09:00', 0, P[(k + 1) % 10]), ap(day, '10:30', 1, P[(k + 4) % 10]), ap(day, '12:00', k % 2, P[(k + 6) % 10], k === 2 ? { status: 'pending', source: 'website' } : {}));
    if (k % 2) rows.push(ap(day, '13:30', 0, P[(k + 8) % 10]));
  }
  for (let k = 1; k <= 8; k += 1) rows.push(ap(addDays(today, -k * 6), '10:00', k % 2, P[0], { status: 'completed', checked_in: true, payment_status: 'paid' }));
  await knex('appointments').insert(rows);
  const byName = async (name, date = today) => knex('appointments').where({ business_id: b, patient_name: name, appointment_date: date }).first();
  // receipts of the visits already paid today
  let n = 1;
  for (const a of await knex('appointments').where({ business_id: b, payment_status: 'paid' })) { // eslint-disable-line no-restricted-syntax
    await knex('invoices').insert({ business_id: b, appointment_id: a.id, patient_id: a.patient_id, patient_name: a.patient_name, doctor_id: a.doctor_id, amount: a.doctor_id === docs[1] ? 25 : 15, payment_method: 'cash', invoice_number: n, created_at: a.appointment_date === today ? new Date(now - 4 * 60000) : new Date(`${a.appointment_date}T08:00:00Z`) }); // eslint-disable-line no-await-in-loop
    n += 1;
  }
  // the visit in progress: vitals, complaint, the consultation timer
  const reem = await byName(P[1].name);
  await knex('consultations').insert({ business_id: b, appointment_id: reem.id, patient_id: P[1].id, patient_name: P[1].name, doctor_id: docs[1], chief_complaint: L.complaint, vital_signs: JSON.stringify({ pulseBpm: 74, bloodPressure: '120/80', temperatureC: 36.8 }) });
  await knex('consultation_timers').insert({ business_id: b, appointment_id: reem.id, doctor_id: docs[1], started_at: mins(18) });
  // surgeries this week
  for (const [k, s] of [[1, 0], [2, 1], [3, 2]]) { // eslint-disable-line no-restricted-syntax
    await appts.block(ctx, { kind: 'surgery', doctor_id: docs[1], appointment_date: addDays(today, k), appointment_time: '15:00', duration_minutes: k === 2 ? '90' : '120', patient_id: P[[0, 1, 4][s]].id, procedure_name: L.procedures[s], hospital_id: hospitals[k % 2], notes: lang === 'ar' ? 'تخدير عام — صيام 8 ساعات' : 'General anaesthesia — fast 8 hours' }); // eslint-disable-line no-await-in-loop
  }
  return { email, b, docs, pats, reem: reem.id, ahmad: P[0].id };
}

async function capture(page, base, url, file, { wait = 600, before } = {}) {
  await page.goto(base + url, { waitUntil: 'load' });
  if (before) await before(page);
  await page.waitForTimeout(wait);
  await page.screenshot({ path: file });
  return file;
}

// Stills → WebP; a tour (key screens) → an animated WebP with cross-fades, and its poster (the first screen).
const PY = `
import sys, json
from PIL import Image
job = json.loads(sys.argv[1])
if job['kind'] == 'still':
    im = Image.open(job['src']).convert('RGB')
    if im.width > 1280: im = im.resize((1280, round(im.height * 1280 / im.width)), Image.LANCZOS)  # taken at 2x: sharper when scaled down
    im.save(job['out'], 'WEBP', quality=82, method=6)
else:
    keys = [Image.open(p).convert('RGB').resize(tuple(job['size']), Image.LANCZOS) for p in job['frames']]
    frames, durs = [], []
    for i, k in enumerate(keys):
        frames.append(k); durs.append(job['hold'])
        nxt = keys[(i + 1) % len(keys)]
        for s in range(1, job['fade'] + 1):
            frames.append(Image.blend(k, nxt, s / (job['fade'] + 1))); durs.append(70)
    frames[0].save(job['out'], 'WEBP', save_all=True, append_images=frames[1:], duration=durs, loop=0, quality=72, method=6)
    keys[0].save(job['poster'], 'WEBP', quality=80, method=6)
`;
const py = (job) => execFileSync('python3', ['-I', '-c', PY, JSON.stringify(job)], { stdio: 'inherit' });

// The MedWorks logo as the sample clinic's logo (wide, and the pulse mark alone for the square one).
async function logos(browser) {
  const page = await browser.newPage({ deviceScaleFactor: 2 });
  const svg = fs.readFileSync(path.join(ROOT, 'public', 'img', 'brand', 'medworks-logo-full.svg'), 'utf8');
  const mark = svg.replace(/viewBox="[^"]*"/, 'viewBox="-3 -62 640 640"').replace(/(<path[^>]*\/>)[\s\S]*<\/svg>/, '$1</svg>');
  const shoot = async (markup, w, h) => {
    await page.setViewportSize({ width: w, height: h });
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${w}px;height:${h}px}</style>${markup}`);
    return page.screenshot({ omitBackground: true });
  };
  const out = { wide: await shoot(svg, 600, 136), square: await shoot(mark, 256, 256) };
  await page.close();
  return out;
}

(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  const { createApp } = require('../src/app'); // eslint-disable-line global-require
  const server = await new Promise((r) => { const s = createApp().listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch(fs.existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {}).catch(() => chromium.launch());
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-'));
  const tag = Date.now().toString(36);
  const logo = await logos(browser);
  for (const lang of ['ar', 'en']) { // eslint-disable-line no-restricted-syntax
    const s = await seed(lang, tag, logo); // eslint-disable-line no-await-in-loop
    const out = path.join(ROOT, 'public', 'img', 'landing', lang);
    const shot = (name) => path.join(tmp, `${lang}-${name}.png`);
    for (const [vw, vh, kind] of [[1280, 800, 'still'], [1120, 700, 'flow']]) { // eslint-disable-line no-restricted-syntax
      const ctxB = await browser.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: kind === 'still' ? 2 : 1, locale: lang === 'ar' ? 'ar-JO' : 'en-GB', colorScheme: 'light', timezoneId: 'Asia/Amman' }); // eslint-disable-line no-await-in-loop
      const page = await ctxB.newPage(); // eslint-disable-line no-await-in-loop
      await page.goto(`${base}/login?lang=${lang}`); // eslint-disable-line no-await-in-loop
      await page.fill('input[name=email]', s.email); await page.fill('input[name=password]', PASSWORD); // eslint-disable-line no-await-in-loop
      await Promise.all([page.waitForNavigation(), page.click('form button[type=submit]')]); // eslint-disable-line no-await-in-loop
      const q = `lang=${lang}`;
      if (kind === 'still') {
        const stills = {
          today: `/app?${q}`,
          calendar: `/app/appointments?view=week&doctor=${s.docs[0]}&${q}`,
          frontdesk: `/app/front-desk?${q}`,
          patient: `/app/patients/${s.ahmad}?${q}`,
          cash: `/app/cashier/screen?${q}`,
          surgeries: `/app/surgeries?view=week&${q}`,
          builder: `/app/website/builder?${q}`,
        };
        for (const [name, url] of Object.entries(stills)) { // eslint-disable-line no-restricted-syntax
          await capture(page, base, url, shot(name), { wait: name === 'builder' ? 1500 : 700 }); // eslint-disable-line no-await-in-loop
          py({ kind: 'still', src: shot(name), out: path.join(out, `${name}.webp`) });
        }
      } else {
        // A visit: the calendar → booking → reception → the visit → the cash screen.
        const visit = [
          await capture(page, base, `/app/appointments?view=day&${q}`, shot('v1')), // eslint-disable-line no-await-in-loop
          await capture(page, base, `/app/appointments/new?doctor=${s.docs[0]}&${q}`, shot('v2')), // eslint-disable-line no-await-in-loop
          await capture(page, base, `/app/front-desk?${q}`, shot('v3')), // eslint-disable-line no-await-in-loop
          await capture(page, base, `/app/visits/${s.reem}?${q}`, shot('v4')), // eslint-disable-line no-await-in-loop
          await capture(page, base, `/app/cashier/screen?${q}`, shot('v5')), // eslint-disable-line no-await-in-loop
        ];
        py({ kind: 'flow', frames: visit, size: [1120, 700], hold: 1800, fade: 4, out: path.join(out, 'flow-visit.webp'), poster: path.join(out, 'flow-visit-poster.webp') });
        // A surgery: book the time → the week → the surgery (send to the hospital) → the patient's file.
        const sid = (await knex('surgeries').where({ business_id: (await knex('users').where({ email: s.email }).first('last_business_id')).last_business_id }).orderBy('id').first('id')).id; // eslint-disable-line no-await-in-loop
        const surgery = [
          await capture(page, base, `/app/appointments?view=day&${q}`, shot('s1'), { before: async (p) => { const btn = await p.$('[data-open-dialog="block-dialog"]'); if (btn) { await btn.click(); await p.waitForTimeout(300); const k = await p.$('input[name="kind"][value="surgery"]'); if (k) await k.check({ force: true }); } } }), // eslint-disable-line no-await-in-loop
          await capture(page, base, `/app/surgeries?view=week&${q}`, shot('s2')), // eslint-disable-line no-await-in-loop
          await capture(page, base, `/app/surgeries/${sid}?${q}`, shot('s3')), // eslint-disable-line no-await-in-loop
          await capture(page, base, `/app/patients/${s.ahmad}?tab=surgeries&${q}`, shot('s4')), // eslint-disable-line no-await-in-loop
        ];
        py({ kind: 'flow', frames: surgery, size: [1120, 700], hold: 1800, fade: 4, out: path.join(out, 'flow-surgery.webp'), poster: path.join(out, 'flow-surgery-poster.webp') });
      }
      await ctxB.close(); // eslint-disable-line no-await-in-loop
    }
    console.log(`landing screenshots (${lang}) written to ${path.relative(ROOT, out)}`); // eslint-disable-line no-console
  }
  await browser.close();
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  await knex.destroy();
})().catch((e) => { console.error(e); process.exit(1); }); // eslint-disable-line no-console

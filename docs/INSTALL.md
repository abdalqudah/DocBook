# تثبيت DocBook — دليل خطوة بخطوة

> English summary at the end.

## المتطلبات
| العنصر | المطلوب |
| --- | --- |
| Node.js | الإصدار 20 أو أحدث (يُفضّل 22) |
| قاعدة البيانات | MySQL 8 أو MariaDB 10.6 أو أحدث |
| الاستضافة | سيرفر VPS (Ubuntu) أو استضافة cPanel تدعم تطبيقات Node.js |
| شهادة SSL | إلزامية (https) — الكاميرا في الاستشارة الأونلاين وبوابات الدفع و Google تعمل فقط على https |
| الذاكرة | 1 GB RAM على الأقل (2 GB مريح) |

> ملاحظة مهمة: شغّل **نسخة واحدة** فقط من التطبيق (instance واحد). المهام المجدولة (التذكيرات، إلغاء الحجوزات غير المدفوعة، نسخ قواعد البيانات) تعمل من داخل التطبيق.

---

## الطريقة الأولى: سيرفر VPS (Ubuntu 22.04/24.04) — الأنسب

### 1) تثبيت البرامج
```bash
sudo apt update
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs mariadb-server nginx unzip
sudo npm install -g pm2
```

### 2) إنشاء قاعدة البيانات
```bash
sudo mysql
```
```sql
CREATE DATABASE docbook CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'docbook'@'localhost' IDENTIFIED BY 'ضع_كلمة_مرور_قوية';
GRANT ALL PRIVILEGES ON docbook.* TO 'docbook'@'localhost';
FLUSH PRIVILEGES;
EXIT;
```

### 3) رفع الملفات وتثبيت الحزم
```bash
sudo mkdir -p /var/www/docbook && sudo chown $USER /var/www/docbook
cd /var/www/docbook
unzip ~/docbook-2.0.0-dist.zip   # نسخة dist: app.js جاهز بكل المكتبات، بدون node_modules
```
> نسخة الـ dist لا تحتاج `npm install`. إذا كنت تستخدم الكود المصدري بدلًا منها: `npm ci --omit=dev` (وتُبنى الـ dist بالأمر `npm run build`).

### 4) ملف الإعدادات
```bash
cp .env.example .env
nano .env
```
عبّئ على الأقل:
- `APP_URL=https://docbook.yourdomain.com`
- `SESSION_SECRET=` و `APP_KEY=` — ولّد كل واحد بالأمر:
  `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
  (لا تغيّر `APP_KEY` بعد التشغيل — تُشفَّر به مفاتيح واتساب والدفع والإيميل)
- `DB_PASSWORD=` كلمة مرور قاعدة البيانات من الخطوة 2
- `SUPER_ADMIN_EMAIL=` و `SUPER_ADMIN_PASSWORD=` — حساب مدير المنصة

### 5) إنشاء الجداول والتشغيل
```bash
node app.js migrate
pm2 start app.js --name docbook
pm2 save
pm2 startup        # ونفّذ الأمر الذي يظهر لك، ليعمل التطبيق تلقائيًا بعد إعادة تشغيل السيرفر
```

### 6) nginx + SSL
أنشئ الملف `/etc/nginx/sites-available/docbook`:
```nginx
server {
    listen 80;
    server_name docbook.yourdomain.com;
    client_max_body_size 4g;    # ملفات المرضى، واستيراد ملفات المرضى (حتى 4 غيغابايت)
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }
}
```
```bash
sudo ln -s /etc/nginx/sites-available/docbook /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d docbook.yourdomain.com
```

افتح `https://docbook.yourdomain.com` — يجب أن تظهر الصفحة الرئيسية.

---

## الطريقة الثانية: استضافة cPanel (Setup Node.js App)

1. **قاعدة البيانات:** cPanel ← MySQL Databases: أنشئ قاعدة بيانات ومستخدمًا وأعطه كل الصلاحيات (سيضيف cPanel بادئة لاسمك، مثل `user_docbook`).
2. **رفع الملف:** File Manager ← ارفع `docbook.zip` إلى مجلد خارج `public_html` (مثل `/home/USER/docbook`) ← Extract.
3. **إنشاء التطبيق:** cPanel ← Setup Node.js App ← Create Application:
   - Node.js version: 20 أو أحدث
   - Application mode: Production
   - Application root: `docbook`
   - Application URL: الدومين أو الدومين الفرعي
   - Application startup file: `app.js`
4. **المتغيرات:** في نفس الصفحة أضف Environment variables (نفس محتوى `.env.example`): `APP_URL`، `SESSION_SECRET`، `APP_KEY`، `DB_HOST=localhost`، `DB_NAME`، `DB_USER`، `DB_PASSWORD`، `SUPER_ADMIN_EMAIL`، `SUPER_ADMIN_PASSWORD`. (أو أنشئ ملف `.env` داخل المجلد.)
5. اضغط **Restart** (نسخة الـ dist لا تحتاج Run NPM Install).
   > CloudLinux: الـ dist لا يحتوي مجلد `node_modules` (يُنشئ CloudLinux رابطًا بهذا الاسم بنفسه). إذا ظهرت رسالة أن المجلد يحتوي `node_modules`، احذف أي `node_modules` قديم من مجلد التطبيق (من رفع سابق) قبل إنشاء التطبيق.
6. SSL: cPanel ← SSL/TLS Status ← Run AutoSSL.
7. تُنشأ الجداول تلقائيًا عند أول تشغيل (إلا إذا وضعت `AUTO_MIGRATE=false`). مستخدم قاعدة البيانات يحتاج كل الصلاحيات (ALL PRIVILEGES).

> إذا كانت الاستضافة المشتركة تحدّ الذاكرة أو توقف التطبيق عند الخمول، قد تتأخر التذكيرات المجدولة — الـ VPS أنسب للإنتاج.

---

## بعد التثبيت (أول مرة)
1. ادخل بحساب مدير المنصة على `/login` ثم افتح `/admin`:
   - **الصفحة الرئيسية:** عدّل المحتوى والصور وSEO.
   - **المناديب:** وافق على حسابات المناديب والمستودعات.
2. سجّل أول عيادة من `/signup` (أو اجعل `ALLOW_SIGNUP=false` وأنشئ العيادات بنفسك).
3. داخل العيادة: معالج الإعداد (الأطباء، الخدمات، الموظفون، عنوان صفحة العيادة)، ثم:
   - **الإعدادات ← صفحة العيادة:** الحجز الإلكتروني والاستشارات الأونلاين والدفع المسبق.
   - **الإعدادات ← الموظفون والدخول:** حسابات الأطباء والتمريض والاستقبال.

## الخدمات الاختيارية (تُفعّل عند الحاجة)
| الخدمة | ماذا تحتاج | أين تُدخل |
| --- | --- | --- |
| الإيميل | بيانات SMTP من مزود البريد | `.env`: `SMTP_*`, `MAIL_FROM` |
| تذكير واتساب | حساب WhatsApp Business API من Meta + 3 قوالب رسائل معتمدة | كل عيادة: الإعدادات ← الرسائل والتذكيرات |
| SMS | حساب لدى مزود (Unifonic / Twilio …) | الإعدادات ← الرسائل والتذكيرات |
| الدفع الإلكتروني | حساب تاجر PayTabs أو HyperPay باسم العيادة | كل عيادة: الإعدادات ← الدفع الإلكتروني |
| الدخول بـ Google | OAuth Client من Google Cloud، رابط الرجوع `https://<الدومين>/auth/google/callback` | `/admin/google` |
| فيديو الاستشارات | يعمل مباشرة؛ لبعض شبكات الجوال أضف سيرفر TURN | `.env`: `ICE_SERVERS` |
| دومين خاص لعيادة | سجلا DNS (TXT و CNAME) من الإعدادات + إضافة الدومين للاستضافة مع SSL | الإعدادات ← صفحة العيادة |
| نسخ لقاعدة بيانات العيادة | قاعدة MySQL/PostgreSQL خارجية للعيادة | الإعدادات ← قاعدة بياناتك |

### سيرفر TURN (مستحسن للاستشارات الأونلاين)
```bash
sudo apt install -y coturn
```
في `/etc/turnserver.conf`: `listening-port=3478`، `fingerprint`، `lt-cred-mech`، `user=USER:PASS`، `realm=yourdomain.com`، ثم فعّل الخدمة وافتح المنافذ 3478 (UDP/TCP) و 49152–65535 UDP. ثم في `.env`:
```
ICE_SERVERS=[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:yourdomain.com:3478","username":"USER","credential":"PASS"}]
```

## التحديث لنسخة جديدة
```bash
cd /var/www/docbook
mysqldump -u docbook -p docbook > ~/backup-$(date +%F).sql   # نسخة احتياطية أولًا
unzip -o ~/docbook-new-dist.zip
node app.js migrate
pm2 restart docbook
```
(لا تستبدل ملف `.env`.)

## النسخ الاحتياطي
- قاعدة البيانات يوميًا: `mysqldump -u docbook -p docbook | gzip > backup.sql.gz` (مثلًا عبر cron).
- احتفظ بنسخة من ملف `.env` في مكان آمن — بدون `APP_KEY` الأصلي لا يمكن قراءة المفاتيح المحفوظة.
- ملفات المرضى (الصور والأشعة والمرفقات) محفوظة داخل قاعدة البيانات، فتشملها نسخة `mysqldump`. ولكل عيادة نسخة خاصة من لوحة الأدمن، ويمكن للعيادة نفسها تصدير ملف مريض أو كل المرضى (المرضى ← تصدير واستيراد) واستيراده لاحقاً.
- ملفات التصدير والاستيراد المؤقتة في `storage/patient-exports` و `storage/patient-imports` (تُحذف تلقائياً بعد 24 ساعة / 7 أيام). لتغيير مكانها أو حد حجم الرفع: `PATIENT_EXPORT_DIR` و `PATIENT_IMPORT_DIR` و `PATIENT_IMPORT_MAX_MB` في `.env`. إذا كان أمامك nginx فارفع `client_max_body_size` ليتسع لملف الاستيراد.

## فحص سريع عند المشاكل
| المشكلة | الحل |
| --- | --- |
| الصفحة لا تفتح | `pm2 logs docbook` لقراءة الخطأ. على cPanel/CloudLinux: الملف `stderr.log` في مجلد التطبيق، ثم Restart من Setup Node.js App |
| صفحة "503 Service Unavailable" من السيرفر (LiteSpeed) | التطبيق لم يعمل: تأكد من Node.js 20+، وملف التشغيل `app.js`، واقرأ `stderr.log` |
| "Missing required environment variable" | متغير ناقص في `.env` |
| `ER_NO_SUCH_TABLE` | الجداول غير موجودة: احذف `AUTO_MIGRATE=false` إن وُجد ثم Restart |
| `MIGRATION_FAILED` | أعطِ مستخدم قاعدة البيانات كل الصلاحيات (ALL PRIVILEGES) ثم Restart |
| خطأ اتصال بقاعدة البيانات | تحقق من `DB_*` وأن المستخدم له صلاحيات |
| تسجيل الدخول يرجع لصفحة الدخول | استخدم https، و `TRUST_PROXY=true` خلف nginx/cPanel |
| الروابط في الإيميلات أو رمز QR خاطئة | اضبط `APP_URL` على العنوان الحقيقي بـ https |
| لا يمكن حفظ مفاتيح واتساب/الدفع | أضف `APP_KEY` إلى `.env` |
| الفيديو لا يتصل عند بعض المرضى | أضف سيرفر TURN في `ICE_SERVERS` |

---

## English summary
1. Requirements: Node.js ≥ 20, MySQL 8 / MariaDB 10.6+, HTTPS, one app instance.
2. Unzip the dist (bundled `app.js`, no `npm install`; from source: `npm ci --omit=dev`, build with `npm run build`) → `cp .env.example .env` and set `APP_URL`, `SESSION_SECRET`, `APP_KEY` (never change it later), `DB_*`, `SUPER_ADMIN_*` → `node app.js migrate` → `pm2 start app.js --name docbook` behind nginx with TLS (`client_max_body_size 4g` for patient-file imports, forward `X-Forwarded-Proto`).
3. cPanel: Setup Node.js App (startup file `app.js`), add the same environment variables, Restart, AutoSSL.
4. Sign in as the super admin → `/admin`; create clinics via `/signup`.
5. Optional services (SMTP, WhatsApp Cloud API, SMS, PayTabs/HyperPay, Google sign-in, TURN, custom domains) are configured as in the table above.

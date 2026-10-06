# دليل إطلاق منصة GEC (بالعربية)

هذا الدليل يشرح خطوة بخطوة ما تحتاجه لنقل المنصة من بيئة التطوير إلى الإنترنت: النطاق (الدومين)، الخادم،
إعدادات DNS، شهادة الأمان HTTPS، البريد الإلكتروني، واتساب، الدفع الإلكتروني، تسجيل الدخول بـ Google/Microsoft،
محركات البحث، والنسخ الاحتياطي. في النهاية قائمة تحقق قبل الإطلاق.

> **ملاحظة:** المنصة لا تتظاهر بوجود خدمة غير مربوطة. أي قناة لم تُربط (واتساب، SMS، الدفع…) تظهر «غير متصلة»
> مع شرح، إلى أن تُدخل بياناتها في **الإعدادات**.

---

## 0. التركيب على Hostinger Business / Cloud (Node.js Web Apps) — بدون VPS

إذا كانت خطتك تدعم **Node.js Web Apps** (تظهر في تفاصيل الخطة: *Supported backend frameworks: Express*) فهي
تكفي لموقع واحد على دومين واحد: Hostinger تثبّت المكتبات وتشغّل التطبيق وتبقيه يعمل، وتعطي HTTPS مجاناً،
وقاعدة MySQL، وبريداً للنطاق، ونسخاً احتياطية يومية. لا تحتاج Docker ولا Caddy ولا VPS.

**مثال خطة مناسبة:** Frankfurt (ألمانيا)، 2 معالج، 3GB رام، 50GB — ممتازة لطلاب الأردن والخليج.

### 0.1 قاعدة البيانات
hPanel ← **Databases ← Management** ← أنشئ قاعدة بيانات ومستخدماً:
- الاسم مثل `u213859182_gec`، والمستخدم `u213859182_gec`، وكلمة مرور قوية.
- انسخ **اسم الخادم (Host)** كما يظهر في الصفحة (غالباً `localhost`)، والاسم، والمستخدم، وكلمة المرور.

### 0.2 مجلد الملفات المرفوعة (مهم)
كل نشر جديد يستبدل ملفات التطبيق، لذلك يجب أن تُحفظ مستندات الطلاب والصور **خارج** مجلد التطبيق.
من **File Manager** أنشئ مجلداً في جذر الحساب: `/home/u213859182/gec-storage`
(رقم الحساب هو اسم مستخدم FTP عندك). سنضعه في المتغير `STORAGE_DIR`.

### 0.3 GitHub وفرع النشر
1. على GitHub: ادمج آخر التحديثات في الفرع **main**.
2. أنشئ فرعاً اسمه **production** من main (Branches ← New branch). هذا ما سيعمل على الموقع.
3. أنشئ رمز GitHub للتحديث: GitHub ← Settings ← Developer settings ← **Fine-grained tokens** ← Generate:
   المستودع: هذا المستودع فقط، الصلاحية: **Contents: Read and write**، مدة صلاحية سنة.

### 0.4 إنشاء التطبيق في hPanel
hPanel ← **Websites ← Add website ← Node.js Web App** (أو من الموقع الحالي ← Node.js):
| الحقل | القيمة |
| --- | --- |
| المصدر | **GitHub** ← اختر المستودع والفرع **production** |
| Framework | **Express** |
| Node.js version | **22.x** |
| Root directory | `gec` (مجلد المنصة داخل المستودع) |
| Entry file | `app.js` |
| Build command / Output directory | فارغ |
| Package manager | npm |

### 0.5 متغيرات البيئة
في إعدادات التطبيق ← **Environment variables** ← **Import .env** والصق (عدّل القيم بين < >):
```env
NODE_ENV=production
APP_URL=https://<دومينك أو العنوان المؤقت xxx.hostingersite.com>
TRUST_PROXY=true
AUTO_MIGRATE=true
SESSION_SECRET=<نص عشوائي طويل>
APP_KEY=<نص عشوائي طويل آخر — لا تغيّره بعد الإطلاق>
DB_HOST=<Host من صفحة قواعد البيانات، غالباً localhost>
DB_PORT=3306
DB_NAME=u213859182_gec
DB_USER=u213859182_gec
DB_PASSWORD=<كلمة مرور القاعدة>
STORAGE_DIR=/home/u213859182/gec-storage
ADMIN_EMAIL=<بريدك>
ADMIN_PASSWORD=<كلمة مرور قوية مؤقتة>
ADMIN_NAME=<اسمك>
DEFAULT_LOCALE=ar
UPDATE_MODE=github
GITHUB_REPO=<المالك/اسم-المستودع>
GITHUB_TOKEN=<رمز GitHub من الخطوة 0.3>
UPDATE_SOURCE_BRANCH=main
UPDATE_DEPLOY_BRANCH=production
```
ثم **Deploy**. عند أول تشغيل تُنشأ الجداول وحساب المدير تلقائياً. افتح `APP_URL/staff/login`.

### 0.6 الدومين و HTTPS
hPanel ← الموقع ← **Connect domain**: اربط دومينك (إن كان من Hostinger يُضبط DNS تلقائياً؛ وإلا ضع سجلات
`A` التي يعرضها hPanel). شهادة SSL مجانية تُفعّل تلقائياً. بعد الربط **غيّر `APP_URL`** إلى `https://دومينك` وأعد النشر.

### 0.7 البريد الإلكتروني
الخطة تتضمن بريداً للنطاق: hPanel ← **Emails** ← أنشئ `no-reply@دومينك` و `info@دومينك`. ثم في المنصة
**الإعدادات ← البريد الإلكتروني**: الخادم `smtp.hostinger.com`، المنفذ `465` (SSL)، المستخدم = عنوان البريد
كاملاً، وكلمة مروره. Hostinger تضيف SPF و DKIM تلقائياً للدومينات المربوطة لديها؛ أضف DMARC (القسم 5).

### 0.8 التحديثات بزر واحد
في المنصة: **النظام ← تحديث النظام** (لمدير النظام الأعلى). عندما تصل تحديثات إلى main تظهر هنا بأسمائها،
وزر **«تحديث النظام الآن»** ينقل فرع production إليها، فتعيد Hostinger البناء تلقائياً (2–5 دقائق) والصفحة
تُظهر متى أصبح الإصدار الجديد يعمل. وزر **«العودة للإصدار السابق»** يرجع خطوة إن ظهرت مشكلة.
النسخ الاحتياطي: Hostinger تأخذ نسخة يومية (hPanel ← Backups)؛ خذ نسخة يدوية قبل التحديثات الكبيرة.

### 0.9 ملاحظات
- لا تعدّل ملفات التطبيق من File Manager — أي نشر يستبدلها. كل التعديلات عبر GitHub أو من لوحة التحكم.
- السجلات (Logs) والأخطاء: إعدادات التطبيق في hPanel ← Logs.
- الأقسام 2–3 (الخادم و Docker و Caddy) و 14 (backup.sh) خاصة بالـ VPS ويمكن تجاوزها؛ أكمل من القسم 5.

---

## 1. ما الذي تحتاجه بالضبط (ملخص)

| العنصر | ماذا تشتري / تجهّز | التكلفة التقريبية |
| --- | --- | --- |
| النطاق | مثل `gec-edu.com` من Cloudflare Registrar أو Namecheap أو GoDaddy | 10–15$ سنوياً |
| الخادم (VPS) | Ubuntu 24.04، 2 معالج، 4GB RAM، 80GB SSD (Hetzner أو DigitalOcean أو AWS Lightsail) | 7–25$ شهرياً |
| بريد الموظفين | Google Workspace أو Microsoft 365 (صناديق مثل info@ و admissions@) | 6–7$ للمستخدم شهرياً |
| بريد المنصة (الإرسال الآلي) | خدمة SMTP للمعاملات: Amazon SES أو Brevo أو Postmark أو Mailgun | مجاني إلى ~15$ شهرياً |
| واتساب (اختياري) | حساب Meta Business + رقم هاتف مخصص لواجهة WhatsApp Cloud API | تُحسب الرسائل حسب المحادثة |
| SMS (اختياري) | حساب Twilio ورقم مرسل | حسب الاستخدام |
| الدفع بالبطاقة (اختياري) | حساب Stripe مفعّل لبلد الشركة | نسبة على كل عملية |
| الذكاء الاصطناعي (اختياري) | مفتاح Anthropic API للمستشار الذكي | حسب الاستخدام |

**من سيقوم بماذا:** إذا لم يكن لديك فريق تقني، يكفي مطوّر/مسؤول أنظمة لمدة يوم إلى يومين لتنفيذ الأقسام 2–5،
وبعدها كل الإعدادات الأخرى تتم من داخل لوحة التحكم دون برمجة.

---

## 2. النطاق (الدومين)

1. اشترِ النطاق. نوصي بـ **Cloudflare Registrar** لأنه يبيع بسعر التكلفة ويعطيك إدارة DNS مجانية وسريعة.
2. إذا اشتريته من جهة أخرى، يمكنك نقل إدارة DNS فقط إلى Cloudflare (تغيير الـ Nameservers من لوحة المسجّل).
3. قرّر العنوان الرسمي: `gec-edu.com` (بدون www) وسنحوّل `www` إليه تلقائياً.

---

## 3. الخادم

### 3.1 إنشاء الخادم
- أنشئ خادماً بنظام **Ubuntu 24.04 LTS** واختر أقرب منطقة لجمهورك (لطلاب الأردن والخليج: أوروبا — ألمانيا أو فرنسا أو هولندا).
- فعّل الدخول بمفتاح SSH، وسجّل عنوان الـ IP العام للخادم (مثال: `203.0.113.10`).

### 3.1أ على Hostinger تحديداً
> هذا القسم لخطط **VPS** فقط. إذا كانت خطتك **Business / Cloud** مع «Node.js Web Apps» فاتبع **القسم 0** بالأعلى ولا تحتاج VPS.

1. **نوع الخطة:** VPS (مثل KVM 2: معالجان، 8GB رام، 100GB NVMe).
2. **الموقع الجغرافي (Location):** لا تختر أمريكا الشمالية (التأخير من الأردن 140–200ms). انزل في القائمة إلى
   **Europe** واختر الأقل تأخيراً عندك — عادة **Germany (Frankfurt)** أو **France (Paris)** أو **Netherlands**
   أو **Lithuania** (حوالي 50–80ms من عمّان). كلها مناسبة لطلاب الأردن والخليج.
3. **نظام التشغيل (Operating System):** اختر **Ubuntu 24.04 with Docker** إن وُجد (Docker جاهز)، وإلا **Ubuntu 24.04** نظيف.
   لا تختر قوالب لوحات تحكم (cPanel / CyberPanel / Coolify) — لا حاجة لها.
4. **كلمة مرور root ومفتاح SSH:** ضع كلمة مرور قوية وأضف مفتاح SSH إن كان لديك.
5. **Malware scanner / Backups:** فعّل النسخ الاحتياطي الأسبوعي من Hostinger (Snapshots) إضافة لنسخ المنصة الليلية.
6. **الجدار الناري (hPanel ← VPS ← Firewall):** اسمح بالمنافذ **22** (SSH) و **80** و **443** فقط.
7. **الدومين:** إن اشتريته من Hostinger، اضبط السجلات من hPanel ← Domains ← DNS / Nameservers:
   سجل `A` للاسم `@` وسجل `A` (أو CNAME) للاسم `www` يشيران إلى IP الـ VPS (يظهر في hPanel ← VPS ← Overview).
   احذف أي سجل `A` افتراضي قديم يشير لاستضافة Hostinger أخرى.
8. ادخل للخادم: من hPanel زر **Browser terminal**، أو من جهازك: `ssh root@IP`، ثم أكمل من القسم 3.2.

### 3.2 تجهيز الخادم (مرة واحدة)
```bash
# تحديث النظام وجدار الحماية
sudo apt update && sudo apt -y upgrade
sudo ufw allow OpenSSH && sudo ufw allow 80 && sudo ufw allow 443 && sudo ufw enable

# Docker
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER   # ثم سجّل الخروج والدخول مجدداً

# Caddy (يصدر شهادة HTTPS ويجددها تلقائياً)
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

### 3.3 تنزيل المنصة وتشغيلها
```bash
sudo mkdir -p /opt/gec && sudo chown $USER /opt/gec
git clone <رابط المستودع> /opt/gec && cd /opt/gec/gec
cp .env.example .env
nano .env
```
املأ في ملف `.env`:

| المتغير | القيمة |
| --- | --- |
| `APP_URL` | `https://gec-edu.com` (العنوان الرسمي بدون / في النهاية) |
| `SESSION_SECRET` و `APP_KEY` | نص عشوائي طويل لكل منهما: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` أو `openssl rand -hex 48` |
| `DB_PASSWORD` | كلمة مرور قوية لقاعدة البيانات |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_NAME` | حساب المدير الأول (غيّر كلمة المرور بعد أول دخول) |
| `TRUST_PROXY` | `true` |
| `NODE_ENV` | `production` |

> احفظ `APP_KEY` و `SESSION_SECRET` في مكان آمن (مدير كلمات مرور). إذا ضاع `APP_KEY` فلن تُقرأ بيانات الربط
> المحفوظة (SMTP، واتساب، Stripe…) وستحتاج لإدخالها من جديد.

ثم شغّل:
```bash
docker compose up -d --build
docker compose logs -f app      # انتظر رسالة listening on 3000
curl http://127.0.0.1:3000/healthz
```
قاعدة البيانات تُنشأ وتُحدّث تلقائياً عند التشغيل. البيانات والملفات المرفوعة محفوظة في Docker volumes.

### 3.4 ربط النطاق وشهادة HTTPS
1. عدّل ملف `deploy/Caddyfile` وضع نطاقك بدل `gec-example.com`.
2. `sudo cp deploy/Caddyfile /etc/caddy/Caddyfile && sudo systemctl reload caddy`
3. بعد ضبط DNS (القسم التالي) سيصدر Caddy الشهادة تلقائياً خلال دقيقة. افتح `https://gec-edu.com`.

### 3.5 التحديثات لاحقاً — زر «تحديث النظام»
ثبّت محدِّث الخادم **مرة واحدة**:
```bash
cd /opt/gec/gec && sudo ./deploy/install-updater.sh
```
بعدها يظهر في لوحة الموظفين **النظام ← تحديث النظام** (لمدير النظام الأعلى فقط): الإصدار الحالي، التحديثات
المتاحة، وزر **«تحديث النظام الآن»**. عند الضغط: نسخة احتياطية ← تنزيل الإصدار الجديد ← إعادة البناء والتشغيل ←
فحص أن المنصة تعمل ← وإن لم تعمل يُستعاد الإصدار السابق تلقائياً. يمكنك متابعة التقدم مباشرة في الصفحة.

> للأمان، الموقع نفسه لا ينفّذ أوامر على الخادم؛ الزر يكتب «طلب تحديث» فقط، وبرنامج صغير على الخادم
> (`deploy/updater.py` عبر systemd) هو من ينفّذه. يجب أن تكون المنصة مثبتة عبر `git clone` حتى يعمل التحديث.

يدوياً (بدون الزر):
```bash
cd /opt/gec && git pull && cd gec && GIT_COMMIT=$(git rev-parse HEAD) docker compose up -d --build
```

---

## 4. سجلات DNS

في لوحة DNS (Cloudflare مثلاً) أضف:

| النوع | الاسم | القيمة | ملاحظة |
| --- | --- | --- | --- |
| A | `@` | عنوان IP الخادم | الموقع |
| A أو CNAME | `www` | نفس الـ IP (أو CNAME إلى `@`) | يُحوَّل تلقائياً إلى العنوان الرسمي |
| MX | `@` | حسب مزود بريد الموظفين (Google أو Microsoft) | استقبال البريد |
| TXT | `@` | سجل SPF (انظر القسم 5) | يثبت أن الإرسال من خوادم مسموح لها |
| TXT/CNAME | حسب المزود | مفاتيح DKIM | توقيع الرسائل |
| TXT | `_dmarc` | `v=DMARC1; p=quarantine; rua=mailto:dmarc@gec-edu.com` | سياسة الحماية |
| TXT | `@` | رمز تحقق Google Search Console (اختياري، يمكن بدلاً منه استخدام وسم HTML من الإعدادات) | |

> في Cloudflare: اترك سجل `@` و `www` على **DNS only (السحابة الرمادية)** حتى تصدر الشهادة أول مرة، ثم يمكنك
> تفعيل الـ Proxy (البرتقالية) مع وضع SSL = **Full (strict)**.

---

## 5. البريد الإلكتروني

هناك نوعان من البريد:

1. **بريد الموظفين** (info@، admissions@…): افتحه في Google Workspace أو Microsoft 365 واتبع خطوات التحقق الخاصة
   بهم (سجلات MX و TXT).
2. **بريد المنصة** (تأكيد الحساب، استعادة كلمة المرور، التذكيرات، الحملات، النشرة البريدية): يُرسل عبر SMTP.
   نوصي بخدمة معاملات مثل **Amazon SES** أو **Brevo** أو **Postmark** باسم مرسل مثل `no-reply@gec-edu.com`
   (أو نطاق فرعي `mail.gec-edu.com` لعزل سمعة الحملات).

### خطوات الإعداد
1. في مزود SMTP: أضف النطاق، وانسخ سجلات **SPF** و **DKIM** التي يعطيك إياها إلى DNS.
2. سجل SPF واحد فقط لكل نطاق؛ اجمع المزودين فيه، مثال:
   `v=spf1 include:_spf.google.com include:amazonses.com ~all`
3. أضف سجل **DMARC** (في الجدول أعلاه). ابدأ بـ `p=none` لأسبوعين ثم انتقل إلى `p=quarantine`.
4. في المنصة: **الإعدادات ← البريد الإلكتروني**: أدخل الخادم والمنفذ (465 أو 587) واسم المستخدم وكلمة المرور
   واسم المرسل، ثم اضغط **إرسال رسالة تجريبية**.
5. اختبر التقييم على <https://www.mail-tester.com> — الهدف 9/10 أو أعلى.

> الحملات والنشرة البريدية تحتوي تلقائياً على رابط إلغاء الاشتراك بنقرة واحدة (List-Unsubscribe) المطلوب من
> Gmail و Yahoo للمرسلين بكثرة، والنشرة تعتمد **التأكيد المزدوج** فلا يُرسل لأحد قبل أن يؤكد.

---

## 6. واتساب (WhatsApp Cloud API) — اختياري

1. أنشئ حساب **Meta Business** وتطبيقاً في <https://developers.facebook.com> وأضف منتج WhatsApp.
2. أضف رقم هاتف مخصصاً (لا يكون مستخدماً على تطبيق واتساب العادي) ووثّق النشاط التجاري.
3. أنشئ **System User** دائم وأعطه صلاحية `whatsapp_business_messaging` واحصل على **Access token** دائم.
4. في المنصة: **الإعدادات ← واتساب**: أدخل `Phone number ID` و `Access token` و `App secret`، واختر
   **Verify token** (أي نص سري تختاره).
5. في Meta ← WhatsApp ← Configuration ← Webhook:
   - Callback URL: `https://gec-edu.com/hooks/whatsapp`
   - Verify token: نفس النص الذي اخترته
   - اشترك في الحقل `messages`.
6. القوالب (Templates) للرسائل التي تبدأ أنت المحادثة بها تحتاج موافقة Meta مسبقاً.

بدون هذا الربط يستطيع الموظفون فتح محادثة `wa.me` من هواتفهم وتُسجَّل في ملف الطالب كرسالة يدوية.

## 7. الرسائل النصية SMS (Twilio) — اختياري
1. حساب Twilio ورقم مرسل (أو Sender ID حسب البلد).
2. **الإعدادات ← الرسائل النصية**: Account SID و Auth token والرقم المرسل.
3. في Twilio اضبط روابط الحالة والرد:
   `https://gec-edu.com/hooks/sms/twilio/status` و `https://gec-edu.com/hooks/sms/twilio`.

## 8. الدفع بالبطاقة (Stripe) — اختياري
1. فعّل حساب Stripe (بيانات الشركة والحساب البنكي).
2. Developers ← API keys: انسخ **Secret key** (يبدأ بـ `sk_live_`).
3. Developers ← Webhooks ← Add endpoint:
   - URL: `https://gec-edu.com/hooks/stripe`
   - الأحداث: `checkout.session.completed` و `checkout.session.async_payment_succeeded` و `checkout.session.async_payment_failed` و `checkout.session.expired`
   - انسخ **Signing secret** (يبدأ بـ `whsec_`).
4. **الإعدادات ← الدفع الإلكتروني**: أدخل المفتاحين وفعّل. تظهر بعدها «ادفع بالبطاقة» على الفواتير.
   لا تمر بيانات البطاقة على خادمك أبداً، والدفعة تُسجَّل فقط من إشعار Stripe الموقّع.

## 9. تسجيل الدخول بـ Google و Microsoft — اختياري

**Google:** <https://console.cloud.google.com> ← APIs & Services ← OAuth consent screen (اسم التطبيق، الشعار، رابط
سياسة الخصوصية `https://gec-edu.com/privacy`) ← Credentials ← Create OAuth client ID ← Web application:
- Authorized redirect URI: `https://gec-edu.com/auth/google/callback`

**Microsoft:** <https://entra.microsoft.com> ← App registrations ← New registration:
- Redirect URI (Web): `https://gec-edu.com/auth/microsoft/callback`
- Certificates & secrets ← New client secret (سجّل تاريخ انتهائه وجدّده قبله).
- للموظفين فقط ضع معرّف الـ Tenant الخاص بشركتك بدل `common`.

ثم **الإعدادات ← الدخول عبر Google / Microsoft**: الصق Client ID و Secret، واختر للطلاب أو الموظفين أو كليهما.

## 10. المستشار الذكي (اختياري)
**الإعدادات ← المستشار الذكي**: أدخل مفتاح Anthropic API. بدونه يعمل المستشار كبحث في قاعدة البيانات ويوضح ذلك.

---

## 11. محركات البحث والظهور في الذكاء الاصطناعي (SEO / GEO / AEO)

1. **الإعدادات ← SEO والبحث الذكي**:
   - اكتب الوصف الافتراضي بالعربية والإنجليزية واختر **صورة المشاركة** (1200×630).
   - اترك «السماح لمحركات الإجابة بالذكاء الاصطناعي» مفعّلاً حتى يرشّحك ChatGPT و Perplexity و Claude.
   - ملف `/llms.txt` يُنشأ تلقائياً من محتوى الموقع.
2. **Google Search Console** <https://search.google.com/search-console>: أضف الموقع (URL prefix)، اختر طريقة
   «HTML tag» والصق الرمز في الإعدادات، ثم أرسل خريطة الموقع `https://gec-edu.com/sitemap.xml`.
3. **Bing Webmaster Tools** <https://www.bing.com/webmasters>: يمكن الاستيراد من Search Console مباشرة.
   مهم لأن بحث ChatGPT و Copilot يعتمدان على فهرس Bing.
4. **Google Business Profile**: أنشئ ملفاً للمكتب (العنوان، الهاتف، ساعات العمل، الموقع) — يظهر في الخرائط
   والبحث المحلي ويزيد الثقة.
5. افتح **الموقع ← فحص SEO** في لوحة التحكم وأصلح ما يظهر (عناوين عربية ناقصة، أوصاف، صور بلا وصف…).

---

## 12. تجهيز المحتوى قبل الإطلاق

| أين | ماذا |
| --- | --- |
| الإعدادات ← الهوية البصرية | الشعار، الألوان، اسم الشركة، تذييل البريد |
| الإعدادات ← الشركة والتواصل | البريد، الهاتف، واتساب، العنوان، روابط التواصل الاجتماعي |
| الموقع ← الصفحة الرئيسية | ترتيب الأقسام وإظهارها وعناوينها |
| الموقع ← شرائح الرئيسية | الشرائح والصور والأزرار |
| الموقع ← مكتبة الوسائط | ارفع صوراً حقيقية للجامعات والوجهات (أو «نسخ إلى المكتبة» للصور الموجودة) |
| القبولات ← الجامعات / البرامج / المنح | راجع البيانات وأزل علامة «تجريبي» أو احذف البيانات التجريبية |
| الموقع ← الصفحات | منشئ الصفحات (من نحن، التأشيرات، صفحات حملات) |
| الموقع ← الأسئلة الشائعة | 20 سؤالاً أو أكثر بالعربية والإنجليزية |
| الإعدادات ← الخصوصية | نص السياسة، مدة الاحتفاظ بالبيانات |
| الفريق ← الموظفون، والإعدادات ← الأدوار | حسابات الموظفين والصلاحيات والفروع |

لحذف كل البيانات التجريبية دفعة واحدة شغّل داخل الحاوية: `docker compose exec app npm run seed -- --remove`
(كل سجل تجريبي يحمل علامة «تجريبي» في لوحة التحكم).

---

## 13. الجامعات الشريكة

- صفحة الانضمام العامة: `https://gec-edu.com/for-universities`
- بوابة الجامعات: `https://gec-edu.com/partner/login`
- الطلبات تصل إلى **المالية ← طلبات الشراكة**؛ عند الموافقة تحدد عمولة GEC (نسبة أو مبلغ ثابت) وتُرسل دعوة
  لموظف الجامعة تلقائياً. كل ما ينشره يمر عبر **القبولات ← مراجعة محتوى الشركاء** قبل ظهوره.

---

## 14. النسخ الاحتياطي والمراقبة

1. نسخ ليلي لقاعدة البيانات والملفات المرفوعة (يُحتفظ به 14 يوماً):
   ```bash
   sudo mkdir -p /var/backups/gec && sudo chown $USER /var/backups/gec
   crontab -e
   # أضف السطر:
   30 2 * * * /opt/gec/gec/deploy/backup.sh >> /var/log/gec-backup.log 2>&1
   ```
2. انسخ مجلد النسخ إلى مكان خارج الخادم (Backblaze B2 أو S3 أو Google Drive عبر `rclone`) — نسخة على نفس
   الخادم لا تحمي من فقدانه. فعّل أيضاً اللقطات (Snapshots) الأسبوعية من مزود الخادم.
3. جرّب الاسترجاع مرة على الأقل:
   `gunzip -c db_XXXX.sql.gz | docker compose exec -T db mariadb -u gec -p"$DB_PASSWORD" gec`
4. المراقبة: أضف `https://gec-edu.com/healthz` إلى خدمة مجانية مثل UptimeRobot أو Better Stack لتصلك رسالة عند التوقف.

---

## 15. قائمة التحقق قبل الإطلاق

- [ ] `APP_URL` بعنوان https الصحيح، و `NODE_ENV=production`، و `TRUST_PROXY=true`
- [ ] `SESSION_SECRET` و `APP_KEY` عشوائيان ومحفوظان في مكان آمن
- [ ] الموقع يفتح على https و www تُحوَّل للعنوان الرسمي
- [ ] غيّرت كلمة مرور المدير الأول وفعّلت حسابات الموظفين بأدوارهم
- [ ] البريد: رسالة تجريبية وصلت، SPF و DKIM و DMARC صحيحة، mail-tester ≥ 9
- [ ] نموذج «احجز استشارة» يصل إلى قائمة العملاء المحتملين وتصل رسالة التأكيد
- [ ] تسجيل طالب جديد + تأكيد البريد + الدخول للبوابة
- [ ] (إن وُجد) واتساب: رسالة واردة تظهر في المنصة، ورسالة صادرة تصل
- [ ] (إن وُجد) Stripe: دفعة اختبار بوضع Test ثم التحويل لمفاتيح Live
- [ ] (إن وُجد) Google / Microsoft: الدخول يعمل من صفحة الدخول
- [ ] Search Console و Bing: تم التحقق وإرسال sitemap.xml
- [ ] الموقع ← فحص SEO: لا توجد بنود «أصلحه الآن»
- [ ] البيانات التجريبية محذوفة أو مراجعة
- [ ] النسخ الاحتياطي الليلي يعمل ونسخة خارج الخادم، ومراقبة `/healthz` مفعّلة
- [ ] صفحة الخصوصية وملفات تعريف الارتباط مراجعة قانونياً لبلد عملك

---

## 16. أين أضبط ماذا؟ (مرجع سريع)

| أريد أن… | المكان |
| --- | --- |
| أغيّر الشعار والألوان | الإعدادات ← الهوية البصرية |
| أغيّر نصوص وأقسام الصفحة الرئيسية | الموقع ← الصفحة الرئيسية |
| أضيف شريحة في السلايدر | الموقع ← شرائح الرئيسية |
| أنشئ صفحة جديدة بتصميم | الموقع ← الصفحات ← صفحة جديدة ← منشئ الصفحة |
| أغيّر قائمة الموقع العلوية والسفلية | الموقع ← القوائم |
| أرفع صوراً | الموقع ← مكتبة الوسائط |
| أعدّل صورة جامعة أو شعارها | القبولات ← الجامعات ← الجامعة (أو تعدّلها الجامعة من بوابتها) |
| أرسل حملة بريد/واتساب | التواصل ← الحملات |
| أرى مشتركي النشرة | التواصل ← مشتركو النشرة |
| أنشئ رابط إعلان متتبَّع | التواصل ← منشئ الروابط (UTM) |
| أرى أداء الموقع والحملات | التحليلات |
| أدير الجامعات الشريكة | المالية ← طلبات الشراكة / حسابات الشركاء |
| أراجع محتوى الجامعات | القبولات ← مراجعة محتوى الشركاء |
| أضبط SEO والذكاء الاصطناعي | الإعدادات ← SEO والبحث الذكي / الموقع ← فحص SEO |

// Seed content: the help center's first how-to guides for clinic staff (help_articles) and the marketing texts of the
// country pages for JO, SA, AE and KW (platform_settings "country_pages").
// Both only fill what is missing: an article whose slug exists is left alone, and a country page field the admin has
// already written is never overwritten (on/off, rate and currency are never touched).
// The help center is public (/help/<slug>), read before signing in too: menu paths are written in bold
// (Workspace → Page) rather than as links into the app.

const ARTICLES = [
  // ---------------------------------------------------------------- start
  {
    slug: 'create-clinic-account',
    category: 'start',
    sort: 10,
    title_ar: 'إنشاء حساب العيادة ومعالج الإعداد',
    title_en: 'Create your clinic account and complete the setup wizard',
    body_ar: `# إنشاء حساب العيادة
افتح صفحة التسجيل واضغط **أنشئ حساب عيادة**، ثم املأ قسمَي **حساب المالك** و**عيادتك**:
- الاسم الكامل والبريد الإلكتروني وكلمة المرور (8 أحرف على الأقل).
- نوع الحساب: **عيادة مستقلة**، أو **مركز طبي (عدة أطباء)** إذا كان لكل طبيب عيادة بحساب منفصل يشترك مع غيره في الاستقبال والمحاسبة.
- اسم العيادة والتخصص والمدينة والمنطقة الزمنية.
وافق على الشروط واضغط **إنشاء حساب العيادة**.

## معالج الإعداد
بعد التسجيل يبدأ معالج قصير، تُحفظ كل خطوة فيه وحدها:
- **بيانات عيادتك**: الاسم وأرقام التواصل والعنوان والشعار والعملة.
- **أيام وأوقات الدوام**: الأسبوع المعتاد للعيادة.
- **أضف الأطباء**: الاسم وسعر الكشفية ومدة الموعد تكفي للبدء. إن كنت أنت الطبيب فاختر **أنا الطبيب**.
- **الخدمات والأسعار**: اختر الخدمات التي تقدّمها واكتب أسعارها.
- **حسابات الموظفين**: حساب دخول لكل موظف.
- **صفحة الحجز الإلكتروني**: عنوان صفحتك وتفعيل الحجز.
اضغط **حفظ ومتابعة** للانتقال، أو **تخطَّ الآن** لإكمال الخطوة لاحقًا.`,
    body_en: `# Create your clinic account
Open the sign-up page and click **Create a clinic account**, then fill in **Owner account** and **Your clinic**:
- Your full name, e-mail and password (at least 8 characters).
- Account type: **Independent clinic**, or **Medical centre (several doctors)** when each doctor has a separate clinic account sharing reception and cash.
- Clinic name, specialty, city and time zone.
Accept the terms and click **Create clinic account**.

## The setup wizard
A short wizard follows; each step is saved on its own:
- **Your clinic details**: name, contact numbers, address, logo and currency.
- **Working days and hours**: the clinic's usual week.
- **Add your doctors**: name, fee and appointment length are enough to start. If you are the doctor, choose **I am the doctor**.
- **Services and prices**: tick the services you offer and type your prices.
- **Logins for your staff**: one login per person.
- **Online booking page**: your page address and online booking on/off.
Click **Save and continue** to move on, or **Skip for now** to finish a step later.`,
  },
  {
    slug: 'add-doctors',
    category: 'start',
    sort: 20,
    title_ar: 'إضافة الأطباء وساعات دوامهم',
    title_en: 'Add doctors and their working hours',
    body_ar: `# إضافة طبيب
من القائمة الجانبية افتح **العيادة ← الأطباء** واضغط **إضافة طبيب**.
- **الملف الشخصي**: الاسم بالعربية والإنجليزية، والتخصص، والصورة، والنبذة.
- **الحجز والأجر**: أجرة الكشفية ومدة الموعد (وهي أيضًا الفاصل بين أوقات بدء الحجز).
- فعّل **يقبل الحجز أونلاين من الموقع** و**يظهر في الموقع الإلكتروني** إذا أردت أن يحجز المرضى معه إلكترونيًا.

## ساعات الدوام
في **الجدول الأسبوعي** اختر أحد الخيارين:
- **يتبع دوام العيادة**: يتغيّر دوام الطبيب تلقائيًا عند تغيير دوام العيادة من **العيادة ← دوام العيادة**.
- **دوام خاص بالطبيب**: حتى فترتين يوميًا واستراحة واحدة، وألغِ تحديد اليوم لجعله إجازة.

## الإجازات
افتح صفحة الطبيب وأضف أيام الإجازة في قسم **الإجازات**، فلا تُعرض هذه الأيام للحجز.

**ملاحظة:** الحجز الإلكتروني يعتمد على هذه الجداول، لذا تأكد من ضبطها قبل نشر رابط الحجز.`,
    body_en: `# Add a doctor
In the sidebar open **Clinic → Doctors** and click **Add doctor**.
- **Profile**: name in Arabic and English, specialty, photo and bio.
- **Booking & pay**: consultation fee and appointment length (also the step between bookable start times).
- Tick **Takes online bookings** and **Shown on the website** if patients should book this doctor online.

## Working hours
Under **Weekly schedule** choose one:
- **Follows the clinic's hours**: the doctor's hours change when you change **Clinic → Working hours**.
- **Doctor's own hours**: up to two shifts per day and one break; untick a day to mark it off.

## Days off
Open the doctor's page and add dates under **Days off & leave**; those days are not offered for booking.

**Note:** online booking uses these schedules, so set them before you share your booking link.`,
  },
  {
    slug: 'services-and-prices',
    category: 'start',
    sort: 30,
    title_ar: 'الخدمات والأسعار',
    title_en: 'Services and prices',
    body_ar: `# الخدمات والأسعار
الخدمات هي ما يستطيع المرضى حجزه. افتح **العيادة ← الخدمات** واضغط **إضافة خدمة**:
- الاسم بالعربية والإنجليزية.
- **السعر**: اتركه فارغًا إذا كان السعر حسب الحالة.
- **المدة**: يعتمد عليها الحجز لإيجاد الأوقات المتاحة. اتركها فارغة لخدمة بدون وقت محدد.
- **الطبيب**: الخدمة بلا طبيب محدد يقدّمها جميع الأطباء.
- **تظهر على موقع العيادة وصفحة الحجز** و**إظهار السعر في صفحة العيادة** حسب رغبتك.

## الخدمات الرئيسية
لتجميع الخدمات الفرعية تحت عنوان واحد (مثل «تقويم الأسنان») أضف **خدمة رئيسية** من لوحة **الخدمات الرئيسية**.

**مهم:** السعر هنا للعرض على الموقع وكسعر مقترح فقط؛ أما الفاتورة فتُحسب من الخدمات التي يدخلها الطبيب في الزيارة.`,
    body_en: `# Services and prices
Services are what patients can book. Open **Clinic → Services** and click **Add service**:
- Name in Arabic and English.
- **Price**: leave empty when the price depends on the case.
- **Duration**: bookings use it to find free slots. Leave empty for a service with no fixed time.
- **Doctor**: a service without a doctor is offered by every doctor.
- **Shown on the clinic website and booking page** and **Show the price on the clinic page**, as you prefer.

## Main services
To group sub-services under one heading (e.g. "Orthodontics"), add a **main service** in the **Main services** panel.

**Important:** the price here is shown on the website and suggested only; the bill comes from the services the doctor enters in the visit.`,
  },
  // ---------------------------------------------------------------- team
  {
    slug: 'team-and-permissions',
    category: 'team',
    sort: 10,
    title_ar: 'الفريق والأدوار والصلاحيات',
    title_en: 'Team, roles and permissions',
    body_ar: `# حسابات الموظفين
لكل موظف حسابه الخاص، ولا يرى إلا ما يسمح به دوره. افتح **العيادة ← الفريق** واضغط **إضافة حساب موظف**:
- الاسم والبريد الإلكتروني والدور: مدير العيادة، طبيب، ممرض/ة، موظف استقبال، محاسب.
- حساب دور **طبيب** يُربط بـ**ملف الطبيب** فيرى مواعيد هذا الطبيب ومرضاه.
- طريقة الدخول: **كلمة مرور مؤقتة** تسلّمها للموظف ويغيّرها عند أول دخول، أو **رابط دعوة** صالح 7 أيام.

## الأدوار والصلاحيات
في تبويب **الأدوار والصلاحيات** ترى **مصفوفة الصلاحيات** لكل دور. الأدوار الجاهزة تناسب معظم العيادات، ويمكنك إنشاء **دور جديد** عندما يحتاج أحدهم مزيجًا مختلفًا من الصلاحيات. المالك يملك جميع الصلاحيات دائمًا.

## صلاحية الصفحات لموظف واحد
من قائمة الأعضاء اضغط أيقونة **صلاحية الصفحات** بجانب الموظف لإضافة صفحات إلى دوره أو حجبها عنه.

## إيقاف حساب
الحساب المعطّل لا يستطيع تسجيل الدخول، ويبقى سجله في العيادة. أما **إزالة من العيادة** فتوقف دخوله فورًا مع بقاء مواعيده وملاحظاته السابقة.`,
    body_en: `# Staff logins
Each person gets their own login and sees only what their role allows. Open **Clinic → Team** and click **Add staff login**:
- Name, e-mail and role: Clinic manager, Doctor, Nurse, Receptionist or Accountant.
- A **Doctor** login is linked to a **Doctor profile** and sees that doctor's own schedule and patients.
- Access: a **Temporary password** you hand over (changed at first sign-in), or an **Invitation link** valid for 7 days.

## Roles & permissions
The **Roles & permissions** tab shows the **Permission matrix** for every role. Built-in roles cover most clinics; create a **New role** when someone needs a different mix of access. Owners always have every permission.

## Page access for one member
In the members list, click the **Page access** icon next to a person to add pages to their role or hide pages from them.

## Disabling a login
A disabled login can't sign in; their history stays in the clinic. **Remove from clinic** ends access immediately, while past appointments and notes stay.`,
  },
  // ---------------------------------------------------------------- booking
  {
    slug: 'appointments-calendar',
    category: 'booking',
    sort: 10,
    title_ar: 'المواعيد والتقويم',
    title_en: 'Appointments and the calendar',
    body_ar: `# حجز موعد
افتح **المواعيد** من القائمة الجانبية، أو اضغط **جديد ← حجز موعد** من أعلى الشاشة.
- اختر الطبيب والوقت المتاح ثم المريض: ابحث عن **مريض مسجّل** بالاسم أو الهاتف، أو أدخل بيانات مريض جديد.
- إذا كان رقم الهاتف لمريض مسجّل في العيادة يُضاف الموعد إلى ملفه.
- اختر الخدمة إن وُجدت، ثم اضغط **احجز الموعد**.

## طرق العرض
بدّل بين **يومي** و**أسبوع** و**شهر** و**قائمة**. في التقويم اسحب على وقت فارغ لحجز موعد أو **حجب وقت** (اجتماع، وقت خاص)، واسحب الموعد لنقله.

## حالات الموعد
- **بانتظار التأكيد**: حجوزات إلكترونية تنتظر تأكيد العيادة، اضغط **تأكيد الموعد**.
- **مؤكد**، **مكتمل**، **ملغى**، **لم يحضر**.
استخدم **إلغاء الموعد** للاحتفاظ بسجلّه، فالحذف يزيل الحجز نهائيًا.`,
    body_en: `# Book an appointment
Open **Appointments** in the sidebar, or use **New → Book an appointment** at the top of the screen.
- Pick the doctor and a free time, then the patient: search for an **Existing patient** by name or phone, or type a new patient's details.
- If the phone number already belongs to a patient of this clinic, the booking is added to their file.
- Choose a service if there is one, then click **Book appointment**.

## Views
Switch between **Day**, **Week**, **Month** and **List**. On the calendar, drag across free time to book it or **Block time** (meeting, personal time), and drag an appointment to move it.

## Appointment statuses
- **Pending**: online bookings waiting for the clinic — click **Confirm appointment**.
- **Confirmed**, **Completed**, **Cancelled**, **No-show**.
Use **Cancel appointment** to keep a record; deleting removes the booking completely.`,
  },
  {
    slug: 'online-booking',
    category: 'booking',
    sort: 20,
    title_ar: 'صفحة الحجز الإلكتروني',
    title_en: 'The online booking page',
    body_ar: `# تفعيل الحجز الإلكتروني
افتح **الموقع الإلكتروني ← الحجز** واضغط **تفعيل الحجز الإلكتروني**. قبل ذلك تأكد من:
- وجود أطباء نشطين لديهم ساعات عمل، وخدمات نشطة.
- تحديد **عنوان صفحة العيادة** من **الموقع الإلكتروني ← العنوان والنشر** (من 3 إلى 40 حرفًا إنجليزيًا أو رقمًا أو شرطة).

## أي الأطباء يظهرون؟
يظهر الطبيب في الحجز عندما يكون مفعّلًا في ملفه: **يقبل الحجز أونلاين من الموقع** و**يظهر في الموقع الإلكتروني** (من **العيادة ← الأطباء**).

## طريقة الحجز
في **طريقة الحجز** اختر أن يختار المريض الطبيب بنفسه، أو **الحجز مع العيادة بس**: يختار المريض الوقت فقط، ثم يختار الاستقبال الطبيب ويؤكد الموعد.

## مشاركة الرابط
- انسخ رابط صفحتك من **العنوان والنشر** وشاركه على واتساب وإنستغرام وخرائط Google.
- من **الروابط ورمز QR** تحصل على روابط حجز قابلة للتتبع ورمز QR وزر حجز لموقعك.
تظهر الحجوزات الجديدة في **المواعيد** بحالة **بانتظار التأكيد** مع تنبيه للاستقبال.`,
    body_en: `# Turn on online booking
Open **Website → Booking** and click **Turn on online booking**. First make sure that:
- You have active doctors with working hours, and active services.
- Your **Clinic page address** is set in **Website → Address & publishing** (3–40 English letters, numbers or dashes).

## Which doctors appear?
A doctor appears in booking when their profile (**Clinic → Doctors**) has **Takes online bookings** and **Shown on the website** ticked.

## How patients book
Under **How patients book**, let patients choose the doctor, or pick **Book with the clinic only**: the patient picks a time only, and reception chooses the doctor and confirms.

## Share the link
- Copy your page address from **Address & publishing** and share it on WhatsApp, Instagram and Google Maps.
- **Links & QR code** gives you tracked booking links, a QR code and a booking button for your own website.
New bookings appear in **Appointments** as **Pending** and notify the front desk.`,
  },
  {
    slug: 'front-desk-check-in',
    category: 'booking',
    sort: 30,
    title_ar: 'الاستقبال وتسجيل الوصول وقائمة الانتظار',
    title_en: 'Front desk: check-in and the waiting list',
    body_ar: `# شاشة الاستقبال
افتح **الاستقبال** من القائمة الجانبية. يظهر مرضى اليوم حسب المرحلة، وتتحدّث الشاشة تلقائيًا:
- **متوقَّع** ← **وصل** ← **عند الطبيب** ← **للدفع** ← **مدفوع**.

## خطوات العمل
- عند وصول المريض اضغط **تسجيل الوصول**، فينتقل إلى قائمة الانتظار.
- يمكن للتمريض أو الاستقبال إدخال **العلامات الحيوية**، ويراها الطبيب أعلى صفحة الزيارة.
- عندما يحين دوره اضغط **إدخال إلى الطبيب**.
- بعد انتهاء الزيارة يظهر المريض في عمود **للدفع**، ومنه تنتقل إلى **شاشة الصندوق**.

## مريض بدون موعد
اضغط **مريض جديد الآن**، واكتب الاسم والهاتف، ثم **إضافة وتسجيل الوصول**: يأخذ المريض أقرب وقت فارغ لدى الطبيب اليوم.

## عدم الحضور
علّم المريض بـ**لم يحضر** عند الحاجة، ويمكن **استعادة** الموعد من قائمة «لم يحضروا والمواعيد الملغاة».`,
    body_en: `# The front desk screen
Open **Front desk** in the sidebar. Today's patients are shown by step, and the screen updates by itself:
- **Expected** → **Arrived** → **With the doctor** → **To pay** → **Paid**.

## Day-to-day steps
- When a patient arrives, click **Check in**; they join the waiting list.
- Nurses or reception can enter **Vital signs**; the doctor sees them at the top of the visit.
- When it is their turn, click **Send in to doctor**.
- After the visit the patient moves to **To pay**, and from there you go to the **Cash screen**.

## Walk-in patients
Click **New patient now**, type the name and phone, then **Add and check in**: the patient gets the doctor's next free time today.

## No-shows
Mark a patient as **No-show** when needed; you can **Restore** them from "No-shows & cancellations".`,
  },
  {
    slug: 'appointment-reminders',
    category: 'booking',
    sort: 40,
    title_ar: 'تذكير المرضى بالمواعيد عبر واتساب والرسائل النصية والبريد',
    title_en: 'Appointment reminders by WhatsApp, SMS and e-mail',
    body_ar: `# الرسائل والتذكيرات
افتح **الإعدادات ← الرسائل والتذكيرات**. تُرسل الرسائل عبر واتساب أولًا، وتُستخدم الرسائل النصية إن لم يكن واتساب مُعدًّا أو فشل الإرسال، ويُضاف البريد الإلكتروني عندما يكون للمريض عنوان.

## إعداد القنوات
- **واتساب للأعمال (Cloud API)**: أدخل **معرّف رقم الهاتف** و**رمز الوصول** من تطبيقك في Meta for Developers، وأسماء **قوالب الرسائل المعتمدة**.
- **مزوّد الرسائل النصية**: أي مزوّد يوفّر واجهة HTTP.
- اضبط **رمز الدولة للأرقام المحلية** ثم جرّب الإعداد عبر **إرسال تجريبي**.

## ما الذي يُرسل؟
- **تأكيد الحجز** فور الحجز، مع رابط للتأكيد أو التغيير أو الإلغاء.
- **التذكير قبل الموعد**: **التذكير الأول** و**التذكير الثاني** بعدد الساعات الذي تحدده.
- **إشعار الإلغاء** و**طلب التقييم بعد الزيارة**.
يمكنك تعديل النصوص من **نصوص الرسائل**، ومتابعة الإرسال في **سجل الرسائل**.

**قبل الإعداد:** يستطيع الموظفون فتح رسالة واتساب جاهزة برابط المريض من صفحة الموعد ومن الاستقبال (زر «واتساب»).`,
    body_en: `# Messages & reminders
Open **Settings → Messages & reminders**. Messages go by WhatsApp first; SMS is used when WhatsApp is not set up or fails; e-mail is added when the patient has an address.

## Set up the channels
- **WhatsApp Business (Cloud API)**: enter the **Phone number ID** and **Access token** from your app in Meta for Developers, and your **Approved message templates**.
- **SMS provider**: any provider with an HTTP API.
- Set the **Country code for local numbers**, then check everything with **Send test**.

## What is sent
- **Booking confirmation** right after a booking, with a link to confirm, change or cancel.
- **Reminders before the appointment**: a **First reminder** and a **Second reminder**, the number of hours you choose.
- **Cancellation notice** and **Review request after the visit**.
Edit the wording in **Message texts** and follow delivery in the **Message log**.

**Until it is set up:** staff can open a ready-made WhatsApp message with the patient's link from the appointment page and the front desk ("WhatsApp" button).`,
  },
  // ---------------------------------------------------------------- patients
  {
    slug: 'patient-records',
    category: 'patients',
    sort: 10,
    title_ar: 'ملف المريض: الزيارات والوصفات والملفات',
    title_en: 'Patient records: visits, prescriptions and files',
    body_ar: `# ملف المريض
يُضاف المريض تلقائيًا عند حجز موعد له، ويمكنك إضافته يدويًا من **المرضى ← إضافة مريض** (الاسم وحده مطلوب).
ابحث بالاسم أو الهاتف أو الرقم الوطني أو رقم التأمين، ثم افتح الملف لترى تبويباته:
- **نظرة عامة**: البيانات والحساسية والأمراض المزمنة والموعد القادم.
- **السجل الطبي**: الزيارات والتشخيصات.
- **المواعيد** و**الوصفات** و**المستندات** و**الحساب المالي** و**السجل الزمني**.
- **الفحوصات والملفات**: ارفع الأوراق الممسوحة ونتائج التحاليل والأشعة لتُحفظ مع المريض.

## الزيارة والوصفة
يفتح الطبيب الزيارة من **يومي** أو من الموعد، ويكتب **التشخيص** وملاحظاته، ثم يضيف الأدوية بالجرعة والتكرار والمدة ويضغط **حفظ الوصفة**.

## الخصوصية والتصدير
الملاحظات السريرية والوصفات متاحة للطاقم الطبي فقط. ويمكن **تصدير الملف كاملاً** في ملف ZIP عند الحاجة.`,
    body_en: `# The patient file
Patients are added automatically when you book them, or by hand from **Patients → Add patient** (only the name is required).
Search by name, phone, national ID or insurance number, then open the file to see its tabs:
- **Overview**: details, allergies, chronic conditions and the next appointment.
- **Clinical**: visits and diagnoses.
- **Appointments**, **Prescriptions**, **Documents**, **Billing** and **Timeline**.
- **Tests & files**: upload scanned papers, lab and imaging results to keep them with the patient.

## The visit and the prescription
The doctor opens the visit from **My day** or from the appointment, writes the **Diagnosis** and notes, adds medications with dose, frequency and duration, and clicks **Save prescription**.

## Privacy and export
Clinical notes and prescriptions are visible to clinical staff only. You can **Export the whole file** as a ZIP when needed.`,
  },
  // ---------------------------------------------------------------- billing
  {
    slug: 'cashier-payments',
    category: 'billing',
    sort: 10,
    title_ar: 'الصندوق وتحصيل المدفوعات',
    title_en: 'The cashier: collecting payments',
    body_ar: `# محاسبة المرضى
افتح **المالية ← الصندوق** (أو **الصندوق** لمن تقتصر صلاحياته على التحصيل). تظهر في **بانتظار الدفع** الزيارات غير المدفوعة، ويمكنك البحث عن أي زيارة غير مدفوعة خلال آخر 30 يومًا بالاسم أو الهاتف.

## تحصيل دفعة
- اختر المريض، وراجع البنود، وأضف **خدمة** أو **بند آخر** عند الحاجة.
- اختر **طريقة الدفع**: نقدًا، بطاقة، نقدًا + بطاقة، تأمين، تحويل بنكي / كليك، أو محفظة إلكترونية.
- اضغط **تأكيد الدفع**، ثم اطبع الإيصال.

## شاشة الصندوق
اضغط **فتح شاشة الصندوق** للعمل بملء الشاشة: تظهر الزيارات فور انتهاء الطبيب منها، ويمكنك تحديد أكثر من موعد ودفعها معًا مع الخصم أو حصة التأمين.

## الإقفال اليومي
من تبويب **الإقفال اليومي** قارن **النقد المتوقع** بـ**النقد المعدود** في الدرج، واطبع ورقة الإقفال.`,
    body_en: `# Patient billing
Open **Finance → Cash screen** (shown as **Cashier** for logins limited to collecting). **Waiting to pay** lists unpaid visits, and you can search any unpaid visit of the last 30 days by name or phone.

## Collect a payment
- Pick the patient, check the lines, and **Add a service** or an **Other item** if needed.
- Choose the **Payment method**: cash, card, cash + card, insurance, bank transfer / CliQ or digital wallet.
- Click **Confirm payment**, then print the receipt.

## The cash screen
Click **Open cash screen** to work full screen: visits appear as soon as the doctor finishes them, and you can select several appointments and pay them together, with a discount or the insurer's share.

## Daily closing
In the **Closings** tab, compare **Expected cash** with the **Counted cash** in the drawer and print the closing slip.`,
  },
  {
    slug: 'subscription-and-payment',
    category: 'billing',
    sort: 20,
    title_ar: 'الاشتراك والفواتير والدفع',
    title_en: 'Subscription, invoices and payment',
    body_ar: `# صفحة الاشتراك
افتح **الإعدادات ← الاشتراك** لترى **الباقة الحالية** والفترة التجريبية و**الاستخدام** مقارنةً بحدود باقتك، و**الفواتير والمدفوعات**.

## اختيار باقة
في **اختر باقة** حدّد الباقة والفوترة (شهريًا أو سنويًا) وعدد الفروع، ثم اضغط **المتابعة إلى الدفع**. تصدر فاتورة، ولا يُخصم أي مبلغ تلقائيًا، وتبدأ الباقة الجديدة بعد انتهاء الفترة المدفوعة الحالية أو التجربة.

## طرق الدفع
- **بالبطاقة**: إن كان الدفع الإلكتروني متاحًا يظهر زر **ادفع بالبطاقة** في الفاتورة.
- **تحويل بنكي** أو **كليك CliQ** أو **محفظة إلكترونية**: حوّل المبلغ إلى البيانات الظاهرة في الفاتورة، واكتب رقم الفاتورة في ملاحظات التحويل.

## الإبلاغ عن الدفع
بعد التحويل اكتب **المرجع** (رقم مرجع التحويل أو كليك، أو رقم الإيصال) واضغط **إرسال إشعار الدفع**. تظهر الفاتورة بحالة **بانتظار التأكيد** حتى نؤكد الدفع ونمدّد اشتراكك.

**ملاحظة:** سجلات مرضاك ملك لك دائمًا؛ حتى دون اشتراك فعّال يمكنك فتحها وتصديرها.`,
    body_en: `# The subscription page
Open **Settings → Subscription** to see your **Current plan**, your trial, **Usage** compared with your plan's limits, and **Invoices and payments**.

## Choose a plan
Under **Choose a plan**, pick the plan, the billing cycle (monthly or yearly) and the number of branches, then click **Continue to payment**. An invoice is issued; nothing is charged automatically. The new plan starts after the current paid period or trial.

## How to pay
- **By card**: when online payment is available, the invoice shows a **Pay by card** button.
- **Bank transfer**, **CliQ** or **E-wallet**: transfer the amount to the details shown on the invoice and write the invoice number in the transfer notes.

## Report your payment
After the transfer, enter the **Reference** (the transfer or CliQ reference, or the receipt number) and click **Send payment notice**. The invoice shows **Payment reported — waiting for confirmation** until we confirm it and extend your subscription.

**Note:** your patients' records always stay yours: even without an active subscription you can open and export them.`,
  },
  // ---------------------------------------------------------------- website
  {
    slug: 'clinic-website',
    category: 'website',
    sort: 10,
    title_ar: 'بناء موقع العيادة الإلكتروني',
    title_en: 'Build your clinic website',
    body_ar: `# موقع العيادة
افتح **الموقع الإلكتروني** من القائمة الجانبية. في **نظرة عامة** ترى حالة الموقع و**جاهزية الموقع**. إلى أن تنشر موقعك يرى المرضى صفحة العيادة الأساسية.

## التصميم
من **التصميم والهوية** اختر **قالبًا** يناسب تخصصك، ثم الألوان والخط والشعار. القالب والتصميم يغيّران الشكل فقط، والمحتوى يبقى كما هو.

## المحرّر
- افتح **المحرّر**، واضغط على أي قسم في المعاينة أو في القائمة لتعديله، ثم **حفظ القسم**.
- أضف أقسامًا جديدة من تبويب **إضافة**، وأضف صفحات من **الصفحات** (مثل «من نحن»).
- تُحفظ التعديلات في **المسودة** ولا يراها المرضى قبل النشر.

## النشر
اضغط **معاينة** للتأكد، ثم **نشر**. ويمكنك من **العنوان والنشر** إيقاف الموقع أو استعادة نسخة سابقة. إيقاف الموقع لا يوقف الحجز، إذ تبقى صفحة مختصرة بزر الحجز.

بيانات الأطباء والخدمات والأسعار تأتي من صفحات **العيادة**، فلا حاجة لإدخالها مرتين.`,
    body_en: `# Your clinic website
Open **Website** in the sidebar. **Overview** shows the site's status and **Website readiness**. Until you publish, patients see the standard clinic page.

## The look
In **Theme & brand**, pick a **Template** suited to your specialty, then colours, font and logo. Template and theme change the look only; the content stays.

## The builder
- Open **Builder** and click any section in the preview or the list to edit it, then **Save section**.
- Add sections from the **Add** tab, and pages from **Pages** (e.g. "About us").
- Changes are saved to the **draft**; patients don't see them until you publish.

## Publishing
Click **Preview** to check, then **Publish**. In **Address & publishing** you can take the site down or restore an earlier version. Taking the site down does not stop booking: a short page with the booking button stays up.

Doctors, services and prices come from the **Clinic** pages, so you never type them twice.`,
  },
  // ---------------------------------------------------------------- other
  {
    slug: 'invite-a-clinic',
    category: 'other',
    sort: 10,
    title_ar: 'ادعُ عيادة واحصل على شهر مجاني',
    title_en: 'Invite a clinic and get a free month',
    body_ar: `# رابط الدعوة
لكل عيادة رابط دعوة خاص بها في **الإعدادات ← الاشتراك**، ضمن قسم **ادعُ عيادة واحصل على شهر مجاني**.
- انسخ الرابط وأرسله إلى زملائك، أو اضغط **مشاركة عبر واتساب**.
- عندما تسجّل عيادة من خلال رابطك وتدفع أول اشتراك لها، تحصل عيادتك على **شهر مجاني**.
- يُضاف الشهر إلى فترة اشتراكك الحالية، أو إلى فترتك التجريبية.
- تُحتسب مكافأة واحدة لكل عيادة جديدة.

## متابعة الدعوات
في القسم نفسه ترى عدد العيادات التي سجّلت عبر رابطك وعدد الأشهر المجانية التي اكتسبتها.`,
    body_en: `# Your invitation link
Every clinic has its own invitation link in **Settings → Subscription**, under **Invite a clinic, get a free month**.
- Copy the link and send it to colleagues, or click **Share on WhatsApp**.
- When a clinic signs up through your link and pays its first subscription, your clinic gets **one month free**.
- The month is added to your current subscription period, or to your trial.
- One reward is counted per new clinic.

## Track your invitations
The same section shows how many clinics signed up through your link and how many free months you have earned.`,
  },
];

// ---------------------------------------------------------------- country pages
const COUNTRY_TEXTS = {
  JO: {
    title_ar: 'نظام إدارة العيادات والمراكز الطبية في الأردن',
    title_en: 'Clinic and medical centre management in Jordan',
    lead_ar: 'المواعيد والحجز الإلكتروني وتذكيرات واتساب والملف الطبي والصندوق وموقع عيادتك، بالعربية والإنجليزية وبالدينار الأردني.',
    lead_en: 'Appointments, online booking, WhatsApp reminders, patient records, the cash desk and your clinic website — in Arabic and English, priced in Jordanian dinars.',
    body_ar: `# كل ما تحتاجه عيادتك في الأردن
- واجهة كاملة بالعربية والإنجليزية للطاقم والمرضى.
- صفحة حجز إلكتروني خاصة بعيادتك تشاركها على واتساب وخرائط Google.
- تذكيرات المواعيد عبر واتساب والرسائل النصية والبريد الإلكتروني لتقليل عدم الحضور.
- الاستقبال وقائمة الانتظار، والصندوق بالنقد والبطاقة والتحويل وكليك.
- ملف طبي لكل مريض: الزيارات والتشخيصات والوصفات والتحاليل والأشعة.
- موقع إلكتروني لعيادتك بقوالب حسب التخصص.
- المراكز الطبية متعددة العيادات: استقبال ومحاسبة مشتركة، ولكل طبيب عيادته وحسابه.
- سوق مستودعات الأدوية والمناديب في الأردن: العروض وزيارات المناديب في مكان واحد.`,
    body_en: `# Everything your clinic in Jordan needs
- A full Arabic and English interface for staff and patients.
- Your own online booking page to share on WhatsApp and Google Maps.
- Appointment reminders by WhatsApp, SMS and e-mail to cut no-shows.
- Front desk and waiting list, and a cash desk for cash, card, transfer and CliQ.
- A medical record for every patient: visits, diagnoses, prescriptions, lab and imaging.
- A website for your clinic, with templates by specialty.
- Multi-clinic medical centres: shared reception and cash, each doctor with their own practice and account.
- A marketplace for Jordan's drug warehouses and medical reps: offers and rep visits in one place.`,
  },
  SA: {
    title_ar: 'نظام إدارة العيادات والمجمعات الطبية في السعودية',
    title_en: 'Clinic and medical complex management in Saudi Arabia',
    lead_ar: 'نظّم المواعيد والحجز الإلكتروني وتذكيرات واتساب والملفات الطبية والفوترة وموقع عيادتك، بالعربية والإنجليزية وبالريال السعودي.',
    lead_en: 'Run appointments, online booking, WhatsApp reminders, patient records, billing and your clinic website — in Arabic and English, priced in Saudi riyals.',
    body_ar: `# مصمَّم لعيادات المملكة
- واجهة عربية كاملة مع الإنجليزية للأطباء والطاقم متعدد الجنسيات.
- حجز إلكتروني على مدار الساعة من صفحة عيادتك أو موقعها.
- تذكيرات واتساب قبل الموعد مع رابط للتأكيد أو التغيير أو الإلغاء.
- الاستقبال وتسجيل الوصول وقائمة الانتظار، والصندوق مع حصة التأمين.
- ملف طبي شامل: الزيارات والوصفات والتحاليل والأشعة والمستندات.
- موقع احترافي لعيادتك تنشره بنفسك.
- المجمعات الطبية متعددة العيادات: استقبال مشترك وشاشة انتظار ومحاسبة مشتركة.
- سوق مستودعات الأدوية والمناديب في السعودية: عروض الموردين وطلبات الزيارة.`,
    body_en: `# Built for clinics in the Kingdom
- A full Arabic interface, with English for doctors and multinational staff.
- Round-the-clock online booking from your clinic page or website.
- WhatsApp reminders before each appointment, with a link to confirm, change or cancel.
- Front desk check-in and waiting list, and a cash desk that handles the insurer's share.
- A complete medical record: visits, prescriptions, lab, imaging and documents.
- A professional website for your clinic that you publish yourself.
- Multi-clinic medical complexes: shared reception, waiting screen and cash.
- A marketplace for Saudi drug warehouses and medical reps: supplier offers and visit requests.`,
  },
  AE: {
    title_ar: 'نظام إدارة العيادات والمراكز الطبية في الإمارات',
    title_en: 'Clinic and medical centre management in the UAE',
    lead_ar: 'الحجز الإلكتروني وتذكيرات واتساب والملفات الطبية والصندوق وموقع عيادتك في نظام واحد، بالعربية والإنجليزية وبالدرهم الإماراتي.',
    lead_en: 'Online booking, WhatsApp reminders, patient records, the cash desk and your clinic website in one system — Arabic and English, priced in UAE dirhams.',
    body_ar: `# نظام واحد لعيادتك في الإمارات
- العربية والإنجليزية في كل شاشة، للمرضى والطاقم معًا.
- حجز إلكتروني مع أطبائك وخدماتك وأوقاتك المتاحة.
- تذكيرات تلقائية عبر واتساب والرسائل النصية والبريد الإلكتروني.
- استقبال سريع وقائمة انتظار، وصندوق بالنقد والبطاقة والتأمين.
- ملف طبي لكل مريض مع الوصفات ونتائج التحاليل والأشعة.
- موقع إلكتروني لعيادتك بتصميم يناسب تخصصك.
- المراكز الطبية متعددة العيادات والفروع: استقبال ومحاسبة مشتركة.
- سوق مستودعات الأدوية والمناديب في الإمارات: العروض وزيارات المناديب.`,
    body_en: `# One system for your clinic in the UAE
- Arabic and English on every screen, for patients and staff alike.
- Online booking with your doctors, services and free times.
- Automatic reminders by WhatsApp, SMS and e-mail.
- Fast front desk and waiting list, and a cash desk for cash, card and insurance.
- A medical record for every patient, with prescriptions, lab and imaging results.
- A clinic website with a design that fits your specialty.
- Multi-clinic medical centres and branches: shared reception and cash.
- A marketplace for UAE drug warehouses and medical reps: offers and rep visits.`,
  },
  KW: {
    title_ar: 'نظام إدارة العيادات والمراكز الطبية في الكويت',
    title_en: 'Clinic and medical centre management in Kuwait',
    lead_ar: 'المواعيد والحجز الإلكتروني وتذكيرات واتساب والملف الطبي والصندوق وموقع عيادتك، بالعربية والإنجليزية وبالدينار الكويتي.',
    lead_en: 'Appointments, online booking, WhatsApp reminders, patient records, the cash desk and your clinic website — in Arabic and English, priced in Kuwaiti dinars.',
    body_ar: `# أدِر عيادتك في الكويت بسهولة
- واجهة بالعربية والإنجليزية للطاقم والمرضى.
- صفحة حجز إلكتروني لعيادتك ورابط تشاركه على واتساب وإنستغرام.
- تذكيرات المواعيد عبر واتساب لتقليل المواعيد الضائعة.
- الاستقبال وقائمة الانتظار، والصندوق والإقفال اليومي.
- ملف طبي منظم: الزيارات والتشخيصات والوصفات والملفات المرفقة.
- موقع إلكتروني لعيادتك تنشره من داخل النظام.
- المراكز الطبية متعددة العيادات: لكل طبيب عيادته، مع استقبال مشترك.
- سوق مستودعات الأدوية والمناديب في الكويت: العروض وزيارات المناديب.`,
    body_en: `# Run your clinic in Kuwait with ease
- An Arabic and English interface for staff and patients.
- An online booking page for your clinic, with a link to share on WhatsApp and Instagram.
- WhatsApp appointment reminders to cut missed visits.
- Front desk and waiting list, a cash desk and daily closing.
- An organised medical record: visits, diagnoses, prescriptions and attached files.
- A clinic website you publish from inside the system.
- Multi-clinic medical centres: each doctor with their own practice, sharing reception.
- A marketplace for Kuwait's drug warehouses and medical reps: offers and rep visits.`,
  },
};
const TEXT_FIELDS = ['title_ar', 'title_en', 'lead_ar', 'lead_en', 'body_ar', 'body_en'];

exports.up = async (knex) => {
  if (await knex.schema.hasTable('help_articles')) {
    for (const a of ARTICLES) {
      // eslint-disable-next-line no-await-in-loop
      if (!(await knex('help_articles').where({ slug: a.slug }).first('id'))) await knex('help_articles').insert({ ...a, published: true });
    }
  }

  if (!(await knex.schema.hasTable('platform_settings'))) return;
  const row = await knex('platform_settings').where({ key: 'country_pages' }).first('value');
  let cur = {};
  try { cur = JSON.parse((row && row.value) || '{}') || {}; } catch { cur = {}; }
  if (typeof cur !== 'object' || Array.isArray(cur)) cur = {};
  Object.entries(COUNTRY_TEXTS).forEach(([cc, texts]) => {
    const page = cur[cc] && typeof cur[cc] === 'object' ? { ...cur[cc] } : {};
    TEXT_FIELDS.forEach((f) => { if (!String(page[f] ?? '').trim()) page[f] = texts[f]; });
    cur[cc] = page;
  });
  const value = JSON.stringify(cur);
  await knex('platform_settings').insert({ key: 'country_pages', value }).onConflict('key').merge({ value, updated_at: new Date() });
};

exports.down = async (knex) => {
  if (await knex.schema.hasTable('help_articles')) await knex('help_articles').whereIn('slug', ARTICLES.map((a) => a.slug)).del();
  // country_pages: the texts may have been edited since — left as they are.
};

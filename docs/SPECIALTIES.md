# Specialties, specialty records and codes

## Catalogue
Every clinic (and, in a centre or a multi-specialty clinic, every doctor) has a specialty from `src/modules/specialty/catalogue.js`. A narrower specialty has a broader *parent* whose website template, suggested services, icons and marketplace catalog it shares.

## What a specialty switches on
- **Specialty records** (`src/modules/specialty/forms`): structured forms with scientific scores and classifications, computed on the server while the doctor types and stored per patient (`specialty_records`). Defaults = the forms of the clinic's specialty plus those of every active doctor's specialty; the clinic can switch any form on or off (Settings → Specialty records). A record is never deleted: removal keeps it (voided, with who and why) and both are in the audit log.
- **Record screens of their own**: dental chart, growth charts, pregnancy follow-up.
- **Diagnosis table**: the ICD-10 (WHO 2019) codes of the specialty, offered first in the doctor's diagnosis search.

## Codes and licences
- ICD-10 codes and titles: WHO (curated subset bundled, Arabic titles written for this system); cross-checked against the public-domain ICD-10-CM list.
- Scores and classifications are published, free-to-use instruments; the citation is shown under each form.
- Procedure codes (CPT, CDT, SNOMED CT, LOINC) are licensed by their owners and are **not** bundled. Each service has its own *procedure code* and *code system* fields for the clinic's licensed or insurer codes.

## Editions
`CLINIC_SPECIALTY` in `.env` sets a single clinic's specialty at first start. `npm run build:specialties` builds one ready clinic per specialty and a bundle of every specialty's `.env`.

## Specialties
| Specialty | الاسم | Key | Parent | Records | ICD-10 codes |
|---|---|---|---|---|---|
| General practice | طب عام | `general` | — | Pneumonia severity (CURB-65), Sepsis risk (qSOFA), Diabetes review, Depression (PHQ-9), Anxiety (GAD-7) | 101 |
| Family medicine | طب الأسرة | `family` | `general` | Stroke risk in AF (CHA₂DS₂-VASc), Pneumonia severity (CURB-65), Sepsis risk (qSOFA), Diabetes review, Depression (PHQ-9), Anxiety (GAD-7), Nutrition assessment | 101 |
| Internal medicine | الأمراض الباطنية | `internal` | `general` | Stroke risk in AF (CHA₂DS₂-VASc), Bleeding risk (HAS-BLED), Pneumonia severity (CURB-65), Sepsis risk (qSOFA), Diabetes review, Kidney function (eGFR & KDIGO), Full blood count, Depression (PHQ-9) | 89 |
| Geriatrics | طب المسنين | `geriatrics` | `internal` | Stroke risk in AF (CHA₂DS₂-VASc), Kidney function (eGFR & KDIGO), Depression (PHQ-9), Wound assessment, Daily-living independence (Katz ADL) | 44 |
| Paediatrics | طب الأطفال | `paediatrics` | — | Growth charts, Full blood count, Speech & language assessment, Newborn check (Apgar) | 60 |
| Obstetrics & gynaecology | النسائية والتوليد | `obgyn` | — | Pregnancy follow-up, Depression (PHQ-9), Gynaecological assessment, Cervical ripeness (Bishop score), Follicle tracking, Newborn check (Apgar) | 103 |
| Fertility & IVF | الإخصاب وأطفال الأنابيب | `fertility` | `obgyn` | Pregnancy follow-up, Gynaecological assessment, Follicle tracking, Semen analysis | 34 |
| Dentistry | طب الأسنان | `dentistry` | — | Dental chart, Oral surgery note | 88 |
| Orthodontics | تقويم الأسنان | `orthodontics` | `dentistry` | Dental chart, Orthodontic assessment | 26 |
| Oral & maxillofacial surgery | جراحة الفم والفكين | `oral_surgery` | `dentistry` | Dental chart, Pre-operative assessment, Oral surgery note | 94 |
| Dermatology | الأمراض الجلدية | `dermatology` | — | Skin lesion, Psoriasis severity (PASI), Aesthetic injection, Skin prick test | 100 |
| Aesthetics & laser | التجميل والليزر | `cosmetic` | — | Aesthetic injection | 30 |
| Plastic & reconstructive surgery | الجراحة التجميلية والترميمية | `plastic` | `cosmetic` | Skin lesion, Aesthetic injection, Pre-operative assessment, Wound assessment | 34 |
| Ophthalmology | طب العيون | `ophthalmology` | — | Eye examination, Glasses prescription | 60 |
| Optometry | فحص النظر والبصريات | `optometry` | `ophthalmology` | Eye examination, Glasses prescription | 33 |
| ENT | الأنف والأذن والحنجرة | `ent` | — | Pure-tone audiogram, ENT examination, Skin prick test | 78 |
| Audiology | السمعيات | `audiology` | `ent` | Pure-tone audiogram | 32 |
| Speech & language therapy | علاج النطق واللغة | `speech` | `ent` | Speech & language assessment | 30 |
| Cardiology | أمراض القلب | `cardiology` | — | Cardiac assessment (ECG & echo), Stroke risk in AF (CHA₂DS₂-VASc), Bleeding risk (HAS-BLED), Ankle-brachial index (ABI) | 90 |
| Pulmonology | الأمراض الصدرية والتنفسية | `pulmonology` | `internal` | Spirometry, Pneumonia severity (CURB-65) | 84 |
| Gastroenterology & hepatology | الجهاز الهضمي والكبد | `gastroenterology` | `internal` | Liver disease severity (Child-Pugh & MELD), Endoscopy report | 85 |
| Endocrinology & diabetes | الغدد الصماء والسكري | `endocrinology` | `internal` | Diabetes review, Thyroid, Kidney function (eGFR & KDIGO), Wound assessment, Ankle-brachial index (ABI), Nutrition assessment | 88 |
| Nephrology | أمراض الكلى | `nephrology` | `internal` | Kidney function (eGFR & KDIGO) | 44 |
| Urology | المسالك البولية | `urology` | — | Kidney function (eGFR & KDIGO), Semen analysis, Prostate symptoms (IPSS) | 45 |
| Neurology | الأعصاب | `neurology` | — | Stroke risk in AF (CHA₂DS₂-VASc), Neurological examination, Stroke scale (NIHSS), Depression (PHQ-9), Daily-living independence (Katz ADL), Speech & language assessment | 72 |
| Neurosurgery | جراحة الدماغ والأعصاب | `neurosurgery` | `neurology` | Neurological examination, Pain assessment, Pre-operative assessment | 71 |
| Psychiatry | الطب النفسي | `psychiatry` | — | Depression (PHQ-9), Anxiety (GAD-7), Mental state examination | 83 |
| Psychology & counselling | العلاج والإرشاد النفسي | `psychology` | `psychiatry` | Depression (PHQ-9), Anxiety (GAD-7), Mental state examination | 86 |
| Orthopaedics | جراحة العظام والمفاصل | `orthopaedics` | — | Range of motion & muscle testing, Pain assessment, Orthopaedic examination, Pre-operative assessment | 147 |
| Sports medicine | الطب الرياضي | `sports` | `orthopaedics` | Range of motion & muscle testing, Pain assessment, Orthopaedic examination | 148 |
| Rheumatology | الروماتيزم | `rheumatology` | `internal` | Range of motion & muscle testing, Pain assessment, Rheumatoid activity (DAS28) | 50 |
| Physiotherapy | العلاج الطبيعي | `physiotherapy` | — | Range of motion & muscle testing, Pain assessment, Daily-living independence (Katz ADL) | 118 |
| Pain management | علاج الألم | `pain` | `physiotherapy` | Range of motion & muscle testing, Pain assessment | 50 |
| Oncology | الأورام | `oncology` | `internal` | Full blood count, Pain assessment, Skin lesion, Cancer staging & treatment | 65 |
| Haematology | أمراض الدم | `haematology` | `internal` | Bleeding risk (HAS-BLED), Full blood count, Cancer staging & treatment | 49 |
| Infectious diseases | الأمراض المعدية | `infectious` | `internal` | Pneumonia severity (CURB-65), Sepsis risk (qSOFA), Full blood count | 116 |
| Allergy & immunology | الحساسية والمناعة | `allergy` | `internal` | Spirometry, Skin prick test | 35 |
| General surgery | الجراحة العامة | `general_surgery` | — | Pre-operative assessment, Wound assessment, Cancer staging & treatment, Endoscopy report | 64 |
| Vascular surgery | جراحة الأوعية الدموية | `vascular` | `general_surgery` | Pre-operative assessment, Wound assessment, Ankle-brachial index (ABI) | 36 |
| Clinical nutrition | التغذية العلاجية | `nutrition` | — | Nutrition assessment | 82 |
| Multi-specialty | متعددة التخصصات | `multi` | — |  | 101 |
| Other | أخرى | `other` | — |  | 101 |

## Forms
| Key | Form | Specialties | Reference |
|---|---|---|---|
| `eye_exam` | Eye examination | ophthalmology, optometry | Visual acuity in Snellen metric notation; diabetic retinopathy by the International Clinical DR Severity Scale (AAO 2002). |
| `glasses_rx` | Glasses prescription | optometry, ophthalmology | Spherical equivalent = sphere + cylinder ÷ 2. |
| `audiogram` | Pure-tone audiogram | audiology, ent | Four-frequency pure-tone average (0.5, 1, 2, 4 kHz); grades of the WHO World Report on Hearing (2021). |
| `ent_exam` | ENT examination | ent | Tonsil size by the Brodsky grading scale (0–4). |
| `cardiac_assessment` | Cardiac assessment (ECG & echo) | cardiology | QTc by Bazett (QT ÷ √RR); heart failure by LVEF (ESC 2021: reduced ≤ 40%, mildly reduced 41–49%); NYHA functional class. |
| `cha2ds2vasc` | Stroke risk in AF (CHA₂DS₂-VASc) | cardiology, internal, neurology, geriatrics, family | Lip GY et al. Chest 2010;137:263–72. Oral anticoagulation recommended at ≥ 2 (men) / ≥ 3 (women), considered at 1 / 2 (ESC 2020). |
| `has_bled` | Bleeding risk (HAS-BLED) | cardiology, haematology, internal | Pisters R et al. Chest 2010;138:1093–100. A score ≥ 3 means high bleeding risk: address modifiable factors and review more often. |
| `spirometry` | Spirometry | pulmonology, allergy | Obstruction when FEV1/FVC < 0.70 and GOLD grade by FEV1 % predicted (GOLD 2024); significant bronchodilator response ≥ 12% and ≥ 200 mL. |
| `curb65` | Pneumonia severity (CURB-65) | pulmonology, infectious, internal, general, family | Lim WS et al. Thorax 2003;58:377–82. |
| `qsofa` | Sepsis risk (qSOFA) | infectious, internal, general, family | Seymour CW et al. JAMA 2016;315:762–74. A score ≥ 2 with suspected infection means a higher risk of a poor outcome. |
| `diabetes_review` | Diabetes review | endocrinology, internal, family, general | Glycaemic target HbA1c < 7% for most adults; foot risk by the IWGDF 2023 screening (monofilament, pulses, ulcer). |
| `thyroid` | Thyroid | endocrinology | Usual adult TSH reference 0.4–4.0 mIU/L (check your laboratory); nodules by ACR TI-RADS (Tessler FN et al. JACR 2017). |
| `kidney` | Kidney function (eGFR & KDIGO) | nephrology, internal, urology, geriatrics, endocrinology | eGFR by the race-free CKD-EPI 2021 creatinine equation (Inker LA et al. NEJM 2021); CKD G and A categories and risk by KDIGO 2024. |
| `liver_scores` | Liver disease severity (Child-Pugh & MELD) | gastroenterology | Child-Turcotte-Pugh classification; MELD (UNOS) and MELD-Na (Kim WR et al. NEJM 2008). |
| `cbc` | Full blood count | haematology, internal, oncology, infectious, paediatrics | Anaemia by WHO haemoglobin thresholds (2024) for adults; usual adult reference ranges — check your laboratory. |
| `neuro_exam` | Neurological examination | neurology, neurosurgery | Glasgow Coma Scale (Teasdale & Jennett 1974); muscle power by the MRC scale (0–5). |
| `nihss` | Stroke scale (NIHSS) | neurology | NIH Stroke Scale (National Institute of Neurological Disorders and Stroke; public domain). |
| `phq9` | Depression (PHQ-9) | psychiatry, psychology, family, general, internal, neurology, geriatrics, obgyn | Kroenke K, Spitzer RL, Williams JB. J Gen Intern Med 2001;16:606–13 (free to use). Over the last 2 weeks. The Arabic wording here is a working translation; use a validated version for research. |
| `gad7` | Anxiety (GAD-7) | psychiatry, psychology, family, general | Spitzer RL et al. Arch Intern Med 2006;166:1092–7 (free to use). Over the last 2 weeks. The Arabic wording here is a working translation; use a validated version for research. |
| `mental_state` | Mental state examination | psychiatry, psychology | — |
| `rom_mmt` | Range of motion & muscle testing | physiotherapy, orthopaedics, sports, rheumatology, pain | Goniometric normal values of the American Academy of Orthopaedic Surgeons; manual muscle testing on the Oxford scale (0–5). |
| `pain_assessment` | Pain assessment | pain, physiotherapy, oncology, orthopaedics, rheumatology, sports, neurosurgery | Numeric Rating Scale 0–10 (mild 1–3, moderate 4–6, severe 7–10); red flags for serious spinal pathology. |
| `das28` | Rheumatoid activity (DAS28) | rheumatology | Prevoo ML et al. Arthritis Rheum 1995;38:44–8. Remission < 2.6, low ≤ 3.2, moderate ≤ 5.1, high > 5.1. |
| `ortho_exam` | Orthopaedic examination | orthopaedics, sports | Fractures may be coded with the AO/OTA classification. |
| `skin_lesion` | Skin lesion | dermatology, plastic, oncology | ABCDE checklist for melanoma (Asymmetry, Border, Colour, Diameter > 6 mm, Evolving); Fitzpatrick skin type. |
| `pasi` | Psoriasis severity (PASI) | dermatology | Fredriksson T, Pettersson U. Dermatologica 1978;157:238–44. Erythema, induration and scaling 0–4; area 0–6 (0 = none, 1 < 10%, 2 = 10–29%, 3 = 30–49%, 4 = 50–69%, 5 = 70–89%, 6 = 90–100%). |
| `aesthetic_injection` | Aesthetic injection | cosmetic, dermatology, plastic | Product, lot and expiry are recorded for traceability. |
| `gyn_exam` | Gynaecological assessment | obgyn, fertility | Cervical cytology reported by the Bethesda System (2014); management by ASCCP risk-based guidelines. |
| `bishop` | Cervical ripeness (Bishop score) | obgyn | Bishop EH. Obstet Gynecol 1964;24:266–8. A score ≥ 8 is favourable for induction; ≤ 6 unfavourable. |
| `follicle_scan` | Follicle tracking | fertility, obgyn | Follicle sizes in mm (mean diameter), one list per ovary; mature follicles usually ≥ 17–18 mm. |
| `semen_analysis` | Semen analysis | fertility, urology | WHO Laboratory Manual for the Examination and Processing of Human Semen, 6th ed. (2021): lower reference limits. |
| `ipss` | Prostate symptoms (IPSS) | urology | International Prostate Symptom Score (AUA symptom index). Mild 0–7, moderate 8–19, severe 20–35; quality of life 0–6. Over the past month. |
| `preop` | Pre-operative assessment | general_surgery, plastic, vascular, neurosurgery, oral_surgery, orthopaedics | ASA Physical Status Classification (American Society of Anesthesiologists, 2020); airway by the modified Mallampati class. |
| `wound` | Wound assessment | general_surgery, vascular, plastic, geriatrics, endocrinology | Pressure injuries by the NPIAP staging (2016); area = length × width. |
| `abi` | Ankle-brachial index (ABI) | vascular, cardiology, endocrinology | ABI = higher ankle pressure (DP or PT) ÷ higher brachial pressure (AHA/ACC 2024): > 1.40 non-compressible, 1.00–1.40 normal, 0.91–0.99 borderline, ≤ 0.90 PAD, ≤ 0.40 severe. |
| `cancer_staging` | Cancer staging & treatment | oncology, general_surgery, haematology | TNM classification (UICC/AJCC 8th edition); ECOG performance status (Oken MM et al. 1982); response by RECIST 1.1. |
| `endoscopy` | Endoscopy report | gastroenterology, general_surgery | Bowel preparation by the Boston Bowel Preparation Scale (Lai EJ et al. 2009): adequate when total ≥ 6 and every segment ≥ 2. |
| `skin_prick` | Skin prick test | allergy, dermatology, ent | A wheal ≥ 3 mm larger than the negative control is positive; the test is valid only when the histamine control is ≥ 3 mm (EAACI). |
| `orthodontic` | Orthodontic assessment | orthodontics | Angle classification; Index of Orthodontic Treatment Need — Dental Health Component (Brook & Shaw 1989). |
| `oral_surgery` | Oral surgery note | oral_surgery, dentistry | Teeth in FDI (ISO 3950) notation; impacted third molars by Winter’s classification. |
| `nutrition` | Nutrition assessment | nutrition, endocrinology, family | BMI by WHO classes; waist-to-hip ratio risk ≥ 0.90 men / ≥ 0.85 women (WHO 2008); energy by the Mifflin-St Jeor equation × activity factor. |
| `katz_adl` | Daily-living independence (Katz ADL) | geriatrics, physiotherapy, neurology | Katz S et al. JAMA 1963;185:914–9. 6 = full function, 4 = moderate impairment, ≤ 2 = severe impairment. |
| `speech_assessment` | Speech & language assessment | speech, paediatrics, neurology | Stuttering frequency as percentage of syllables stuttered (%SS); intelligibility as the share of speech understood by an unfamiliar listener. |
| `newborn` | Newborn check (Apgar) | paediatrics, obgyn | Apgar V. Curr Res Anesth Analg 1953;32:260–7: 7–10 reassuring, 4–6 moderately abnormal, 0–3 low. |

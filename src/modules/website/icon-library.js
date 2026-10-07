// Icon libraries for the website builder: the common set plus one library per specialty (dentistry has DocBook's
// own dental set — scripts/icons-medical.js). The picker opens on the clinic's own specialty; every library stays
// available. All names are symbols of public/icons.svg.
const COMMON = ['stethoscope', 'heart-pulse', 'shield-check', 'clock', 'star', 'smile', 'baby', 'award', 'hospital', 'syringe', 'pill', 'thermometer', 'activity', 'badge-check', 'calendar-check', 'map-pin', 'phone', 'users', 'sparkles', 'hand-coins',
  'heart', 'hand-heart', 'leaf', 'flower-2', 'sun-medium', 'brain', 'ruler', 'droplet', 'zap', 'wand-sparkles',
  'cross', 'ambulance', 'bandage', 'pill-bottle', 'tablets', 'microscope', 'test-tube', 'heart-handshake', 'hand-helping', 'bed', 'shield-plus', 'stamp', 'house'];

const LIBS = {
  dentistry: ['dt-tooth', 'dt-whitening', 'dt-caries', 'dt-filling', 'dt-crown', 'dt-implant', 'dt-braces', 'dt-aligner', 'dt-root-canal', 'dt-extraction', 'dt-xray',
    'dt-dentures', 'dt-veneer', 'dt-bridge', 'dt-gum', 'dt-kids', 'dt-protect', 'dt-pain', 'dt-mirror', 'dt-scaler', 'dt-chair', 'dt-floss', 'dt-smile', 'dt-scan',
    'toothbrush', 'toothbrush-sparkles', 'smile', 'smile-plus', 'laugh', 'sparkles', 'sparkle', 'syringe', 'scan-face', 'shield-check', 'baby'],
  dermatology: ['der-skin', 'der-mole', 'der-acne', 'der-cream', 'der-sunscreen', 'der-laser', 'der-hair', 'der-nail', 'der-lips', 'der-mask', 'der-wrinkles',
    'scan-face', 'scan-search', 'droplets', 'droplet', 'sparkle', 'sparkles', 'sun-snow', 'sun-medium', 'sun-dim', 'thermometer-sun', 'soap-dispenser-droplet', 'spray-can',
    'shower-head', 'bath', 'hand', 'leaf', 'sprout', 'flower-2', 'feather', 'microscope', 'syringe', 'wand-sparkles', 'scissors', 'brush', 'bandage', 'virus', 'bug', 'snowflake', 'flame'],
  cosmetic: ['der-lips', 'der-mask', 'der-wrinkles', 'der-skin', 'der-laser', 'der-hair', 'der-cream', 'der-sunscreen', 'der-nail', 'scan-face', 'sparkle', 'sparkles', 'wand-sparkles',
    'syringe', 'droplets', 'brush', 'flower-2', 'feather', 'shell', 'sun-snow', 'snowflake', 'spray-can', 'scissors', 'smile-plus', 'hand-heart', 'heart', 'leaf', 'soap-dispenser-droplet', 'bath', 'gift'],
  paediatrics: ['ped-bottle', 'ped-pacifier', 'ped-teddy', 'ped-rattle', 'ped-growth', 'ped-stroller', 'ped-child', 'ped-vaccine', 'ped-diaper', 'ped-thermometer',
    'baby', 'milk', 'puzzle', 'blocks', 'toy-brick', 'balloon', 'cake', 'gift', 'party-popper', 'rocking-chair', 'smile', 'smile-plus', 'laugh', 'heart', 'hand-heart', 'syringe',
    'thermometer', 'ruler', 'weight', 'apple', 'banana', 'shield-check', 'stethoscope', 'book-heart', 'moon-star', 'sun'],
  obgyn: ['ob-pregnant', 'ob-ultrasound', 'ob-uterus', 'ob-embryo', 'ob-cycle', 'ob-ivf', 'ob-mother', 'ped-stroller', 'ped-bottle',
    'venus', 'venus-and-mars', 'baby', 'heart-handshake', 'scan-heart', 'heart-pulse', 'heart-plus', 'ribbon', 'flower-2', 'flower', 'calendar-heart', 'calendar-check', 'calendar-range',
    'milk', 'hand-heart', 'test-tube', 'test-tube-diagonal', 'microscope', 'dna', 'shield-plus', 'file-heart', 'sprout'],
  orthopaedics: ['or-knee', 'or-spine', 'or-cast', 'or-crutches', 'or-wheelchair', 'or-joint', 'or-xray', 'or-back', 'or-stretch',
    'bone', 'bone-fracture', 'footprints', 'person-standing', 'accessibility', 'hand', 'hand-fist', 'hand-grab', 'dumbbell', 'biceps-flexed', 'bike', 'bed', 'bandage', 'ruler',
    'ruler-dimension-line', 'activity', 'scan-line', 'file-scan', 'shield-plus', 'snowflake', 'flame'],
  physiotherapy: ['or-stretch', 'or-back', 'or-spine', 'or-knee', 'or-joint', 'or-crutches', 'or-wheelchair', 'or-cast',
    'dumbbell', 'biceps-flexed', 'bike', 'person-standing', 'accessibility', 'footprints', 'bone', 'hand-helping', 'hand', 'hand-fist', 'hand-grab', 'activity', 'bed', 'timer',
    'heart-pulse', 'leaf', 'snowflake', 'flame', 'thermometer-snowflake', 'thermometer-sun', 'bath', 'zap'],
  ophthalmology: ['oph-chart', 'oph-lens', 'oph-drops', 'oph-laser', 'oph-check', 'oph-retina', 'oph-lamp',
    'eye', 'glasses', 'scan-eye', 'eye-closed', 'eye-off', 'eye-dashed', 'crosshair', 'sun-medium', 'sun-dim', 'microscope', 'shield-check', 'zap', 'droplet', 'droplets', 'baby', 'book-open'],
  ent: ['ent-nose', 'ent-throat', 'ent-hearing', 'ent-ear', 'ent-sinus', 'ent-voice',
    'ear', 'ear-off', 'headphones', 'headset', 'mic', 'mic-vocal', 'audio-lines', 'audio-waveform', 'volume-2', 'radio', 'wind', 'smile', 'thermometer', 'stethoscope', 'scan-face',
    'droplets', 'snowflake', 'flower-2', 'virus', 'baby'],
  cardiology: ['car-bp', 'car-stent', 'car-holter', 'car-ecg', 'car-vessel',
    'heart-pulse', 'heart', 'heart-plus', 'heart-minus', 'scan-heart', 'heart-crack', 'heart-handshake', 'activity', 'square-activity', 'stethoscope', 'gauge', 'pill', 'tablets',
    'cigarette-off', 'dumbbell', 'bike', 'footprints', 'apple', 'salad', 'scale', 'droplet', 'timer', 'siren', 'file-heart'],
  psychiatry: ['psy-head', 'psy-talk', 'psy-lotus', 'psy-sleep', 'psy-couch',
    'brain', 'brain-cog', 'brain-circuit', 'puzzle', 'book-heart', 'hand-heart', 'heart-handshake', 'message-circle', 'message-circle-heart', 'users', 'smile', 'meh', 'frown',
    'leaf', 'sprout', 'feather', 'sun-medium', 'sunrise', 'moon-star', 'bed', 'headphones', 'music', 'user-round-check'],
  nutrition: ['nut-plate', 'nut-tape', 'nut-balance', 'nut-supplement', 'nut-scale', 'nut-water',
    'apple', 'salad', 'carrot', 'citrus', 'grape', 'banana', 'cherry', 'egg', 'egg-fried', 'fish', 'drumstick', 'beef', 'sandwich', 'soup', 'nut', 'leafy-green', 'wheat', 'milk',
    'glass-water', 'cup-soda', 'scale', 'weight', 'weight-tilde', 'dumbbell', 'bike', 'hand-platter', 'heart-pulse', 'droplet', 'flame', 'sprout'],
  lab: ['lab-tube', 'lab-petri', 'lab-cup', 'lab-centrifuge', 'lab-blood', 'lab-report',
    'microscope', 'test-tube', 'test-tube-diagonal', 'test-tubes', 'flask-conical', 'flask-round', 'dna', 'virus', 'bug', 'droplet', 'syringe', 'scan-line', 'scan-search',
    'clipboard-check', 'file-check', 'file-scan', 'thermometer', 'timer', 'shield-check'],
};
LIBS.general = [...COMMON];
const KEYS = ['general', 'dentistry', 'dermatology', 'cosmetic', 'paediatrics', 'obgyn', 'orthopaedics', 'physiotherapy', 'ophthalmology', 'ent', 'cardiology', 'psychiatry', 'nutrition', 'lab'];

/** Every icon a section may use (the validator's list); the common set first (its first icon is the default). */
const ALL = [...new Set([...COMMON, ...KEYS.flatMap((k) => LIBS[k])])];

/** The library to open first for a clinic specialty (unknown or multi-specialty → general). */
const libFor = (specialty) => { const k = require('../specialty/catalogue').lineage(specialty).find((x) => LIBS[x]); return k && k !== 'general' ? k : 'general'; }; // eslint-disable-line global-require

module.exports = { COMMON, LIBS, KEYS, ALL, libFor };

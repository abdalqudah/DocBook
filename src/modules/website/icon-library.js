// Icon libraries for the website builder: the common set plus one library per specialty (dentistry has DocBook's
// own dental set — scripts/icons-medical.js). The picker opens on the clinic's own specialty; every library stays
// available. All names are symbols of public/icons.svg.
const COMMON = ['stethoscope', 'heart-pulse', 'shield-check', 'clock', 'star', 'smile', 'baby', 'award', 'hospital', 'syringe', 'pill', 'thermometer', 'activity', 'badge-check', 'calendar-check', 'map-pin', 'phone', 'users', 'sparkles', 'hand-coins',
  'heart', 'hand-heart', 'leaf', 'flower-2', 'sun-medium', 'brain', 'ruler', 'droplet', 'zap', 'wand-sparkles',
  'cross', 'ambulance', 'bandage', 'pill-bottle', 'tablets', 'microscope', 'test-tube', 'heart-handshake', 'hand-helping', 'bed', 'shield-plus', 'stamp', 'house'];

const LIBS = {
  dentistry: ['dt-tooth', 'dt-whitening', 'dt-caries', 'dt-filling', 'dt-crown', 'dt-implant', 'dt-braces', 'dt-aligner', 'dt-root-canal', 'dt-extraction', 'dt-xray',
    'dt-dentures', 'dt-veneer', 'dt-bridge', 'dt-gum', 'dt-kids', 'dt-protect', 'dt-pain', 'dt-mirror', 'dt-scaler', 'dt-chair', 'dt-floss', 'dt-smile', 'dt-scan',
    'toothbrush', 'smile', 'smile-plus', 'laugh', 'sparkles', 'sparkle', 'syringe', 'scan-face', 'shield-check', 'baby'],
  dermatology: ['scan-face', 'droplets', 'droplet', 'sparkle', 'sparkles', 'sun-snow', 'sun-medium', 'thermometer-sun', 'soap-dispenser-droplet', 'spray-can', 'shower-head', 'hand', 'leaf', 'flower-2', 'microscope', 'syringe', 'wand-sparkles', 'scissors', 'brush', 'bandage'],
  cosmetic: ['scan-face', 'sparkle', 'sparkles', 'wand-sparkles', 'syringe', 'droplets', 'brush', 'flower-2', 'sun-snow', 'spray-can', 'scissors', 'smile-plus', 'hand-heart', 'heart', 'leaf', 'soap-dispenser-droplet'],
  paediatrics: ['baby', 'milk', 'puzzle', 'smile', 'smile-plus', 'laugh', 'heart', 'hand-heart', 'syringe', 'thermometer', 'ruler', 'weight', 'apple', 'shield-check', 'stethoscope', 'book-heart'],
  obgyn: ['venus', 'baby', 'heart-handshake', 'scan-heart', 'heart-pulse', 'ribbon', 'flower-2', 'calendar-check', 'calendar-range', 'milk', 'hand-heart', 'test-tube', 'microscope', 'shield-plus'],
  orthopaedics: ['bone', 'footprints', 'person-standing', 'accessibility', 'hand', 'dumbbell', 'biceps-flexed', 'bed', 'bandage', 'ruler', 'activity', 'scan-line', 'shield-plus'],
  physiotherapy: ['dumbbell', 'biceps-flexed', 'person-standing', 'accessibility', 'footprints', 'bone', 'hand-helping', 'hand', 'activity', 'bed', 'timer', 'heart-pulse', 'leaf'],
  ophthalmology: ['eye', 'glasses', 'scan-eye', 'eye-closed', 'eye-off', 'sun-medium', 'microscope', 'shield-check', 'zap', 'droplet'],
  ent: ['ear', 'wind', 'mic', 'radio', 'volume-2', 'smile', 'thermometer', 'stethoscope', 'scan-face', 'droplets'],
  cardiology: ['heart-pulse', 'heart', 'scan-heart', 'heart-crack', 'activity', 'square-activity', 'stethoscope', 'gauge', 'pill', 'cigarette-off', 'dumbbell', 'apple'],
  psychiatry: ['brain', 'brain-cog', 'brain-circuit', 'puzzle', 'book-heart', 'hand-heart', 'heart-handshake', 'message-circle', 'smile', 'leaf', 'sun-medium', 'bed'],
  nutrition: ['apple', 'salad', 'carrot', 'citrus', 'egg', 'fish', 'leafy-green', 'wheat', 'milk', 'scale', 'weight', 'dumbbell', 'hand-platter', 'heart-pulse', 'droplet'],
  lab: ['microscope', 'test-tube', 'test-tubes', 'flask-conical', 'dna', 'droplet', 'syringe', 'scan-line', 'clipboard-check', 'file-check'],
};
LIBS.general = [...COMMON];
const KEYS = ['general', 'dentistry', 'dermatology', 'cosmetic', 'paediatrics', 'obgyn', 'orthopaedics', 'physiotherapy', 'ophthalmology', 'ent', 'cardiology', 'psychiatry', 'nutrition', 'lab'];

/** Every icon a section may use (the validator's list); the common set first (its first icon is the default). */
const ALL = [...new Set([...COMMON, ...KEYS.flatMap((k) => LIBS[k])])];

/** The library to open first for a clinic specialty (unknown or multi-specialty → general). */
const libFor = (specialty) => (LIBS[specialty] && specialty !== 'general' ? specialty : 'general');

module.exports = { COMMON, LIBS, KEYS, ALL, libFor };

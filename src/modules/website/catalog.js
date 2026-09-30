// Clinic website catalog (DocBook 2.0 redesign, phase 4): the healthcare templates a clinic starts from and the theme
// presets they use. Pure data — no database. Plans may limit which templates a clinic can pick (entitlement
// website.templates); themes themselves are presentation only and never hold content.
const THEMES = ['calm', 'clinical', 'warm', 'minimal', 'bold'];
const TEMPLATES = ['general', 'dental', 'dermatology', 'aesthetic', 'pediatrics', 'gynecology', 'physio', 'medical_center', 'multi_specialty', 'individual_doctor'];

module.exports = { THEMES, TEMPLATES };

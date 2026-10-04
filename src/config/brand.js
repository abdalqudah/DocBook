// ============================================================================
// Brand & theme — the ONE place that defines the product's identity.
// Change the name, logo, favicon, fonts or any colour here and the whole product
// follows: the app shell, charts, auth pages, landing page, printed reports and
// exports all read these values (as CSS custom properties generated at /theme.css).
// No component contains a hard-coded brand colour.
//
// A workspace can additionally override `primary` and the logo from
// Settings → Appearance; that override is layered on top of these defaults.
// ============================================================================
const edition = require('./edition'); // also reads .env (BRAND_NAME, CLINIC_NAME)

module.exports = {
  // BRAND_NAME in .env renames the product everywhere (a single clinic / centre installation: its own name).
  name: (process.env.BRAND_NAME || '').trim() || (edition.single && (process.env.CLINIC_NAME || '').trim()) || 'DocBook',
  // Short product line used in titles, the sidebar and the landing page.
  tagline: {
    en: 'Clinic bookings, patients and billing in one place',
    ar: 'حجوزات العيادة ومرضاها وفواتيرها في مكان واحد',
  },
  // Logo: leave null to use the built-in mark + wordmark (tinted with `primary`),
  // or point to files under /public (e.g. '/brand/logo.svg'). logoOnDark is used in dark mode.
  logo: null,
  logoOnDark: null,
  // Favicon: null = generated from the built-in mark in the primary colour (/favicon.svg).
  favicon: null,
  // The built-in mark's drawing inside its rounded square (a single clinic / centre: a medical cross).
  markInner: (ink) => (edition.single
    ? `<path d="M26 16h12v10h10v12H38v10H26V38H16V26h10z" fill="${ink}"/>`
    : `<path d="M20 16h14c9.4 0 16 6.8 16 16s-6.6 16-16 16H20z" fill="none" stroke="${ink}" stroke-width="5" stroke-linejoin="round"/><path d="M28 26h8M28 32h10M28 38h6" stroke="${ink}" stroke-width="4" stroke-linecap="round"/>`),
  // Letters used by the built-in mark (1–2 characters).
  monogram: 'D',

  fonts: {
    // System stacks keep the CSP strict (no third-party font hosts) and render Arabic well.
    sans: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Noto Sans', 'Noto Sans Arabic', 'Helvetica Neue', Tahoma, Arial, sans-serif",
    mono: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  },

  // Calm, neutral palette: greys carry the interface; the single brand colour (primary) is reserved for the
  // main action, the active navigation item, focus rings and links. Status colours appear only as small
  // dots/labels, never as large filled areas.
  colors: {
    light: {
      primary: '#0F766E',
      primaryHover: '#0B5F58',
      primaryInk: '#FFFFFF',        // text on primary
      secondary: '#161616',         // near-black, used sparingly (e.g. the selected segment)
      secondaryInk: '#FFFFFF',
      accent: '#0F766E',            // same hue as primary: one brand colour only
      background: '#F7F7F7',
      surface: '#FFFFFF',
      surfaceMuted: '#FAFAFA',
      surfaceSunken: '#F2F2F2',
      text: '#0A0A0A',
      textMuted: '#4A4A4A',
      textSubtle: '#767676',
      border: '#E4E4E4',
      borderStrong: '#CFCFCF',
      success: '#137A4B',
      warning: '#A15C07',
      danger: '#B42318',
      info: '#3F5B8C',
    },
    dark: {
      primary: '#3CBFAE',
      primaryHover: '#62CFC1',
      primaryInk: '#04211D',
      secondary: '#F2F2F2',
      secondaryInk: '#0A0A0A',
      accent: '#3CBFAE',
      background: '#0A0A0A',
      surface: '#121212',
      surfaceMuted: '#161616',
      surfaceSunken: '#0E0E0E',
      text: '#F5F5F5',
      textMuted: '#BDBDBD',
      textSubtle: '#8A8A8A',
      border: '#262626',
      borderStrong: '#363636',
      success: '#4CC38A',
      warning: '#E0A84E',
      danger: '#F07167',
      info: '#8FA8D6',
    },
  },

  radius: { sm: '6px', md: '10px', lg: '16px' },
  // Contact line shown on the landing page and support page (leave empty to hide).
  supportEmail: process.env.SUPPORT_EMAIL || '',
};

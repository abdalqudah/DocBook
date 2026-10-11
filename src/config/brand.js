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
  name: (process.env.BRAND_NAME || '').trim() || (edition.single && (process.env.CLINIC_NAME || '').trim()) || 'MedWorks',
  // Short product line used in titles, the sidebar and the landing page.
  tagline: edition.single ? {
    en: 'Clinic bookings, patients and billing in one place',
    ar: 'حجوزات العيادة ومرضاها وفواتيرها في مكان واحد',
  } : {
    en: 'One Platform. Smarter Healthcare',
    ar: 'منصة واحدة. رعاية صحية أذكى',
  },
  // Logo: leave null to use the built-in mark + wordmark (tinted with `primary`),
  // or point to files under /public (e.g. '/brand/logo.svg'). logoOnDark is used in dark mode.
  // The platform's MedWorks wordmark; a single clinic / centre installation shows its own name with the built-in mark.
  logo: edition.single ? null : '/img/brand/medworks-logo.svg',
  logoOnDark: edition.single ? null : '/img/brand/medworks-logo-dark.svg',
  // The wordmark with the tagline (landing page, sign-in pages).
  logoFull: edition.single ? null : '/img/brand/medworks-logo-full.svg',
  logoFullOnDark: edition.single ? null : '/img/brand/medworks-logo-full-dark.svg',
  // Favicon: null = generated from the built-in mark in the primary colour (/favicon.svg).
  favicon: null,
  // The built-in mark's drawing inside its rounded square: the MedWorks heartbeat "M" (a single clinic / centre: a medical cross).
  markInner: (ink) => (edition.single
    ? `<path d="M26 16h12v10h10v12H38v10H26V38H16V26h10z" fill="${ink}"/>`
    : `<path d="M6.00 34.59 L20.44 33.81 L25.62 18.76 L32.00 37.30 L40.91 9.97 L48.73 34.53 L58.00 35.01 L58.00 37.78 L50.78 38.50 L47.29 46.93 L40.91 26.46 L32.00 54.03 L25.62 33.08 L23.94 38.14 L6.00 36.94 Z" fill="${ink}"/>`),
  // Letters used by the built-in mark (1–2 characters).
  monogram: 'M',

  fonts: {
    // The platform: IBM Plex Sans Arabic (Arabic and Latin), served from this site (public/fonts, SIL OFL) so the CSP
    // stays strict; a single clinic / centre installation keeps the system stack, which renders Arabic well.
    sans: `${edition.single ? '' : "'IBM Plex Sans Arabic', "}system-ui, -apple-system, 'Segoe UI', Roboto, 'Noto Sans', 'Noto Sans Arabic', 'Helvetica Neue', Tahoma, Arial, sans-serif`,
    mono: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  },

  // Calm, neutral palette: greys carry the interface; the single brand colour (primary) is reserved for the
  // main action, the active navigation item, focus rings and links. Status colours appear only as small
  // dots/labels, never as large filled areas.
  colors: {
    light: {
      primary: '#0A6FD6',           // MedWorks blue (the logo's #0E8BFF, deepened for white text and links)
      primaryHover: '#085AB0',
      primaryInk: '#FFFFFF',        // text on primary
      secondary: '#04223F',         // MedWorks navy, used sparingly (e.g. the selected segment)
      secondaryInk: '#FFFFFF',
      accent: '#0A6FD6',            // same hue as primary: one brand colour only
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
      primary: '#3AA2FF',
      primaryHover: '#66B8FF',
      primaryInk: '#021A33',
      secondary: '#F2F2F2',
      secondaryInk: '#0A0A0A',
      accent: '#3AA2FF',
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

  // Web fonts loaded by /theme.css (@font-face), each subset only when the page uses its characters.
  fontFaces: edition.single ? [] : [400, 500, 600, 700].flatMap((weight) => [
    { family: 'IBM Plex Sans Arabic', weight, src: `/fonts/ibm-plex-sans-arabic/arabic-${weight}.woff2`, range: 'U+0600-06FF, U+0750-077F, U+0870-088E, U+0890-0891, U+0897-08E1, U+08E3-08FF, U+200C-200E, U+2010-2011, U+204F, U+2E41, U+FB50-FDFF, U+FE70-FE74, U+FE76-FEFC' },
    { family: 'IBM Plex Sans Arabic', weight, src: `/fonts/ibm-plex-sans-arabic/latin-${weight}.woff2`, range: 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD' },
  ]),

  radius: { sm: '6px', md: '10px', lg: '16px' },
  // Contact line shown on the landing page and support page (leave empty to hide).
  supportEmail: process.env.SUPPORT_EMAIL || '',
};

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
module.exports = {
  name: 'DocBook',
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
  // Letters used by the built-in mark (1–2 characters).
  monogram: 'D',

  fonts: {
    // System stacks keep the CSP strict (no third-party font hosts) and render Arabic well.
    sans: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Noto Sans', 'Noto Sans Arabic', 'Helvetica Neue', Tahoma, Arial, sans-serif",
    mono: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  },

  colors: {
    light: {
      primary: '#0E7C6B',
      primaryHover: '#0A6456',
      primaryInk: '#FFFFFF',        // text on primary
      secondary: '#1B2A41',
      secondaryInk: '#FFFFFF',
      accent: '#E8A33D',
      background: '#F5F7F6',
      surface: '#FFFFFF',
      surfaceMuted: '#F0F3F2',
      surfaceSunken: '#E9EDEC',
      text: '#0F1A17',
      textMuted: '#4B5A56',
      textSubtle: '#6B7A76',
      border: '#DCE3E1',
      borderStrong: '#C3CDCA',
      success: '#11855A',
      warning: '#B45309',
      danger: '#C0362C',
      info: '#2459C9',
    },
    dark: {
      primary: '#35C2A6',
      primaryHover: '#5ED3BB',
      primaryInk: '#04211B',
      secondary: '#E4ECF7',
      secondaryInk: '#0B1220',
      accent: '#F2B45A',
      background: '#0B1110',
      surface: '#121A18',
      surfaceMuted: '#17211F',
      surfaceSunken: '#0E1513',
      text: '#EEF4F2',
      textMuted: '#B3C1BD',
      textSubtle: '#8A9A96',
      border: '#24312E',
      borderStrong: '#34443F',
      success: '#3DD68C',
      warning: '#F5B94A',
      danger: '#FF7A6E',
      info: '#86A8FF',
    },
  },

  radius: { sm: '6px', md: '10px', lg: '16px' },
  // Contact line shown on the landing page and support page (leave empty to hide).
  supportEmail: process.env.SUPPORT_EMAIL || '',
};

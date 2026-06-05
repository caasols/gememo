// design_tokens.js — the single source of truth for the visual language shared
// by all three surfaces (UXC-0):
//   • the popup (popup.html / popup.js)
//   • the in-Meet toast + close overlay (content_meet.js)
//   • the toolbar badge (background.js)
//
// Plain values, no DOM access, so the same file loads in the popup (a <script>
// tag), the service worker (importScripts), and the content script (manifest
// content_scripts). The popup.html :root block MIRRORS color.* 1:1 for light
// mode — tests/tokens.spec.js guards against drift. The badge (background.js)
// and toast/overlay (content_meet.js) reference these values directly instead
// of the three hand-divergent hexes they used before (e.g. danger was written
// as #ea4335 in the popup but #c5221f in the badge + toast).

const TOKENS = {
  color: {
    primary:     '#1a73e8',
    primaryDark: '#1557b0',
    // Semantic states — each has a fill weight (for badges/toasts/solid chips)
    // and a text weight (for tinted text on a light background).
    danger:      '#ea4335',  // fill
    dangerText:  '#b91c1c',
    success:     '#34a853',  // fill
    successText: '#137333',
    warn:        '#e8710a',  // fill — replaces the off-palette #e37400/#e8710a split
    warnText:    '#92400e',
    info:        '#1a73e8',  // fill — same blue as primary, for info toasts
    surface:     '#ffffff',
    text:        '#202124',
    onColor:     '#ffffff',  // text/label drawn on top of a coloured fill
  },
  radius: { sm: '6px', md: '6px', pill: '999px' },
  space:  { xs: '4px', sm: '6px', md: '8px', lg: '12px', xl: '16px' },
  font: {
    ui: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  },
};

// Map a showStatus/notification level → its fill colour. One source of truth for
// the in-Meet toast colour map and the toolbar badge background.
function tokenStatusFill(level) {
  return ({
    err:  TOKENS.color.danger,
    warn: TOKENS.color.warn,
    ok:   TOKENS.color.success,
    info: TOKENS.color.info,
  })[level] || TOKENS.color.info;
}

// Node (Playwright spec) access — harmless in the browser/service-worker where
// `module` is undefined.
if (typeof module !== 'undefined') module.exports = { TOKENS, tokenStatusFill };

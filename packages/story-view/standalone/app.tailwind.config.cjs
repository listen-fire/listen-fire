const base = require('./tailwind.config.cjs');

/**
 * Tailwind for the IN-CHAT app — the link page's config with one change.
 *
 * The typeface. A sandboxed app may not load a font file from anywhere, so
 * the brand face is off the table here; the stack below is what the reader's
 * own system already has, with a first slot the host can fill (Claude offers
 * its typeface as `--font-sans`, which the app copies into `--app-font-sans`
 * on connect). The fallback inside the `var()` matters: an unset variable with
 * no fallback would invalidate the whole declaration, not just its first term.
 *
 * Everything else — the brand ramp, the sources scanned — is shared with the
 * link page by construction, so the two mounts cannot drift apart on colour.
 */
module.exports = {
  ...base,
  theme: {
    ...base.theme,
    extend: {
      ...base.theme.extend,
      fontFamily: {
        ...base.theme.extend.fontFamily,
        sans: [
          'var(--app-font-sans, ui-sans-serif)',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'Arial',
          'sans-serif',
        ],
      },
    },
  },
};

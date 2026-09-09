const path = require('node:path');

/**
 * Tailwind for the STANDALONE page — a pass over this package alone.
 *
 * The app's own config scans the same sources for the same reason (Tailwind
 * only emits what it can see); this one exists because the standalone page has
 * no app to inherit a stylesheet from. The tokens below are the ones the story
 * components actually name — the brand ramp and the two type stacks — and they
 * must agree with `apps/web/tailwind.config.ts`, which declares them for the
 * whole app. Two mounts, one look.
 */
module.exports = {
  content: [
    path.join(__dirname, '*.{ts,tsx}'),
    path.join(__dirname, '..', '*.{ts,tsx}'),
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          '"Segoe UI"',
          'Roboto',
          '"Helvetica Neue"',
          'Arial',
          'sans-serif',
        ],
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
      },
      colors: {
        primary: {
          DEFAULT: '#8778F7',
          50: '#F5F3FE',
          100: '#EBE8FD',
          200: '#D4CEFB',
          300: '#BDB4F9',
          400: '#A296F8',
          500: '#8778F7',
          600: '#6B5BD4',
          700: '#5242A8',
          800: '#3C307D',
          900: '#271F52',
        },
      },
    },
  },
};

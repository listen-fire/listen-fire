import type { Config } from 'tailwindcss';
import typography from '@tailwindcss/typography';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
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
  plugins: [typography],
};

export default config;

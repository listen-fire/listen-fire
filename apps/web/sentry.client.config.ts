import * as Sentry from '@sentry/nextjs';

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NEXT_PUBLIC_SENTRY_ENV ?? 'localhost',
  release: process.env.NEXT_PUBLIC_SENTRY_RELEASE,

  integrations: [
    Sentry.browserTracingIntegration(),
    Sentry.dedupeIntegration(),
  ],

  ignoreErrors: [
    'ResizeObserver loop',
    'ResizeObserver loop completed with undelivered notifications',
    /^Non-Error promise rejection/,
    'AbortError',
    'NetworkError',
    'Load failed',
    'Failed to fetch',
    'Network request failed',
    /^chrome-extension:\/\//,
    /^moz-extension:\/\//,
  ],

  tracesSampleRate: 0.05,
});

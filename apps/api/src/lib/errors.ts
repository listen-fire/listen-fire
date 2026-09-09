import * as Sentry from '@sentry/node';

const handleError = (err: unknown) => {
  console.error(err);
  if (process.env.NODE_ENV !== 'test') {
    Sentry.captureException(err);
  }
};

export { handleError };

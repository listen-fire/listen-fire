import * as Sentry from '@sentry/node';

function runInBackground<T>(fn: () => Promise<T>): void {
  fn().catch((error) => {
    console.error(error);
    Sentry.captureException(error);
  });
}

export { runInBackground };

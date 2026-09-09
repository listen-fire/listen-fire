import { RequestHandler } from 'express';
import * as Sentry from '@sentry/node';

import { currentContext } from '../../services/context';

const sentryScopeHandler: RequestHandler = (req, _, next) => {
  const ctx = currentContext();
  Sentry.setUser({ id: ctx.authenticated ? ctx.user.id : undefined });
  if (req.xRequestId) {
    Sentry.setTag('requestId', req.xRequestId);
  }

  next();
};

export { sentryScopeHandler };

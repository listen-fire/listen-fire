// GET /api/v1/valuations/health — is the change-notification path alive, and
// is anything stuck in it.
//
// The reader has existed since the outbox was carved out (V-16); nothing
// published it, so valuations was the one product whose delivery loop could
// stop without any way to see it from outside. This is the peer of knowledge's
// `/api/v1/knowledge/graph/health` and asks' `/api/v1/asks/health`: the unit's own
// detail — including the last error text — behind the unit's own scope. The
// cross-product summary lives on the workers surface instead, and carries no
// free text because it is not authenticated.

import { Router } from 'express';

import { readDeliveryHealth } from '../../../../services/valuations_outbox/delivery';
import { internalError } from './shared';

const healthRouter: ReturnType<typeof Router> = Router();

healthRouter.get('/', async (_req, res) => {
  try {
    return res.status(200).json({ data: await readDeliveryHealth() });
  } catch (err) {
    return internalError(res, err);
  }
});

export { healthRouter };

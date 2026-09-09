import { Router } from 'express';

import { VALUATIONS_SCOPE, requireScope } from './shared';
import {
  legalEntitiesRouter,
  investmentsRouter,
  transactionsRouter,
  assetsRouter,
  assetTransfersRouter,
  pricesRouter,
  eventsRouter,
  exchangeRatesRouter,
} from './resources';
import { computeRouter } from './compute';
import { queryRouter } from './query';
import { commandsRouter } from './commands';
import { webhooksRouter } from './webhooks';
import { healthRouter } from './health';

const valuationsRouter: ReturnType<typeof Router> = Router();

valuationsRouter.use(requireScope(VALUATIONS_SCOPE));

valuationsRouter.use('/health', healthRouter);
valuationsRouter.use('/commands', commandsRouter);
valuationsRouter.use('/legal-entities', legalEntitiesRouter);
valuationsRouter.use('/investments', investmentsRouter);
valuationsRouter.use('/transactions', transactionsRouter);
valuationsRouter.use('/assets', assetsRouter);
valuationsRouter.use('/asset-transfers', assetTransfersRouter);
valuationsRouter.use('/prices', pricesRouter);
valuationsRouter.use('/events', eventsRouter);
valuationsRouter.use('/exchange-rates', exchangeRatesRouter);
valuationsRouter.use('/compute', computeRouter);
valuationsRouter.use('/query', queryRouter);
valuationsRouter.use('/webhooks', webhooksRouter);

export { valuationsRouter };

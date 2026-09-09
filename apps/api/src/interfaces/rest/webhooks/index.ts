import { Router } from 'express';

import { mailgunRouter } from './mailgun';

const webhookRouter: ReturnType<typeof Router> = Router();

webhookRouter.use('/mailgun', mailgunRouter);

export { webhookRouter };

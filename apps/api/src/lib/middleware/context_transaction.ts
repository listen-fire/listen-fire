import { RequestHandler } from 'express';

import { currentContext } from '../../services/context';

const contextTransactionHandler: RequestHandler = (_req, _res, next) => {
  const ctx = currentContext();
  ctx
    .enterTransaction()
    .then(() => {
      next();
    })
    .catch((err) => {
      next(err);
    });
};

export { contextTransactionHandler };

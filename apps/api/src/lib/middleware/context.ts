import { RequestHandler } from 'express';

import { Context } from '../../services/context';

const contextInjector: RequestHandler = (req, res, next) => {
  const ctx = new Context({ xRequestId: req.xRequestId, originId: req.xOriginId });
  ctx
    .run(() => {
      res.on('prefinish', () => ctx.end());
      req.on('error', (err) => ctx.error(err));

      next();
    })
    .catch((err) => {
      throw err;
    });
};

export { contextInjector };

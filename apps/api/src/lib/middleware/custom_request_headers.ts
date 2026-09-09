import { RequestHandler } from 'express';

const customHeadersExtractor: RequestHandler = (req, _res, next) => {
  const requestId = req.headers['x-request-id'];
  const originId = req.headers['x-listen-fire-origin'];
  req.xRequestId = typeof requestId === 'string' ? requestId : undefined;
  req.xOriginId = typeof originId === 'string' && originId.length > 0 ? originId : undefined;

  next();
};

export { customHeadersExtractor };

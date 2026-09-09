// The floor under an express router's handlers.
//
// Express 4 does not catch an async handler's REJECTION: a throw outside the
// handler's own try/catch leaves the request with NO RESPONSE AT ALL — a hung
// socket (`HTTP=000`), not a 500. bd41ec5d3 found the shape in a middleware and
// 58555e271 closed it for the knowledge router; this is that wrapper, lifted so
// the next router mounts through it rather than growing a second copy.
//
// Each router keeps its own error translation (the trace-id tag, the 400 it
// derives from a domain error), so the wrapper takes it rather than assuming
// one. Handlers still own the errors they expect; this only catches the escapes.

import type { RequestHandler } from 'express';

type Response = Parameters<RequestHandler>[1];

/** A router's last-resort error translator — the same `internalError` its
 *  handlers already call. */
type Fail = (res: Response, err: unknown) => unknown;

/**
 * Build the `route()` a router wraps each mount point in:
 * `knowledgeRouter.get('/nodes', route(nodesHandler))`.
 */
function catchingRoutes(fail: Fail): (handler: RequestHandler) => RequestHandler {
  return (handler) => (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch((err: unknown) => {
      // Once bytes are on the wire there is no status left to send — hand it to
      // express, which closes the connection rather than crashing the process.
      if (res.headersSent) return next(err);
      fail(res, err);
    });
  };
}

export { catchingRoutes };

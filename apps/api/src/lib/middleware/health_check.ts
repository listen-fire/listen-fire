import { RequestHandler } from 'express';

import { readWorkersHealth } from '../../startup/health';

/** The deploy platform's liveness probe. Its contract is the 201 — do not widen it. */
function healthCheck(): RequestHandler {
  return async (_, res) => {
    res.status(201).send();
  };
}

/**
 * Worker liveness, per mounted product (ST-11). Alongside the probe above
 * rather than inside it: the probe answers "is this process serving HTTP",
 * which stays true while every background loop is wedged.
 *
 * Unauthenticated, like the probe, because the operator of a self-hosted
 * deployment is whoever can reach the process — so the body carries ticks,
 * depths and flags, and no free text. Error DETAIL stays on each product's own
 * authenticated health route.
 *
 * Always 200 when the report can be assembled: it reports facts and leaves the
 * alerting thresholds (how stale is stale) to whoever is watching.
 */
function workersHealthCheck(): RequestHandler {
  return async (_, res, next) => {
    try {
      res.status(200).json(await readWorkersHealth());
    } catch (err) {
      next(err);
    }
  };
}

export { healthCheck, workersHealthCheck };

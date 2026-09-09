// The webhook_sync door's REST contract after the capture-then-ack split.
// Drives the real router over an in-process HTTP server (same idiom as
// connect_handshake.unit.test.ts) with the handler mocked, so what's under
// test is the route's own decisions:
//
//   • the Slack url_verification handshake still short-circuits FIRST,
//   • a production delivery is acked BEFORE the deferred half runs,
//   • a deferred failure never turns that 200 into an error,
//   • a test-harness delivery waits and reports dispatch errors inline,
//   • phase-1 refusals keep their status codes (404/400/401).

import express, { type Router } from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const handleInboundWebhook = jest.fn();

jest.mock('../../../services/webhook_sync/handler', () => ({
  handleInboundWebhook: (input: unknown) => handleInboundWebhook(input),
}));

jest.mock('../../../services/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { webhookSyncRouter } from '../webhookSync';

let server: Server;
let baseUrl: string;

beforeAll((done) => {
  const app = express();
  app.use('/api/public/webhook-sync', express.raw({ type: '*/*' }), webhookSyncRouter as Router);
  server = createServer(app);
  server.listen(0, () => {
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    done();
  });
});

afterAll((done) => {
  server.close(() => done());
});

async function post(path: string, body: unknown) {
  const res = await fetch(`${baseUrl}/api/public/webhook-sync${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** Resolves the first time `resolve` is handed out. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('POST /:provider/:subscriptionId — production deliveries', () => {
  it('acks before the deferred half finishes, then runs it', async () => {
    const gate = deferred();
    let deferredStarted = false;
    let deferredFinished = false;
    handleInboundWebhook.mockResolvedValue({
      ok: true,
      eventsProcessed: 3,
      runDeferred: async () => {
        deferredStarted = true;
        await gate.promise;
        deferredFinished = true;
        return { eventsProcessed: 3, perEventErrors: [] };
      },
    });

    const res = await post('/attio/sub-1', { any: 'payload' });

    // The 200 landed while the dispatch is still parked — that IS the change.
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, eventsProcessed: 3 });
    expect(deferredFinished).toBe(false);

    gate.resolve();
    await new Promise((r) => setTimeout(r, 20));
    expect(deferredStarted).toBe(true);
    expect(deferredFinished).toBe(true);
  });

  it('a rejected deferred half still leaves the delivery a 200', async () => {
    // Nothing depends on a provider retry — the receipt is the durability
    // story — so a post-ack explosion must not be reported as a bad delivery.
    handleInboundWebhook.mockResolvedValue({
      ok: true,
      eventsProcessed: 1,
      runDeferred: async () => {
        throw new Error('dispatch exploded');
      },
    });

    const res = await post('/attio/sub-1', { any: 'payload' });
    await new Promise((r) => setTimeout(r, 20));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, eventsProcessed: 1 });
  });

  it('never leaks per-event errors to a production sender', async () => {
    handleInboundWebhook.mockResolvedValue({
      ok: true,
      eventsProcessed: 1,
      runDeferred: async () => ({
        eventsProcessed: 0,
        perEventErrors: [{ event: {}, error: 'boom' }],
      }),
    });

    const res = await post('/attio/sub-1', { any: 'payload' });

    expect(res.body).toEqual({ ok: true, eventsProcessed: 1 });
  });
});

describe('POST /:provider/:subscriptionId — test-harness deliveries', () => {
  it('waits for the dispatch and reports its errors inline (the dev-loop contract)', async () => {
    let acked = false;
    handleInboundWebhook.mockResolvedValue({
      ok: true,
      eventsProcessed: 2,
      awaitDeferred: true,
      runDeferred: async () => {
        expect(acked).toBe(false);
        return {
          eventsProcessed: 1,
          perEventErrors: [{ event: { payload: {} }, error: 'movement blew up' }],
        };
      },
    });

    const res = await post('/attio/sub-1', { any: 'payload' });
    acked = true;

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      // The dispatch outcome, not the capture count — what it always reported.
      eventsProcessed: 1,
      perEventErrors: [{ event: { payload: {} }, error: 'movement blew up' }],
    });
  });

  it('omits perEventErrors when the harness delivery ran clean', async () => {
    handleInboundWebhook.mockResolvedValue({
      ok: true,
      eventsProcessed: 1,
      awaitDeferred: true,
      runDeferred: async () => ({ eventsProcessed: 1, perEventErrors: [] }),
    });

    expect((await post('/attio/sub-1', {})).body).toEqual({ ok: true, eventsProcessed: 1 });
  });
});

describe('POST /:provider/:subscriptionId — pre-ack refusals are unchanged', () => {
  it.each([
    ['unknown_provider', 404],
    ['subscription_not_found', 404],
    ['provider_mismatch', 400],
    ['signature_invalid', 401],
  ])('%s → %i', async (error, status) => {
    handleInboundWebhook.mockResolvedValue({ ok: false, eventsProcessed: 0, error });

    const res = await post('/attio/sub-1', {});

    expect(res.status).toBe(status);
    expect(res.body).toEqual({ error });
  });

  it('the Slack url_verification challenge short-circuits before the handler', async () => {
    handleInboundWebhook.mockResolvedValue({ ok: true, eventsProcessed: 0 });

    const res = await post('/slack/sub-1', { type: 'url_verification', challenge: 'abc-123' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ challenge: 'abc-123' });
    expect(handleInboundWebhook).not.toHaveBeenCalled();
  });
});

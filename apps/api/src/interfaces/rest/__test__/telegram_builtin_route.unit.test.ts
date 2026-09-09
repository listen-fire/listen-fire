// The shared built-in Telegram bot door's REST contract after the
// capture-then-ack split. Drives the real router over an in-process HTTP server
// with the shared-bot service mocked, so what's under test is the route's own
// decisions:
//
//   • a production delivery is acked BEFORE the deferred dispatch runs,
//   • a deferred failure never turns that 200 into anything else,
//   • a test-harness delivery waits and reports the dispatch outcome inline,
//   • the always-200 policy survives everything — auth refusals, a thrown
//     service, an unparseable body being the one exception (400, unchanged).
//
// Telegram permits answering a webhook with a Bot API method call in the
// RESPONSE BODY. This door has never used that (replies are explicit Bot API
// calls out of `handleStart`), which is what makes deferring the dispatch safe:
// nothing the sender sees depends on work done after the ack.

import express, { type Router } from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const handleSharedBotInbound = jest.fn();

jest.mock('../../../services/webhook_sync/telegram_builtin', () => ({
  handleSharedBotInbound: (raw: unknown) => handleSharedBotInbound(raw),
}));

jest.mock('../../../services/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { telegramBuiltinRouter } from '../telegramBuiltin';

let server: Server;
let baseUrl: string;

const ORIGINAL_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_BYPASS = process.env.ALLOW_UNSIGNED_WEBHOOKS;

beforeAll((done) => {
  const app = express();
  app.use('/api/public/telegram', express.raw({ type: '*/*' }), telegramBuiltinRouter as Router);
  server = createServer(app);
  server.listen(0, () => {
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    done();
  });
});

afterAll((done) => {
  if (ORIGINAL_SECRET === undefined) delete process.env.TELEGRAM_WEBHOOK_SECRET;
  else process.env.TELEGRAM_WEBHOOK_SECRET = ORIGINAL_SECRET;
  if (ORIGINAL_BYPASS === undefined) delete process.env.ALLOW_UNSIGNED_WEBHOOKS;
  else process.env.ALLOW_UNSIGNED_WEBHOOKS = ORIGINAL_BYPASS;
  process.env.NODE_ENV = ORIGINAL_NODE_ENV ?? 'test';
  server.close(() => done());
});

beforeEach(() => {
  handleSharedBotInbound.mockReset();
  // No secret configured + the explicit unsigned opt-in → the door is open, so
  // the tests below are about the ack boundary rather than the gate (the gate
  // has its own suite in services/webhook_sync/__test__/telegram-shared-bot).
  delete process.env.TELEGRAM_WEBHOOK_SECRET;
  process.env.ALLOW_UNSIGNED_WEBHOOKS = 'true';
  process.env.NODE_ENV = 'test';
});

async function post(body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${baseUrl}/api/public/telegram/builtin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
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

const UPDATE = { update_id: 1, message: { message_id: 42, from: { id: 999 }, text: 'hi' } };

describe('POST /builtin — production deliveries', () => {
  it('acks before the deferred dispatch finishes, then runs it', async () => {
    const gate = deferred();
    let deferredStarted = false;
    let deferredFinished = false;
    handleSharedBotInbound.mockResolvedValue({
      result: { ok: true, classification: 'message', routedTeamIds: ['team-A'] },
      runDeferred: async () => {
        deferredStarted = true;
        await gate.promise;
        deferredFinished = true;
        return { ok: true, classification: 'message', routedTeamIds: ['team-A'] };
      },
    });

    const res = await post(UPDATE);

    // The 200 landed while the movement is still parked — that IS the change.
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, classification: 'message', routedTeamIds: ['team-A'] });
    expect(deferredFinished).toBe(false);

    gate.resolve();
    await new Promise((r) => setTimeout(r, 20));
    expect(deferredStarted).toBe(true);
    expect(deferredFinished).toBe(true);
  });

  it('a rejected deferred half still leaves the delivery a 200', async () => {
    // Telegram retries anything that is not a prompt 2xx; the receipt is the
    // durability story, so a post-ack explosion must never earn a redelivery.
    handleSharedBotInbound.mockResolvedValue({
      result: { ok: true, classification: 'message', routedTeamIds: ['team-A'] },
      runDeferred: async () => {
        throw new Error('dispatch exploded');
      },
    });

    const res = await post(UPDATE);
    await new Promise((r) => setTimeout(r, 20));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, classification: 'message', routedTeamIds: ['team-A'] });
  });

  it('a delivery with nothing to run (a handshake) answers its result directly', async () => {
    handleSharedBotInbound.mockResolvedValue({
      result: { ok: true, classification: 'start', bind: { ok: true, email: 'ada@example.com' } },
    });

    const res = await post({ message: { from: { id: 999 }, text: '/start tok' } });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      classification: 'start',
      bind: { ok: true, email: 'ada@example.com' },
    });
  });
});

describe('POST /builtin — test-harness deliveries stay synchronous', () => {
  it('waits for the dispatch and answers with its outcome (the dev-loop contract)', async () => {
    let acked = false;
    handleSharedBotInbound.mockResolvedValue({
      result: { ok: true, classification: 'message', routedTeamIds: ['team-A', 'team-B'] },
      awaitDeferred: true,
      runDeferred: async () => {
        expect(acked).toBe(false);
        return { ok: true, classification: 'message', routedTeamIds: ['team-B'] };
      },
    });

    const res = await post(UPDATE);
    acked = true;

    expect(res.status).toBe(200);
    // The dispatch outcome, not the capture list — what it always reported.
    expect(res.body).toEqual({ ok: true, classification: 'message', routedTeamIds: ['team-B'] });
  });
});

describe('POST /builtin — the always-200 policy is unchanged', () => {
  it('an unauthorized delivery is a 200 carrying the classification', async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = 'the-real-secret';

    const res = await post(UPDATE, { 'X-Telegram-Bot-Api-Secret-Token': 'wrong' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false, classification: 'unauthorized' });
    expect(handleSharedBotInbound).not.toHaveBeenCalled();
  });

  it('a thrown service is a 200 with the error in the body', async () => {
    handleSharedBotInbound.mockRejectedValue(new Error('capture exploded'));

    const res = await post(UPDATE);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: false,
      classification: 'no_message',
      error: 'capture exploded',
    });
  });

  it('an unparseable body is still the one 400', async () => {
    const res = await post('{not json');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ ok: false, error: 'invalid_json' });
  });
});

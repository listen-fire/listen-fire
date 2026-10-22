// The keyed provider talks to a real (fake) Messages server: the SDK must not
// retry a 429 itself (it would sleep inside the held permit), and the throttle
// a 429 sets lands on that API key alone.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  HOLD_MS,
  installLimiter,
  MemoryLimiter,
  throttleKey,
  type LimitGrant,
  type LimitRequest,
} from 'movement-engine/public/limiter';
import { anthropicClient } from '../client';
import { anthropicKeyedChatProvider } from '../keyed_provider';

const TOO_MANY = { type: 'error', error: { type: 'rate_limit_error', message: 'slow' } };

/** The Messages stream the client reads: one text block, "ok". */
function streamOk(res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const events: [string, unknown][] = [
    ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
    ['message_stop', { type: 'message_stop' }],
  ];
  for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
}

function tooMany(res: ServerResponse, retryAfter: string): void {
  res.writeHead(429, { 'content-type': 'application/json', 'retry-after': retryAfter });
  res.end(JSON.stringify(TOO_MANY));
}

/** Counts permits out, so a test can see the permit is not held while waiting. */
class CountingLimiter extends MemoryLimiter {
  held = 0;
  override async acquire(request: LimitRequest): Promise<LimitGrant> {
    const grant = await super.acquire(request);
    if (grant.granted) this.held += 1;
    return grant;
  }
  override async release(permit: string): Promise<void> {
    this.held -= 1;
    await super.release(permit);
  }
}

function chatOver(apiKey: string, baseUrl: string) {
  const client = anthropicKeyedChatProvider({ apiKey, baseUrl });
  return anthropicClient({
    chatCallFor: (name) => ({ client, wireModel: name, resolved: { preferred: name, provider: 'anthropic', wireModel: name } }),
    recordUsage: async () => undefined,
    logFields: () => ({}),
  });
}

describe('the keyed provider against a Messages server answering 429', () => {
  let server: Server;
  let baseUrl: string;
  let arrivals: { at: number; key: string | undefined }[];
  let handler: (req: IncomingMessage, res: ServerResponse) => void;
  let limiter: CountingLimiter;

  beforeEach(async () => {
    arrivals = [];
    server = createServer((req, res) => {
      arrivals.push({ at: Date.now(), key: req.headers['x-api-key']?.toString() });
      req.resume();
      handler(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    limiter = new CountingLimiter();
    installLimiter(limiter);
  });

  afterEach(async () => {
    installLimiter(new MemoryLimiter());
    await new Promise((resolve) => server.close(resolve));
  });

  it('sees exactly one request before the throttle, releases the permit, and retries after Retry-After', async () => {
    handler = (_req, res) => (arrivals.length === 1 ? tooMany(res, '2') : streamOk(res));
    const reply = chatOver('sk-ant-secret-one', baseUrl).anthropicChat({ model: 'claude-sonnet-5', system: 'sys', userMessage: 'hi' });

    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(arrivals).toHaveLength(1);
    expect(limiter.held).toBe(0);

    await expect(reply).resolves.toBe('ok');
    expect(arrivals).toHaveLength(2);
    expect(arrivals[1]!.at - arrivals[0]!.at).toBeGreaterThanOrEqual(1_990);
  }, 15_000);

  it("leaves another key open when one key meets a 429, and the throttle key never holds the key", async () => {
    // Key A is refused once, with a short wait; key B is never refused.
    handler = (req, res) =>
      req.headers['x-api-key']?.toString().includes('-A') && !refused ? ((refused = true), tooMany(res, '1')) : streamOk(res);
    let refused = false;
    const keyA = 'sk-ant-secret-A1234567890';
    const keyB = 'sk-ant-secret-B1234567890';
    const providerA = anthropicKeyedChatProvider({ apiKey: keyA, baseUrl });
    const providerB = anthropicKeyedChatProvider({ apiKey: keyB, baseUrl });
    const callerFor = (credential: string | undefined) => ({ module: '@lf/anthropic', team: '', ...(credential ? { credential } : {}) });
    const acquire = (credential: string | undefined) =>
      limiter.acquire({ key: throttleKey(callerFor(credential)), cost: 1, limits: [], holdMs: HOLD_MS });

    const replyA = chatOver(keyA, baseUrl).anthropicChat({ model: 'claude-sonnet-5', system: 'sys', userMessage: 'hi' });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(arrivals).toHaveLength(1);

    expect((await acquire(providerA.credential)).granted).toBe(false);
    const grantB = await acquire(providerB.credential);
    expect(grantB.granted).toBe(true);

    for (const key of [throttleKey(callerFor(providerA.credential)), throttleKey(callerFor(providerB.credential))]) {
      expect(key).not.toContain(keyA);
      expect(key).not.toContain(keyB);
      expect(key).not.toContain('sk-ant');
    }
    expect(providerA.credential).not.toBe(providerB.credential);

    if (grantB.granted) await limiter.release(grantB.permit);
    await expect(chatOver(keyB, baseUrl).anthropicChat({ model: 'claude-sonnet-5', system: 'sys', userMessage: 'hi' })).resolves.toBe('ok');
    await expect(replyA).resolves.toBe('ok');
  }, 15_000);
});

// A success reports the key's remaining budget in its headers: spent, it
// closes the key until the reset (the next request waits, as after a 429);
// not spent, it changes nothing.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { installLimiter, MemoryLimiter } from 'movement-engine/public/limiter';
import { anthropicClient } from '../client';
import { anthropicKeyedChatProvider } from '../keyed_provider';

function answerOk(res: ServerResponse, headers: Record<string, string>): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', ...headers });
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

function chatOver(apiKey: string, baseUrl: string) {
  const client = anthropicKeyedChatProvider({ apiKey, baseUrl });
  return anthropicClient({
    chatCallFor: (name) => ({ client, wireModel: name, resolved: { preferred: name, provider: 'anthropic', wireModel: name } }),
    recordUsage: async () => undefined,
    logFields: () => ({}),
  });
}

describe('the keyed provider against a Messages server reporting its budget on success', () => {
  let server: Server;
  let baseUrl: string;
  let arrivals: number[];
  let budget: () => Record<string, string>;

  beforeEach(async () => {
    arrivals = [];
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      arrivals.push(Date.now());
      req.resume();
      answerOk(res, budget());
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    installLimiter(new MemoryLimiter());
  });

  afterEach(async () => {
    installLimiter(new MemoryLimiter());
    await new Promise((resolve) => server.close(resolve));
  });

  const ask = (key: string) => chatOver(key, baseUrl).anthropicChat({ model: 'claude-sonnet-5', system: 'sys', userMessage: 'hi' });

  it('holds the next request until the reset when the budget is spent', async () => {
    budget = () => ({
      'anthropic-ratelimit-requests-remaining': '0',
      'anthropic-ratelimit-requests-reset': new Date(Date.now() + 2_000).toISOString(),
    });
    await expect(ask('sk-ant-spent')).resolves.toBe('ok');
    await expect(ask('sk-ant-spent')).resolves.toBe('ok');
    expect(arrivals).toHaveLength(2);
    expect(arrivals[1]! - arrivals[0]!).toBeGreaterThanOrEqual(1_900);
  }, 15_000);

  it('leaves the next request alone while budget remains', async () => {
    budget = () => ({
      'anthropic-ratelimit-requests-remaining': '41',
      'anthropic-ratelimit-requests-reset': new Date(Date.now() + 2_000).toISOString(),
    });
    await expect(ask('sk-ant-plenty')).resolves.toBe('ok');
    await expect(ask('sk-ant-plenty')).resolves.toBe('ok');
    expect(arrivals[1]! - arrivals[0]!).toBeLessThan(1_000);
  }, 15_000);
});

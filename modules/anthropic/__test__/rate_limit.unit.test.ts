// A vendor's 429 is a throttle on the model caller's key in the limiter slot,
// not a sleep inside the request's permit: every model request made in this
// process (or by any host sharing the limiter) waits until the vendor's
// Retry-After is over.

import type Anthropic from '@anthropic-ai/sdk';
import type { ChatProvider } from '../chat';

import { HOLD_MS, installLimiter, MemoryLimiter, throttleKey, type Limiter } from 'movement-engine/public/limiter';
import { anthropicClient } from '../client';

const MODELS_KEY = throttleKey({ module: '@lf/anthropic', team: '' });

function message(text: string): Anthropic.Message {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5',
    container: null,
    content: [{ type: 'text', text, citations: null }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    stop_details: null,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      output_tokens_details: null,
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      inference_geo: null,
      server_tool_use: null,
      service_tier: null,
    },
  };
}

class RateLimited extends Error {
  readonly headers: Record<string, string>;
  constructor(headers: Record<string, string>) {
    super('429 {"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}');
    this.headers = headers;
  }
}

/** A provider answering 429 (with `headers`) first, then "ok". */
function provider(headers: Record<string, string>): { client: ChatProvider; requests: () => number } {
  let requests = 0;
  const finalMessage = async () => {
    requests += 1;
    if (requests === 1) throw new RateLimited(headers);
    return message('ok');
  };
  return {
    client: { messages: { create: finalMessage, stream: () => ({ finalMessage }) } },
    requests: () => requests,
  };
}

function chatOver(client: ChatProvider) {
  return anthropicClient({
    chatCallFor: (name) => ({ client, wireModel: name, resolved: { preferred: name, provider: 'anthropic', wireModel: name } }),
    recordUsage: async () => undefined,
    logFields: () => ({}),
  });
}

async function closed(limiter: Limiter): Promise<string | undefined> {
  const grant = await limiter.acquire({ key: MODELS_KEY, cost: 1, limits: [], holdMs: HOLD_MS });
  if (grant.granted) {
    await limiter.release(grant.permit);
    return undefined;
  }
  return grant.retryAt;
}

describe("a model vendor's 429", () => {
  let limiter: MemoryLimiter;

  beforeEach(() => {
    jest.useFakeTimers({ now: Date.parse('2026-10-22T12:00:00Z') });
    limiter = new MemoryLimiter();
    installLimiter(limiter);
  });

  afterEach(() => {
    installLimiter(new MemoryLimiter());
    jest.useRealTimers();
  });

  it("throttles the model caller's key for the Retry-After, and a second request waits until then", async () => {
    const start = Date.now();
    const { client, requests } = provider({ 'retry-after': '7' });
    const chat = chatOver(client);
    const first = chat.anthropicChat({ model: 'claude-sonnet-5', system: 'sys', userMessage: 'one' });
    await jest.advanceTimersByTimeAsync(0);
    expect(requests()).toBe(1);
    expect(await closed(limiter)).toBe(new Date(start + 7_000).toISOString());

    const second = chat.anthropicChat({ model: 'claude-sonnet-5', system: 'sys', userMessage: 'two' });
    await jest.advanceTimersByTimeAsync(6_999);
    expect(requests()).toBe(1);
    await jest.advanceTimersByTimeAsync(1);
    await expect(first).resolves.toBe('ok');
    await expect(second).resolves.toBe('ok');
    expect(requests()).toBe(3);
  });

  it("throttles for behaviour.json's rateLimitWaitMs when the vendor names no wait", async () => {
    const start = Date.now();
    const { client } = provider({});
    const first = chatOver(client).anthropicChat({ model: 'claude-sonnet-5', system: 'sys', userMessage: 'one' });
    await jest.advanceTimersByTimeAsync(0);
    expect(await closed(limiter)).toBe(new Date(start + 30_000).toISOString());
    await jest.advanceTimersByTimeAsync(30_000);
    await expect(first).resolves.toBe('ok');
  });
});

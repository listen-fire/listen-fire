/**
 * Integration-style coverage for the `dev:inject mailgun-email` wrapper.
 *
 * Drives `buildMailgunRequestBody` end-to-end with the real bundled
 * fixture and asserts:
 *
 *   - the body matches the Mailgun webhook schema the adapter accepts
 *   - the `inbox+pi-PLACEHOLDER@example.com` placeholder is substituted
 *     in every field that contains it (recipient, To, message-headers)
 *   - the HMAC the wrapper attaches passes the adapter's verifier
 *     contract (same shape as `InboundMailgunAdapter.verifyMailgunValues`)
 *   - from / subject overrides land where expected
 */
import * as fs from 'node:fs/promises';
import { createHmac, timingSafeEqual } from 'node:crypto';

import {
  buildMailgunRequestBody,
  DEFAULT_MAILGUN_FIXTURE,
  DEFAULT_MAILGUN_API_KEY,
  injectMailgunEmail,
  getApiBaseUrl,
} from '../inject';
import { DEV_LOOP_EMAIL } from '../_lib';

function verifyAdapterSignature(
  apiKey: string,
  body: { timestamp: string; token: string; signature: string },
): boolean {
  const expected = createHmac('sha256', apiKey)
    .update(body.timestamp + body.token)
    .digest('hex');
  return timingSafeEqual(Buffer.from(body.signature), Buffer.from(expected));
}

describe('buildMailgunRequestBody', () => {
  let fixture: Record<string, unknown>;

  beforeAll(async () => {
    const raw = await fs.readFile(DEFAULT_MAILGUN_FIXTURE, 'utf-8');
    fixture = JSON.parse(raw);
  });

  test('default fixture has the placeholder we will substitute', () => {
    expect(fixture.recipient).toMatch(/inbox\+pi-PLACEHOLDER@example\.com/);
    expect(fixture.To).toMatch(/inbox\+pi-PLACEHOLDER@example\.com/);
    expect(fixture['message-headers']).toMatch(/inbox\+pi-PLACEHOLDER@example\.com/);
  });

  test('substitutes placeholder recipient across recipient / To / message-headers', () => {
    const body = buildMailgunRequestBody({
      fixture,
      to: 'inbox+pi-realkey42@example.com',
      apiKey: 'test-harness-dummy-key',
    });
    expect(body.recipient).toBe('inbox+pi-realkey42@example.com');
    expect(body.To).toBe('inbox+pi-realkey42@example.com');
    expect(body['message-headers']).toEqual(expect.stringContaining('inbox+pi-realkey42@example.com'));
    expect(body['message-headers']).toEqual(expect.not.stringContaining('PLACEHOLDER'));
  });

  test('signed body passes the adapter verifier contract', () => {
    const body = buildMailgunRequestBody({
      fixture,
      to: 'inbox+pi-x@example.com',
      apiKey: 'test-harness-dummy-key',
    });
    expect(
      verifyAdapterSignature('test-harness-dummy-key', {
        timestamp: body.timestamp as string,
        token: body.token as string,
        signature: body.signature as string,
      }),
    ).toBe(true);
  });

  test('signature fails verification under a different api key', () => {
    const body = buildMailgunRequestBody({
      fixture,
      to: 'inbox+pi-x@example.com',
      apiKey: 'test-harness-dummy-key',
    });
    expect(
      verifyAdapterSignature('some-other-key', {
        timestamp: body.timestamp as string,
        token: body.token as string,
        signature: body.signature as string,
      }),
    ).toBe(false);
  });

  test('--from override sets both sender and From', () => {
    const body = buildMailgunRequestBody({
      fixture,
      to: 'inbox+pi-x@example.com',
      from: 'override@example.com',
      apiKey: 'k',
    });
    expect(body.sender).toBe('override@example.com');
    expect(body.From).toBe('override@example.com');
  });

  test('--subject override sets the subject', () => {
    const body = buildMailgunRequestBody({
      fixture,
      to: 'inbox+pi-x@example.com',
      subject: 'A new subject',
      apiKey: 'k',
    });
    expect(body.subject).toBe('A new subject');
  });

  test('deterministic timestamp + token round-trip', () => {
    const body = buildMailgunRequestBody({
      fixture,
      to: 'inbox+pi-x@example.com',
      apiKey: 'k',
      now: { timestamp: '1700000000', token: 'fixed-token' },
    });
    expect(body.timestamp).toBe('1700000000');
    expect(body.token).toBe('fixed-token');
    const expected = createHmac('sha256', 'k')
      .update('1700000000' + 'fixed-token')
      .digest('hex');
    expect(body.signature).toBe(expected);
  });

  test('does not mutate the input fixture', () => {
    const before = JSON.stringify(fixture);
    buildMailgunRequestBody({
      fixture,
      to: 'inbox+pi-x@example.com',
      from: 'other@example.com',
      subject: 'other',
      apiKey: 'k',
    });
    expect(JSON.stringify(fixture)).toBe(before);
  });

  test('default fixture sender resolves to the dev-loop user', () => {
    // The plus-key dispatch on /api/mailgun/callback can only resolve a
    // team when the sender corresponds to a known user_email row. The
    // dev-loop seed creates `dev-loop@listen-fire.local` — bake that into the
    // fixture so the e2e path doesn't NULL-land in inbound_payload.
    expect(fixture.sender).toBe(DEV_LOOP_EMAIL);
    expect(fixture.From).toEqual(expect.stringContaining(DEV_LOOP_EMAIL));
  });
});

describe('injectMailgunEmail apiKey default', () => {
  const ORIGINAL_FETCH = global.fetch;
  const ORIGINAL_ENV = process.env.MAILGUN_API_KEY;

  let captured: { url: string; body: any } | undefined;

  beforeEach(() => {
    captured = undefined;
    global.fetch = (async (url: any, init: any) => {
      captured = {
        url: String(url),
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      };
      return {
        ok: true,
        status: 200,
        text: async () => '{}',
      } as any;
    }) as any;
  });

  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
    if (ORIGINAL_ENV === undefined) {
      delete process.env.MAILGUN_API_KEY;
    } else {
      process.env.MAILGUN_API_KEY = ORIGINAL_ENV;
    }
  });

  function verify(apiKey: string, body: any): boolean {
    const expected = createHmac('sha256', apiKey)
      .update(body.timestamp + body.token)
      .digest('hex');
    return timingSafeEqual(Buffer.from(body.signature), Buffer.from(expected));
  }

  test('defaults apiKey to test-harness-dummy-key when none supplied', async () => {
    process.env.MAILGUN_API_KEY = 'a-real-mailgun-key-from-dotenv';

    await injectMailgunEmail({ to: 'inbox+pi-x@example.com' });

    expect(captured).toBeDefined();
    expect(captured!.url).toContain('/api/mailgun/callback');
    expect(DEFAULT_MAILGUN_API_KEY).toBe('test-harness-dummy-key');
    expect(verify(DEFAULT_MAILGUN_API_KEY, captured!.body)).toBe(true);
    expect(verify('a-real-mailgun-key-from-dotenv', captured!.body)).toBe(false);
  });

  test('uses --api-key override when supplied (real-mailgun path still works)', async () => {
    await injectMailgunEmail({
      to: 'inbox+pi-x@example.com',
      apiKey: 'an-explicit-override-key',
    });

    expect(captured).toBeDefined();
    expect(verify('an-explicit-override-key', captured!.body)).toBe(true);
    expect(verify(DEFAULT_MAILGUN_API_KEY, captured!.body)).toBe(false);
  });

  test('ignores process.env.MAILGUN_API_KEY entirely (no silent fallback)', async () => {
    process.env.MAILGUN_API_KEY = 'env-key-should-not-be-picked-up';

    await injectMailgunEmail({ to: 'inbox+pi-x@example.com' });

    expect(verify('env-key-should-not-be-picked-up', captured!.body)).toBe(false);
    expect(verify(DEFAULT_MAILGUN_API_KEY, captured!.body)).toBe(true);
  });
});

/**
 * V10: the base URL is resolved lazily at call time. This means
 * `_profile_loader`'s `applyEnv` (which runs at import time before any
 * handler executes) can populate `API_BASE_URL` for the agent stack
 * (port 3500) and we'll pick it up — without the prior module-load-time
 * capture freezing the default 3000.
 */
describe('getApiBaseUrl — lazy resolution', () => {
  const ORIGINAL = process.env.API_BASE_URL;

  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env.API_BASE_URL;
    } else {
      process.env.API_BASE_URL = ORIGINAL;
    }
  });

  test('reads process.env.API_BASE_URL at call time (dev-loop profile case)', () => {
    // Simulate the _profile_loader having merged the agent stack's port
    // *after* the module loaded. With the V10 lazy getter we still see it.
    delete process.env.API_BASE_URL;
    expect(getApiBaseUrl()).toBe('http://localhost:3000');

    process.env.API_BASE_URL = 'http://localhost:3500';
    expect(getApiBaseUrl()).toBe('http://localhost:3500');
  });

  test('explicit env override wins over the default (regression for the shell-prefix path)', () => {
    process.env.API_BASE_URL = 'https://api.production.example';
    expect(getApiBaseUrl()).toBe('https://api.production.example');
  });

  test('falls back to localhost:3000 when nothing is set', () => {
    delete process.env.API_BASE_URL;
    expect(getApiBaseUrl()).toBe('http://localhost:3000');
  });
});

describe('injectRaw — base URL routes through getApiBaseUrl()', () => {
  const ORIGINAL_FETCH = global.fetch;
  const ORIGINAL_BASE = process.env.API_BASE_URL;
  let captured: { url: string } | undefined;

  beforeEach(() => {
    captured = undefined;
    global.fetch = (async (url: any) => {
      captured = { url: String(url) };
      return {
        ok: true,
        status: 200,
        text: async () => '{}',
      } as any;
    }) as any;
  });

  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
    if (ORIGINAL_BASE === undefined) {
      delete process.env.API_BASE_URL;
    } else {
      process.env.API_BASE_URL = ORIGINAL_BASE;
    }
  });

  test('injectMailgunEmail uses the env-resolved base URL at call time', async () => {
    process.env.API_BASE_URL = 'http://localhost:3500';
    await injectMailgunEmail({ to: 'inbox+pi-x@example.com' });
    expect(captured!.url).toBe('http://localhost:3500/api/mailgun/callback');
  });

  test('changes to API_BASE_URL between calls are picked up (no module-load freeze)', async () => {
    process.env.API_BASE_URL = 'http://localhost:3500';
    await injectMailgunEmail({ to: 'inbox+pi-x@example.com' });
    expect(captured!.url).toBe('http://localhost:3500/api/mailgun/callback');

    process.env.API_BASE_URL = 'http://localhost:9999';
    await injectMailgunEmail({ to: 'inbox+pi-x@example.com' });
    expect(captured!.url).toBe('http://localhost:9999/api/mailgun/callback');
  });
});

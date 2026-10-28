// The module's seams with its host: how the context's credential becomes a
// client and the door's secret, and what the module declares.

import { emptyOcrSlot, type CredentialFields, type ModuleContext } from 'module-kit';
import { emptyBrowserSlot } from 'movement-engine/public/browser';

import { STRIPE_API_VERSION } from '../api_client';
import { STRIPE_EVENT_TYPES } from '../types';
import { stripeClientFrom, stripeDoorFrom, stripeModule } from '../index';

interface Seen {
  url: string;
  headers: Record<string, string>;
}

function contextOver(fields: () => CredentialFields, config: { baseUrlOverride?: string } = {}): { ctx: ModuleContext; seen: Seen[] } {
  const refuse = (): never => {
    throw new Error('not used');
  };
  const seen: Seen[] = [];
  const ctx: ModuleContext = {
    credential: { name: 'stripe', fields: async () => fields(), update: async () => refuse() },
    spend: { charge: () => undefined },
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)) });
      return new Response(JSON.stringify({ object: 'list', data: [], has_more: false }), { status: 200 });
    }) as typeof fetch,
    log: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    files: { put: refuse, read: refuse, expose: refuse },
    kv: { get: refuse, set: refuse, delete: refuse, list: refuse, compareAndSet: refuse },
    models: { chat: refuse, chatStructured: refuse },
    identities: { list: refuse, find: refuse },
    browser: emptyBrowserSlot('none'),
    ocr: emptyOcrSlot('none'),
    config: { tenant: 'team-1', constructionArgs: {}, ...config },
  };
  return { ctx, seen };
}

describe('stripeClientFrom', () => {
  it('says how to add a key when the credential holds none', async () => {
    await expect(stripeClientFrom(contextOver(() => ({})).ctx)()).rejects.toThrow(/holds no API key\. Add one: lf credential add --module stripe/);
  });

  it('reaches api.stripe.com through the host fetch, with the key and the pinned API version', async () => {
    const { ctx, seen } = contextOver(() => ({ apiKey: 'rk_test_x' }));
    await (await stripeClientFrom(ctx)()).listCustomers({ email: 'ada@example.com' }, 1);
    expect(seen).toEqual([
      {
        url: 'https://api.stripe.com/v1/customers?email=ada%40example.com&limit=1',
        headers: { Authorization: 'Bearer rk_test_x', 'Stripe-Version': STRIPE_API_VERSION, 'User-Agent': 'listen-fire' },
      },
    ]);
  });

  it('reaches the host base URL override (the dev loop fake) instead', async () => {
    const { ctx, seen } = contextOver(() => ({ apiKey: 'k' }), { baseUrlOverride: 'http://127.0.0.1:1/stripe/' });
    await (await stripeClientFrom(ctx)()).listInvoices({}, 1);
    expect(seen.map((s) => s.url)).toEqual(['http://127.0.0.1:1/stripe/v1/invoices?limit=1']);
  });

  it('reads the credential per call, so an edit between calls is seen by the next', async () => {
    let fields: CredentialFields = { apiKey: 'one' };
    const { ctx, seen } = contextOver(() => fields);
    const source = stripeClientFrom(ctx);
    const first = await source();
    expect(await source()).toBe(first);
    fields = { apiKey: 'two' };
    await (await source()).listInvoices({}, 1);
    expect(seen.map((s) => s.headers.Authorization)).toEqual(['Bearer two']);
  });
});

describe('stripeDoorFrom', () => {
  it('reads the signing secret off the credential, and none when it is empty', async () => {
    let fields: CredentialFields = { apiKey: 'k', webhookSecret: ' whsec_1 ' };
    const door = stripeDoorFrom(contextOver(() => fields).ctx);
    expect(await door.webhookSecret()).toBe('whsec_1');
    fields = { apiKey: 'k', webhookSecret: '' };
    expect(await door.webhookSecret()).toBeUndefined();
  });
});

describe('stripeModule', () => {
  it('declares an API key and an optional signing secret, and a door whose secret Stripe issues', () => {
    expect(stripeModule.credentials[0]?.fields.map((f) => [f.name, f.optional === true])).toEqual([
      ['apiKey', false],
      ['webhookSecret', true],
    ]);
    expect(stripeModule.inbound).toEqual({ providerKey: 'stripe', scheme: 'module', secretIssuedBy: 'provider' });
  });

  it('is a webhook source whose events are Stripe’s event types, and writes nothing', () => {
    expect(stripeModule.manifest.supportedTriggers).toEqual(['webhook']);
    expect(stripeModule.manifest.subscribableEvents).toEqual([...STRIPE_EVENT_TYPES]);
    expect(STRIPE_EVENT_TYPES).toEqual(expect.arrayContaining(['invoice.payment_failed', 'customer.subscription.deleted', 'customer.created']));
    expect(stripeModule.manifest.methods).toEqual(expect.arrayContaining(['checkInbound', 'listEventTypes', 'getRelated']));
    for (const write of ['createRecord', 'updateRecord', 'deleteRecord']) expect(stripeModule.manifest.methods).not.toContain(write);
  });
});

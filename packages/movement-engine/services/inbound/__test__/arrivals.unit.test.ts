// What a delivery says landed on listenable edges (adapter protocol 2.5) is
// handed to the run host to log, which wakes each wait parked on its record:
// on a signed delivery's reading, on a module's acceptance (whose reply the
// door answers once the delivery is kept), and at the wake door, which
// refuses the keys a wake named before 2.5.

import { createHmac } from 'node:crypto';

import type { Arrival } from 'engine-contracts';

import type { DiscriminableEvent } from '../../translation_graph/adapter';
import { CONTRACT_PROVIDER_KEY, CONTRACT_PUSH_TYPE, memoryInboundStores, type ContractWorld } from '../contract';
import { answerDelivery, type InboundStore } from '../deliver';
import { answerWake } from '../push';
import { CHECKED_BY_MODULE } from '../verify';

const TEAM = 'team-contract';
const SECRET = 'contract-secret';

const LANDED: Arrival = { edge: 'Comments', key: 'thread:c1', identity: 'k1', landing: { recordType: 'Comment', fields: { Text: 'hi' } } };
const GONE: Arrival = { edge: 'Comments', key: 'thread:c2', gone: true };

const WORLD: ContractWorld = {
  providers: [{ providerKey: CONTRACT_PROVIDER_KEY, scheme: 'hmac_sha256_hex', signatureHeaders: ['x-crm-signature'] }],
  subscriptions: [{ id: 'sub-crm', teamId: TEAM, providerKey: CONTRACT_PROVIDER_KEY, secret: SECRET }],
  pushInstalls: [{ teamId: TEAM, adapterType: CONTRACT_PUSH_TYPE, credential: 'push-credential' }],
  faults: {},
};

/** The stores, with every arrival the run host was handed and for whom. */
function storesLogging(world: ContractWorld = WORLD) {
  const stores = memoryInboundStores(world);
  const logged: Array<{ adapterType: string; teamId: string; arrivals: readonly Arrival[] }> = [];
  const keep = <S extends { logArrivals(input: { adapterType: string; teamId: string; arrivals: readonly Arrival[] }): Promise<void> }>(store: S): S => ({
    ...store,
    logArrivals: async (input) => {
      logged.push(input);
      await store.logArrivals(input);
    },
  });
  return { ...stores, store: keep(stores.store), push: keep(stores.push), logged };
}

function signed(body: unknown) {
  const rawBody = Buffer.from(JSON.stringify(body), 'utf-8');
  return { rawBody, headers: { 'x-crm-signature': `sha256=${createHmac('sha256', SECRET).update(rawBody).digest('hex')}` } };
}

describe("a delivery's arrivals", () => {
  it('are handed to the run host to log, with the events or without them', async () => {
    const { store, host, logged, observed } = storesLogging();
    const withEvents = await answerDelivery(store, host, { provider: 'contract_crm', subscriptionId: 'sub-crm', ...signed({ events: [{ n: 1 }], arrivals: [LANDED] }) });
    expect([withEvents.status, withEvents.body]).toEqual([200, { ok: true, eventsProcessed: 1 }]);
    const alone = await answerDelivery(store, host, { provider: 'contract_crm', subscriptionId: 'sub-crm', ...signed({ arrivals: [GONE] }) });
    expect([alone.status, alone.body]).toEqual([200, { ok: true, eventsProcessed: 0 }]);
    expect(logged).toEqual([
      { adapterType: 'contract_crm', teamId: TEAM, arrivals: [LANDED] },
      { adapterType: 'contract_crm', teamId: TEAM, arrivals: [GONE] },
    ]);
    expect(observed().arrivals).toEqual([LANDED, GONE]);
  });

  it('that cannot be logged fail the delivery, so the sender retries', async () => {
    const { store, host } = storesLogging({ ...WORLD, faults: { logArrivals: true } });
    const answer = await answerDelivery(store, host, { provider: 'contract_crm', subscriptionId: 'sub-crm', ...signed({ arrivals: [LANDED] }) });
    expect([answer.status, answer.body]).toEqual([500, { error: 'internal' }]);
  });
});

describe("a module's acceptance", () => {
  /** A door whose module checks its own inbound and accepts what `accepted` says. */
  function moduleDoor(accepted: { events?: DiscriminableEvent[]; arrivals?: Arrival[]; reply?: { status: number; html?: string } }) {
    const logged: Array<readonly Arrival[]> = [];
    const queued: DiscriminableEvent[] = [];
    const store: InboundStore<DiscriminableEvent> = {
      findSubscription: async (id) => ({ id, teamId: TEAM, providerKey: 'FORMS', credentialsId: 'credential', secret: SECRET, grandfatheredUnsigned: false }),
      knowsProvider: () => true,
      intercepts: () => [],
      sourceFor: async () => ({
        verifier: CHECKED_BY_MODULE,
        secret: SECRET,
        open: async () => ({
          adapterType: 'forms',
          credentialsId: 'credential',
          adapter: { adapterType: 'forms', checkInbound: async () => ({ outcome: 'accepted', events: accepted.events ?? [], ...accepted }) },
        }),
      }),
      verifiesSignature: () => true,
      capture: async ({ event }) => event,
      saveCheckpoint: async () => {},
      enqueue: async ({ event }) => {
        queued.push(event);
      },
      logArrivals: async ({ arrivals }) => {
        logged.push(arrivals);
      },
    };
    return { store, logged, queued, host: { notify: () => {} } };
  }

  it('is answered with its reply once the delivery is kept, its arrivals logged', async () => {
    const door = moduleDoor({ arrivals: [LANDED], reply: { status: 200, html: '<p>Thanks: your answer was recorded.</p>' } });
    const answer = await answerDelivery(door.store, door.host, { provider: 'forms', subscriptionId: 'sub-forms', rawBody: Buffer.from('Answer=yes'), headers: {} });
    expect([answer.status, answer.body, answer.contentType]).toEqual([200, '<p>Thanks: your answer was recorded.</p>', 'text/html']);
    expect(door.logged).toEqual([[LANDED]]);
  });

  it('with nothing to run and no reply is acknowledged as the door always did', async () => {
    const door = moduleDoor({});
    const answer = await answerDelivery(door.store, door.host, { provider: 'forms', subscriptionId: 'sub-forms', rawBody: Buffer.from('{}'), headers: {} });
    expect([answer.status, answer.body]).toEqual([200, { ok: true, eventsProcessed: 0 }]);
    expect(door.logged).toEqual([]);
  });
});

describe('the wake door', () => {
  const caller = { adapterType: CONTRACT_PUSH_TYPE, headers: { authorization: 'Bearer push-credential' } };

  it('hands what arrived to the run host to log: 202 accepted', async () => {
    const { push, logged } = storesLogging();
    const answer = await answerWake(push, { ...caller, body: { arrivals: [LANDED, GONE] } });
    expect([answer.status, answer.body]).toEqual([202, { accepted: 2 }]);
    expect(logged).toEqual([{ adapterType: CONTRACT_PUSH_TYPE, teamId: TEAM, arrivals: [LANDED, GONE] }]);
  });

  it('refuses a push naming keys, naming adapter protocol 2.5, and logs nothing', async () => {
    const { push, logged } = storesLogging();
    for (const body of [{ keys: ['thread:c1'] }, { keys: ['thread:c1'], arrivals: [LANDED] }]) {
      const answer = await answerWake(push, { ...caller, body });
      expect(answer.status).toBe(400);
      const issues = (answer.body as { issues: Array<{ path: string; message: string }> }).issues;
      expect(issues[0]?.path).toBe('keys');
      expect(issues[0]?.message).toContain('adapter protocol 2.5');
    }
    expect(logged).toEqual([]);
  });
});

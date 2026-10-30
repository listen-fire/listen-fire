// Arrivals over the kit (adapter protocol 2.5): a server lists `awaitKeys`
// when its adapter offers the capability, still stating 2.0, and answers it
// from the capability; a delivery's acceptance carries what arrived.

import { Readable } from 'node:stream';

import { BASE_RUNTIME_CAPABILITIES, METHODS, PROTOCOL_VERSION } from 'engine-contracts';

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Adapter } from 'module-runtime/adapter';

import { accepted } from '../inbound';
import { adapterManifestResult, adapterProtocolMethods, createAdapterProtocolHandler } from '../server';

function crm(overrides: Partial<Adapter> = {}): Adapter {
  return {
    adapterType: 'acme_crm',
    supportedTriggers: ['webhook'],
    runtimeCapabilities: () => BASE_RUNTIME_CAPABILITIES,
    listEntryPoints: async () => [],
    describe: async () => null,
    resolveEntity: async () => ({ candidates: [] }),
    getFieldValue: async () => null,
    getRelated: async () => [],
    createRecord: async () => {
      throw new Error('read-only');
    },
    updateRecord: async () => {
      throw new Error('read-only');
    },
    deleteRecord: async () => {
      throw new Error('read-only');
    },
    ...overrides,
  };
}

const threads: Adapter['arrivals'] = {
  awaitKeys: async ({ heads }) => heads.map((head) => (head.recordId === 'gone' ? { gone: true as const } : { key: `thread:${head.recordId}` })),
};

async function rpc(adapter: Adapter, method: string, params: unknown): Promise<{ ok: boolean; result?: unknown }> {
  const handler = createAdapterProtocolHandler({ adapter });
  const req = Object.assign(Readable.from([JSON.stringify({ protocolVersion: PROTOCOL_VERSION, method, cacheScopeId: 's', params })]), {
    headers: {},
  }) as unknown as IncomingMessage;
  let payload = '';
  const res = { writeHead: () => undefined, end: (body: string) => void (payload = body) } as unknown as ServerResponse;
  await handler(req, res);
  return JSON.parse(payload);
}

describe('arrivals over the kit', () => {
  it('a kit server lists awaitKeys when the adapter offers arrivals, and states minor 0', () => {
    const methods = adapterProtocolMethods(crm({ arrivals: threads }));
    expect(methods).toContain('awaitKeys');
    expect(adapterManifestResult(crm({ arrivals: threads }), methods)).toMatchObject({ protocolVersion: 2, protocolMinor: 0 });
    expect(adapterProtocolMethods(crm())).not.toContain('awaitKeys');
  });

  it('answers awaitKeys from the capability, in the order of the heads', async () => {
    const answer = await rpc(crm({ arrivals: threads }), 'awaitKeys', { edge: 'Comments', heads: [{ recordId: 'c1' }, { recordId: 'gone' }] });
    expect(answer).toEqual({ ok: true, result: [{ key: 'thread:c1' }, { gone: true }] });
  });

  it("a delivery's acceptance carries its arrivals, in the wire's shape", () => {
    const check = accepted([], {
      arrivals: [
        { edge: 'Comments', key: 'thread:c1', identity: 'k1', landing: { recordType: 'Comment', fields: { Text: 'hi' } } },
        { edge: 'Comments', key: 'thread:c2', gone: true },
      ],
    });
    expect(METHODS.checkInbound.result.parse(check)).toEqual(check);
    // An arrival names its identity.
    const unnamed = { outcome: 'accepted', events: [], arrivals: [{ edge: 'Comments', key: 'thread:c1', landing: { fields: {} } }] };
    expect(METHODS.checkInbound.result.safeParse(unnamed).success).toBe(false);
  });
});

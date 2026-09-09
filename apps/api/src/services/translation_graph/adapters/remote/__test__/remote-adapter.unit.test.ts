// RemoteAdapter — the client side of the wire protocol. These tests stub the
// transport by jest.mocking `postRpc` from `protocol/client`, so we assert the
// exact RPC envelope the adapter issues (method, params, cacheScopeId) and the
// re-wrapping of paged streams + manifest-gated optional methods.

import type { RuntimeCapabilities } from '../../../adapter';
import type { RemoteAdapterConfig, RemoteManifest } from '../index';

// Mock the transport. Every forwarder funnels through `postRpc`; we control its
// return value per-method and inspect the calls.
jest.mock('../../../protocol/client', () => {
  const actual = jest.requireActual('../../../protocol/client');
  return { ...actual, postRpc: jest.fn() };
});

import { postRpc } from '../../../protocol/client';
import { RemoteAdapter, createRemoteAdapter, fetchRemoteManifest } from '../index';

const postRpcMock = postRpc as jest.MockedFunction<typeof postRpc>;

const runtimeCapabilities: RuntimeCapabilities = {
  traversal: { incoming: false, edgeProperties: false },
  resources: false,
};

const config: RemoteAdapterConfig = {
  adapterType: 'remote-email',
  baseUrl: 'https://adapter.example/rpc',
  authStrategy: { kind: 'bearer' },
  credentialsId: 'cred-1',
};

const CACHE_SCOPE = 'scope-abc';

const ALL_METHODS = [
  'manifest',
  'listEntryPoints',
  'describe',
  'resolveEntity',
  'getFieldValue',
  'getRelated',
  'iterateRelated',
  'preprocessInbound',
  'listEventTypes',
  'createRecord',
  'updateRecord',
  'deleteRecord',
  'readRecord',
  'translateFilter',
  'writeResource',
  'writeEvidence',
  'getDedupRules',
  'getActorCandidates',
  'extractActor',
  'getDisplayData',
  'describeOpaqueId',
  'resolveFileRef',
  'invokeFieldFunction',
];

function manifest(methods: readonly string[] = ALL_METHODS): RemoteManifest {
  return {
    adapterType: 'remote-email',
    supportedTriggers: ['snapshot', 'webhook'],
    runtimeCapabilities,
    methods,
  };
}

function buildAdapter(methods: readonly string[] = ALL_METHODS): RemoteAdapter {
  return createRemoteAdapter({
    config,
    secret: 's3cr3t',
    cacheScopeId: CACHE_SCOPE,
    manifest: manifest(methods),
  });
}

const samplePosition = {
  adapterType: 'remote-email',
  recordType: 'email:message',
  identity: { kind: 'unstable' as const, data: { from: 'h@x.com' } },
};

// ── Introspection-aware transport ──────────────────────────────────────────
//
// The shim now translates NATURAL names → the remote's internal ids LOCALLY,
// from the introspection it fetches over the wire (`listEntryPoints` +
// `describe`). For these envelope-assertion tests the remote server speaks
// natural names AS its own ids (`displayName === typeId`, field
// `displayName === fieldId`) — so translation is the identity and the
// forwarded wire params are unchanged, exactly what the assertions pin.
//
// `primeTransport` installs a `postRpc` implementation that answers the
// introspection methods from this identity schema and serves every other
// method from a per-test FIFO queue (`enqueue`). Introspection calls don't
// consume the queue, so a test enqueues only its own method's response.

const IDENTITY_ENTRIES = [
  { typeId: 'email:message', displayName: 'email:message', writable: true, readable: true },
  { typeId: 'attio:companies', displayName: 'attio:companies', writable: true, readable: true },
  { typeId: 'remote:message', displayName: 'remote:message', writable: true, readable: true },
];

function identityDescriptor(typeId: string): unknown {
  // Every field the tests reference, declared with displayName === fieldId so
  // the resolver is the identity. References cover the parentLink edge cases.
  const fieldNames =
    typeId === 'attio:companies'
      ? ['name']
      : typeId === 'remote:message'
        ? ['text']
        : ['from', 'subject'];
  return {
    typeId,
    displayName: typeId,
    fields: fieldNames.map((f) => ({ fieldId: f, displayName: f, kind: 'string', writable: true, required: false })),
    references: [{ fieldId: 'attachments', targetTypeId: typeId, cardinality: 'many', direction: 'outgoing', name: 'attachments' }],
  };
}

let responseQueue: unknown[] = [];
function enqueue(...responses: unknown[]): void {
  responseQueue.push(...responses);
}

function primeTransport(): void {
  postRpcMock.mockImplementation(async (req: { method: string; params?: unknown }) => {
    if (req.method === 'listEntryPoints') return IDENTITY_ENTRIES;
    if (req.method === 'describe') {
      const typeId = (req.params as { typeId?: string } | undefined)?.typeId ?? 'email:message';
      return identityDescriptor(typeId);
    }
    if (responseQueue.length === 0) {
      throw new Error(`unit-test transport: no queued response for method=${req.method}`);
    }
    return responseQueue.shift();
  });
}

beforeEach(() => {
  primeTransport();
});

afterEach(() => {
  postRpcMock.mockReset();
  responseQueue = [];
});

describe('RemoteAdapter manifest props', () => {
  it('exposes adapterType / supportedTriggers / runtimeCapabilities from the manifest', () => {
    const adapter = buildAdapter();
    expect(adapter.adapterType).toBe('remote-email');
    expect(adapter.supportedTriggers).toEqual(['snapshot', 'webhook']);
    expect(adapter.runtimeCapabilities()).toBe(runtimeCapabilities);
  });

  it('exposes webhookEventTypeId from the manifest (static config, no RPC)', () => {
    const adapter = createRemoteAdapter({
      config,
      secret: 's3cr3t',
      cacheScopeId: CACHE_SCOPE,
      manifest: { ...manifest(), webhookEventTypeId: 'remote-attio:webhook_event' },
    });
    expect(adapter.webhookEventTypeId).toBe('remote-attio:webhook_event');
  });
});

describe('RemoteAdapter forwarding', () => {
  it('describe forwards the resolved internal typeId with the cacheScopeId stamped', async () => {
    const adapter = buildAdapter();
    const result = await adapter.describe('email:message');

    // The natural type name resolves (identity) to its internal id and is
    // forwarded over the wire as `{ typeId }`; the server's descriptor returns
    // unchanged (the shim never rewrites the descriptor body).
    expect(result).toEqual(identityDescriptor('email:message'));
    expect(postRpcMock).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: config.baseUrl,
        method: 'describe',
        cacheScopeId: CACHE_SCOPE,
        params: { typeId: 'email:message' },
        auth: { Authorization: 'Bearer s3cr3t' },
      }),
    );
  });

  it('listEntryPoints issues method=listEntryPoints with empty params', async () => {
    const entryPoints = [
      { typeId: 'email:message', displayName: 'Email', writable: false, readable: true },
    ];
    postRpcMock.mockResolvedValueOnce(entryPoints);

    const adapter = buildAdapter();
    const result = await adapter.listEntryPoints();

    expect(result).toEqual(entryPoints);
    expect(postRpcMock).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'listEntryPoints', params: {} }),
    );
  });

  it('getFieldValue forwards the position + resolved fieldId and returns the opaque value', async () => {
    enqueue('hello@x.com');

    const adapter = buildAdapter();
    const result = await adapter.getFieldValue({ position: samplePosition, fieldId: 'from' });

    expect(result).toBe('hello@x.com');
    // `from` resolves (identity) against the position's natural type and is
    // forwarded as the wire `fieldId`.
    expect(postRpcMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'getFieldValue',
        params: { position: samplePosition, fieldId: 'from' },
      }),
    );
  });

  it('createRecord (a write) forwards the translated input and parses the WriteResult', async () => {
    const writeResult = { adapterType: 'attio', externalId: 'rec-9', data: { name: 'Acme' } };
    enqueue(writeResult);

    const input = {
      recordType: 'attio:companies',
      fields: { name: 'Acme' },
      mutationContext: {
        source: { adapterType: 'kg' },
        occurredAt: '2026-06-05T00:00:00Z',
      },
    };
    const adapter = buildAdapter();
    const result = await adapter.createRecord(input as never);

    expect(result).toEqual(writeResult);
    // recordType + field keys resolve (identity) to the remote's internal ids;
    // the parent slots normalize to an empty `parentLinks` (none supplied).
    expect(postRpcMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'createRecord',
        params: expect.objectContaining({
          recordType: 'attio:companies',
          fields: { name: 'Acme' },
          parentLinks: [],
        }),
      }),
    );
  });

  it('stamps the same cacheScopeId on every call', async () => {
    enqueue([], []);

    const adapter = buildAdapter();
    await adapter.listEntryPoints();
    await adapter.getRelated({ position: samplePosition, fieldId: 'attachments', direction: 'outgoing' });

    for (const call of postRpcMock.mock.calls) {
      expect(call[0].cacheScopeId).toBe(CACHE_SCOPE);
    }
  });
});

describe('RemoteAdapter resolveEntity tolerance', () => {
  const resolveInput = {
    record: { name: 'Acme' },
    recordType: 'attio:companies',
    candidates: [],
    constraints: { any: [] },
  };

  it('tolerates a server that returns a bare [] (no { candidates } wrapper)', async () => {
    // The handbook historically said resolveEntity "may always return []".
    // A homespun adapter that did so must not crash the write path.
    enqueue([]);
    const adapter = buildAdapter();
    const result = await adapter.resolveEntity(resolveInput as never);
    expect(result).toEqual({ candidates: [] });
  });

  it('tolerates a bare candidates array and maps candidate data to natural names', async () => {
    enqueue([{ adapterType: 'attio', externalId: 'rec-1', data: { name: 'Acme' } }]);
    const adapter = buildAdapter();
    const result = await adapter.resolveEntity(resolveInput as never);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ externalId: 'rec-1' });
  });
});

describe('RemoteAdapter surfaces a helpful error on a malformed response', () => {
  it('names the failing method when a result does not match its schema', async () => {
    // createRecord result must be an ExternalRecordRef; this is missing the
    // required fields. The thrown error should name the method, not just dump
    // a raw Zod issue.
    enqueue({ nope: true });
    const adapter = buildAdapter();
    await expect(
      adapter.createRecord({
        recordType: 'attio:companies',
        fields: { name: 'Acme' },
        mutationContext: {
          source: { adapterType: 'kg' },
          occurredAt: '2026-06-05T00:00:00Z',
        },
      } as never),
    ).rejects.toThrow(/createRecord/);
  });
});

describe('RemoteAdapter streaming re-wrap', () => {
  it('iterateRelated yields items across pages with cursor starting undefined', async () => {
    const r1 = { position: samplePosition, edgeId: 'e1' };
    const r2 = { position: samplePosition, edgeId: 'e2' };

    enqueue({ items: [r1], nextCursor: 'rc1' }, { items: [r2] });

    const adapter = buildAdapter();
    const out: unknown[] = [];
    for await (const r of adapter.iterateRelated!({
      position: samplePosition,
      fieldId: 'attachments',
      direction: 'outgoing',
    })) {
      out.push(r);
    }

    expect(out).toEqual([r1, r2]);
    // The paged `iterateRelated` calls (introspection aside) start at
    // cursor=undefined then advance with the server's nextCursor.
    const pageCalls = postRpcMock.mock.calls.filter((c) => c[0].method === 'iterateRelated');
    expect(pageCalls[0][0].params).toMatchObject({ cursor: undefined });
    expect(pageCalls[1][0].params).toMatchObject({ cursor: 'rc1' });
  });
});

describe('RemoteAdapter manifest gating', () => {
  it('omits an optional method the manifest did not advertise', () => {
    const adapter = buildAdapter(ALL_METHODS.filter((m) => m !== 'getActorCandidates'));
    expect(adapter.getActorCandidates).toBeUndefined();
  });

  it('keeps an optional method the manifest advertised as a callable forwarder', async () => {
    postRpcMock.mockResolvedValueOnce([
      { identity: { identifier: 'h@x.com', scheme: 'email' }, source: 'originator' },
    ]);

    const adapter = buildAdapter();
    expect(typeof adapter.getActorCandidates).toBe('function');

    const event = { pipelineInputId: 'pi', adapterType: 'remote-email', triggerType: 'webhook', payload: null };
    const result = await adapter.getActorCandidates!({ event: event as never });
    expect(result).toEqual([
      { identity: { identifier: 'h@x.com', scheme: 'email' }, source: 'originator' },
    ]);
    expect(postRpcMock).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'getActorCandidates', params: { event } }),
    );
  });

  it('omits iterateRelated when not advertised', () => {
    const adapter = buildAdapter(['listEntryPoints', 'describe']);
    expect(adapter.iterateRelated).toBeUndefined();
  });

  it('forwards extractActor over the wire when advertised', async () => {
    postRpcMock.mockResolvedValueOnce({ identifier: 'wm-1', scheme: 'opaque', adapterType: 'attio', label: 'wm-1' });
    const adapter = buildAdapter();
    expect(typeof adapter.extractActor).toBe('function');

    const event = { pipelineInputId: 'pi', adapterType: 'remote-email', triggerType: 'webhook', payload: null };
    const result = await adapter.extractActor!({ event: event as never });
    expect(result).toEqual({ identifier: 'wm-1', scheme: 'opaque', adapterType: 'attio', label: 'wm-1' });
    expect(postRpcMock).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'extractActor', params: { event } }),
    );
  });

  it('forwards invokeFieldFunction over the wire when advertised', async () => {
    enqueue('*Thanks @[Frank Smith]!* 🎉');
    const adapter = buildAdapter();
    expect(typeof adapter.invokeFieldFunction).toBe('function');

    const params = {
      recordType: 'remote:message',
      fieldId: 'text',
      functionName: 'SLACK_MESSAGE',
      args: { instructions: 'thank them', data: ['Frank Smith'] },
    };
    const result = await adapter.invokeFieldFunction!(params);
    expect(result).toBe('*Thanks @[Frank Smith]!* 🎉');
    // recordType + fieldId resolve (identity) to the remote's internal ids.
    expect(postRpcMock).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'invokeFieldFunction', params }),
    );
  });

  it('prunes extractActor / invokeFieldFunction when not advertised', () => {
    const adapter = buildAdapter(
      ALL_METHODS.filter(
        (m) => m !== 'extractActor' && m !== 'invokeFieldFunction',
      ),
    );
    expect(adapter.extractActor).toBeUndefined();
    expect(adapter.invokeFieldFunction).toBeUndefined();
  });
});

describe('fetchRemoteManifest', () => {
  it('calls method=manifest and parses the result into a RemoteManifest', async () => {
    postRpcMock.mockResolvedValueOnce({
      adapterType: 'remote-email',
      supportedTriggers: ['snapshot', 'webhook'],
      runtimeCapabilities,
      methods: ['describe', 'getRelated'],
      webhookEventTypeId: 'remote-email:webhook_event',
    });

    const result = await fetchRemoteManifest(config, 's3cr3t');

    expect(result.adapterType).toBe('remote-email');
    expect(result.supportedTriggers).toEqual(['snapshot', 'webhook']);
    expect(result.methods).toEqual(['describe', 'getRelated']);
    expect(result.webhookEventTypeId).toBe('remote-email:webhook_event');
    expect(postRpcMock).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: config.baseUrl,
        method: 'manifest',
        params: {},
        auth: { Authorization: 'Bearer s3cr3t' },
      }),
    );
  });
});

describe('RemoteAdapter.resolveFileRef (url→stream)', () => {
  const ref = {
    __brand: 'FileRef' as const,
    name: 'doc.pdf',
    source: { ownerAdapterType: 'remote-email', handle: 'h-1' },
  };

  it('calls the wire resolveFileRef (→ {url}), fetches it, and yields a stream', async () => {
    const realFetch = global.fetch;
    // Wire method returns a presigned/proxy url; bytes never ride the envelope.
    postRpcMock.mockResolvedValueOnce({ url: 'https://owner.example/blob/abc', contentType: 'application/pdf' });
    const fetchMock = jest.fn(async () =>
      new Response('PDFBYTES', { status: 200, headers: { 'content-type': 'application/pdf' } }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    try {
      const adapter = buildAdapter();
      const { stream, contentType } = await adapter.resolveFileRef!({ ref });

      // Forwarded the FileRef over the wire as the resolveFileRef params.
      expect(postRpcMock).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'resolveFileRef', params: { ref } }),
      );
      // Fetched the resolved url.
      expect(fetchMock).toHaveBeenCalledWith('https://owner.example/blob/abc');
      expect(contentType).toBe('application/pdf');

      // The stream yields the fetched bytes.
      const chunks: Buffer[] = [];
      for await (const c of stream) chunks.push(Buffer.from(c as Buffer));
      expect(Buffer.concat(chunks).toString()).toBe('PDFBYTES');
    } finally {
      global.fetch = realFetch;
    }
  });

  it('is pruned when the manifest does not advertise it', () => {
    const adapter = buildAdapter(ALL_METHODS.filter((m) => m !== 'resolveFileRef'));
    expect(adapter.resolveFileRef).toBeUndefined();
  });
});

describe('RemoteAdapter FileRef revival on getFieldValue', () => {
  it('re-binds retrieve() on a wire FileRef so it fetches via the wire resolveFileRef', async () => {
    // A FileRef crosses the wire as plain JSON — no closure. getFieldValue
    // returns it; the adapter must re-attach a working retrieve().
    enqueue({
      __brand: 'FileRef',
      name: 'deck.pdf',
      contentType: 'application/pdf',
      source: { ownerAdapterType: 'remote-email', handle: 'h-1' },
    });

    const adapter = buildAdapter();
    const ref = (await adapter.getFieldValue({
      position: samplePosition,
      fieldId: 'from',
    })) as { retrieve?: () => Promise<{ stream: AsyncIterable<unknown> }> };

    expect(typeof ref.retrieve).toBe('function');

    // retrieve() forwards to the wire resolveFileRef (→ {url}) then fetches it.
    enqueue({ url: 'https://owner.example/blob/h-1', contentType: 'application/pdf' });
    const realFetch = global.fetch;
    const fetchMock = jest.fn(async () =>
      new Response('REMOTE-BYTES', { status: 200, headers: { 'content-type': 'application/pdf' } }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    try {
      const resolved = await ref.retrieve!();
      expect(postRpcMock).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'resolveFileRef' }),
      );
      expect(fetchMock).toHaveBeenCalledWith('https://owner.example/blob/h-1');
      const chunks: Buffer[] = [];
      for await (const c of resolved.stream) chunks.push(Buffer.from(c as Buffer));
      expect(Buffer.concat(chunks).toString()).toBe('REMOTE-BYTES');
    } finally {
      global.fetch = realFetch;
    }
  });
});

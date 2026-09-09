import {
  PROTOCOL_VERSION,
  RpcRequest,
  RpcError,
  RpcResponse,
  RelatedPage,
  WireResource,
  WireSourcePosition,
  WireLandedRecordPosition,
  WireTriggerEvent,
  WireRelatedResult,
  WireEdgesFromResult,
  WireActorCandidate,
  WireFileRef,
  WireResolveEntityResult,
  METHODS,
} from '../schema';

// A representative source position — the wire mirror of `SourcePosition`.
const samplePosition = {
  adapterType: 'remote-email',
  recordType: 'email:message',
  identity: { kind: 'unstable', data: { from: 'h@x.com', subject: 'hi' } },
};

describe('protocol envelope', () => {
  it('PROTOCOL_VERSION is the string "1"', () => {
    expect(PROTOCOL_VERSION).toBe('1');
  });

  it('RpcRequest round-trips a well-formed request', () => {
    const req = {
      protocolVersion: PROTOCOL_VERSION,
      method: 'describe',
      cacheScopeId: 'scope-123',
      params: { typeId: 'email:message' },
    };
    expect(RpcRequest.parse(req)).toEqual(req);
  });

  it('RpcRequest rejects a request missing the method', () => {
    expect(() =>
      RpcRequest.parse({
        protocolVersion: '1',
        cacheScopeId: 'scope-123',
        params: {},
      }),
    ).toThrow();
  });

  it('RpcResponse accepts the ok:true branch', () => {
    const ok = { ok: true, result: { typeId: 'x' } };
    const parsed = RpcResponse.parse(ok);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.result).toEqual({ typeId: 'x' });
  });

  it('RpcResponse accepts the ok:false branch with a structured error', () => {
    const err = {
      ok: false,
      error: { code: 'method_not_implemented', message: 'nope', retryable: false },
    };
    const parsed = RpcResponse.parse(err);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.code).toBe('method_not_implemented');
  });

  it('RpcResponse rejects a body missing the discriminator', () => {
    expect(() => RpcResponse.parse({ result: {} })).toThrow();
  });

  it('RpcError validates the error shape', () => {
    expect(() =>
      RpcError.parse({ code: 'x', message: 'y', retryable: 'not-a-bool' }),
    ).toThrow();
  });
});

describe('streaming page shapes', () => {
  it('RelatedPage round-trips with a nextCursor', () => {
    const page = {
      items: [{ position: samplePosition, edgeId: 'edge-1' }],
      nextCursor: { offset: 50 },
    };
    expect(RelatedPage.parse(page)).toEqual(page);
  });

  it('RelatedPage round-trips without a nextCursor', () => {
    const page = { items: [{ position: samplePosition }] };
    expect(RelatedPage.parse(page)).toEqual(page);
  });
});

describe('wire DTOs', () => {
  it('WireResource accepts a plain-string id (not a branded ResourceId)', () => {
    const resource = {
      id: 'a-plain-string-id',
      externalId: 'slack-ts-123',
      type: 'FILE',
      name: 'report.pdf',
      url: 'https://x/report.pdf',
    };
    expect(WireResource.parse(resource)).toEqual(resource);
  });

  it('WireResource is valid with no id at all', () => {
    expect(WireResource.parse({ name: 'inline text' })).toEqual({ name: 'inline text' });
  });

  it('WireSourcePosition round-trips a stable position', () => {
    const pos = {
      adapterType: 'attio',
      recordType: 'attio:companies',
      identity: { kind: 'stable', recordId: 'rec-1', data: { name: 'Acme' } },
    };
    expect(WireSourcePosition.parse(pos)).toEqual(pos);
  });

  it('WireTriggerEvent round-trips a minimal event', () => {
    const event = {
      pipelineInputId: 'pi-1',
      adapterType: 'remote-email',
      triggerType: 'webhook',
      payload: null,
    };
    expect(WireTriggerEvent.parse(event)).toEqual(event);
  });

  it('WireRelatedResult requires a position', () => {
    expect(() => WireRelatedResult.parse({ edgeId: 'e' })).toThrow();
    expect(WireRelatedResult.parse({ position: samplePosition })).toEqual({
      position: samplePosition,
    });
  });

  it('WireSourcePosition still tolerates a null recordType (request-side echo)', () => {
    const pos = {
      adapterType: 'attio',
      recordType: null,
      identity: { kind: 'unstable', data: {} },
    };
    expect(WireSourcePosition.parse(pos)).toEqual(pos);
  });

  it('WireLandedRecordPosition rejects a null recordType', () => {
    const pos = {
      adapterType: 'attio',
      recordType: null,
      identity: { kind: 'unstable', data: {} },
    };
    expect(() => WireLandedRecordPosition.parse(pos)).toThrow(/must name its type/);
  });

  it('WireRelatedResult (a getRelated/iterateRelated traversal result) rejects a typeless position', () => {
    const typeless = { ...samplePosition, recordType: null };
    expect(() => WireRelatedResult.parse({ position: typeless })).toThrow(/must name its type/);
  });

  it('WireEdgesFromResult rejects a typeless targetPosition', () => {
    const descriptor = {
      typeId: 'email:message',
      displayName: 'Email Message',
      fields: [],
      references: [],
    };
    expect(
      WireEdgesFromResult.parse({
        descriptor,
        targetPositions: { attachments: samplePosition },
      }),
    ).toEqual({ descriptor, targetPositions: { attachments: samplePosition } });
    expect(() =>
      WireEdgesFromResult.parse({
        descriptor,
        targetPositions: { attachments: { ...samplePosition, recordType: null } },
      }),
    ).toThrow(/must name its type/);
  });

  it('WireActorCandidate validates the source tag', () => {
    const candidate = {
      identity: { identifier: 'h@x.com', scheme: 'email', email: 'h@x.com' },
      source: 'originator',
    };
    expect(WireActorCandidate.parse(candidate)).toEqual(candidate);
    expect(() =>
      WireActorCandidate.parse({ ...candidate, source: 'terminal' }),
    ).toThrow();
  });
});

describe('METHODS registry', () => {
  it('covers the full protocol catalog', () => {
    const expected = [
      'manifest',
      'listEntryPoints',
      'describe',
      'edgesFrom',
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
      'getDedupRules',
      'getActorCandidates',
      'extractActor',
      'describeOpaqueId',
      'resolveFileRef',
      'invokeFieldFunction',
    ];
    expect(Object.keys(METHODS).sort()).toEqual([...expected].sort());
  });

  it('every entry exposes a params + result zod schema', () => {
    for (const [name, def] of Object.entries(METHODS)) {
      expect(typeof def.params.parse).toBe('function');
      expect(typeof def.result.parse).toBe('function');
      // sanity: the names are non-empty
      expect(name.length).toBeGreaterThan(0);
    }
  });

  it('manifest: params {} → { adapterType, supportedTriggers, runtimeCapabilities, methods }', () => {
    expect(METHODS.manifest.params.parse({})).toEqual({});
    const result = {
      adapterType: 'remote-email',
      supportedTriggers: ['snapshot', 'webhook'],
      runtimeCapabilities: {
        traversal: { incoming: false, edgeProperties: false },
        resources: false,
      },
      methods: ['listEntryPoints', 'describe', 'getRelated', 'getActorCandidates'],
    };
    // webhookEventTypeId is optional → a manifest without it round-trips.
    expect(METHODS.manifest.result.parse(result)).toEqual(result);
  });

  it('manifest: result carries the optional webhookEventTypeId config', () => {
    const result = {
      adapterType: 'remote-attio',
      supportedTriggers: ['webhook'],
      runtimeCapabilities: {
        traversal: { incoming: false, edgeProperties: false },
        resources: true,
      },
      methods: ['listEntryPoints', 'describe', 'getActorCandidates'],
      webhookEventTypeId: 'remote-attio:webhook_event',
    };
    expect(METHODS.manifest.result.parse(result)).toEqual(result);
  });

  it('manifest: result rejects a payload missing the methods array', () => {
    expect(() =>
      METHODS.manifest.result.parse({
        adapterType: 'remote-email',
        supportedTriggers: [],
        runtimeCapabilities: {
          traversal: { incoming: false, edgeProperties: false },
          resources: false,
        },
      }),
    ).toThrow();
  });

  it('describe: params { typeId } → descriptor | null', () => {
    expect(METHODS.describe.params.parse({ typeId: 'email:message' })).toEqual({
      typeId: 'email:message',
    });
    expect(METHODS.describe.result.parse(null)).toBeNull();
    const descriptor = {
      typeId: 'email:message',
      displayName: 'Email Message',
      fields: [],
      references: [],
    };
    expect(METHODS.describe.result.parse(descriptor)).toEqual(descriptor);
  });

  it('getRelated: input has no fetchCache field', () => {
    const input = { position: samplePosition, fieldId: 'attachments', direction: 'outgoing' };
    const parsed = METHODS.getRelated.params.parse({ ...input, fetchCache: { x: 1 } }) as Record<
      string,
      unknown
    >;
    expect(parsed).not.toHaveProperty('fetchCache');
  });

  it('iterateRelated: result is a RelatedPage', () => {
    const page = { items: [{ position: samplePosition }], nextCursor: 'c' };
    expect(METHODS.iterateRelated.result.parse(page)).toEqual(page);
  });

  it('getFieldValue: result is opaque (any value passes)', () => {
    expect(METHODS.getFieldValue.result.parse('a string')).toBe('a string');
    expect(METHODS.getFieldValue.result.parse(42)).toBe(42);
    expect(METHODS.getFieldValue.result.parse(null)).toBeNull();
  });

  it('createRecord: result is the ExternalRecordRef currency', () => {
    // Missing the required adapterType + externalId.
    expect(() => METHODS.createRecord.result.parse({ data: {} })).toThrow();
    const result = { adapterType: 'attio', externalId: 'new-rec-1', data: { name: 'Acme' } };
    expect(METHODS.createRecord.result.parse(result)).toEqual(result);
  });

  it('resolveEntity: result carries a flat candidates array', () => {
    const result = {
      candidates: [{ adapterType: 'attio', externalId: 'n1', data: { name: 'Acme' } }],
    };
    expect(METHODS.resolveEntity.result.parse(result)).toEqual(result);
  });

  it('getActorCandidates: result is an array of candidates', () => {
    const result = [
      { identity: { identifier: 'h@x.com', scheme: 'email' }, source: 'originator' },
    ];
    expect(METHODS.getActorCandidates.result.parse(result)).toEqual(result);
  });

  it('WireFileRef: round-trips a source-bearing ref (the remote handle)', () => {
    const sourceRef = {
      name: 'doc.pdf',
      contentType: 'application/pdf',
      size: 1234,
      source: { ownerAdapterType: 'email', handle: 'att-1' },
    };
    expect(WireFileRef.parse(sourceRef)).toEqual(sourceRef);
  });

  it('resolveFileRef: params { ref } and result { url, contentType? } round-trip', () => {
    const params = { ref: { name: 'd.pdf', source: { ownerAdapterType: 'email', handle: 'h' } } };
    expect(METHODS.resolveFileRef.params.parse(params)).toEqual(params);

    const result = { url: 'https://owner.example/blob', contentType: 'application/pdf' };
    expect(METHODS.resolveFileRef.result.parse(result)).toEqual(result);
    // contentType is optional.
    expect(METHODS.resolveFileRef.result.parse({ url: 'https://x/y' })).toEqual({ url: 'https://x/y' });
    // url is required.
    expect(() => METHODS.resolveFileRef.result.parse({})).toThrow();
  });
});

describe('WireResolveEntityResult (tolerant of a bare candidates array)', () => {
  const ref = { adapterType: 'acme_crm', externalId: 'c_1', data: {} };

  it('accepts the canonical { candidates: [...] } object form', () => {
    expect(WireResolveEntityResult.parse({ candidates: [ref] })).toEqual({
      candidates: [ref],
    });
  });

  it('coerces a bare empty array to { candidates: [] }', () => {
    // The handbook historically told authors they "may always return []" — a
    // bare array must not crash the write path with "expected object, received
    // array". Coerce it to the canonical object form.
    expect(WireResolveEntityResult.parse([])).toEqual({ candidates: [] });
  });

  it('coerces a bare candidates array to { candidates: [...] }', () => {
    expect(WireResolveEntityResult.parse([ref])).toEqual({ candidates: [ref] });
  });
});

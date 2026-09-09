// RemoteAdapter — implements the in-process `Adapter` interface by forwarding
// every call over the wire protocol (`protocol/schema.ts` + `protocol/client.ts`).
// A third-party (or out-of-process) adapter server speaks the same method
// registry; this class lets the TG engine drive it as if it were local.
//
// Construction is synchronous: the manifest is fetched once at install time
// (`fetchRemoteManifest`) and passed IN, so the engine can read
// `adapterType` / `runtimeCapabilities` / `supportedTriggers` immediately. The factory
// (`createRemoteAdapter`) prunes optional methods the server didn't advertise so
// the engine's `if (adapter.method)` capability checks see `undefined`.
//
// Position-type resolution is no longer an adapter method: the former
// `getPositionTypeId` was pure config, now resolved generically by the engine
// (`engine/position_type.ts`) from the adapter's static `webhookEventTypeId`,
// which a remote adapter carries in its manifest. `narrowReferenceType` and
// `extractActor` are now async, so they round-trip cleanly over the protocol
// and are full forwarders here (advertised → forwarded; absent → pruned).

import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

import type {
  Adapter,
  RuntimeCapabilities,
  DeleteInput,
  DeleteResult,
  EdgesFromResult,
  FileRef,
  GetFieldValueInput,
  GetRelatedInput,
  InvokeFieldFunctionInput,
  DiscriminableEvent,
  EventType,
  RelatedResult,
  ResolveEntityInput,
  ResolveEntityResult,
  ResolveFileRefResult,
  Resource,
  ActorCandidate,
  ActorIdentity,
  DedupRules,
  FilterTranslationResult,
  ResourceFilter,
  ReadInput,
  UpdateInput,
  UpdateResult,
  WriteInput,
  WriteResult,
} from '../../adapter';
import type {
  SchemaEntryPoint,
  SchemaTypeDescriptor,
  SourcePosition,
} from '../../types';
import { exposeFile } from '../../engine/files/expose';
import { streamFileRef, isFileRef } from '../../engine/files/retrieve';
import type { TriggerEvent, TriggerType } from '../../triggers/types';
import type { Expression } from '#shared/expression/types';

import { authHeader, postRpc, parseWireResult } from '../../protocol/client';
import type { AuthStrategy } from '../../protocol/client';
import { METHODS } from '../../protocol/schema';
import type { MethodName } from '../../protocol/schema';
import { writeParentLinks } from '../../adapter';
import { META_RECORD_TYPE } from '../../types';
import {
  memoizedResolver,
  naturalName,
  type ScopedResolver,
} from '../name_resolution';

export interface RemoteAdapterConfig {
  /** Slug the engine routes on. */
  adapterType: string;
  baseUrl: string;
  authStrategy: AuthStrategy;
  credentialsId: string;
}

export interface RemoteManifest {
  adapterType: string;
  supportedTriggers: readonly TriggerType[];
  runtimeCapabilities: RuntimeCapabilities;
  /** Protocol method names the server implements — drives optional-method
   *  pruning in `createRemoteAdapter`. */
  methods: readonly string[];
  /** Static webhook/synthetic event type, consumed by the engine's generic
   *  `resolvePositionTypeId`. Pure config — no RPC. */
  webhookEventTypeId?: string;
}

/**
 * Optional `Adapter` methods that round-trip cleanly over the protocol. The
 * factory deletes any of these the manifest didn't advertise so the engine's
 * `if (adapter.method)` capability gates see `undefined`.
 *
 * `extractActor` is async (post-refactor) and so is a full forwarder here.
 * `getPositionTypeId` is gone entirely — position type is now resolved
 * generically from the manifest's `webhookEventTypeId`.
 */
export const OPTIONAL_REMOTE_METHODS = [
  'edgesFrom',
  'iterateRelated',
  'preprocessInbound',
  'listEventTypes',
  'readRecord',
  'describeOpaqueId',
  'translateFilter',
  'getDedupRules',
  'getActorCandidates',
  'extractActor',
  'resolveFileRef',
  'invokeFieldFunction',
] as const satisfies readonly (keyof Adapter)[];

/**
 * Install-time manifest fetch. Calls the server's `manifest` method and
 * validates the result against the protocol schema, then re-enters the branded
 * domain at the single sanctioned boundary `as` (a validated wire value
 * crossing back into branded types).
 */
export async function fetchRemoteManifest(
  config: RemoteAdapterConfig,
  secret: string,
): Promise<RemoteManifest> {
  const raw = await postRpc({
    baseUrl: config.baseUrl,
    auth: authHeader(config.authStrategy, secret),
    method: 'manifest',
    cacheScopeId: '<none>',
    params: {},
  });
  const result = parseWireResult(METHODS.manifest.result, raw, {
    method: 'manifest',
    adapter: config.adapterType,
  });
  return {
    adapterType: result.adapterType,
    // Sole sanctioned boundary `as`: validated wire value → branded domain.
    supportedTriggers: result.supportedTriggers as readonly TriggerType[],
    // Validated structurally by the wire schema — no boundary `as` needed.
    runtimeCapabilities: result.runtimeCapabilities,
    methods: result.methods,
    webhookEventTypeId: result.webhookEventTypeId,
  };
}

export interface RemoteAdapterInput {
  config: RemoteAdapterConfig;
  secret: string;
  cacheScopeId: string;
  manifest: RemoteManifest;
}

export class RemoteAdapter implements Adapter {
  readonly adapterType: string;
  /**
   * A remote adapter's graph is whatever its author modelled, and nothing here
   * can see whether it has containers. Assume it does: refusing a full-surface
   * describe costs an extra hop, wrongly issuing one costs a call per entry
   * against somebody else's service.
   */
  readonly walksContainers = true;
  readonly supportedTriggers: readonly TriggerType[];
  private readonly _runtimeCapabilities: RuntimeCapabilities;
  readonly webhookEventTypeId?: string;

  private readonly config: RemoteAdapterConfig;
  private readonly secret: string;
  private readonly cacheScopeId: string;

  constructor(input: RemoteAdapterInput) {
    this.config = input.config;
    this.secret = input.secret;
    this.cacheScopeId = input.cacheScopeId;
    this.adapterType = input.manifest.adapterType;
    this.supportedTriggers = input.manifest.supportedTriggers;
    this._runtimeCapabilities = input.manifest.runtimeCapabilities;
    this.webhookEventTypeId = input.manifest.webhookEventTypeId;
  }

  runtimeCapabilities(): RuntimeCapabilities {
    return this._runtimeCapabilities;
  }

  /**
   * Natural-name → internal-id resolver, memoized from the introspection this
   * shim ALREADY fetches over the wire (`listEntryPoints()` + `describe()`).
   * The remote server's wire protocol still speaks ITS OWN internal ids
   * (Decision #3: "the remote shim translates locally from the manifest it
   * fetched, wire protocol unchanged") — so the shim resolves the program's
   * NATURAL names to those internal ids on the first line of each forwarding
   * method, then forwards the internal ids over the wire UNCHANGED. The remote
   * adapter doesn't extend BaseAdapter (it's a wire forwarder, not an
   * external-record adapter), so it composes the same `memoizedResolver` helper
   * BaseAdapter wires in — exactly as the KG adapter does.
   *
   * When the remote server's introspection already publishes natural names as
   * its own ids (displayName === typeId/fieldId), translation is the identity —
   * we do NOT special-case it; the resolver returns the same value.
   */
  private readonly resolver: ScopedResolver = memoizedResolver(this);

  /**
   * Resolve a `describe(ref)` argument to the remote server's INTERNAL typeId.
   * `describe` accepts the program's NATURAL type name (engine / checker
   * currency) OR an internal typeId (the resolver build feeds it the entry's
   * own typeId; legacy callers pass stored ids). Entries-only — it NEVER calls
   * `describe`, so the resolver build (which calls `describe` per entry typeId)
   * stays recursion-free. A natural name maps to its entry's typeId; an
   * already-internal id (or an unknown one) passes through.
   */
  private async resolveTypeRef(ref: string): Promise<string> {
    if (this.typeIdByDisplayName === undefined) {
      this.typeIdByDisplayName = (async () => {
        const map = new Map<string, string>();
        for (const entry of await this.listEntryPoints()) {
          map.set(entry.displayName, entry.typeId);
        }
        return map;
      })();
      this.typeIdByDisplayName.catch(() => {
        this.typeIdByDisplayName = undefined;
      });
    }
    return (await this.typeIdByDisplayName).get(ref) ?? ref;
  }
  private typeIdByDisplayName?: Promise<Map<string, string>>;

  /** Resolve a NATURAL field name to the remote's internal field id against a
   *  position's NATURAL type. Identity when the position carries no type. */
  private async resolveFieldId(
    typeName: string | null,
    fieldNaturalName: string,
  ): Promise<string> {
    if (typeName === null) return fieldNaturalName;
    const resolver = await this.resolver({ types: [typeName] });
    return resolver.fieldId(naturalName(typeName), naturalName(fieldNaturalName));
  }

  private async call<M extends MethodName>(
    method: M,
    params: unknown,
  ): Promise<ReturnType<(typeof METHODS)[M]['result']['parse']>> {
    const result = await postRpc({
      baseUrl: this.config.baseUrl,
      auth: authHeader(this.config.authStrategy, this.secret),
      method,
      cacheScopeId: this.cacheScopeId,
      params,
    });
    return parseWireResult(METHODS[method].result, result, {
      method,
      adapter: this.config.adapterType,
    }) as ReturnType<(typeof METHODS)[M]['result']['parse']>;
  }

  // ── Required forwarders ────────────────────────────────────────────────

  listEntryPoints(): Promise<SchemaEntryPoint[]> {
    return this.call('listEntryPoints', {}) as Promise<SchemaEntryPoint[]>;
  }

  async describe(typeRef: string): Promise<SchemaTypeDescriptor | null> {
    // Resolve the NATURAL type name to the remote's internal typeId, then
    // forward the internal id over the wire. `resolveTypeRef` is entries-only
    // (it passes an already-internal id through), so the resolver build —
    // which calls `describe(entry.typeId)` — never recurses.
    const typeId = await this.resolveTypeRef(typeRef);
    return this.call('describe', { typeId }) as Promise<SchemaTypeDescriptor | null>;
  }

  /**
   * Meta-graph walk — a pure forwarder. No name resolution on the way in:
   * unlike `describe`'s typeRef, a position is not a name the program wrote,
   * it is one the remote MINTED and we are echoing back, so translating it
   * would corrupt the remote's own path. Pruned to `undefined` by
   * `createRemoteAdapter` when the manifest doesn't advertise it.
   */
  async edgesFrom(position: SourcePosition, cursor?: unknown): Promise<EdgesFromResult | null> {
    return this.call('edgesFrom', {
      position,
      ...(cursor !== undefined ? { cursor } : {}),
    }) as Promise<EdgesFromResult | null>;
  }

  async resolveEntity(input: ResolveEntityInput): Promise<ResolveEntityResult> {
    // recordType + record keys + each constraint field are the program's
    // NATURAL names; translate them to the remote's internal currency, then
    // forward. Candidate `data` comes back keyed by the remote's internal field
    // ids — rename it to NATURAL names so the engine arbitrates in the same
    // currency it holds the asserted record + constraints in.
    const resolver = await this.resolver({ types: [input.recordType] });
    const type = naturalName(input.recordType);
    const internalFieldName = (name: string): string =>
      resolver.tryFieldId(type, naturalName(name)) ??
      resolver.tryEdgeWriteName(type, naturalName(name)) ??
      name;
    const record: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(input.record)) {
      record[internalFieldName(name)] = value;
    }
    const constraints = {
      any: input.constraints.any.map((branch) => ({
        all: branch.all.map((entry) => ({ ...entry, field: internalFieldName(entry.field) })),
      })),
    };
    const result = (await this.call('resolveEntity', {
      ...input,
      recordType: resolver.typeId(type),
      record,
      constraints,
    })) as ResolveEntityResult;

    // Candidate `data` comes back keyed by the remote's internal field ids —
    // rename to the NATURAL field names (the same currency the engine holds the
    // asserted record + constraints in) via a reverse map built from the
    // remote's own descriptor. A key with no reverse mapping (already natural,
    // or a folded relationship entry) round-trips as itself.
    const naturalByInternalField = await this.naturalFieldNameMap(input.recordType);
    return {
      candidates: result.candidates.map((c) => {
        const data: Record<string, unknown> = {};
        for (const [id, value] of Object.entries(c.data)) {
          data[naturalByInternalField.get(id) ?? id] = value;
        }
        return { ...c, data };
      }),
    };
  }

  /** internal field id → NATURAL field name for one type, from the remote's
   *  fetched descriptor — the reverse of the resolver's forward field lookup,
   *  used to rename a candidate's `data` bag back to natural names. */
  private async naturalFieldNameMap(typeNaturalName: string): Promise<Map<string, string>> {
    const typeId = await this.resolveTypeRef(typeNaturalName);
    const descriptor = await this.describeInternal(typeId);
    const map = new Map<string, string>();
    if (descriptor) {
      for (const f of descriptor.fields) map.set(f.fieldId, f.displayName);
    }
    return map;
  }

  /** Forward a describe call for an already-internal typeId (no re-resolution).
   *  Shared by the resolver-build path and the candidate-data reverse map. */
  private describeInternal(typeId: string): Promise<SchemaTypeDescriptor | null> {
    return this.call('describe', { typeId }) as Promise<SchemaTypeDescriptor | null>;
  }

  async getFieldValue(input: GetFieldValueInput): Promise<unknown> {
    // `fieldId` is the NATURAL field name; `position.recordType` is the NATURAL
    // type name. Resolve to the remote's internal field id, then forward.
    const fieldId = await this.resolveFieldId(input.position.recordType, input.fieldId);
    const value = await this.call('getFieldValue', { ...input, fieldId });
    return this.reviveFileRefs(value);
  }

  /**
   * Re-attach a `retrieve()` to FileRefs that crossed the wire. A wire FileRef
   * is plain JSON (`{ __brand, name, contentType, source }`) — closures don't
   * serialize — so a consumer's `streamFileRef` would have no byte channel.
   * Bind it back to the remote's own `resolveFileRef` (a wire call), so the
   * FileRef is self-contained again on this side. Deep-walks the value because a
   * file-typed field may return a FileRef nested in an array/object.
   *
   */
  private reviveFileRefs(value: unknown): unknown {
    if (Array.isArray(value)) {
      for (const item of value) this.reviveFileRefs(item);
      return value;
    }
    if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      if (obj.__brand === 'FileRef' && typeof obj.retrieve !== 'function') {
        const ref = obj as unknown as FileRef;
        obj.retrieve = () => {
          if (!this.resolveFileRef) {
            throw new Error(
              `RemoteAdapter(${this.adapterType}): emitted a FileRef but does not ` +
                'advertise resolveFileRef, so its bytes cannot be retrieved.',
            );
          }
          return this.resolveFileRef({ ref });
        };
      }
      for (const key of Object.keys(obj)) {
        if (key !== 'retrieve') this.reviveFileRefs(obj[key]);
      }
      return value;
    }
    return value;
  }

  async getRelated(input: GetRelatedInput): Promise<RelatedResult[]> {
    return this.call('getRelated', await this.toInternalRelatedInput(input)) as Promise<
      RelatedResult[]
    >;
  }

  /** Translate a `getRelated` input's NATURAL edge / collection name to the
   *  remote's internal currency. A meta-root hop names a collection (a type);
   *  a normal hop names an edge on the position's natural type. */
  private async toInternalRelatedInput(input: GetRelatedInput): Promise<GetRelatedInput> {
    // The meta branch is entries-only (`collectionTypeId`); only the edge
    // branch below needs the holder's type described.
    const resolver = await this.resolver({
      types:
        input.position.recordType !== null && input.position.recordType !== META_RECORD_TYPE
          ? [input.position.recordType]
          : [],
    });
    if (input.position.recordType === META_RECORD_TYPE) {
      return { ...input, fieldId: resolver.collectionTypeId(naturalName(input.fieldId)) };
    }
    if (input.position.recordType === null) return input;
    return {
      ...input,
      fieldId: resolver.edgeReadId(
        naturalName(input.position.recordType),
        naturalName(input.fieldId),
      ),
    };
  }

  async createRecord(input: WriteInput): Promise<WriteResult> {
    return this.call('createRecord', await this.toInternalWriteInput(input)) as Promise<WriteResult>;
  }

  async updateRecord(input: UpdateInput): Promise<UpdateResult> {
    return this.call('updateRecord', {
      ...(await this.toInternalWriteInput(input)),
      externalId: input.externalId,
    }) as Promise<UpdateResult>;
  }

  async deleteRecord(input: DeleteInput): Promise<DeleteResult> {
    const resolver = await this.resolver();
    return this.call('deleteRecord', {
      ...input,
      recordType: resolver.typeId(naturalName(input.recordType)),
    }) as Promise<DeleteResult>;
  }

  /** Translate a write's NATURAL currency to the remote's internal ids:
   *  recordType + field keys (+ per-field evidence keys) + each parent's type /
   *  edge name. The wire body then speaks the remote server's own ids. */
  private async toInternalWriteInput<T extends WriteInput>(input: T): Promise<T> {
    const resolver = await this.resolver({ types: [input.recordType] });
    const type = naturalName(input.recordType);
    const fields: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(input.fields)) {
      // A file field can't ride raw bytes over the JSON wire — expose any
      // FileRef (buffer its bytes to a short-lived Listen-Fire URL) so the remote
      // server can fetch them. Deep-walks: a FileRef may nest in an array.
      fields[resolver.fieldId(type, naturalName(name))] = await this.exposeWriteFileRefs(value);
    }
    let evidence: WriteInput['evidence'];
    if (input.evidence) {
      evidence = {};
      for (const [name, ev] of Object.entries(input.evidence)) {
        evidence[resolver.fieldId(type, naturalName(name))] = ev;
      }
    }
    const parentLinks = writeParentLinks(input).map((p) => ({
      ...p,
      recordType: resolver.typeId(naturalName(p.recordType)),
      edgeName: resolver.edgeWriteName(naturalName(p.recordType), naturalName(p.edgeName)),
    }));
    // Node-level resources carry file bytes on their own `fileRef` — expose
    // those too so a written resource's file is fetchable server-side.
    const resources = input.resources
      ? ((await Promise.all(input.resources.map((r) => this.exposeWriteFileRefs(r)))) as T['resources'])
      : undefined;
    return {
      ...input,
      recordType: resolver.typeId(type),
      fields,
      ...(evidence ? { evidence } : {}),
      // The normalized, translated parent set (0/1/N).
      parentLinks,
      ...(resources !== undefined ? { resources } : {}),
    };
  }

  /**
   * Deep-walk a write value, replacing every FileRef with a WIRE FileRef whose
   * bytes are exposed at a short-lived Listen-Fire URL (`exposeFile` → S3). Raw bytes
   * and the `retrieve()` closure can't cross the JSON envelope, so the remote
   * server fetches the bytes from `url` instead. Non-FileRef values pass
   * through; an already-exposed FileRef (carrying `url`, no closure) is kept.
   */
  private async exposeWriteFileRefs(value: unknown): Promise<unknown> {
    if (Array.isArray(value)) {
      return Promise.all(value.map((v) => this.exposeWriteFileRefs(v)));
    }
    if (isFileRef(value)) {
      return this.fileRefToWire(value);
    }
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = await this.exposeWriteFileRefs(v);
      }
      return out;
    }
    return value;
  }

  /** Turn one FileRef into its wire form: metadata + a fetchable `url`. */
  private async fileRefToWire(ref: FileRef): Promise<Record<string, unknown>> {
    const wire: Record<string, unknown> = { __brand: 'FileRef' };
    if (ref.name !== undefined) wire.name = ref.name;
    if (ref.contentType !== undefined) wire.contentType = ref.contentType;
    if (ref.size !== undefined) wire.size = ref.size;
    if (ref.source !== undefined) wire.source = ref.source;
    if (typeof ref.url === 'string') {
      // Already exposed (e.g. re-sent off the wire) — keep its URL.
      wire.url = ref.url;
    } else if (typeof ref.retrieve === 'function') {
      const resolved = await streamFileRef(ref);
      const exposed = await exposeFile({
        stream: resolved.stream,
        filename: ref.name,
        contentType: resolved.contentType ?? ref.contentType,
      });
      wire.url = exposed.url;
      if (wire.contentType === undefined && resolved.contentType !== undefined) {
        wire.contentType = resolved.contentType;
      }
    }
    return wire;
  }

  // ── Streaming (paged) ──────────────────────────────────────────────────

  async *iterateRelated(input: GetRelatedInput): AsyncIterable<RelatedResult> {
    // Same NATURAL edge / collection → internal translation as `getRelated`.
    const internal = await this.toInternalRelatedInput(input);
    let cursor: unknown = undefined;
    do {
      const page = await this.call('iterateRelated', { ...internal, cursor });
      yield* page.items as unknown as RelatedResult[];
      cursor = page.nextCursor;
    } while (cursor != null);
  }

  // ── Optional forwarders (pruned by the factory when unadvertised) ──────

  preprocessInbound(input: {
    raw: unknown;
    checkpoint?: unknown;
  }): Promise<{ events: DiscriminableEvent[]; checkpoint?: unknown }> {
    return this.call('preprocessInbound', input) as Promise<{
      events: DiscriminableEvent[];
      checkpoint?: unknown;
    }>;
  }

  listEventTypes(): Promise<EventType[]> {
    return this.call('listEventTypes', {}) as Promise<EventType[]>;
  }

  readRecord(input: ReadInput): Promise<Record<string, unknown> | null> {
    return this.call('readRecord', input);
  }

  describeOpaqueId(input: { fieldPath: string; value: string }): Promise<string | null> {
    return this.call('describeOpaqueId', input);
  }

  async translateFilter(input: {
    expression: Expression;
    entityType: string;
  }): Promise<FilterTranslationResult> {
    // `entityType` is the NATURAL type name; resolve to the remote's internal
    // typeId before forwarding (the body's field names inside `expression` are
    // the remote server's own concern — it owns its filter dialect).
    const resolver = await this.resolver();
    return this.call('translateFilter', {
      ...input,
      entityType: resolver.typeId(naturalName(input.entityType)),
    }) as Promise<FilterTranslationResult>;
  }

  async getDedupRules(input: { typeRef: string }): Promise<DedupRules | null> {
    // `typeRef` is the NATURAL type name; resolve to the remote's internal
    // typeId before forwarding.
    const resolver = await this.resolver();
    return this.call('getDedupRules', {
      ...input,
      typeRef: resolver.typeId(naturalName(input.typeRef)),
    }) as Promise<DedupRules | null>;
  }

  getActorCandidates(input: { event: TriggerEvent }): Promise<ActorCandidate[]> {
    return this.call('getActorCandidates', input) as Promise<ActorCandidate[]>;
  }

  extractActor(input: { event: TriggerEvent }): Promise<ActorIdentity | null> {
    return this.call('extractActor', input) as Promise<ActorIdentity | null>;
  }

  async invokeFieldFunction(input: InvokeFieldFunctionInput): Promise<unknown> {
    // `recordType` + `fieldId` are the program's NATURAL names; translate to
    // the remote's internal currency before forwarding.
    const resolver = await this.resolver({ types: [input.recordType] });
    const type = naturalName(input.recordType);
    return this.call('invokeFieldFunction', {
      ...input,
      recordType: resolver.typeId(type),
      fieldId: resolver.fieldId(type, naturalName(input.fieldId)),
    });
  }

  /**
   * The wire `resolveFileRef` returns `{ url }` (bytes can't ride the JSON
   * envelope); this forwarder converts url→stream so the engine's
   * `/api/files/{token}` pass-through sees the same `{ stream }` shape a local
   * owner returns. The fetched URL is the owner server's own presigned/proxy
   * location — Listen-Fire never holds the owner's credentials.
   */
  async resolveFileRef(input: { ref: FileRef }): Promise<ResolveFileRefResult> {
    const { url, contentType } = await this.call('resolveFileRef', input);
    const res = await fetch(url);
    if (!res.ok || !res.body) {
      throw new Error(
        `RemoteAdapter.resolveFileRef: fetch of resolved url failed (status ${res.status}).`,
      );
    }
    return {
      stream: Readable.fromWeb(res.body as unknown as WebReadableStream),
      contentType: contentType ?? res.headers.get('content-type') ?? undefined,
    };
  }

}

/**
 * Construct a `RemoteAdapter` and prune the optional methods the manifest
 * didn't advertise. Pruning assigns `undefined` on the instance, which shadows
 * the prototype method so `adapter.<method>` is falsy — exactly what the
 * engine's `if (adapter.<method>)` capability gates expect.
 */
export function createRemoteAdapter(input: RemoteAdapterInput): RemoteAdapter {
  const adapter = new RemoteAdapter(input);
  const advertised = new Set(input.manifest.methods);

  for (const method of OPTIONAL_REMOTE_METHODS) {
    if (!advertised.has(method)) {
      (adapter as unknown as Record<string, unknown>)[method] = undefined;
    }
  }

  return adapter;
}

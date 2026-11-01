// Airtable TG adapter — implements the translation-graph `Adapter` contract
// for Airtable: reads, writes, and the arrivals a listen hears (a table's
// `Changes`, a base's `Tables`) through Airtable's webhooks.
//
// The host supplies the client (from the install's credential) and the files
// an attachment write exposes.

import type { EnsureEdgeSubscriptionInput, ModuleFiles, RefreshEdgeSubscriptionInput, RemoveEdgeSubscriptionInput } from 'module-kit';
import type { ArrivalsCapability, AwaitHead, AwaitKey } from 'engine-contracts';
import type {
  AdapterManifest,
  DeleteInput,
  DeleteResult,
  EdgesFromResult,
  EventSubscriptionRefresh,
  EventSubscriptionRegistration,
  GetFieldValueInput,
  GetRelatedInput,
  ParentLink,
  RelatedResult,
  ReadInput,
  ResolveEntityInput,
  ResolveEntityResult,
  UpdateInput,
  UpdateResult,
  WriteInput,
  WriteResult,
} from 'movement-engine/public/adapter';
import type { TriggerType } from 'movement-engine/public/inbound';
import type {
  SchemaEntryPoint,
  SchemaTypeDescriptor,
  SourcePosition,
} from 'movement-engine/public/catalog';

import { logger } from 'movement-engine/public/log';
import { AirtableAPIClient, asksForWebhookIncludes } from './api_client';
import { AIRTABLE_MANIFEST } from './manifest';
import {
  META_RECORD_TYPE,
  makeStablePosition,
  positionData,
} from 'movement-engine/public/catalog';
import { BaseAdapter } from 'module-kit/adapter/base';
import { hydrateTargets, targetStubs } from 'module-kit/adapter/hop';
import { stubTargetOf } from 'movement-engine/public/adapter';
import { memoizedResolver, naturalName, type ScopedResolver } from 'module-kit/adapter/name_resolution';
import {
  AIRTABLE_ADAPTER_TYPE,
  type AirtableTableId,
} from './types';
import {
  AIRTABLE_BASES_EDGE,
  allTableEntryPoints,
  basesEntryPoint,
  basesForWalk,
  entryPointsForBase,
  freshBases,
  listenedEntryPoints,
  resolveBaseId,
  BASE_META_TYPE,
  TABLE_META_TYPE,
  describeBaseMeta,
  describeChange,
  describeRow,
  describeTableMeta,
  describe as catalogDescribe,
  describeBase,
  describeTableAt,
  cachedTables,
  freshTables,
  invalidateTableCache,
  loadTableCatalog,
  tablesEntryPoint,
  type TableCatalog,
} from './schema_catalog';
import {
  AIRTABLE_CHANGE_RECORD_EDGE,
  AIRTABLE_CHANGE_TYPE,
  AIRTABLE_CHANGES_EDGE,
  AIRTABLE_ROW_TYPE,
  AIRTABLE_TABLES_EDGE,
  airtablePingSchema,
  arrivalsFromPayload,
  changeDataOf,
  changesTables,
  type AirtableArrival,
  type FieldsByTable,
} from './webhook';
import {
  resolveEntity as recordResolveEntity,
  getFieldValue as recordGetFieldValue,
  getRelated as recordGetRelated,
  listCollection,
  readRecord as recordReadRecord,
  createRecord as recordCreateRecord,
  updateRecord as recordUpdateRecord,
  deleteRecord as recordDeleteRecord,
} from './record';

export { AIRTABLE_ADAPTER_TYPE } from './types';


export class AirtableAdapter extends BaseAdapter {
  readonly adapterType = AIRTABLE_ADAPTER_TYPE;
  /** Bases hold tables: describing every published entry means a `listTables` per base.
   *  So a full-surface describe is refused and the author walks in instead. */
  readonly walksContainers = true;

  readonly supportedTriggers = AIRTABLE_MANIFEST.supportedTriggers;


  private apiClient: AirtableAPIClient | null = null;
  private readonly teamId: string;
  /** Optional entry position — the `base:` construction arg (a base's name).
   *  When set, the instance enumerates ONLY that base, so introspection is a
   *  single base walk rather than the whole workspace. An unrecognised name
   *  falls back to the full walk (mirrors the catalog's positioned-miss
   *  fallback; the checker warns on the unknown name at author time). */
  private readonly entryBaseName?: string;

  constructor(private readonly host: AirtableHost) {
    super();
    this.teamId = host.tenant;
    this.entryBaseName = host.base?.trim() || undefined;
  }

  /** Resolve the configured entry-position base name → its id (first match), or
   *  undefined when no `base:` was configured or the name is unknown. */
  private async entryBaseId(): Promise<string | undefined> {
    if (!this.entryBaseName) return undefined;
    const client = await this.getApiClient();
    return resolveBaseId({ client, teamId: this.teamId, baseName: this.entryBaseName });
  }

  // ── Name → structured-identifier cache (THE reference pattern) ───────────
  // The framework names a table only by its pretty `displayName`; the Airtable
  // API routes on `{ baseId, tableId }`. This private catalog is the map
  // between them, memoized per instance from the SAME base/table introspection
  // that lists entry points. Every method that needs to hit the API recovers
  // its ids from the recordType NAME here, on its first line — never by parsing
  // a magic string. Mirrors `resolver()`'s lazy-memoize-and-evict-on-failure.

  private tableCatalogCache?: Promise<TableCatalog>;

  private catalog(): Promise<TableCatalog> {
    if (this.tableCatalogCache === undefined) {
      this.tableCatalogCache = (async () => {
        const client = await this.getApiClient();
        // SCOPED to the entry base when positioned: table names are bare now,
        // so they're unique only within a base. This instance can only name
        // its own base's tables, and this is what makes those names exact.
        const baseId = await this.entryBaseId();
        return loadTableCatalog({
          client,
          teamId: this.teamId,
          ...(baseId !== undefined ? { baseId } : {}),
        });
      })();
      // A failed introspection mustn't poison the instance — drop the cache so
      // the next call retries (mirrors the resolver's eviction policy).
      this.tableCatalogCache.catch(() => {
        this.tableCatalogCache = undefined;
      });
    }
    return this.tableCatalogCache;
  }

  /** Resolve a table's pretty NAME to its `{ baseId, tableId }`, or undefined
   *  when the name isn't a known table (an unknown type — the caller decides
   *  whether that's a graceful empty or a hard error). */
  private async structuredIdFor(name: string): Promise<AirtableTableId | undefined> {
    return (await this.catalog()).idsByName.get(name);
  }

  /** The write/read variant: a name that doesn't resolve is a hard error (the
   *  movement targets a table this connection can't see — drift). */
  private async requireStructuredId(name: string, method: string): Promise<AirtableTableId> {
    const ids = await this.structuredIdFor(name);
    if (!ids) {
      throw new Error(`AirtableAdapter.${method}: unrecognised recordType "${name}".`);
    }
    return ids;
  }

  // ── 1. Schema introspection ────────────────────────────────────────────

  async listEntryPoints(): Promise<SchemaEntryPoint[]> {
    // Positioned at a base (`base:` arg) → that base's tables: the construction
    // already walked the cursor there, so the root's edges ARE its tables.
    // Unpositioned → the polymorphic `Base` edge; naming a table needs a base
    // either way — by walking to it, or by this auto-traversal.
    //
    // The EVENT edge is on both, and behind neither: a listen HANDS you the
    // event position, so naming it must not require having walked to a
    // container. That is the whole of 6_event_positions.md's complaint — the
    // author used to say the base twice (once to construct, once to listen)
    // because the event type was a table, and a table lives behind its base.
    const baseId = await this.entryBaseId();
    if (baseId) {
      const client = await this.getApiClient();
      return [
        tablesEntryPoint(),
        ...listenedEntryPoints({ positioned: true }),
        ...(await entryPointsForBase({ client, teamId: this.teamId, baseId })),
      ];
    }
    // ONE presentation (4_polymorphic_edges.md, narrowed 2026-07-17): the
    // polymorphic `Base` edge, narrowed by WHERE. The named per-base edges
    // were dropped — they said nothing the narrowable edge doesn't, and a
    // movement should meet "the base called CRM", not a bare proper noun.
    // Costs NOTHING: both entries are static facts, so the unpositioned root
    // no longer even pays its `listBases` here (the walk pays it, once, when
    // someone follows the edge).
    return [basesEntryPoint(), ...listenedEntryPoints({ positioned: false })];
  }

  /**
   * The name resolver's type surface: every TABLE this instance may be asked
   * to read or write, by name.
   *
   * Deliberately NOT `listEntryPoints`. The root publishes the author-facing
   * entrance to type-space (the bases); the resolver answers a different
   * question — the engine hands it a table NAME at runtime and it must produce
   * that table's field ids. A base has no fields, so a resolver built from the
   * published entries would map nothing and every write would send display
   * names where Airtable expects field ids.
   *
   * So this is the pre-existing full walk, unchanged and equally cached. The
   * drill-down's win is on the AUTHOR-TIME path (describe), which is where the
   * timeout was; a movement that actually runs against a table was always
   * going to need that table's fields.
   */
  private async tableEntryPoints(): Promise<SchemaEntryPoint[]> {
    const client = await this.getApiClient();
    const baseId = await this.entryBaseId();
    const tables = baseId
      ? await entryPointsForBase({ client, teamId: this.teamId, baseId })
      : await allTableEntryPoints({ client, teamId: this.teamId });
    // The types a listen lands on ride along: the engine hands this resolver
    // a `Change` when a movement walks its `Record` edge, and a type that is a
    // static fact about the adapter is never workspace drift.
    return [...listenedEntryPoints({ positioned: baseId !== undefined }), ...tables];
  }

  protected override readonly resolver: ScopedResolver = memoizedResolver({
    listEntryPoints: () => this.tableEntryPoints(),
    describe: (typeRef: string) => this.describe(typeRef),
  });

  async describe(typeRef: string): Promise<SchemaTypeDescriptor | null> {
    // The type is named by its displayName (a base's name, or a table's own
    // name within it), which IS the entry `typeId` — `resolveTypeRef` is a
    // pass-through for a known name and a no-op for anything else; the catalog
    // resolves the name to its ids.
    const typeId = await this.resolveTypeRef(typeRef);
    if (typeId === BASE_META_TYPE) return describeBaseMeta();
    // The event's `Record` edge lands here before anything says WHICH table —
    // free, like every unnarrowed meta node: its shape is a fact about the
    // adapter, not the workspace.
    if (typeId === TABLE_META_TYPE) return describeTableMeta();
    // What a listen lands on costs nothing to describe: a change's shape is a
    // fact about the adapter, not about the workspace.
    if (typeId === AIRTABLE_CHANGE_TYPE) return describeChange();
    if (typeId === AIRTABLE_ROW_TYPE) return describeRow();
    const client = await this.getApiClient();
    return catalogDescribe({ client, teamId: this.teamId, typeId });
  }

  /**
   * The meta-graph walk: meta → a base → a table → its fields.
   *
   * This is the drill-down. Each hop is ONE upstream call answering exactly
   * what was asked, because the position carries the route: a `Table` position
   * holds its `baseId`, so describing a table never re-walks the workspace to
   * map its name back to `{baseId, tableId}`. That re-derivation — 1 + N calls
   * to describe ONE table — is what `describe` still pays when a caller has
   * only a name, and what a walker never pays.
   *
   * Airtable is the case the model was built for: two bases hold different
   * tables, so they are two TYPES rather than two instances of one, and each
   * gets its own type-edge off the root.
   *
   */
  async edgesFrom(position: SourcePosition): Promise<EdgesFromResult | null> {
    const client = await this.getApiClient();

    if (position.recordType === META_RECORD_TYPE) {
      // Positioned at a base (`base:` arg) — the construction already walked
      // us there, so the root's edges ARE that base's tables. Unpositioned,
      // the root's edges are the bases. Same model, different cursor.
      const baseId = await this.entryBaseId();
      const hop = baseId ? await this.baseHop(baseId, { positioned: true }) : await this.rootHop();
      return this.withTargets(hop);
    }

    if (position.recordType === BASE_META_TYPE && position.identity.kind === 'stable') {
      // Mid-walk, a base's tables are traversed AND written: `createRecord`
      // resolves a table by its own name anywhere in the workspace, so the
      // write path is the same one the positioned root offers. For an
      // UNPOSITIONED instance this edge is the only place a row create can be
      // authored at all — the root publishes only the read-only `Base`.
      return this.withTargets(await this.baseHop(position.identity.recordId, { positioned: false }));
    }

    if (position.recordType === TABLE_META_TYPE && position.identity.kind === 'stable') {
      const baseId = (position.identity.data as { baseId?: string } | undefined)?.baseId;
      if (baseId === undefined) return null;
      const descriptor = await describeTableAt({
        client,
        teamId: this.teamId,
        baseId,
        tableId: position.identity.recordId,
      });
      // A table is a leaf of the META-graph: its link edges lead to other
      // TYPES, but reaching those is `describe`/traversal's business, not a
      // deeper container hop — so no paths on from here. The link targets are
      // STUBBED: naming one means a `getTableColumns` against Airtable, and a
      // wide table links to many.
      return descriptor ? { descriptor, ...targetStubs(descriptor) } : null;
    }

    return null;
  }

  /** The root's edges: the ONE `Bases` edge, its members riding
   *  `targetPositions` with the path on to each; narrowing selects a member
   *  and follows its path — same landing, same single fetch. */
  private async rootHop(): Promise<EdgesFromResult> {
    const client = await this.getApiClient();
    const bases = await basesForWalk({ client, teamId: this.teamId });
    return {
      descriptor: {
        typeId: META_RECORD_TYPE,
        displayName: META_RECORD_TYPE,
        fields: [],
        references: [
          // You traverse a base; you never write one. `listEntryPoints`
          // publishes this same edge with the same promises — the entry list
          // and the walk are the same node's edges, and an absent flag here
          // would default to a write claim the entry list denies.
          {
            fieldId: AIRTABLE_BASES_EDGE,
            name: AIRTABLE_BASES_EDGE,
            targetTypeId: BASE_META_TYPE,
            cardinality: 'many' as const,
            writable: false,
          },
        ],
      },
      // The polymorphic edge's MEMBERS — paths without presentation rows
      // (`EdgesFromResult.targetPositions`): each member's `recordType` names
      // the edge it belongs to, its `Name` label names the member.
      targetPositions: Object.fromEntries(
        bases.map((base) => [
          base.id,
          makeStablePosition({
            adapterType: this.adapterType,
            recordType: BASE_META_TYPE,
            recordId: base.id,
            // `Name` addresses it the way a movement does; `Id` addresses it the
            // way a LISTEN does (`base: "appDevLoop"`). Both are published
            // because narrowing evaluates a predicate over this data, and the
            // two surfaces name the same base differently.
            data: { Name: base.name, Id: base.id },
          }),
        ]),
      ),
    };
  }

  /**
   * What each of this hop's edges LANDS ON.
   *
   * Bases and tables are STUBBED: naming one means a `listTables` or a
   * `getTableColumns` against Airtable, and a hop has an edge per container —
   * hydrating would fetch the workspace to answer "what is in here".
   *
   * The meta nodes a listen walks through (`Table`, `Change`) are hydrated:
   * their descriptors are static (no call). Stub what is expensive, not
   * everything.
   */
  private async withTargets(hop: EdgesFromResult | null): Promise<EdgesFromResult | null> {
    if (!hop) return null;
    const targetNodes = await hydrateTargets({
      descriptor: hop.descriptor,
      describe: (typeId) => this.describe(typeId),
      stubTarget: (reference) =>
        reference.targetTypeId === TABLE_META_TYPE || reference.targetTypeId === BASE_META_TYPE
          ? undefined
          : stubTargetOf({ typeId: reference.targetTypeId }),
    });
    return { ...hop, ...(targetNodes !== undefined ? { targetNodes } : {}) };
  }

  /** One base's edges: its tables, each pathed by `{baseId, tableId}` — the
   *  route a table can't be reached without. Every table edge promises write
   *  (see `describeBase`): creating a row is THE Airtable operation, and it
   *  resolves the table by name however the caller got there. */
  private async baseHop(baseId: string, at: { positioned: boolean }): Promise<EdgesFromResult | null> {
    const client = await this.getApiClient();
    const descriptor = await describeBase({ client, teamId: this.teamId, baseId, positioned: at.positioned });
    if (!descriptor) return null;
    return {
      descriptor,
      targetPositions: Object.fromEntries(
        // `describeBase` keys each table edge by its raw tableId — the fieldId
        // the caller looks the path up under.
        descriptor.references.filter((reference) => reference.fieldId !== AIRTABLE_TABLES_EDGE).map((reference) => [
          reference.fieldId,
          makeStablePosition({
            adapterType: this.adapterType,
            recordType: TABLE_META_TYPE,
            recordId: reference.fieldId,
            // `baseId` is the ROUTE on (a table can't be fetched without its
            // base — `edgesFrom` reads it back). `Id`/`Name` are how the table
            // is ADDRESSED: by id from a listen (`table: "tblDeals"`), by name
            // from a movement.
            data: { baseId, Id: reference.fieldId, Name: reference.name ?? reference.fieldId },
          }),
        ]),
      ),
    };
  }

  // ── 2. Entity resolution ───────────────────────────────────────────────

  async resolveEntity(input: ResolveEntityInput): Promise<ResolveEntityResult> {
    // The engine names the record type / `record` keys / constraint fields by
    // this adapter's NATURAL names. Two first-line translations: (a) the type
    // NAME → its `{ baseId, tableId }` via the structured-id cache (the
    // constraint search needs the routing ids); (b) each `record` key +
    // constraint `field` property-first (`tryFieldId`), else link/edge
    // (`tryEdgeWriteName`), else leave as-is. `recordType` itself STAYS the
    // natural name — the bridge stage matches it against the persisted
    // `external_object_type` label, which is also a name now. Candidate `data`
    // returned by the record layer is already keyed by field display names, so
    // no internal→natural pass is needed on the way out.
    const resolver = await this.resolver({ types: [input.recordType] });
    const naturalTypeName = input.recordType;
    const ids = await this.structuredIdFor(naturalTypeName);

    const renameKey = (field: string): string =>
      resolver.tryFieldId(naturalName(naturalTypeName), naturalName(field)) ??
      resolver.tryEdgeWriteName(naturalName(naturalTypeName), naturalName(field)) ??
      field;

    const record: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input.record)) record[renameKey(k)] = v;

    const constraints = {
      any: input.constraints.any.map((branch) => ({
        all: branch.all.map((entry) => ({ ...entry, field: renameKey(entry.field) })),
      })),
    };

    const client = await this.getApiClient();
    return recordResolveEntity({
      client,
      teamId: this.teamId,
      ids,
      resolve: { ...input, record, constraints },
    });
  }

  // ── 3. Field-level access ──────────────────────────────────────────────

  async getFieldValue(input: GetFieldValueInput): Promise<unknown> {
    // `fieldId` is the NATURAL field name (the field displayName). Airtable's
    // read API returns each record's `fields` keyed by field NAME (the client
    // never sets `returnFieldsByFieldId`), so the position `data` is itself
    // name-keyed — the natural field name IS the lookup key, and no
    // natural→internal-id translation is needed (resolving to a `fld…` id here
    // would miss the name-keyed payload).
    return recordGetFieldValue({ adapterType: this.adapterType, get: input });
  }

  async getRelated(input: GetRelatedInput): Promise<RelatedResult[]> {
    // A change's `Record` edge: the row it changed, as the change left it. The
    // change carries the row's id, its table's name and its cells, so
    // following it is a mint, never a read.
    const outgoing = input.direction === 'outgoing';
    if (outgoing && input.fieldId === AIRTABLE_CHANGE_RECORD_EDGE) {
      const change = changeDataOf(positionData(input.position));
      if (change !== null) {
        return [{ position: makeStablePosition({ adapterType: this.adapterType, recordType: change.row.table, recordId: change.row.id, data: change.row.cells }) }];
      }
    }

    // The root's `Bases`: every base, by `Name` and `Id` (what a listen's
    // WHERE narrows them by), as the `base:` construction arg's options too.
    if (outgoing && input.position.recordType === META_RECORD_TYPE && input.fieldId === AIRTABLE_BASES_EDGE) {
      const client = await this.getApiClient();
      // Read now, never from the cache: a listen lists them again on a clock
      // to see a base renamed, which Airtable never reports (`freshBases`).
      const bases = await freshBases({ client, teamId: this.teamId });
      return bases.map((b) => ({
        position: makeStablePosition({ adapterType: this.adapterType, recordType: BASE_META_TYPE, recordId: b.id, data: { Name: b.name, Id: b.id } }),
      }));
    }

    // A base's `Tables` (a positioned root's are its base's): each table by
    // `Name` and `Id`, carrying its base, the route on to it.
    const tablesOf =
      !outgoing || input.fieldId !== AIRTABLE_TABLES_EDGE
        ? undefined
        : input.position.recordType === META_RECORD_TYPE
          ? await this.entryBaseId()
          : input.position.recordType === BASE_META_TYPE && input.position.identity.kind === 'stable'
            ? input.position.identity.recordId
            : undefined;
    if (tablesOf !== undefined) {
      const client = await this.getApiClient();
      // Read now, never from the cache: a listen narrowed by its tables is
      // listed again when one is renamed, and must see the rename (`freshTables`).
      const tables = await freshTables({ client, teamId: this.teamId, baseId: tablesOf });
      return tables.map((table) => ({
        position: makeStablePosition({ adapterType: this.adapterType, recordType: TABLE_META_TYPE, recordId: table.id, data: { Name: table.name, Id: table.id, baseId: tablesOf } }),
      }));
    }

    // A COLLECTION hop — the records in a table, reached from a CONTAINER
    // rather than from a record: the root of a base-positioned instance
    // (`at-[c:`Deals`]->`), or a base you traversed to
    // (`-[b:Bases WHERE b.Name == "CRM"]->-[c:Deals]->`). Both surfaces are
    // published readable, so both must read; before this the first threw (a
    // meta position isn't a record) and the second silently returned nothing.
    // The container supplies the base, which is what makes the bare table name
    // exact — the same rule the whole model runs on.
    const containerBaseId =
      input.position.recordType === META_RECORD_TYPE
        ? await this.entryBaseId()
        : input.position.recordType === BASE_META_TYPE && input.position.identity.kind === 'stable'
          ? input.position.identity.recordId
          : undefined;
    if (outgoing && containerBaseId !== undefined) {
      const client = await this.getApiClient();
      const tables = await cachedTables({
        client,
        teamId: this.teamId,
        baseId: containerBaseId,
      });
      const table = tables.find((t) => t.name === input.fieldId);
      // An unknown collection degrades to empty, like every other unresolved
      // name here — the checker owns the author's diagnostic.
      if (!table) return [];
      return listCollection({
        client,
        adapterType: this.adapterType,
        baseId: containerBaseId,
        tableId: table.id,
        tableName: table.name,
      });
    }

    // The UNPOSITIONED root has exactly one collection — `Bases`, handled
    // above. Anything else off the meta node is unknown: empty, like every
    // other unresolved name (and never the record path, whose fallback would
    // pay a workspace walk to answer nothing).
    if (input.position.recordType === META_RECORD_TYPE) return [];

    // The position's `recordType` is a NATURAL table name on every hop (the
    // landings this adapter emits stamp the linked table's name too). Recover
    // its `{ baseId, tableId }` from the structured-id cache; an unknown name
    // yields undefined and the record layer degrades to an empty traversal.
    // The catalog's `nameByTableId` lets the record layer NAME the landings it
    // emits. The NATURAL edge name (`fieldId`) resolves directly against the
    // record layer's `fieldMetaByKey` (indexed by both id and name).
    const recordType = input.position.recordType;
    const ids = recordType !== null ? await this.structuredIdFor(recordType) : undefined;
    const catalog = await this.catalog();
    const client = await this.getApiClient();
    return recordGetRelated({
      client,
      teamId: this.teamId,
      adapterType: this.adapterType,
      ids,
      nameByTableId: catalog.nameByTableId,
      get: input,
    });
  }

  // ── 5. Writes ───────────────────────────────────────────────────────────

  /**
   * Translate a write/update's FIELD names from the engine's NATURAL currency
   * to this adapter's internal `fld…` ids, on the first line of each write
   * method: each `fields` / `evidence` key (field displayName) → internal field
   * id; each parent slot's `edgeName` (the link field's displayName) → its
   * write currency (the link field's id). `recordType` itself STAYS the natural
   * table name — the record layer routes via the structured-id cache, not by
   * decoding a string. (Airtable accepts id-keyed fields, matching the
   * parent-link field the record layer sets by id.)
   */
  private async translateWrite<T extends WriteInput>(input: T): Promise<T> {
    const resolver = await this.resolver({ types: [input.recordType] });
    const naturalTypeName = input.recordType;

    const renameFieldKey = (field: string): string =>
      resolver.tryFieldId(naturalName(naturalTypeName), naturalName(field)) ??
      resolver.tryEdgeWriteName(naturalName(naturalTypeName), naturalName(field)) ??
      field;

    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input.fields)) fields[renameFieldKey(k)] = v;

    const evidence = input.evidence
      ? Object.fromEntries(
          Object.entries(input.evidence).map(([k, v]) => [renameFieldKey(k), v]),
        )
      : input.evidence;

    const translateParent = (parent: ParentLink): ParentLink => {
      // The edge name belongs to the FROM (child) side's type — the link field
      // on this record. Resolve against the write's own type. `recordType`
      // stays the parent's natural name (the record layer reads only edgeName +
      // externalId from a parentLink).
      const edgeName =
        resolver.tryEdgeWriteName(naturalName(naturalTypeName), naturalName(parent.edgeName)) ??
        parent.edgeName;
      return { ...parent, edgeName };
    };

    return {
      ...input,
      fields,
      ...(evidence !== undefined ? { evidence } : {}),
      ...(input.parentLinks
        ? { parentLinks: input.parentLinks.map(translateParent) }
        : {}),
    };
  }

  async createRecord(rawInput: WriteInput): Promise<WriteResult> {
    const input = await this.translateWrite(rawInput);
    const ids = await this.requireStructuredId(rawInput.recordType, 'createRecord');
    const client = await this.getApiClient();
    return recordCreateRecord({ client, teamId: this.teamId, files: this.host.files, ids, write: input });
  }

  async updateRecord(rawInput: UpdateInput): Promise<UpdateResult> {
    const input = await this.translateWrite(rawInput);
    const ids = await this.requireStructuredId(rawInput.recordType, 'updateRecord');
    const client = await this.getApiClient();
    return recordUpdateRecord({ client, teamId: this.teamId, files: this.host.files, ids, update: input });
  }

  async deleteRecord(input: DeleteInput): Promise<DeleteResult> {
    // `recordType` is the NATURAL table name — recover its routing ids from the
    // structured-id cache; an unknown table is a hard error.
    const ids = await this.requireStructuredId(input.recordType, 'deleteRecord');
    const client = await this.getApiClient();
    return recordDeleteRecord({ client, ids, del: input });
  }

  // ── 6. No-op detection read ─────────────────────────────────────────────

  async readRecord(input: ReadInput): Promise<Record<string, unknown> | null> {
    // `recordType` is the NATURAL table name — recover its routing ids from the
    // structured-id cache. An unknown table reads as "nothing here" (null).
    const ids = await this.structuredIdFor(input.recordType);
    if (!ids) return null;
    const client = await this.getApiClient();
    return recordReadRecord({ client, ids, read: input });
  }

  // ── 7. Arrivals (notify-then-pull) ────────────────────────────────────────
  // Airtable pings with only ids (`{ base, webhook }`); the changes are PULLED
  // from the webhook's payload feed, from the cursor the host keeps for the
  // webhook, and each becomes an arrival (webhook.ts): a row's change on its
  // table's `Changes`, a table made, renamed or removed on its base's `Tables`.

  async preprocessInbound(input: { raw: unknown; checkpoint?: unknown }): Promise<{ events: []; arrivals: AirtableArrival[]; checkpoint?: unknown }> {
    const ping = airtablePingSchema.safeParse(input.raw);
    if (!ping.success) return { events: [], arrivals: [] };
    const { base, webhook } = ping.data;
    const client = await this.getApiClient();
    const positioned = (await this.entryBaseId()) === base.id;

    // Drain from the persisted cursor (default 1 = from the webhook's start).
    // The page loop is bounded so a misbehaving feed can't spin forever; the
    // host keeps the returned cursor only once the arrivals are kept.
    let cursor = typeof input.checkpoint === 'number' ? input.checkpoint : 1;
    const payloads = [];
    const MAX_PAGES = 1000;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await client.listPayloads({ baseId: base.id, webhookId: webhook.id, cursor });
      payloads.push(...result.payloads);
      cursor = result.cursor;
      if (!result.mightHaveMore) break;
    }
    // A table made, renamed or removed: what this module holds of the base's
    // tables is stale, and a listen narrowed by them lists them again now.
    if (payloads.some(changesTables)) {
      invalidateTableCache(this.teamId, base.id);
      this.tableCatalogCache = undefined;
    }
    const context = { baseId: base.id, positioned, ...(await this.fieldsOf(base.id)) };
    return { events: [], arrivals: payloads.flatMap((payload) => arrivalsFromPayload(payload, context)), checkpoint: cursor };
  }

  /** The base's `fieldId → { name, type }` maps and table names, so cells
   *  (keyed by field id) are read by name. A metadata failure leaves them
   *  keyed by id rather than dropping the delivery. */
  private async fieldsOf(baseId: string): Promise<{ fieldsByTable: FieldsByTable; tableNamesById: Map<string, string> }> {
    const fieldsByTable: FieldsByTable = new Map();
    const tableNamesById = new Map<string, string>();
    try {
      const client = await this.getApiClient();
      for (const table of await cachedTables({ client, teamId: this.teamId, baseId })) {
        fieldsByTable.set(table.id, new Map(table.fields.map((f) => [f.id, { name: f.name, type: f.type }])));
        tableNamesById.set(table.id, table.name);
      }
    } catch (err) {
      logger.warn('[AirtableAdapter.preprocessInbound] table metadata unavailable — reading fields by id', {
        teamId: this.teamId,
        baseId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return { fieldsByTable, tableNamesById };
  }

  /** A run waits on a table's `Changes` under the table's id, and on a base's
   *  `Tables` under the base's: the key each arrival on them names. Airtable's
   *  ids say what they are (`tbl…`, `app…`), so no two collide. */
  readonly arrivals: ArrivalsCapability = {
    awaitKeys: async ({ edge, heads }: { edge: string; heads: AwaitHead[] }): Promise<AwaitKey[]> => {
      if (edge !== AIRTABLE_CHANGES_EDGE && edge !== AIRTABLE_TABLES_EDGE) {
        throw new Error(`airtable: '${edge}' is not a listenable edge (only '${AIRTABLE_CHANGES_EDGE}' and '${AIRTABLE_TABLES_EDGE}')`);
      }
      return heads.map((head) => ({ key: head.recordId }));
    },
  };

  // ── Event subscriptions (one webhook per subscription) ────────────────────
  // A table's `Changes` is a webhook scoped to the table (`recordChangeScope`)
  // taking every change kind; a base's `Tables` is a webhook on the base
  // taking its schema (`tableMetadata`). Airtable webhooks belong to a base,
  // so a table's is registered on the base the table is in.

  async ensureEventSubscription(input: EnsureEdgeSubscriptionInput): Promise<EventSubscriptionRegistration | undefined> {
    const at = await this.webhookScope(input);
    const client = await this.getApiClient();
    if (input.current?.externalId !== undefined) {
      if (at.tableId === undefined || (await this.asksForEveryInclude(client, at.baseId, input.current.externalId))) return undefined;
      // Registered before a webhook asked for what it asks for now: drop it
      // and register anew (best-effort; a stale one expires anyway).
      await client.deleteWebhook({ baseId: at.baseId, webhookId: input.current.externalId }).catch((err) => {
        logger.warn('[AirtableAdapter] failed to delete superseded webhook before recreate', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
    const created = await client.createWebhook({
      baseId: at.baseId,
      notificationUrl: input.callbackUrl,
      ...(at.tableId !== undefined
        ? { tableId: at.tableId, changeTypes: ['add', 'update', 'remove'] }
        : { dataTypes: ['tableMetadata'] as const, changeTypes: ['add', 'update', 'remove'] }),
    });
    // macSecretBase64 is issued ONLY here — the host keeps it as the inbound
    // MAC key. A webhook lapses 7 days on unless refreshed: the host
    // refreshes it before `expiresAt`.
    return {
      externalId: created.webhookId,
      secret: created.macSecretBase64,
      ...(created.expirationTime !== undefined ? { expiresAt: created.expirationTime } : {}),
    };
  }

  /** Whether the held webhook was created asking for what a webhook asks for
   *  now (`WEBHOOK_INCLUDES`); one this cannot find or read is taken as it
   *  is, since a lapsed or vanished webhook is the host's to register anew. */
  private async asksForEveryInclude(client: AirtableAPIClient, baseId: string, webhookId: string): Promise<boolean> {
    try {
      const held = (await client.listWebhooks({ baseId })).find((w) => w.id === webhookId);
      return held === undefined || asksForWebhookIncludes(held.specification);
    } catch (err) {
      logger.warn('[AirtableAdapter] could not read the webhook\'s specification; keeping it', {
        error: err instanceof Error ? err.message : String(err),
      });
      return true;
    }
  }

  async removeEventSubscription(input: RemoveEdgeSubscriptionInput): Promise<void> {
    if (input.externalId === undefined) return;
    const at = await this.webhookScope(input);
    const client = await this.getApiClient();
    await client.deleteWebhook({ baseId: at.baseId, webhookId: input.externalId });
  }

  /**
   * Extend a registered webhook's 7-day expiry. Airtable disables inactive
   * webhooks after 7 days; a delivery (which pulls payloads) already extends
   * the window, so only quiet webhooks need this — `listen-fire` refreshes
   * one before the `expiresAt` its registration returned. Answers when it now
   * expires.
   */
  async refreshEventSubscription(input: RefreshEdgeSubscriptionInput): Promise<EventSubscriptionRefresh | undefined> {
    const at = await this.webhookScope(input);
    const client = await this.getApiClient();
    const refreshed = await client.refreshWebhook({ baseId: at.baseId, webhookId: input.externalId });
    return refreshed.expirationTime !== undefined ? { expiresAt: refreshed.expirationTime } : {};
  }

  /**
   * The base a subscription's webhook belongs to, and for a table's `Changes`
   * the table: a `Changes` subscription is scoped by its table, a `Tables`
   * one by its base (or, at a positioned root, the connection's base).
   */
  private async webhookScope(input: { edge: string; scope?: string }): Promise<{ baseId: string; tableId?: string }> {
    if (input.edge === AIRTABLE_CHANGES_EDGE) {
      if (input.scope === undefined) throw new Error(`airtable: a subscription to '${AIRTABLE_CHANGES_EDGE}' names the table it is for`);
      return { baseId: await this.baseOfTable(input.scope), tableId: input.scope };
    }
    if (input.edge === AIRTABLE_TABLES_EDGE) {
      const baseId = input.scope ?? (await this.entryBaseId());
      if (baseId === undefined) throw new Error(`airtable: a subscription to '${AIRTABLE_TABLES_EDGE}' names the base it is for`);
      return { baseId };
    }
    throw new Error(`airtable: '${input.edge}' is not a listenable edge (only '${AIRTABLE_CHANGES_EDGE}' and '${AIRTABLE_TABLES_EDGE}')`);
  }

  /** The base a table is in: the connection's own when it is positioned,
   *  else the one whose tables list it. A table made since they were read is
   *  found by reading them again. */
  private async baseOfTable(tableId: string): Promise<string> {
    const positioned = await this.entryBaseId();
    if (positioned !== undefined) return positioned;
    const find = async () => {
      const client = await this.getApiClient();
      for (const base of await basesForWalk({ client, teamId: this.teamId })) {
        const tables = await cachedTables({ client, teamId: this.teamId, baseId: base.id });
        if (tables.some((t) => t.id === tableId)) return base.id;
      }
      return undefined;
    };
    const found = await find();
    if (found !== undefined) return found;
    for (const base of await basesForWalk({ client: await this.getApiClient(), teamId: this.teamId })) invalidateTableCache(this.teamId, base.id);
    const again = await find();
    if (again === undefined) throw new Error(`airtable: no base this connection can see holds table ${tableId}`);
    return again;
  }

  // ── Internal: lazy API client construction ──────────────────────────────

  private async getApiClient(): Promise<AirtableAPIClient> {
    if (this.apiClient) return this.apiClient;
    this.apiClient = await this.host.client();
    return this.apiClient;
  }
}

/** What the adapter is built over: the client for the install's credential,
 *  the host's tenant and files, and the `base:` construction argument. */
export interface AirtableHost {
  /** The tenant the install belongs to; the catalog caches by it. */
  tenant: string;
  /** The client for the install's credential, asked for on first use. */
  client(): Promise<AirtableAPIClient>;
  files: ModuleFiles;
  /** A base's name to scope the instance to (optional; default is the full
   *  workspace). */
  base?: string;
}

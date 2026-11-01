// Airtable TG adapter — schema introspection. `listEntryPoints` enumerates
// bases → tables; `describe(typeId)` loads one table's fields + references.
// The Airtable-field-type → TG-field-shape mapping lives here, alongside the
// base/table catalog cache (LRU + TTL, keyed by base — mirrors Attio).

import { LRUCache } from 'lru-cache';

import type {
  SchemaEntryPoint,
  SchemaFieldDescriptor,
  SchemaFieldKind,
  SchemaReferenceDescriptor,
  SchemaTypeDescriptor,
} from 'movement-engine/public/catalog';
import type { AirtableAPIClient } from './api_client';

import {
  BASE_META_TYPE,
  LINK_FIELD_TYPE,
  READ_ONLY_FIELD_TYPES,
  RECORD_ID_FIELD,
  TABLE_META_TYPE,
  type AirtableTableId,
  type AirtableFieldMeta,
  type AirtableTableMeta,
} from './types';
import {
  AIRTABLE_CHANGE_KINDS,
  AIRTABLE_CHANGE_RECORD_EDGE,
  AIRTABLE_CHANGE_TYPE,
  AIRTABLE_CHANGES_EDGE,
  AIRTABLE_ROW_TYPE,
  AIRTABLE_TABLES_EDGE,
} from './webhook';

/**
 * Per-base table catalog, keyed by `<teamId>:<baseId>`. Populated lazily by
 * `cachedTables`; consumed by `describe`, `resolveEntity`, and the write
 * path — all of which need the table's field metadata without re-firing
 * `listTables`. 10-minute TTL matches the Attio catalog cache.
 */
const tableCatalogCache = new LRUCache<string, AirtableTableMeta[]>({
  max: 200,
  ttl: 10 * 60 * 1000,
});

/** Per-team base catalog (id → name), keyed by team. Lets `describe` resolve a
 *  base by name without a `listBases` round-trip on every call. */
const baseCatalogCache = new LRUCache<string, Map<string, string>>({
  max: 50,
  ttl: 10 * 60 * 1000,
});

function tableCacheKey(teamId: string, baseId: string): string {
  return `${teamId}:${baseId}`;
}

export async function cachedTables(input: {
  client: AirtableAPIClient;
  teamId: string;
  baseId: string;
}): Promise<AirtableTableMeta[]> {
  const key = tableCacheKey(input.teamId, input.baseId);
  const hit = tableCatalogCache.get(key);
  if (hit) return hit;
  const tables = await input.client.listTables({ baseId: input.baseId });
  tableCatalogCache.set(key, tables as AirtableTableMeta[]);
  return tables as AirtableTableMeta[];
}

/** A base's tables read now, past the cache, and kept in it: what a base's
 *  `Tables` lists. A listen re-resolved on a schema ping may be listed by
 *  another process than the one the ping reached, whose cache it never
 *  cleared; listing fresh, any process sees the rename. One `listTables`
 *  per base listed, which `Tables` declares cheap. */
export async function freshTables(input: {
  client: AirtableAPIClient;
  teamId: string;
  baseId: string;
}): Promise<AirtableTableMeta[]> {
  const tables = (await input.client.listTables({ baseId: input.baseId })) as AirtableTableMeta[];
  tableCatalogCache.set(tableCacheKey(input.teamId, input.baseId), tables);
  return tables;
}

async function cachedBases(input: {
  client: AirtableAPIClient;
  teamId: string;
}): Promise<Map<string, string>> {
  const hit = baseCatalogCache.get(input.teamId);
  if (hit) return hit;
  const bases = await input.client.listBases();
  const map = new Map<string, string>();
  for (const b of bases) map.set(b.id, b.name);
  baseCatalogCache.set(input.teamId, map);
  return map;
}

/** The workspace's bases read now, past the cache, and kept in it: what the
 *  root's `Bases` lists, so a listen listing them again on its clock sees a
 *  base renamed since (Airtable reports none). One `listBases`. */
export async function freshBases(input: {
  client: AirtableAPIClient;
  teamId: string;
}): Promise<{ id: string; name: string }[]> {
  const bases = await input.client.listBases();
  baseCatalogCache.set(input.teamId, new Map(bases.map((b) => [b.id, b.name])));
  return bases.map((b) => ({ id: b.id, name: b.name }));
}

/** The workspace's bases, cache-backed — `id → name`. The root hop reads them
 *  through here rather than firing its own `listBases`, so walking the root
 *  right after `listEntryPoints` (the ordinary case: the cache enumerates the
 *  node list, then walks to learn its paths) costs ONE call, not two. */
export async function basesForWalk(input: {
  client: AirtableAPIClient;
  teamId: string;
}): Promise<{ id: string; name: string }[]> {
  const baseNames = await cachedBases(input);
  return [...baseNames].map(([id, name]) => ({ id, name }));
}

// ── How a table is named ─────────────────────────────────────────────────────
// By its own name. Nothing more.
//
// It used to be `"<Base> — <Table>"`, because tables were FLAT ROOTS sharing
// one namespace and needed to be globally unique in it. The drill-down removed
// that reason: a table lives behind its base, and naming one REQUIRES a base
// (by walking to it, or via `base:`). So the qualifier is a fossil — and a
// path flattened into a string, with a separator an author had to know and
// `demandSeed` had to substring-match. The path is the address now.
//
// Uniqueness still holds where it must: a POSITIONED instance sees one base's
// tables, so `Companies` is unambiguous within it; an unpositioned instance
// can't name a table at all, so there is no namespace to collide in. That is
// why the catalog below is base-scoped.

// ── Name → structured-identifier cache (the reference pattern) ───────────────
// The framework only ever names a table by its `displayName`. The Airtable API
// routes on `{ baseId, tableId }`. This catalog is the adapter's PRIVATE map
// between the two — populated from the SAME base/table introspection that lists
// entry points, so a position can carry a plain name and the adapter recovers
// the routing ids from it without parsing any magic string. The `nameByTableId`
// reverse lets the read path STAMP an emitted position (a `getRelated` landing)
// with the linked table's name rather than leaking an identifier.

export interface TableCatalog {
  /** `displayName` → `{ baseId, tableId }`. The name → identifier lookup. */
  idsByName: Map<string, AirtableTableId>;
  /** `tableId` → `displayName`. The reverse, for naming positions the adapter
   *  emits (Airtable links stay within a base, so a bare tableId is unique). */
  nameByTableId: Map<string, string>;
}

/**
 * Build the name ⇄ structured-identifier catalog (cache-backed via
 * `cachedBases` + `cachedTables`, so callers re-derive it cheaply and the
 * adapter memoizes it per instance).
 *
 * SCOPE IT with `baseId` — the instance's entry base. Table names are bare now,
 * so they are unique only WITHIN a base: two bases may each hold a `Companies`,
 * and a workspace-wide `idsByName` would silently route one to the other's
 * table. A positioned instance passes its base and the names are exact.
 *
 * Unscoped, this is best-effort and last-wins on a clash: it serves the landing
 * stamps (`nameByTableId`, keyed by the unique tableId, so unaffected) and
 * `describe`'s by-name fallback. An unpositioned instance can't name a table
 * anyway, so nothing routes a write through an ambiguous entry.
 */
export async function loadTableCatalog(input: {
  client: AirtableAPIClient;
  teamId: string;
  /** Restrict to ONE base — what makes a bare table name unambiguous. */
  baseId?: string;
}): Promise<TableCatalog> {
  const baseNames = await cachedBases({ client: input.client, teamId: input.teamId });
  const baseIds = input.baseId !== undefined ? [input.baseId] : [...baseNames.keys()];
  const idsByName = new Map<string, AirtableTableId>();
  const nameByTableId = new Map<string, string>();
  for (const baseId of baseIds) {
    const tables = await cachedTables({ client: input.client, teamId: input.teamId, baseId });
    for (const table of tables) {
      idsByName.set(table.name, { baseId, tableId: table.id });
      nameByTableId.set(table.id, table.name);
    }
  }
  return { idsByName, nameByTableId };
}

// ── Field-type → TG field shape (3_model.md) ───────────────────────────────
// `multipleRecordLinks` is handled separately (it becomes a reference, not a
// value field). Everything else maps to a scalar/array value kind here.

interface ValueShape {
  kind: SchemaFieldKind;
  cardinality: 'one' | 'many';
}

function valueShapeFor(fieldType: string | undefined): ValueShape {
  switch (fieldType) {
    case 'number':
    case 'percent':
    case 'currency':
    case 'duration':
    case 'rating':
    case 'count':
    case 'autoNumber':
      return { kind: 'number', cardinality: 'one' };
    case 'checkbox':
      return { kind: 'boolean', cardinality: 'one' };
    case 'date':
    case 'dateTime':
    case 'createdTime':
    case 'lastModifiedTime':
      return { kind: 'date', cardinality: 'one' };
    case 'multipleSelects':
    case 'multipleCollaborators':
    case 'multipleLookupValues':
    case 'lookup':
      return { kind: 'string', cardinality: 'many' };
    case 'multipleAttachments':
      // A first-class File field: authors map a FileRef (an email attachment,
      // an extracted doc) and the write path hands Airtable the file's signed
      // URL to fetch. Multi — an Airtable attachment cell holds a list.
      return { kind: 'file', cardinality: 'many' };
    case 'singleSelect':
    case 'singleCollaborator':
    case 'singleLineText':
    case 'multilineText':
    case 'email':
    case 'url':
    case 'phoneNumber':
    case 'richText':
    case 'barcode':
    case 'aiText':
      return { kind: 'string', cardinality: 'one' };
    // formula / rollup carry an Airtable-computed `result` whose type
    // we don't statically know. It is a SCALAR though (Airtable computes a
    // number, a string, a date — never a document), so `string` is the honest
    // narrowing: unknown-typed but readable and renderable. `json` is for a
    // genuinely structured value, and would make these read-only fields opaque
    // — unusable in a comparison or a write, for no gain.
    case 'formula':
    case 'rollup':
      return { kind: 'string', cardinality: 'one' };
    default:
      // Unknown / system types (createdBy, lastModifiedBy, button,
      // externalSyncSource, …) surface as string scalars; they're in the
      // read-only set so they never round-trip as writes.
      return { kind: 'string', cardinality: 'one' };
  }
}

// A select's choices come from the base schema (`options.choices[].name`). A
// select with none listed stays text: an empty enum would refuse every value,
// including ones Airtable would accept.
function selectChoices(field: AirtableFieldMeta): string[] {
  if (field.type !== 'singleSelect' && field.type !== 'multipleSelects') return [];
  const choices = (field.options as { choices?: Array<{ name?: unknown }> } | undefined)?.choices;
  if (!Array.isArray(choices)) return [];
  return choices.flatMap((c) => (typeof c?.name === 'string' && c.name !== '' ? [c.name] : []));
}

function fieldDescriptor(field: AirtableFieldMeta): SchemaFieldDescriptor {
  const shape = valueShapeFor(field.type);
  const choices = selectChoices(field);
  return {
    fieldId: field.id,
    displayName: field.name,
    kind: choices.length > 0 ? 'enum' : shape.kind,
    ...(choices.length > 0 ? { enumValues: choices } : {}),
    cardinality: shape.cardinality,
    writable: !READ_ONLY_FIELD_TYPES.has(field.type ?? ''),
    required: false,
    description: field.description,
  };
}

function referenceDescriptor(input: {
  field: AirtableFieldMeta;
  baseName: string;
  tables: AirtableTableMeta[];
}): SchemaReferenceDescriptor | null {
  if (input.field.type !== LINK_FIELD_TYPE) return null;
  const linkedTableId = (input.field.options as { linkedTableId?: string } | undefined)
    ?.linkedTableId;
  if (!linkedTableId) return null;
  // A reference's target is named, like every position, by the linked table's
  // displayName — never an encoded id. Airtable links are within-base, so the
  // linked table is in this base's `tables`. Skip a link to a table the catalog
  // doesn't list (a stale/inaccessible target) rather than name it by raw id.
  const linkedTable = input.tables.find((t) => t.id === linkedTableId);
  if (!linkedTable) return null;
  return {
    fieldId: input.field.id,
    name: input.field.name,
    targetTypeId: linkedTable.name,
    cardinality: 'many',
  };
}

// ── The meta-graph vocabulary ────────────────────────────────────────────────
// The record types of TYPE nodes — the nodes a `edgesFrom` walk moves between,
// NOT nodes holding records. They are deliberately this adapter's own private
// words: a meta-graph position `{recordType: 'Table', recordId: tblXYZ}` can
// never be confused with a data-graph position `{recordType: 'Companies',
// recordId: recXYZ}` naming an actual row. The framework's name for a type
// stays its `displayName`; these only describe how the adapter gets back there.
//
// `Base` doubles as the collection the `base:` construction arg draws from: its
// members are the base NAMES the author picks between (the arg's value enum),
// materialised through `getRelated` off the meta root (see index.ts).
export { BASE_META_TYPE, TABLE_META_TYPE };

/** How often a listen narrowed by its bases lists them again when the
 *  operator says nothing (lf.yaml's `resolveEvery` overrides it): Airtable
 *  says nothing when a base is made or renamed, and that is rare. */
export const AIRTABLE_BASES_RELIST_SECONDS = 3600;

/** The edge a workspace's bases hang off the connection by. */
export const AIRTABLE_BASES_EDGE = 'Bases';

// ── Names this module gives its own types and edges ──────────────────────────
// A table is named by its own name, as a type and as its base's edge to it, and
// a link field as its table's edge. Where one is a name this module gives its
// own (a table called `Change`, a link field called `Changes`), one of the two
// would shadow the other, and which one a program meant could not be told. So
// the describe that would hold both is refused, naming the table or field to
// rename in Airtable. Why not give the user's a namespaced name: that name
// would be a string to parse back, and the rename is one click in Airtable.

/** What a table may not be called: the types this module describes itself
 *  (`Base`, `Table`, `Change`, `Row`) and a base's own edge (`Tables`). */
const RESERVED_TABLE_NAMES: readonly string[] = [BASE_META_TYPE, TABLE_META_TYPE, AIRTABLE_CHANGE_TYPE, AIRTABLE_ROW_TYPE, AIRTABLE_TABLES_EDGE];

/** Refuse a base holding a table named as one of this module's own types or
 *  edges. */
function refuseReservedTableNames(baseName: string, tables: readonly AirtableTableMeta[]): void {
  const clash = tables.find((table) => RESERVED_TABLE_NAMES.includes(table.name));
  if (clash !== undefined) {
    throw new Error(
      `airtable: base "${baseName}" has a table named "${clash.name}", a name the Airtable module gives its own (${RESERVED_TABLE_NAMES.join(', ')}), so a program could not tell which it meant: rename the table in Airtable to reach this base`,
    );
  }
  // A table's changes are named for it (`Candidates Change`): a table of that
  // name would be two types under one name.
  const changes = tables.find((table) => tables.some((other) => table.name === tableChangeType(other.name)));
  if (changes !== undefined) {
    throw new Error(
      `airtable: base "${baseName}" has a table named "${changes.name}", the name the Airtable module gives another table's changes, so a program could not tell which it meant: rename the table in Airtable to reach this base`,
    );
  }
}

/** The type a table's changes land on, named for the table. */
export function tableChangeType(tableName: string): string {
  return `${tableName} ${AIRTABLE_CHANGE_TYPE}`;
}

/** Refuse a table, reached as one of a base's `Tables`, whose link field is
 *  named as its own `Changes` edge. */
function refuseReservedReferenceNames(tableName: string, references: readonly SchemaReferenceDescriptor[]): void {
  const clash = references.find((reference) => (reference.name ?? reference.fieldId) === AIRTABLE_CHANGES_EDGE);
  if (clash === undefined) return;
  throw new Error(
    `airtable: table "${tableName}" has a link field named "${AIRTABLE_CHANGES_EDGE}", the name of a table's own edge to its changes, so a program could not tell which it meant: rename the field in Airtable to reach this table`,
  );
}

/**
 * The root's `Bases`: every base the connection can see, each a member
 * narrowed by `Name` or `Id` (`at-[b:Bases WHERE b.Name == "Finance"]->`).
 * Cheap to list (one call), and listed again on a clock: Airtable reports
 * no base made or renamed.
 */
export function basesEntryPoint(): SchemaEntryPoint {
  return {
    typeId: BASE_META_TYPE,
    displayName: BASE_META_TYPE,
    collectionName: AIRTABLE_BASES_EDGE,
    // You traverse a base; you never create one from a movement.
    writable: false,
    readable: true,
    cheapToList: true,
    relistEverySeconds: AIRTABLE_BASES_RELIST_SECONDS,
  };
}

/**
 * The positioned root's `Tables`: the base's tables, as `Table` records
 * (`hiring-[t:Tables WHERE t.Name == "Candidates"]->-[:Changes]->`). The base
 * is the connection's own, so its tables' changes are reported to the
 * connection: one schema webhook for the base.
 */
export function tablesEntryPoint(): SchemaEntryPoint {
  return {
    typeId: TABLE_META_TYPE,
    displayName: TABLE_META_TYPE,
    collectionName: AIRTABLE_TABLES_EDGE,
    writable: false,
    readable: true,
    ...TABLES_LISTENING,
    delivery: 'connection',
  };
}

/** A type a hop lands on that no root lists: named so the resolver knows it. */
function namedOnly(typeId: string): SchemaEntryPoint {
  return { typeId, displayName: typeId, writable: false, readable: false };
}

/** The types a listen walks through that no root publishes: a table, its
 *  changes, and the row a change is about. */
export function listenedEntryPoints(input: { positioned: boolean }): SchemaEntryPoint[] {
  return [...(input.positioned ? [] : [namedOnly(TABLE_META_TYPE)]), namedOnly(AIRTABLE_CHANGE_TYPE), namedOnly(AIRTABLE_ROW_TYPE)];
}

/** What a base's `Tables` declares of listening, wherever it is: listed
 *  cheaply, and its changes (a table made, renamed, removed) reported by
 *  Airtable's schema webhook, so a listen narrowed by its tables is listed
 *  again on each, never on a clock. */
const TABLES_LISTENING = {
  cheapToList: true,
  parentChanges: 'pushed',
  listenable: true,
  identity: 'Id',
} as const;

/** The `Tables` edge off a base, one schema webhook per base: per base
 *  (`scope`) off a base walked to, the connection's own at a positioned root. */
export function tablesReference(delivery: 'scope' | 'connection' = 'scope'): SchemaReferenceDescriptor {
  return {
    fieldId: AIRTABLE_TABLES_EDGE,
    name: AIRTABLE_TABLES_EDGE,
    targetTypeId: TABLE_META_TYPE,
    cardinality: 'many',
    direction: 'outgoing',
    readable: true,
    writable: false,
    ...TABLES_LISTENING,
    delivery,
    description: "The base's tables. A table made, renamed or removed arrives here (Airtable's schema webhook, one per base).",
  };
}

const metaField = (fieldId: string, description: string): SchemaFieldDescriptor => ({
  fieldId,
  displayName: fieldId,
  kind: 'string',
  writable: false,
  required: false,
  description,
});

/**
 * The `Base` node, UNNARROWED: its own `Name` and `Id`, and its `Tables`.
 * Which tables it holds by name depends on WHICH base: narrowing answers
 * with that base's real surface (`describeBase`) for one call.
 */
export function describeBaseMeta(): SchemaTypeDescriptor {
  return {
    typeId: BASE_META_TYPE,
    displayName: BASE_META_TYPE,
    description:
      "One of this workspace's bases. Narrow to one (`-[b:Bases WHERE b.Name == \"CRM\"]->`, " +
      'or the `base:` construction arg) and its tables become the edges you write rows along.',
    fields: [
      // The labels a narrowing predicate reads — published on every member
      // the root hop mints.
      metaField('Name', "The base's name."),
      metaField('Id', "Airtable's id for the base (app…)."),
    ],
    references: [tablesReference()],
  };
}

/**
 * The `Table` node: a table of a base, by its `Name` and `Id`, and its
 * `Changes`. Narrowed by a WHERE, it is that table, its rows' fields included.
 */
export function describeTableMeta(at: { positioned: boolean }): SchemaTypeDescriptor {
  return {
    typeId: TABLE_META_TYPE,
    displayName: TABLE_META_TYPE,
    description: "A table in one of this workspace's bases. Listen on its `Changes` for what happens to its rows.",
    fields: [metaField('Name', "The table's name."), metaField('Id', "Airtable's id for the table (tbl…).")],
    references: [changesReference(at)],
  };
}

/**
 * A table's `Changes`, each change once, pushed to ONE data webhook per base
 * whatever number of its tables a listen watches: Airtable lets an OAuth
 * integration make 2 webhooks per base, and the schema webhook (`Tables`) is
 * the other. Off a base walked to, it is subscribed per base the listen's
 * `Bases` hop landed on (`scopedBy`); at a connection positioned at a base,
 * once for the connection. Each change names its table, and a listen keeps
 * only its own tables' changes.
 */
export function changesReference(at: { positioned: boolean; target?: string }): SchemaReferenceDescriptor {
  return {
    fieldId: AIRTABLE_CHANGES_EDGE,
    name: AIRTABLE_CHANGES_EDGE,
    targetTypeId: at.target ?? AIRTABLE_CHANGE_TYPE,
    cardinality: 'many',
    direction: 'outgoing',
    // You are told of a change; you cannot list the ones that happened.
    readable: false,
    writable: false,
    listenable: true,
    ...(at.positioned ? { delivery: 'connection' as const } : { delivery: 'scope' as const, scopedBy: AIRTABLE_BASES_EDGE }),
    identity: 'Id',
    attributes: true,
    description: "What happens to the table's rows: one change per row an edit touched (created, updated or deleted), with the row before and after it (`Previous`, `Current`).",
  };
}

/** A change to a table's row, one per row an edit touched: what happened
 *  (`Kind`), the row before and after the edit (`Previous`, `Current`: values,
 *  read through with `.`), and the row as it is now (`Record`, an edge: a
 *  read). Every table's changes hold a `Row`; one table's (`tableChange`)
 *  hold that table's rows. */
export function describeChange(): SchemaTypeDescriptor {
  return changeDescriptor({ typeId: AIRTABLE_CHANGE_TYPE, row: AIRTABLE_ROW_TYPE });
}

/** The changes of one table: `Previous` and `Current` are its rows, typed by
 *  its fields, and `Record` is one of them. */
export function describeTableChange(tableName: string): SchemaTypeDescriptor {
  return changeDescriptor({ typeId: tableChangeType(tableName), row: tableName });
}

function changeDescriptor(input: { typeId: string; row: string }): SchemaTypeDescriptor {
  const held = (fieldId: string, description: string): SchemaFieldDescriptor => ({
    fieldId,
    displayName: fieldId,
    kind: 'record',
    record: { typeId: input.row },
    mayBeAbsent: true,
    writable: false,
    required: false,
    description,
  });
  return {
    typeId: input.typeId,
    displayName: input.typeId,
    description:
      'A change to a row of an Airtable table, one per row an edit touched: what happened (`Kind`), the row as the edit left it (`Current`) and as it was before (`Previous`). Compare them in a listen, each tested present before a field is read through it (`exists(c.Current) AND c.Current.Stage == "Interview" AND (NOT exists(c.Previous) OR c.Previous.Stage != "Interview")`); walk `Record` for the row as it is now.',
    fields: [
      { ...metaField('Id', 'Names the change: the same each time Airtable reports it.'), required: true },
      { fieldId: 'Kind', displayName: 'Kind', kind: 'enum', enumValues: [...AIRTABLE_CHANGE_KINDS], writable: false, required: true, description: 'What happened to the row.' },
      held('Current', 'The row as the edit left it, every field by name. Absent when the row was deleted.'),
      held('Previous', 'The row as it was before the edit, every field by name. Absent when the row was created, and when it was deleted (Airtable sends no cells then).'),
    ],
    references: [
      {
        fieldId: AIRTABLE_CHANGE_RECORD_EDGE,
        name: AIRTABLE_CHANGE_RECORD_EDGE,
        targetTypeId: input.row,
        cardinality: 'one',
        direction: 'outgoing',
        readable: true,
        writable: false,
        description: 'The row as it is now, read from Airtable: none once it is deleted.',
      },
    ],
  };
}

/** The row a change is about, whichever table it is in: its `Id`. Its cells
 *  are read by name at run time. */
export function describeRow(): SchemaTypeDescriptor {
  return {
    typeId: AIRTABLE_ROW_TYPE,
    displayName: AIRTABLE_ROW_TYPE,
    description: 'A row of the table a change happened in.',
    fields: [metaField(RECORD_ID_FIELD, "Airtable's id for the row (rec…).")],
    references: [],
  };
}

/** Resolve a base's NAME to its id (first case-insensitive match), or undefined
 *  when no accessible base carries that name. Feeds the `base:` entry position;
 *  an unresolved name falls the instance back to the full-workspace walk (the
 *  author-time checker warns on the unknown name separately). */
export async function resolveBaseId(input: {
  client: AirtableAPIClient;
  teamId: string;
  baseName: string;
}): Promise<string | undefined> {
  const baseNames = await cachedBases({ client: input.client, teamId: input.teamId });
  const norm = (v: string) => v.trim().toLowerCase();
  for (const [id, name] of baseNames) {
    if (norm(name) === norm(input.baseName)) return id;
  }
  return undefined;
}

// ── entry points ───────────────────────────────────────────────────────────
// The unpositioned root's entries are STATIC facts (the event edge + the
// polymorphic `Base` edge — see index.ts); only a POSITIONED instance
// enumerates anything here.

/** One base's tables as writable roots, by their own bare names — unique within
 *  the base, which is the only namespace they live in. Mirrors Sheets'
 *  `entryPointsForSpreadsheet`. */
function baseEntryPoints(input: {
  tables: AirtableTableMeta[];
}): SchemaEntryPoint[] {
  return input.tables.map((table) => {
    const displayName = table.name;
    return {
      // The framework identity IS the table's own name — the structured
      // `{ baseId, tableId }` lives only in the private cache. `externalId`
      // keeps the raw tableId for callers that key on the external table.
      typeId: displayName,
      displayName,
      externalId: table.id,
      writable: true,
      readable: true,
      labelTemplate: `{${table.primaryFieldId}}`,
    };
  });
}

/**
 * EVERY table in the workspace, as types. Costs 1 + N calls (a `listTables`
 * per base) — which is why it is no longer what the meta node publishes.
 *
 * It survives for the NAME RESOLVER, which answers a different question than
 * the root does: given a table name the engine hands it at runtime, what are
 * that table's field ids? Bases have no fields, so a resolver built from the
 * published entries would leave every table unmapped and writes would send
 * display names where Airtable expects field ids.
 */
export async function allTableEntryPoints(input: {
  client: AirtableAPIClient;
  teamId: string;
}): Promise<SchemaEntryPoint[]> {
  const baseNames = await cachedBases({ client: input.client, teamId: input.teamId });
  const entries: SchemaEntryPoint[] = [];
  for (const [baseId, baseName] of baseNames) {
    const tables = await cachedTables({ client: input.client, teamId: input.teamId, baseId });
    entries.push(...baseEntryPoints({ tables }));
  }
  return entries;
}

/** The writable entry points for an instance POSITIONED at one base (`base:`
 *  construction arg) — only that base's tables, so enumeration is a SINGLE base
 *  walk instead of every base in the workspace. This is the escape hatch from a
 *  large-workspace `listEntryPoints` that would otherwise walk (and can time
 *  out on) hundreds of bases. */
export async function entryPointsForBase(input: {
  client: AirtableAPIClient;
  teamId: string;
  baseId: string;
}): Promise<SchemaEntryPoint[]> {
  const baseNames = await cachedBases({ client: input.client, teamId: input.teamId });
  const baseName = baseNames.get(input.baseId) ?? input.baseId;
  const tables = await cachedTables({
    client: input.client,
    teamId: input.teamId,
    baseId: input.baseId,
  });
  refuseReservedTableNames(baseName, tables);
  return baseEntryPoints({ tables });
}

// ── describe ───────────────────────────────────────────────────────────────

/**
 * A BASE's node: no fields of its own, one edge per table in it. ONE
 * `listTables` — the hop the whole drill-down exists to make cheap.
 *
 * The edge's `fieldId` is the raw tableId, which is what a caller keys
 * `targetPositions` by to get the path on to the table.
 *
 * Every table edge promises WRITE, and that does not depend on the standpoint.
 * Creating a row is THE Airtable operation: `createRecord` (and `updateRecord`)
 * take the table's own name, resolve it through the workspace catalog and call
 * `recordCreateRecord` — a table reached by walking to its base is exactly as
 * writable as one published by a `base:`-positioned root. The edge is also the
 * ONLY place the write can be authored when the instance is unpositioned: the
 * root then publishes only `Base`, which is read-only, so a table has no
 * writable root of its own. The projection serves precisely this case — a
 * `writable: true` edge registers its target in `createShapes` even with no
 * top-level root (message-write-unification §5.1).
 *
 * `writable` is EXPLICIT since layer 13: absent means read-only, which made
 * every walked-to table's create fail at the checker.
 *
 */
export async function describeBase(input: {
  client: AirtableAPIClient;
  teamId: string;
  baseId: string;
  /** The connection is positioned at this base: its hop is the root's. */
  positioned?: boolean;
}): Promise<SchemaTypeDescriptor | null> {
  const baseNames = await cachedBases({ client: input.client, teamId: input.teamId });
  const baseName = baseNames.get(input.baseId);
  if (baseName === undefined) return null;
  const tables = await cachedTables({
    client: input.client,
    teamId: input.teamId,
    baseId: input.baseId,
  });
  refuseReservedTableNames(baseName, tables);
  return {
    typeId: baseName,
    displayName: baseName,
    fields: [],
    references: [
      ...tables.map((table) => ({
        fieldId: table.id,
        name: table.name,
        targetTypeId: table.name,
        cardinality: 'many' as const,
        writable: true,
      })),
      // The base's tables as records a listen narrows (`-[t:Tables WHERE …]->`).
      // At a positioned root they are the connection's own (`tablesEntryPoint`).
      tablesReference(input.positioned === true ? 'connection' : 'scope'),
    ],
  };
}

/** A TABLE's node: its fields, and an edge per link field. Both `describe` (by
 *  name) and the walk (by path) land here, so the two can never state
 *  different facts about the same table. */
async function tableDescriptor(input: {
  client: AirtableAPIClient;
  teamId: string;
  baseId: string;
  tableId: string;
}): Promise<SchemaTypeDescriptor | null> {
  const tables = await cachedTables({
    client: input.client,
    teamId: input.teamId,
    baseId: input.baseId,
  });
  const table = tables.find((t) => t.id === input.tableId);
  if (!table) return null;

  const baseNames = await cachedBases({ client: input.client, teamId: input.teamId });
  const baseName = baseNames.get(input.baseId) ?? input.baseId;

  const fields = table.fields.map(fieldDescriptor);
  if (!table.fields.some((f) => f.name === RECORD_ID_FIELD)) {
    fields.push({
      fieldId: RECORD_ID_FIELD,
      displayName: RECORD_ID_FIELD,
      kind: 'string',
      cardinality: 'one',
      writable: false,
      required: false,
      description: "Airtable's id for the row (rec…).",
    });
  }
  const references = table.fields
    .map((field) => referenceDescriptor({ field, baseName, tables }))
    .filter((r): r is SchemaReferenceDescriptor => r !== null);

  const displayName = table.name;
  return {
    // typeId == displayName: the framework's identity for this type is its name.
    typeId: displayName,
    displayName,
    labelTemplate: `{${table.primaryFieldId}}`,
    fields,
    references,
    // A table's rows are removed by `deleteRecord`.
    deletable: true,
    // P2: native uniqueness is never invented for Airtable — identity is
    // the TG layer's concern via author-defined constraints.
    uniquenessConstraints: undefined,
  };
}

/**
 * Describe a type BY NAME — the slow route, and now the last resort rather
 * than the first move. A walk (`edgesFrom`) arrives holding the routing ids,
 * so it never comes through here; this is what answers when a caller has only
 * a name and no path to it.
 *
 * Bases resolve first, off the cheap cached `listBases`. Only a table name
 * pays `loadTableCatalog`'s full workspace walk — the cost this ordering
 * exists to avoid for every base describe.
 */
export async function describe(input: {
  client: AirtableAPIClient;
  teamId: string;
  /** A base's name, or a table's own name within this instance's base. */
  typeId: string;
}): Promise<SchemaTypeDescriptor | null> {
  const baseId = await resolveBaseId({
    client: input.client,
    teamId: input.teamId,
    baseName: input.typeId,
  });
  if (baseId) return describeBase({ client: input.client, teamId: input.teamId, baseId });

  // Recover the routing ids from the name through the private cache — the same
  // first-line lookup every read/write does. An unknown name (drift) → null.
  const catalog = await loadTableCatalog({ client: input.client, teamId: input.teamId });
  const ids = catalog.idsByName.get(input.typeId);
  if (!ids) return null;
  return tableDescriptor({
    client: input.client,
    teamId: input.teamId,
    baseId: ids.baseId,
    tableId: ids.tableId,
  });
}

/** A table's node, reached BY PATH (`edgesFrom`). The position carries
 *  `{baseId, tableId}` because a table is only reachable through its base —
 *  so this costs one `listTables` (usually cached by the base's own hop) and
 *  never the workspace walk that resolving the name would. */
export async function describeTableAt(input: {
  client: AirtableAPIClient;
  teamId: string;
  baseId: string;
  tableId: string;
  /** The connection is positioned at the table's base. */
  positioned: boolean;
}): Promise<SchemaTypeDescriptor | null> {
  const descriptor = await tableDescriptor(input);
  if (descriptor === null) return null;
  // Reached as one of a base's `Tables`, it is still a `Table`: a listen
  // narrowed to it goes on to its `Changes`.
  refuseReservedReferenceNames(descriptor.displayName, descriptor.references);
  return {
    ...descriptor,
    references: [...descriptor.references, changesReference({ positioned: input.positioned, target: tableChangeType(descriptor.displayName) })],
  };
}

/** A table's changes, reached BY PATH from the table (`edgesFrom`): its rows
 *  before and after, by the table's own fields. */
export async function describeTableChangeAt(input: { client: AirtableAPIClient; teamId: string; baseId: string; tableId: string }): Promise<SchemaTypeDescriptor | null> {
  const tables = await cachedTables({ client: input.client, teamId: input.teamId, baseId: input.baseId });
  const table = tables.find((t) => t.id === input.tableId);
  return table === undefined ? null : describeTableChange(table.name);
}

/** Drop a base's cached tables — used after lf-platform's dev-loop seeds new tables,
 *  or on a stale-schema miss. Exposed for completeness; not on the hot path. */
export function invalidateTableCache(teamId: string, baseId: string): void {
  tableCatalogCache.delete(tableCacheKey(teamId, baseId));
}

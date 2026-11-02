// What Airtable's webhooks tell a listen, as arrivals (adapter protocol 2.6).
//
// Airtable notifies, and the module pulls: a ping names only the base and the
// webhook, and the changes are read from that webhook's payload feed from
// the cursor the host keeps for it. Two kinds of webhook feed listens:
//
// - one per base, for its tables' `Changes` (`tableData`, every table): one
//   change per row an edit touched (created, updated or deleted), carrying the
//   row before and after (`Previous`, `Current`), keyed by its table;
// - one per base, for its `Tables` (Airtable's `tableMetadata` data type): a
//   table created, renamed or removed. A listen whose tables are narrowed by a
//   WHERE is listed again on each, so a table renamed into its filter is
//   watched from then on.
//
// The rest is pure: the ping's shape, and a payload as the arrivals it makes.

import { z } from 'zod';

import type { Arrival, AwaitLanding } from 'engine-contracts';
import type { AirtableWebhookPayload } from './api_client';
import { BASE_META_TYPE, TABLE_META_TYPE } from './types';

/** The Airtable ping POSTed to the callback URL. It carries only ids — the
 *  actual changes are pulled from the webhook's payload feed. */
export const airtablePingSchema = z.object({
  base: z.object({ id: z.string() }),
  webhook: z.object({ id: z.string() }),
  timestamp: z.string().optional(),
});

/** The edge a base's tables hang off it by. */
export const AIRTABLE_TABLES_EDGE = 'Tables';
/** The edge a table's changes arrive on. */
export const AIRTABLE_CHANGES_EDGE = 'Changes';
/** What a table's changes land on. */
export const AIRTABLE_CHANGE_TYPE = 'Change';
/** A change's edge to the row it changed. */
export const AIRTABLE_CHANGE_RECORD_EDGE = 'Record';
/** The row a change's `Record` edge lands on, whichever table it is in. */
export const AIRTABLE_ROW_TYPE = 'Row';

export const AIRTABLE_CHANGE_KINDS = ['created', 'updated', 'deleted'] as const;
export type AirtableChangeKind = (typeof AIRTABLE_CHANGE_KINDS)[number];

/** An arrival on a table's `Changes` or a base's `Tables`: never a record
 *  gone (a deleted row's change is one). */
export type AirtableArrival = Exclude<Arrival, { gone: true }>;

/** A change's position data: what a listen's WHERE reads (`Kind`, the row
 *  before and after as `Previous` and `Current`, each by field name, the
 *  fields it touched, and the ids of its base, table and row), and the row it
 *  is about, by the ids the `Record` edge reads it again by. */
export interface ChangeData {
  Id: string;
  Kind: AirtableChangeKind;
  Current?: Record<string, unknown>;
  Previous?: Record<string, unknown>;
  [AIRTABLE_CHANGED_FIELDS]: string[];
  [AIRTABLE_BASE_ID]: string;
  [AIRTABLE_TABLE_ID]: string;
  [AIRTABLE_RECORD_ID]: string;
  row: ChangedRow;
}

/** The names of the fields a change touched: every field a created row was
 *  given, none for a deleted one. */
export const AIRTABLE_CHANGED_FIELDS = 'Changed Fields';
/** The ids a change names its base, table and row by: the row's survives its
 *  deletion, which `Record` (a read) does not. */
export const AIRTABLE_BASE_ID = 'Base Id';
export const AIRTABLE_TABLE_ID = 'Table Id';
export const AIRTABLE_RECORD_ID = 'Record Id';

export interface ChangedRow {
  /** The row's Airtable id (`rec…`). */
  id: string;
  /** Its base and table: the route a read of it takes. */
  baseId: string;
  tableId: string;
  /** Its table's name: the record type the row is read as. */
  table: string;
}

const changeDataSchema = z.object({
  Id: z.string(),
  Kind: z.enum(AIRTABLE_CHANGE_KINDS),
  Current: z.record(z.string(), z.unknown()).optional(),
  Previous: z.record(z.string(), z.unknown()).optional(),
  row: z.object({ id: z.string(), baseId: z.string(), tableId: z.string(), table: z.string() }),
});

/** A change's data back off its position, as far as reading its row again
 *  takes, or null when it is not one. */
export function changeDataOf(data: unknown): z.infer<typeof changeDataSchema> | null {
  const parsed = changeDataSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}

/** Per-table `fieldId → { name, type }` maps, so cell values (which Airtable
 *  keys by field id) become name-keyed data a movement reads by field name,
 *  each in the shape its field type reads as. */
export type FieldsByTable = Map<string, Map<string, { name: string; type?: string }>>;

/**
 * A cell as a movement reads it: the value its field declares (text, a
 * number, a list of them), never the object Airtable sends. The host
 * compares two cells by value only when they are values — two decoded copies
 * of one object are never equal — so `c.Current.Owner != c.Previous.Owner`
 * holds only when Owner changed. A webhook payload carries cells in
 * Airtable's cell format V2 (https://airtable.com/developers/web/api/field-model):
 * a select as `{ id, name, color }` (read by its name, what its enum holds),
 * a collaborator as `{ id, email, name }` (by its email, unique per user),
 * a barcode as `{ text, type }`, an AI text as `{ state, value, … }`, a
 * button as `{ label, url }`, a linked record as `{ id, name }` (by its id),
 * and a lookup as `{ valuesByLinkedRecordId, linkedRecordIds }` (its values
 * in link order). A formula or a rollup holds whatever it computes, each
 * object in it read as any other. Attachments stay as Airtable sends them:
 * a file is the value they are written as, and it is not compared by value.
 */
function readCell(value: unknown, type: string | undefined): unknown {
  if (value === null || value === undefined) return value;
  switch (type) {
    case 'multipleAttachments':
      return value;
    case 'multipleRecordLinks':
      return Array.isArray(value) ? value.map((link) => member(link, 'id')) : value;
    case 'multipleLookupValues':
    case 'lookup':
      return lookupValues(value);
    default:
      return Array.isArray(value) ? value.map(scalarOf) : scalarOf(value);
  }
}

/** `object[key]` when it is text, else the object read as any other. */
function member(cell: unknown, key: string): unknown {
  if (typeof cell === 'object' && cell !== null) {
    const held = Reflect.get(cell, key);
    if (typeof held === 'string') return held;
  }
  return scalarOf(cell);
}

/** A lookup's values, in the order of the records it looked them up on. */
function lookupValues(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scalarOf);
  if (typeof value !== 'object' || value === null) return value;
  const byRecord = Reflect.get(value, 'valuesByLinkedRecordId');
  if (typeof byRecord !== 'object' || byRecord === null) return scalarOf(value);
  const order = Reflect.get(value, 'linkedRecordIds');
  const ids = Array.isArray(order) ? order.filter((id): id is string => typeof id === 'string') : Object.keys(byRecord);
  return ids.flatMap((id) => {
    const values: unknown = Reflect.get(byRecord, id);
    return Array.isArray(values) ? values.map(scalarOf) : values === undefined ? [] : [scalarOf(values)];
  });
}

/** One cell value as text, a number or a boolean: an object by the member
 *  that names it, the first of `email` (a collaborator), `name` (a select),
 *  `text` (a barcode), `value` (an AI text, null until generated), `label`
 *  (a button) and `id`; an object with none of them (a formula's error) as
 *  its JSON, keys sorted, so equal objects read equal. */
function scalarOf(cell: unknown): unknown {
  if (typeof cell !== 'object' || cell === null) return cell;
  if (Array.isArray(cell)) return stableJson(cell.map(scalarOf));
  for (const key of ['email', 'name', 'text'] as const) {
    const named = Reflect.get(cell, key);
    if (typeof named === 'string') return named;
  }
  if ('value' in cell && 'state' in cell) {
    const generated = Reflect.get(cell, 'value');
    return typeof generated === 'string' ? generated : null;
  }
  for (const key of ['label', 'id'] as const) {
    const named = Reflect.get(cell, key);
    if (typeof named === 'string') return named;
  }
  return stableJson(cell);
}

/** JSON with every object's keys sorted, so equal values spell equal. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(Reflect.get(value, key))}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** What turning a payload into arrivals reads besides the payload. */
export interface PayloadContext {
  baseId: string;
  /** The base's name, from the meta API; absent when it could not be read. */
  baseName?: string;
  fieldsByTable: FieldsByTable;
  /** `tableId → name`, from the same metadata the field map came from. */
  tableNamesById: Map<string, string>;
  /** The connection is positioned at this base: its `Tables` is a root
   *  collection, whose arrivals name no record they are under. */
  positioned: boolean;
}

/**
 * One payload as its arrivals: each row an edit touched, once, on its table's
 * `Changes` (created, updated or deleted, with the row before and after), and
 * each table created, renamed or removed on its base's `Tables`. A change is
 * named by the base's transaction that made it and the row, so a payload
 * pulled again names the same changes and runs nothing.
 */
export function arrivalsFromPayload(payload: AirtableWebhookPayload, context: PayloadContext): AirtableArrival[] {
  const occurredAt = payload.timestamp;
  const transaction = transactionOf(payload);
  const arrivals: AirtableArrival[] = [];
  for (const [tableId, changes] of Object.entries(payload.changedTablesById ?? {})) {
    const tableFields = context.fieldsByTable.get(tableId);
    const table = context.tableNamesById.get(tableId) ?? tableId;
    const parents = carriedParents(context, tableId);
    const named = (cells: Record<string, unknown> | undefined): Record<string, unknown> => {
      const data: Record<string, unknown> = {};
      for (const [fieldId, value] of Object.entries(cells ?? {})) {
        const field = tableFields?.get(fieldId);
        data[field?.name ?? fieldId] = readCell(value, field?.type);
      }
      return data;
    };
    const change = (recordId: string, kind: AirtableChangeKind, rows: { Current?: Record<string, unknown>; Previous?: Record<string, unknown>; changed: string[] }): AirtableArrival => {
      const id = `${transaction}:${recordId}`;
      const { changed, ...held } = rows;
      const data: ChangeData = {
        Id: id,
        Kind: kind,
        ...held,
        [AIRTABLE_CHANGED_FIELDS]: changed,
        [AIRTABLE_BASE_ID]: context.baseId,
        [AIRTABLE_TABLE_ID]: tableId,
        [AIRTABLE_RECORD_ID]: recordId,
        row: { id: recordId, baseId: context.baseId, tableId, table },
      };
      return {
        edge: AIRTABLE_CHANGES_EDGE,
        key: tableId,
        identity: id,
        landing: { recordId: id, recordType: AIRTABLE_CHANGE_TYPE, fields: { ...data } },
        parents,
        about: { recordType: table, externalId: recordId },
        ...(occurredAt !== undefined ? { occurredAt } : {}),
      };
    };
    for (const [recordId, created] of Object.entries(changes.createdRecordsById ?? {})) {
      const current = named(created.cellValuesByFieldId);
      arrivals.push(change(recordId, 'created', { Current: current, changed: Object.keys(current) }));
    }
    for (const [recordId, updated] of Object.entries(changes.changedRecordsById ?? {})) {
      // `current` holds the changed cells as the edit left them, `previous`
      // as they were, `unchanged` every other cell. A cell emptied by the
      // edit may be left out of `current` (Airtable types a cell as "Cell
      // value V2 or null", and says no more of an empty one): the row as the
      // edit left it then does not hold it.
      const unchanged = named(updated.unchanged?.cellValuesByFieldId);
      const current = named(updated.current?.cellValuesByFieldId);
      const previous = named(updated.previous?.cellValuesByFieldId);
      // An emptied cell may be in `previous` alone: it changed too.
      const changed = [...new Set([...Object.keys(current), ...Object.keys(previous)])].filter((name) => !(name in unchanged));
      arrivals.push(change(recordId, 'updated', { Current: { ...unchanged, ...current }, Previous: { ...unchanged, ...previous }, changed }));
    }
    for (const recordId of changes.destroyedRecordIds ?? []) {
      arrivals.push(change(recordId, 'deleted', { changed: [] }));
    }
    // A table renamed (or redescribed): its schema changed.
    if (changes.changedMetadata !== undefined) {
      arrivals.push(tableArrival(context, tableId, changes.changedMetadata.current?.name ?? context.tableNamesById.get(tableId), transaction, occurredAt));
    }
  }
  for (const [tableId, created] of Object.entries(payload.createdTablesById ?? {})) {
    arrivals.push(tableArrival(context, tableId, created.metadata?.name, transaction, occurredAt));
  }
  for (const tableId of payload.destroyedTableIds ?? []) {
    arrivals.push(tableArrival(context, tableId, undefined, transaction, occurredAt));
  }
  return arrivals;
}

/** The records a change carries, as a walked-to table's `Changes` declares
 *  (`carries`): its base and its table, by their ids and names, so a listen
 *  narrowed by either is judged from the arrival alone. The same whatever the
 *  connection's position: a host reads a delivery for its install, not for
 *  one connection, so the door cannot tell. A positioned table's `Changes`
 *  declares none, and a host reads none of them there. A name that could not
 *  be read is said unknown. */
function carriedParents(context: PayloadContext, tableId: string): AwaitLanding[] {
  return [metaRecord(BASE_META_TYPE, context.baseId, context.baseName), metaRecord(TABLE_META_TYPE, tableId, context.tableNamesById.get(tableId))];
}

function metaRecord(recordType: string, id: string, name: string | undefined): AwaitLanding {
  return name === undefined ? { recordId: id, recordType, fields: { Id: id }, unknown: ['Name'] } : { recordId: id, recordType, fields: { Id: id, Name: name } };
}

/** Whether a payload changed the base's tables (any arrival on `Tables`):
 *  what the module holds of them is then stale. */
export function changesTables(payload: AirtableWebhookPayload): boolean {
  return (
    Object.keys(payload.createdTablesById ?? {}).length > 0 ||
    (payload.destroyedTableIds ?? []).length > 0 ||
    Object.values(payload.changedTablesById ?? {}).some((changes) => changes.changedMetadata !== undefined)
  );
}

/** A table created, changed or removed, as the arrival on its base's
 *  `Tables`: named by the transaction and the table, so each change of it
 *  arrives once. */
function tableArrival(context: PayloadContext, tableId: string, name: string | undefined, transaction: string, occurredAt: string | undefined): AirtableArrival {
  return {
    edge: AIRTABLE_TABLES_EDGE,
    ...(context.positioned ? {} : { key: context.baseId }),
    identity: `${transaction}:${tableId}`,
    landing: { recordId: tableId, recordType: TABLE_META_TYPE, fields: { Id: tableId, ...(name !== undefined ? { Name: name } : {}) } },
    ...(occurredAt !== undefined ? { occurredAt } : {}),
  };
}

/** The base's transaction a payload records: unique within the base, and the
 *  same each time the payload is pulled. A payload without one is named by
 *  its time. */
function transactionOf(payload: AirtableWebhookPayload): string {
  return payload.baseTransactionNumber !== undefined ? String(payload.baseTransactionNumber) : (payload.timestamp ?? '');
}

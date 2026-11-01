// What Airtable's webhooks tell a listen, as arrivals (adapter protocol 2.6).
//
// Airtable notifies, and the module pulls: a ping names only the base and the
// webhook, and the changes are read from that webhook's payload feed from
// the cursor the host keeps for it. Two kinds of webhook feed listens:
//
// - one per base, for its tables' `Changes` (`tableData`, every table): each
//   record created, each field of a record updated (one change per field,
//   `Field` naming it), each record deleted, keyed by its table;
// - one per base, for its `Tables` (Airtable's `tableMetadata` data type): a
//   table created, renamed or removed. A listen whose tables are narrowed by a
//   WHERE is listed again on each, so a table renamed into its filter is
//   watched from then on.
//
// The rest is pure: the ping's shape, and a payload as the arrivals it makes.

import { z } from 'zod';

import type { Arrival } from 'engine-contracts';
import type { AirtableWebhookPayload } from './api_client';
import { TABLE_META_TYPE } from './types';

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

/** A change's position data: what a listen's WHERE reads (`Kind`, `Field`,
 *  `Old`, `New`), and the row it is about, as the change left it, which the
 *  `Record` edge mints without a read. */
export interface ChangeData {
  Id: string;
  Kind: AirtableChangeKind;
  Field?: string;
  Old?: string | null;
  New?: string | null;
  row: ChangedRow;
}

export interface ChangedRow {
  /** The row's Airtable id (`rec…`). */
  id: string;
  /** Its table's name: the record type its position is stamped with. */
  table: string;
  /** Its cells as the change left them, by field name: every field, as the
   *  webhook asks Airtable for them all. Empty for a deleted row. */
  cells: Record<string, unknown>;
}

const changeDataSchema = z.object({
  Id: z.string(),
  Kind: z.enum(AIRTABLE_CHANGE_KINDS),
  Field: z.string().optional(),
  Old: z.string().nullable().optional(),
  New: z.string().nullable().optional(),
  row: z.object({ id: z.string(), table: z.string(), cells: z.record(z.string(), z.unknown()) }),
});

/** A change's data back off its position, or null when it is not one. */
export function changeDataOf(data: unknown): ChangeData | null {
  const parsed = changeDataSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}

/** Per-table `fieldId → { name, type }` maps, so cell values (which Airtable
 *  keys by field id) become name-keyed data a movement reads by field name,
 *  each in the shape its field type reads as. */
export type FieldsByTable = Map<string, Map<string, { name: string; type?: string }>>;

/**
 * A cell as a movement reads it. A webhook payload carries select cells in
 * Airtable's cell format V2 — `{ id, name, color }` per choice — where a read
 * of the row returns the plain name. The name is the value: it is what the
 * field's enum holds and what a listen's `c.New == "Interview"` names.
 */
function readCell(value: unknown, type: string | undefined): unknown {
  const nameOf = (cell: unknown): unknown =>
    typeof cell === 'object' && cell !== null && typeof Reflect.get(cell, 'name') === 'string' ? Reflect.get(cell, 'name') : cell;
  if (type === 'singleSelect') return nameOf(value);
  if (type === 'multipleSelects' && Array.isArray(value)) return value.map(nameOf);
  return value;
}

/** A cell as `Old` and `New` hold it: as text (a select by its choice's
 *  name, a number as written, a list or a link as its JSON), null when empty. */
function asText(cell: unknown): string | null {
  if (cell === undefined || cell === null) return null;
  if (typeof cell === 'string') return cell;
  if (typeof cell === 'number' || typeof cell === 'boolean') return String(cell);
  return JSON.stringify(cell);
}

/** What turning a payload into arrivals reads besides the payload. */
export interface PayloadContext {
  baseId: string;
  fieldsByTable: FieldsByTable;
  /** `tableId → name`, from the same metadata the field map came from. */
  tableNamesById: Map<string, string>;
  /** The connection is positioned at this base: its `Tables` is a root
   *  collection, whose arrivals name no record they are under. */
  positioned: boolean;
}

/**
 * One payload as its arrivals: each record change on its table's `Changes`
 * (an update one per field it touched), and each table created, renamed or
 * removed on its base's `Tables`. A change is named by the base's transaction
 * that made it and what it touched, so a payload pulled again names the same
 * changes and runs nothing.
 */
export function arrivalsFromPayload(payload: AirtableWebhookPayload, context: PayloadContext): AirtableArrival[] {
  const occurredAt = payload.timestamp;
  const transaction = transactionOf(payload);
  const arrivals: AirtableArrival[] = [];
  for (const [tableId, changes] of Object.entries(payload.changedTablesById ?? {})) {
    const tableFields = context.fieldsByTable.get(tableId);
    const table = context.tableNamesById.get(tableId) ?? tableId;
    const named = (cells: Record<string, unknown> | undefined): Record<string, unknown> => {
      const data: Record<string, unknown> = {};
      for (const [fieldId, value] of Object.entries(cells ?? {})) {
        const field = tableFields?.get(fieldId);
        data[field?.name ?? fieldId] = readCell(value, field?.type);
      }
      return data;
    };
    const change = (recordId: string, id: string, kind: AirtableChangeKind, cells: Record<string, unknown>, field?: { name: string; old: string | null; now: string | null }): AirtableArrival => {
      const data: ChangeData = {
        Id: id,
        Kind: kind,
        ...(field !== undefined ? { Field: field.name, Old: field.old, New: field.now } : {}),
        row: { id: recordId, table, cells },
      };
      return {
        edge: AIRTABLE_CHANGES_EDGE,
        key: tableId,
        identity: id,
        landing: { recordId: id, recordType: AIRTABLE_CHANGE_TYPE, fields: { ...data } },
        about: { recordType: table, externalId: recordId },
        ...(occurredAt !== undefined ? { occurredAt } : {}),
      };
    };
    for (const [recordId, created] of Object.entries(changes.createdRecordsById ?? {})) {
      arrivals.push(change(recordId, `${transaction}:${recordId}:created`, 'created', named(created.cellValuesByFieldId)));
    }
    for (const [recordId, updated] of Object.entries(changes.changedRecordsById ?? {})) {
      // `current` holds the changed cells; `unchanged` every other one. A cell
      // emptied by the update may be left out of `current` (Airtable types a
      // cell as "Cell value V2 or null", and says no more of an empty one),
      // so a field `previous` holds that `unchanged` does not changed too,
      // to nothing: its `New` is null.
      const current = updated.current?.cellValuesByFieldId ?? {};
      const unchanged = updated.unchanged?.cellValuesByFieldId ?? {};
      const previous = named(updated.previous?.cellValuesByFieldId);
      const cells = { ...named(unchanged), ...named(current) };
      const emptied = Object.keys(updated.previous?.cellValuesByFieldId ?? {}).filter((fieldId) => !Object.hasOwn(current, fieldId) && !Object.hasOwn(unchanged, fieldId));
      for (const fieldId of [...Object.keys(current), ...emptied]) {
        const name = tableFields?.get(fieldId)?.name ?? fieldId;
        arrivals.push(change(recordId, `${transaction}:${recordId}:${fieldId}`, 'updated', cells, { name, old: asText(previous[name]), now: asText(cells[name]) }));
      }
    }
    for (const recordId of changes.destroyedRecordIds ?? []) {
      arrivals.push(change(recordId, `${transaction}:${recordId}:deleted`, 'deleted', {}));
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

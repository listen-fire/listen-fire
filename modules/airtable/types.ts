// Airtable TG adapter — shared types and the Airtable-field-type constant
// sets. A TG type is an Airtable *table*; the framework names it by its own
// name within its base (bases are the instance's entry position, so the
// namespace is one base — see 5_paths_as_addresses.md), and the adapter recovers the
// `{ baseId, tableId }` the Airtable API routes on from that name through its
// private name → structured-identifier cache (`schema_catalog.loadTableCatalog`).
// There is deliberately NO `encode/decodeTypeId` magic-string codec: an
// identifier is never flattened into a string and crammed onto a position.

import { z } from 'zod';

/** Stable adapter identifier. Matches `MutationContext.source.adapterType`. */
export const AIRTABLE_ADAPTER_TYPE = 'airtable';

/** Airtable field type whose value is a `string[]` of linked record ids —
 *  modeled as a TG `reference` (non-polymorphic) to the linked table. */
export const LINK_FIELD_TYPE = 'multipleRecordLinks';

/**
 * Airtable field types that require numeric values. Lifted verbatim from
 * the v3 output (`output_v3/adapters/airtable.ts`) — the behavioral
 * reference for coercion. `coerceAirtableValue` runs `Number()` over these.
 */
export const NUMERIC_FIELD_TYPES = new Set<string>([
  'number',
  'percent',
  'currency',
  'duration',
  'rating',
  'count',
  'autoNumber',
]);

/**
 * Read-only Airtable field types (P2). These are surfaced in `describe`
 * with `writable: false` and silently-but-visibly filtered from writes
 * (a `logger.debug`, not a buried warning). The set mirrors the model
 * table in `3_model.md`: computed / system-stamped / derived fields.
 */
export const READ_ONLY_FIELD_TYPES = new Set<string>([
  'formula',
  'lookup',
  'multipleLookupValues',
  'rollup',
  'autoNumber',
  'count',
  'button',
  'barcode',
  'createdBy',
  'createdTime',
  'lastModifiedBy',
  'lastModifiedTime',
  'externalSyncSource',
  'aiText',
]);

// ── Empty cells ─────────────────────────────────────────────────────────────
// Airtable leaves an empty cell out of a row: "Returned records do not include
// any fields with "empty" values, e.g. "", [], or false" (the list-records
// reference, read 2026-11-03). So what a row omits depends on its field's type.

/** Field types whose cell holds a list: left out when it holds none. */
export const LIST_FIELD_TYPES = new Set<string>([
  'multipleSelects',
  'multipleCollaborators',
  'multipleAttachments',
  'multipleLookupValues',
  'lookup',
  LINK_FIELD_TYPE,
]);

/** Field types Airtable fills in on every row, so never left out: a number
 *  it counts (`count` answers 0, which is no "empty" value), a number or a
 *  stamp it sets when the row is made, and a button. */
export const ALWAYS_PRESENT_FIELD_TYPES = new Set<string>(['autoNumber', 'count', 'createdTime', 'createdBy', 'button']);

/** What a cell of `type` left out of a row holds: an unchecked checkbox's
 *  `false`, a list type's `[]`, or nothing (`undefined`) where a left-out
 *  cell is a field with no value. */
export function emptyCell(type: string | undefined): false | [] | undefined {
  if (type === 'checkbox') return false;
  if (type !== undefined && LIST_FIELD_TYPES.has(type)) return [];
  return undefined;
}

/** A field of `type` may have no value on a row: Airtable leaves it out, and
 *  nothing stands in for it. */
export function mayBeEmpty(type: string | undefined): boolean {
  return emptyCell(type) === undefined && !(type !== undefined && ALWAYS_PRESENT_FIELD_TYPES.has(type));
}

/** A row's cells, keyed by field name, with each cell Airtable left out that
 *  has a value when empty (`false`, `[]`) put back, so a reader sees the type
 *  the catalog gives the field. */
export function withEmptyCells(cells: Record<string, unknown>, fields: Iterable<{ name: string; type?: string }>): Record<string, unknown> {
  const filled = { ...cells };
  for (const field of fields) {
    const empty = emptyCell(field.type);
    if (empty !== undefined && filled[field.name] === undefined) filled[field.name] = Array.isArray(empty) ? [] : empty;
  }
  return filled;
}

/** The Airtable API's structured routing identifier for a table — the value
 *  the name → structured-identifier cache yields for a table's displayName.
 *  This is the adapter's PRIVATE currency; it never appears on a position. */
export interface AirtableTableId {
  baseId: string;
  tableId: string;
}

// ── Credential parser ──────────────────────────────────────────────────────
// Mirrors `airtableCredsParser` from the apiClient; re-declared here so the
// adapter validates the decrypted payload at its own boundary (same shape).

export const airtableAdapterCredsParser = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  accessTokenExpiresAt: z.string(),
  refreshTokenExpiresAt: z.string(),
  baseUrl: z.string().url().optional(),
});

export type AirtableAdapterCreds = z.infer<typeof airtableAdapterCredsParser>;

// ── Airtable schema shapes (subset the adapter consumes) ───────────────────
// The apiClient's `listTables` returns richer rows; the adapter only reads
// these fields. Kept structural so the apiClient's parsed shape is assignable.

export interface AirtableFieldMeta {
  id: string;
  name: string;
  type?: string;
  options?: unknown;
  description?: string;
}

export interface AirtableTableMeta {
  id: string;
  name: string;
  primaryFieldId: string;
  fields: AirtableFieldMeta[];
  description?: string;
}

/** The meta types a walk lands on: a base, and a table within it. */
export const BASE_META_TYPE = 'Base';
export const TABLE_META_TYPE = 'Table';

/** The read-only field a row's Airtable id reads as (`rec…`), as other
 *  modules publish theirs. A table with a field of its own by this name keeps
 *  it, and the id is then reached as the row it is (or as `change.record`). */
export const RECORD_ID_FIELD = 'Id';

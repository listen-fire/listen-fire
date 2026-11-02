// A record's `Changes`: what Affinity's webhook says happened to an
// organization, a person, an opportunity or a list's entry (created, a field
// value set, changed or cleared, deleted), as an arrival on that record's `Changes`
// edge. Each record type's changes land on a record type of their own
// (`OrganizationChange`, `List Entry Change — Master Deals List`), so a listen
// on one list's entries is never fired by another list's or by a company's.
//
// One webhook serves every listen on `Changes` of a connection: Affinity caps
// an instance at three, and the host judges each arrival against each listen
// by the record type it landed on. Affinity's deliveries carry no id, so a
// change is named by what it says: its event type, the thing it is about, and
// a digest of that thing as sent. A redelivery names the same change and runs
// nothing; the next change of the same field is another one.

import { createHash } from 'node:crypto';

import { z } from 'zod';

import type { Arrival } from 'engine-contracts';
import type { SchemaEntryPoint, SchemaFieldDescriptor, SchemaReferenceDescriptor, SchemaTypeDescriptor } from 'movement-engine/public/catalog';

import { AFFINITY_ENTITY_TYPE, ENTITY_DISPLAY_NAMES, listNameFromPerListType, perListTypeName } from './types';

/** The edge every changed record hangs its changes off. */
export const AFFINITY_CHANGES_EDGE = 'Changes';
/** Its reference id: no Affinity field id takes it (those are numbers). */
export const AFFINITY_CHANGES_REFERENCE = 'affinity:changes';

export const AFFINITY_CHANGE_KINDS = ['created', 'updated', 'deleted'] as const;
export type AffinityChangeKind = (typeof AFFINITY_CHANGE_KINDS)[number];

/** How a field's value changed (`Field Change`), by Affinity's event: a value
 *  given to the field, one replaced, one removed. */
export const AFFINITY_FIELD_CHANGES = ['set', 'changed', 'cleared'] as const;
export type AffinityFieldChange = (typeof AFFINITY_FIELD_CHANGES)[number];

const FIELD_CHANGE_OF_KIND: Record<AffinityChangeKind, AffinityFieldChange> = { created: 'set', updated: 'changed', deleted: 'cleared' };

/** The fields a field value's change holds its value in: the record with only
 *  that field set, at its new value or at the value removed. */
export const AFFINITY_CURRENT = 'Current';
export const AFFINITY_PREVIOUS = 'Previous';
export const AFFINITY_FIELD_CHANGE = 'Field Change';

/** The entities whose own events Affinity's webhook sends. A list's entries
 *  change too, through `list_entry.*` and their field values. */
export const AFFINITY_CHANGED_ENTITIES = ['organization', 'person', 'opportunity'] as const;
export type AffinityChangedEntity = (typeof AFFINITY_CHANGED_ENTITIES)[number];

/** The webhook events a subscription for the arrivals on `Changes` takes.
 *  Affinity sends list entries' creation and deletion only; a value set on an
 *  entry arrives as a field value. */
export const AFFINITY_RECORD_EVENTS: readonly string[] = [
  ...AFFINITY_CHANGED_ENTITIES.flatMap((entity) => AFFINITY_CHANGE_KINDS.map((kind) => `${entity}.${kind}`)),
  'list_entry.created',
  'list_entry.deleted',
  ...AFFINITY_CHANGE_KINDS.map((kind) => `field_value.${kind}`),
];

/** An arrival on a record's `Changes`: a change, never a record gone (a
 *  deleted record's change is one). */
export type ChangeArrival = Exclude<Arrival, { gone: true }>;

const PER_LIST_CHANGE_PREFIX = 'List Entry Change — ';

/** The record type a record type's changes land on: `OrganizationChange`, and
 *  for a list's entries `List Entry Change — <list>`. */
export function changeTypeName(recordType: string): string {
  const list = perListName(recordType);
  return list === undefined ? `${recordType}Change` : `${PER_LIST_CHANGE_PREFIX}${list}`;
}

/** The record type whose changes `typeName` is, if it is a change type. */
export function recordTypeOfChange(typeName: string | null): string | undefined {
  if (typeName === null) return undefined;
  if (typeName.startsWith(PER_LIST_CHANGE_PREFIX)) return perListTypeName(typeName.slice(PER_LIST_CHANGE_PREFIX.length));
  const entity = AFFINITY_CHANGED_ENTITIES.find((e) => typeName === `${ENTITY_DISPLAY_NAMES[e]}Change`);
  return entity === undefined ? undefined : ENTITY_DISPLAY_NAMES[entity];
}

/** The edge from a change to the record it changed: the record type's own
 *  name, and `List Entry` for a list's entry. */
export function recordEdgeOf(recordType: string): string {
  return perListName(recordType) === undefined ? recordType : ENTITY_DISPLAY_NAMES['list-entry'];
}

/** The key a record's `Changes` are waited on and arrive under: its id,
 *  qualified by the kind of record it is. Organizations, persons,
 *  opportunities and list entries each number their ids apart, so a bare id
 *  would answer a wait on organization 13 with person 13's change. Only ever
 *  compared, never read back. */
export function changesKey(record: ChangedRecord): string {
  return `${record.entity}:${record.id}`;
}

/** The changed record a wait's head names, by the record type its host says
 *  it is (`List Entry — <list>` for a list's entry), or why it names none. */
export function changedRecordOfHead(head: { recordId: string; recordType?: string }): ChangedRecord | { refused: string } {
  if (head.recordType === undefined) {
    return { refused: `a wait on record ${head.recordId}'s ${AFFINITY_CHANGES_EDGE} needs its record type, which this host does not say (adapter protocol 2.6 hosts do)` };
  }
  const entity =
    perListName(head.recordType) !== undefined || head.recordType === ENTITY_DISPLAY_NAMES['list-entry']
      ? 'list-entry'
      : AFFINITY_CHANGED_ENTITIES.find((e) => ENTITY_DISPLAY_NAMES[e] === head.recordType);
  if (entity === undefined) return { refused: `a ${head.recordType} has no ${AFFINITY_CHANGES_EDGE}` };
  return { entity, id: head.recordId };
}

function perListName(recordType: string): string | undefined {
  return recordType.startsWith(`${ENTITY_DISPLAY_NAMES['list-entry']} — `) ? listNameFromPerListType(recordType) : undefined;
}

/** A change type's entry: named so the resolver knows it, listed by nothing. */
export function changeEntryPoint(recordType: string): SchemaEntryPoint {
  return { typeId: changeTypeName(recordType), displayName: changeTypeName(recordType), writable: false, readable: false };
}

/** A record's `Changes`: pushed to the connection's webhook, each change once,
 *  carrying the record as it is after it. */
export function changesEdge(recordType: string): SchemaReferenceDescriptor {
  const noun = perListName(recordType) === undefined ? recordType.toLowerCase() : `entry on ${perListName(recordType)}`;
  return {
    fieldId: AFFINITY_CHANGES_REFERENCE,
    name: AFFINITY_CHANGES_EDGE,
    targetTypeId: changeTypeName(recordType),
    cardinality: 'many',
    direction: 'outgoing',
    readable: false,
    listenable: true,
    delivery: 'connection',
    identity: 'Id',
    attributes: true,
    carries: [recordType],
    description: `What happens to this ${noun} in Affinity, each change once: created, a field's value set, changed or cleared (\`Field\` names it, \`Current\` and \`Previous\` hold its value), deleted.`,
  };
}

/** The fields a change's `Field` can name: the record's own custom fields,
 *  scalar or record-valued, by the names it publishes them under (a custom
 *  field's id is its Affinity field id, a number). */
export function changeableFields(record: SchemaTypeDescriptor): Array<{ fieldId: string; name: string }> {
  return [...record.fields.map((f) => ({ fieldId: f.fieldId, name: f.displayName })), ...record.references.map((r) => ({ fieldId: r.fieldId, name: r.name ?? r.fieldId }))].filter((f) =>
    /^\d+$/.test(f.fieldId),
  );
}

/** A record type's change type. `Field` is an enum of the record's custom
 *  fields, so a listen naming one it lacks is refused at check. `Current` and
 *  `Previous` are the record's own type, so a comparison of the value is
 *  checked against its field (`c.Current.Status == "Won"`). */
export function describeChange(
  record: SchemaTypeDescriptor,
  /** `Field` as text whatever the record's fields: an opportunity list's,
   *  which 0.13.0 typed so (its columns were not on its record type then), so
   *  a name that is no column checks within 0.13 as it did. */
  options: { textField?: true } = {},
): SchemaTypeDescriptor {
  const recordType = record.displayName;
  const noun = perListName(recordType) === undefined ? recordType.toLowerCase() : `entry on ${perListName(recordType)}`;
  const titles = [...new Set(changeableFields(record).map((f) => f.name))];
  const field = (fieldId: string, kind: SchemaFieldDescriptor['kind'], more: Partial<SchemaFieldDescriptor> = {}): SchemaFieldDescriptor => ({
    fieldId,
    displayName: fieldId,
    kind,
    writable: false,
    required: false,
    cardinality: 'one',
    ...more,
  });
  const held = (fieldId: string, description: string): SchemaFieldDescriptor =>
    field(fieldId, 'record', { record: { typeId: recordType }, mayBeAbsent: true, description });
  const edge = recordEdgeOf(recordType);
  return {
    typeId: changeTypeName(recordType),
    displayName: changeTypeName(recordType),
    description: `A change to an Affinity ${noun}: what happened (\`Kind\`) and, when a field's value changed, which field (\`Field\`), how (\`Field Change\`) and its value (\`Current\`, or \`Previous\` when it was cleared), each holding only that field. Walk \`${edge}\` for the ${noun} as it is now.`,
    fields: [
      field('Id', 'string', { required: true, description: 'Names the change: the same on every redelivery of it.' }),
      field('Kind', 'enum', { required: true, enumValues: [...AFFINITY_CHANGE_KINDS], description: `What happened to the ${noun}: a field value set, changed or cleared is \`updated\`.` }),
      titles.length > 0 && options.textField !== true
        ? field('Field', 'enum', { enumValues: titles, description: 'When a field value changed, the field, by its name (`Status`).' })
        : field('Field', 'string', { description: 'When a field value changed, the field, by its name.' }),
      field(AFFINITY_FIELD_CHANGE, 'enum', {
        enumValues: [...AFFINITY_FIELD_CHANGES],
        description:
          'When a field value changed, how: `set` (a value given to the field), `changed` (its value replaced) or `cleared` (its value removed). For a field holding several values, each value added is `set` and each removed `cleared`.',
      }),
      held(
        AFFINITY_CURRENT,
        `When a field's value was set or changed, the ${noun} holding only that field, at its new value (\`exists(c.Current) AND c.Current.Status == "Won"\`); a field holding several values holds the one added. Absent otherwise.`,
      ),
      held(
        AFFINITY_PREVIOUS,
        `When a field's value was cleared, the ${noun} holding only that field, at the value removed. Absent otherwise. Affinity does not send the value a change replaced, so a filter reading it on a \`changed\` change cannot be judged.`,
      ),
      field('Record', 'string', { required: true, description: `The ${noun}'s Affinity id.` }),
    ],
    references: [
      {
        fieldId: edge,
        name: edge,
        targetTypeId: recordType,
        cardinality: 'one',
        direction: 'outgoing',
        requiresLiveRecord: true,
        description: `The ${noun} that changed, read from Affinity.`,
      },
    ],
  };
}

/** One of a change's fields, by name, from what its position holds. */
export function changeFieldOf(change: unknown, name: string): unknown {
  if (typeof change !== 'object' || change === null) return null;
  return Object.entries(change).find(([key]) => key === name)?.[1] ?? null;
}

const deliverySchema = z
  .object({
    type: z.string(),
    body: z.record(z.string(), z.unknown()),
    sent_at: z.number().optional(),
  })
  .passthrough();

/** What changed, as one delivery says it, before the workspace is asked
 *  anything: an entity by its kind, or a list's entry (its list known when
 *  the body names it). */
export type ChangedRecord =
  | { entity: AffinityChangedEntity; id: string }
  | { entity: 'list-entry'; id: string; listId?: number };

export interface AffinityChange {
  record: ChangedRecord;
  kind: AffinityChangeKind;
  /** The field whose value changed, how, and the value Affinity sent (the
   *  new one, or the one removed), for a field value's event. */
  fieldId?: number;
  fieldChange?: AffinityFieldChange;
  value?: unknown;
  identity: string;
  occurredAt?: string;
}

const ENTITY_OF_FIELD_VALUE: Record<number, AffinityChangedEntity> = {
  [AFFINITY_ENTITY_TYPE.PERSON]: 'person',
  [AFFINITY_ENTITY_TYPE.ORGANIZATION]: 'organization',
  [AFFINITY_ENTITY_TYPE.OPPORTUNITY]: 'opportunity',
};

function idOf(value: unknown): string | undefined {
  return typeof value === 'number' || (typeof value === 'string' && value !== '') ? String(value) : undefined;
}

function kindOf(eventType: string): AffinityChangeKind | undefined {
  return AFFINITY_CHANGE_KINDS.find((kind) => eventType.endsWith(`.${kind}`));
}

/**
 * The change one Affinity delivery (`{ type, body, sent_at }`, one event per
 * POST) is about, or null for one that is about nothing a listen hears
 * (notes, reminders, lists, fields, files) or is no delivery at all.
 *
 * A field value's event is an update of the record it sits on: its list entry
 * when it names one (a deal's stage), else the entity its `entity_type` names.
 */
export function changeOf(raw: unknown): AffinityChange | null {
  const parsed = deliverySchema.safeParse(raw);
  if (!parsed.success) return null;
  const { type, body, sent_at } = parsed.data;
  const kind = kindOf(type);
  if (kind === undefined) return null;
  const subject = type.slice(0, type.indexOf('.'));
  const record = changedRecord(subject, body);
  if (record === null) return null;
  const identity = `${type}:${idOf(body.id) ?? record.id}:${digest(body)}`;
  const stamped = [body.updated_at, kind === 'deleted' ? undefined : body.created_at].find(
    (stamp): stamp is string => typeof stamp === 'string' && !Number.isNaN(Date.parse(stamp)),
  );
  const occurredAt = stamped ?? (sent_at !== undefined ? new Date(sent_at * 1000).toISOString() : undefined);
  return {
    record,
    kind: subject === 'field_value' ? 'updated' : kind,
    ...(subject === 'field_value' && typeof body.field_id === 'number'
      ? { fieldId: body.field_id, fieldChange: FIELD_CHANGE_OF_KIND[kind], value: body.value ?? null }
      : {}),
    identity,
    ...(occurredAt !== undefined ? { occurredAt } : {}),
  };
}

/**
 * A field value's change's own fields, beside `Kind`: the field, how it
 * changed, and its value, under the name the record type publishes the field
 * by. A field the record type does not name (one this connection cannot see,
 * or one made since) is marked unknown, as is what it held, so a filter on
 * them is undecided, never false. Affinity sends the new value of a set or a
 * change and the value removed by a clear, never the value a change replaced:
 * `Previous` is unknown on a change.
 */
export function fieldValueChange(change: AffinityChange, field: { name: string; value: unknown } | undefined): { fields: Record<string, unknown>; unknown: string[] } {
  if (change.fieldChange === undefined) return { fields: {}, unknown: [] };
  const how = { [AFFINITY_FIELD_CHANGE]: change.fieldChange };
  if (field === undefined) return { fields: how, unknown: ['Field', AFFINITY_CURRENT, AFFINITY_PREVIOUS] };
  const held = { [field.name]: field.value };
  switch (change.fieldChange) {
    case 'set':
      return { fields: { Field: field.name, ...how, [AFFINITY_CURRENT]: held }, unknown: [] };
    case 'changed':
      return { fields: { Field: field.name, ...how, [AFFINITY_CURRENT]: held }, unknown: [AFFINITY_PREVIOUS] };
    case 'cleared':
      return { fields: { Field: field.name, ...how, [AFFINITY_PREVIOUS]: held }, unknown: [] };
    default:
      return change.fieldChange satisfies never;
  }
}

/**
 * A list entry's change whose list the workspace does not name (a list this
 * connection cannot see, or one made since its lists were read): it states no
 * record type, so no listen on `Changes` can tell whether it is its own. The
 * host says so for each (an `Arrival Not Judged`), where it once ran nothing
 * without a word, and `listens replay` puts it through again once the list is
 * known.
 */
export function unplacedChange(change: AffinityChange): ChangeArrival {
  // The field is named by the record type it is on: a filter on it, or on
  // what it held, is undecided, never false.
  const { fields, unknown } = fieldValueChange(change, undefined);
  return {
    edge: AFFINITY_CHANGES_EDGE,
    key: changesKey(change.record),
    identity: change.identity,
    landing: {
      recordId: change.identity,
      fields: { Id: change.identity, Kind: change.kind, Record: change.record.id, ...fields },
      ...(unknown.length > 0 ? { unknown } : {}),
    },
    parents: [null],
    ...(change.occurredAt !== undefined ? { occurredAt: change.occurredAt } : {}),
  };
}

function changedRecord(subject: string, body: Record<string, unknown>): ChangedRecord | null {
  const entity = AFFINITY_CHANGED_ENTITIES.find((e) => e === subject);
  if (entity !== undefined) {
    const id = idOf(body.id);
    return id === undefined ? null : { entity, id };
  }
  if (subject === 'list_entry') {
    const id = idOf(body.id);
    if (id === undefined) return null;
    return typeof body.list_id === 'number' ? { entity: 'list-entry', id, listId: body.list_id } : { entity: 'list-entry', id };
  }
  if (subject === 'field_value') {
    const entry = idOf(body.list_entry_id);
    if (entry !== undefined) return { entity: 'list-entry', id: entry };
    const owner = typeof body.entity_type === 'number' ? ENTITY_OF_FIELD_VALUE[body.entity_type] : undefined;
    const id = idOf(body.entity_id);
    return owner === undefined || id === undefined ? null : { entity: owner, id };
  }
  return null;
}

/** 16 hex digits of the sha256 of a value's JSON. */
function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

// A record's `Changes`: what Attio's webhook says happened to one of an
// object's records (created, an attribute updated, deleted), as an arrival on
// that record's `Changes` edge. Each object's changes land on a record type
// of their own (`DealChange`, `CompanyChange`), so a listen on a deal's
// changes is never fired by a company's.
//
// One webhook serves every listen on `Changes` of a connection: Attio's
// record events cover every object, and the host judges each arrival against
// each listen by the record type it landed on. Attio's events carry no id
// and no time, so a change is named by what it changed: the record, and for
// an update the attribute and its value now (which carries the time Attio
// stamped it with). A redelivery names the same change and runs nothing; the
// next change to the same attribute is another one.

import { createHash } from 'node:crypto';

import { z } from 'zod';

import type { ActorIdentity, Arrival, AwaitLanding } from 'engine-contracts';
import type { SchemaEntryPoint, SchemaFieldDescriptor, SchemaTypeDescriptor, SchemaReferenceDescriptor } from 'movement-engine/public/catalog';

import { extractAttioValue, type AttioAttribute } from './attributes';
import { ATTIO_ADAPTER_TYPE } from './types';

/** The edge every object's records hang their changes off. */
export const ATTIO_CHANGES_EDGE = 'Changes';
/** Its reference id: no attribute slug takes it (slugs are snake_case). */
export const ATTIO_CHANGES_REFERENCE = 'attio:changes';

export const ATTIO_CHANGE_KINDS = ['created', 'updated', 'deleted'] as const;
export type AttioChangeKind = (typeof ATTIO_CHANGE_KINDS)[number];

/** The webhook events a subscription for the arrivals on `Changes` takes. */
export const ATTIO_RECORD_EVENTS: readonly string[] = ATTIO_CHANGE_KINDS.map((kind) => `record.${kind}`);

/** An object, as the workspace's catalog names it. */
export interface ChangedObject {
  id: string;
  /** Its plural noun: the name of its record type (`Deals`). */
  name: string;
  /** Its singular noun (`Deal`): names its change type and the edge to it. */
  singular: string;
  slug: string | null;
}

/** An arrival on a record's `Changes`: a change, never a record gone (a
 *  deleted record's change is one). */
export type ChangeArrival = Exclude<Arrival, { gone: true }>;

/** The record type an object's changes land on: its singular noun as one
 *  word, and `Change` (`DealChange`). */
export function changeTypeName(object: ChangedObject): string {
  return `${object.singular.replace(/\s+/g, '')}Change`;
}

/** The object whose change type is `typeName`, if any. */
export function objectOfChangeType<T extends ChangedObject>(objects: readonly T[], typeName: string | null): T | undefined {
  return typeName === null ? undefined : objects.find((object) => changeTypeName(object) === typeName);
}

/** A change type's entry: named so the resolver knows it, listed by nothing. */
export function changeEntryPoint(object: ChangedObject): SchemaEntryPoint {
  return { typeId: changeTypeName(object), displayName: changeTypeName(object), writable: false, readable: false };
}

/** A record's `Changes`: pushed to the connection's webhook, each change
 *  once, carrying the record as it is after it. */
export function changesEdge(object: ChangedObject): SchemaReferenceDescriptor {
  return {
    fieldId: ATTIO_CHANGES_REFERENCE,
    name: ATTIO_CHANGES_EDGE,
    targetTypeId: changeTypeName(object),
    cardinality: 'many',
    direction: 'outgoing',
    readable: false,
    listenable: true,
    delivery: 'connection',
    identity: 'Id',
    attributes: true,
    carries: [object.name],
    description:
      `What happens to a ${object.singular.toLowerCase()} in Attio, each change once: created, an attribute updated (\`Field\` names it), deleted.`,
  };
}

/** An object's change type. `Field` is an enum of the object's attributes, so
 *  a listen naming one it lacks is refused at check. */
export function describeChange(object: ChangedObject, attributes: readonly AttioAttribute[]): SchemaTypeDescriptor {
  const noun = object.singular.toLowerCase();
  const titles = [...new Set(attributes.map((attribute) => attribute.name))];
  const field = (fieldId: string, kind: SchemaFieldDescriptor['kind'], more: Partial<SchemaFieldDescriptor> = {}): SchemaFieldDescriptor => ({
    fieldId,
    displayName: fieldId,
    kind,
    writable: false,
    required: false,
    cardinality: 'one',
    ...more,
  });
  return {
    typeId: changeTypeName(object),
    displayName: changeTypeName(object),
    description: `A change to a ${noun} in Attio: what happened (\`Kind\`) and, on an update, which attribute (\`Field\`). Walk \`${object.singular}\` for the ${noun} as it is now.`,
    fields: [
      field('Id', 'string', { required: true, description: 'Names the change: the same on every redelivery of it.' }),
      field('Kind', 'enum', { required: true, enumValues: [...ATTIO_CHANGE_KINDS], description: `What happened to the ${noun}.` }),
      titles.length > 0
        ? field('Field', 'enum', { enumValues: titles, description: `On an update, the attribute that changed, by its title (\`Stage\`).` })
        : field('Field', 'string', { description: 'On an update, the attribute that changed, by its title.' }),
      field('Record', 'string', { required: true, description: `The ${noun}'s record id.` }),
    ],
    references: [
      {
        fieldId: object.singular,
        name: object.singular,
        targetTypeId: object.name,
        cardinality: 'one',
        direction: 'outgoing',
        requiresLiveRecord: true,
        description: `The ${noun} that changed, read from Attio.`,
      },
    ],
  };
}

const attioActor = z.object({ id: z.string().nullable(), type: z.string() }).optional();

/** Where a change keeps who made it, as Attio's webhook names them
 *  (`{ type, id }`, `type` Attio's own: `workspace-member`, `api-token`,
 *  `system`): beside its named fields. The arrival's `actor` carries the id
 *  alone; the type stays here, for the one reader that gates on it (whether
 *  the actor is a workspace member whose email can be fetched). */
export const ATTIO_CHANGE_ACTOR = 'actor';

/** Who made a change, as the door names them on its arrival: the id of the
 *  actor Attio's webhook names, whatever its type. Pure parse — a bare id
 *  with no resolved email maps to no Listen-Fire user (`scheme: 'opaque'`);
 *  the candidate path resolves a workspace member's email separately. None
 *  when the webhook names no actor id. `proven`: the host admits only a
 *  delivery signed with the webhook's secret, so the id is Attio's own. */
function changeActorOf(actor: { id: string | null } | undefined): ActorIdentity | undefined {
  const id = actor?.id;
  if (id === undefined || id === null || id.length === 0) return undefined;
  return { identifier: id, scheme: 'opaque', adapterType: ATTIO_ADAPTER_TYPE, label: id, proven: true };
}

/** One of a change's fields, by name, from what its position holds. */
export function changeFieldOf(change: unknown, name: string): unknown {
  if (typeof change !== 'object' || change === null) return null;
  return Object.entries(change).find(([key]) => key === name)?.[1] ?? null;
}

/** A webhook delivery's body: a batch of events, each naming what it is about. */
export const attioWebhookBody = z.object({
  webhook_id: z.string(),
  events: z.array(
    z.object({
      event_type: z.string(),
      id: z
        .object({
          workspace_id: z.string(),
          object_id: z.string().optional(),
          record_id: z.string().optional(),
          attribute_id: z.string().optional(),
        })
        .passthrough(),
      actor: attioActor,
    }),
  ),
});

/** A record as Attio answers it: its values by attribute slug, each Attio's
 *  array of typed values (each stamped `active_from`). */
export interface ChangedRecord {
  values: Record<string, unknown>;
  createdAt?: string;
}

/** What turning a delivery into arrivals reads from Attio. */
export interface ChangeSources {
  /** The object an event's `object_id` names (its id, else its slug). */
  object(objectId: string): Promise<ChangedObject | undefined>;
  attributes(object: ChangedObject): Promise<readonly AttioAttribute[]>;
  /** The record now; null when it is gone. */
  record(object: ChangedObject, recordId: string): Promise<ChangedRecord | null>;
}

function kindOf(eventType: string): AttioChangeKind | undefined {
  return ATTIO_CHANGE_KINDS.find((kind) => eventType === `record.${kind}`);
}

/** Each record event of a delivery as the arrival on its record's `Changes`,
 *  in the delivery's order. Events about anything but a record run nothing. */
export async function changeArrivals(raw: unknown, sources: ChangeSources): Promise<ChangeArrival[]> {
  const body = attioWebhookBody.safeParse(raw);
  if (!body.success) return [];
  const records = new Map<string, Promise<ChangedRecord | null>>();
  const arrivals: ChangeArrival[] = [];
  for (const event of body.data.events) {
    const kind = kindOf(event.event_type);
    const { object_id: objectId, record_id: recordId, attribute_id: attributeId } = event.id;
    if (kind === undefined || objectId === undefined || recordId === undefined) continue;
    const object = await sources.object(objectId);
    if (object === undefined) throw new Error(`attio: a ${event.event_type} event names object ${objectId}, which the workspace does not list`);
    const attributes = await sources.attributes(object);
    const record = kind === 'deleted' ? null : await readOnce(records, object, recordId, sources);
    const attribute = attributeId === undefined ? undefined : attributes.find((a) => a.id === attributeId || a.apiSlug === attributeId);
    const values = attribute === undefined ? record?.values : record?.values[attribute.apiSlug ?? attribute.id];
    const identity = [object.id, recordId, kind, ...(kind === 'updated' ? [attributeId ?? '', digest(values ?? null)] : [])].join(':');
    const occurredAt = kind === 'updated' ? latestActiveFrom(values) : kind === 'created' ? record?.createdAt : undefined;
    const fields: Record<string, unknown> = {
      Id: identity,
      Kind: kind,
      Record: recordId,
      ...(attribute !== undefined ? { Field: attribute.name } : {}),
      ...(event.actor !== undefined ? { [ATTIO_CHANGE_ACTOR]: event.actor } : {}),
    };
    const actor = changeActorOf(event.actor);
    arrivals.push({
      edge: ATTIO_CHANGES_EDGE,
      key: recordId,
      identity,
      landing: { recordId: identity, recordType: changeTypeName(object), fields },
      parents: [record === null ? null : recordLanding(object, recordId, record, attributes)],
      about: { recordType: object.name, externalId: recordId },
      ...(actor !== undefined ? { actor } : {}),
      ...(occurredAt !== undefined ? { occurredAt } : {}),
    });
  }
  return arrivals;
}

/** A record read once per delivery, however many of its events it carries. */
function readOnce(records: Map<string, Promise<ChangedRecord | null>>, object: ChangedObject, recordId: string, sources: ChangeSources): Promise<ChangedRecord | null> {
  const key = `${object.id}:${recordId}`;
  const held = records.get(key);
  if (held !== undefined) return held;
  const read = sources.record(object, recordId);
  records.set(key, read);
  return read;
}

/** The record as a listen's WHERE on its hop reads it: each attribute's
 *  plain value under its title. */
function recordLanding(object: ChangedObject, recordId: string, record: ChangedRecord, attributes: readonly AttioAttribute[]): AwaitLanding {
  const fields: Record<string, unknown> = {};
  for (const attribute of attributes) {
    const raw = record.values[attribute.apiSlug ?? attribute.id];
    if (raw !== undefined) fields[attribute.name] = extractAttioValue(raw);
  }
  if (record.createdAt !== undefined) fields['Created At'] = record.createdAt;
  return { recordId, recordType: object.name, fields };
}

/** The latest `active_from` among an attribute's values: when Attio says the
 *  value now held took effect. */
function latestActiveFrom(values: unknown): string | undefined {
  if (!Array.isArray(values)) return undefined;
  const stamps = values
    .map((value: unknown) => (typeof value === 'object' && value !== null && 'active_from' in value ? value.active_from : undefined))
    .filter((stamp): stamp is string => typeof stamp === 'string' && !Number.isNaN(Date.parse(stamp)));
  return stamps.sort().at(-1);
}

/** 16 hex digits of the sha256 of a value's JSON. */
function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

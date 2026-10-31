// The event a run fired on: which source and trigger delivered it, its
// payload, and the record it anchors to. A resume is handed the run's
// original event.

import { z } from 'zod';

/** Who or what produced a change, as the producing system asserts it. */
export const actorTypeSchema = z.enum(['user', 'api-token', 'system']);

export type ActorType = z.infer<typeof actorTypeSchema>;

export const actorSchema = z.object({
  type: actorTypeSchema,
  id: z.string().nullable(),
});

export type Actor = z.infer<typeof actorSchema>;

/** What fired the change. */
export const triggerTypeSchema = z.enum([
  'snapshot',
  'poll',
  'changes-feed',
  'webhook',
  'mutation',
  'extraction',
]);

export type TriggerType = z.infer<typeof triggerTypeSchema>;

/** What fired a run: one of the trigger types a source names, or an arrival
 *  on a listen's last edge, which fired a listen on a traversal. */
export const firedTriggerTypeSchema = z.union([triggerTypeSchema, z.literal('arrival')]);

/** The record that landed on a listen's last edge, and the records it
 *  carries from earlier hops (adapter protocol 2.6). */
const firedLandingSchema = z.object({ recordId: z.string().optional(), recordType: z.string().optional(), fields: z.record(z.string(), z.unknown()) });

/** The source system's identifier for the record an inbound event is about. */
export const inboundRecordRefSchema = z.object({
  adapterType: z.string(),
  externalId: z.string(),
  recordType: z.string().optional(),
});

export type InboundRecordRef = z.infer<typeof inboundRecordRefSchema>;

export const triggerEventSchema = z.object({
  pipelineInputId: z.string(),
  adapterType: z.string(),
  objectType: z.string().optional(),
  triggerEntryId: z.string().optional(),
  triggerType: firedTriggerTypeSchema,
  payload: z.unknown().optional(),
  changeType: z.enum(['create', 'update', 'delete']).optional(),
  actor: actorSchema.optional(),
  snapshotRunId: z.string().optional(),
  snapshotComplete: z.boolean().optional(),
  /** The host's own id (a UUID) of the record this event anchors to — a
   *  node it materialised for the event. External identifiers ride
   *  `externalRecordRef`. */
  recordId: z.string().uuid().optional(),
  /** The source system's identifier for the record, for webhook and
   *  snapshot triggers. */
  externalRecordRef: inboundRecordRefSchema.optional(),
  /**
   * The concrete source type the inbound dispatch discriminated this event to
   * (an `EventType.positionType`, e.g. `attio:companies`), set by the dispatch
   * layer after matching the event against the adapter's `listEventTypes`. When
   * present (with `externalRecordRef.externalId`), the run seeds a typed stable
   * record position rather than the raw unstable payload.
   */
  rootRecordType: z.string().optional(),
  changedFields: z.array(z.string()).optional(),
  /**
   * The source's own per-DELIVERY id (Slack envelope `event_id`, …): a host
   * dedupes an at-least-once redelivery on it. Absent ⇒ not deduped.
   */
  idempotencyKey: z.string().optional(),
  occurredAt: z.string().datetime().optional(),
  /**
   * What fired a listen on a traversal (`triggerType: 'arrival'`): the record
   * that landed on its last edge, which the fired function's parameter binds
   * as a wait binds what lands on its edge, and the records it carries from
   * earlier hops (adapter protocol 2.6).
   */
  arrival: z.object({ adapterType: z.string(), edge: z.string(), landing: firedLandingSchema, parents: z.array(firedLandingSchema.nullable()).optional() }).optional(),
});

export type TriggerEvent = z.infer<typeof triggerEventSchema>;

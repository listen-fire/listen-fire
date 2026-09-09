// Trigger taxonomy and event shape (P6).

import { z } from 'zod';
import { actorSchema, triggerTypeSchema } from '../mutation_context';
import type { TriggerType } from '../mutation_context';
import type { NodeId } from '../../../generated/kysely/knowledge/Node';

export { triggerTypeSchema };
export type { TriggerType };

/**
 * External-side identifier for a webhook-originated event. Holds the
 * source-system record id plus the adapter and optional record-type
 * slug. Read by `engine/evaluate.ts` when constructing
 * `bridgeToExternal` / `loadLinkedObjectCandidates` / `ensureBridge`.
 *
 */
export const inboundRecordRefSchema = z.object({
  adapterType: z.string(),
  externalId: z.string(),
  recordType: z.string().optional(),
});
/**
 * Renamed from `ExternalRecordRef` (3b §3.1): that name is now the
 * target-role external-record currency in `adapter.ts`. This trigger-side
 * shape is the leaner inbound identifier carried on `TriggerEvent`.
 */
export type InboundRecordRef = z.infer<typeof inboundRecordRefSchema>;

export const triggerEventSchema = z.object({
  pipelineInputId: z.string(),
  adapterType: z.string(),
  objectType: z.string().optional(),
  triggerEntryId: z.string().optional(),
  triggerType: triggerTypeSchema,
  payload: z.unknown(),
  changeType: z.enum(['create', 'update', 'delete']).optional(),
  actor: actorSchema.optional(),
  snapshotRunId: z.string().optional(),
  snapshotComplete: z.boolean().optional(),
  /**
   * KG NodeId UUID this event anchors to. For webhook flows this is
   * the webhook-bridge-materialised source node id (see
   * `webhook_sync/materialise_message_node.ts`). Used to be plain
   * `string` and carried external identifiers — W3-B1 split those
   * into `externalRecordRef`.
   *
   */
  recordId: z.string().uuid().optional(),
  /**
   * External-side identifier for webhook + snapshot triggers. Read by
   * `engine/evaluate.ts` when constructing `bridgeToExternal` /
   * matching prior `linked_object` rows.
   */
  externalRecordRef: inboundRecordRefSchema.optional(),
  /**
   * The concrete source type the inbound dispatch discriminated this event to
   * (an `EventType.positionType`, e.g. `attio:companies`), set by the dispatch
   * layer after matching the event against the adapter's `listEventTypes`. When
   * present (with `externalRecordRef.externalId`), `seedRootSourcePosition`
   * seeds a typed stable record position rather than the raw unstable payload.
   *
   */
  rootRecordType: z.string().optional(),
  changedFields: z.array(z.string()).optional(),
  /**
   * The source's own per-DELIVERY id (Slack envelope `event_id`, …). Persisted
   * as `trigger_event.external_event_id`; the receipt's partial unique index
   * on (trigger_id, external_event_id) makes an at-least-once redelivery a
   * no-op insert instead of a duplicate run. Absent ⇒ not deduped.
   */
  idempotencyKey: z.string().optional(),
  occurredAt: z.string().datetime().optional(),
});

/**
 * `recordId` is narrowed from `string | undefined` to
 * `NodeId | undefined` here. Zod can't express column-branding
 * directly; we layer the brand on the inferred shape.
 *
 */
export type TriggerEvent = Omit<z.infer<typeof triggerEventSchema>, 'recordId'> & {
  recordId?: NodeId;
};

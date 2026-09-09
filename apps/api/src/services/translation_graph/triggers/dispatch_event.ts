// The shared inbound-dispatch tail. Both the webhook handler
// (`webhook_sync/handler.ts`) and the poll-source worker
// (`poll_source/worker.ts`) produce `DiscriminableEvent`s — one from an
// async `Adapter.preprocessInbound` intercept, the other from a
// `PollSource.getEvents` pull — and from here on the path is identical:
// discriminate the event into a concrete root type, build the `TriggerEvent`,
// store a durable receipt, and dispatch to the movement engine. This module is
// that common tail, so the two front doors stay the only difference between the
// webhook and poll inbound paths.
import { logger } from '../../logger';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { TriggerId } from '../../../generated/kysely/automations/Trigger';
import type { DiscriminableEvent, EventType } from '../adapter';
import type { TriggerType } from '../mutation_context';
import type { TriggerEvent } from './types';
import { discriminateEvent } from '../engine/inbound/discriminate';
import { dispatchTriggerByIdEvent } from './router';
import {
  storeTriggerEvent,
  markTriggerEventDispatched,
  markTriggerEventFailed,
} from './event_store';
import { platformTokenRegistry } from '../engine/platform_token_registry_db';
import { isTestHarnessTeam } from '../../../lib/recording';

/** One trigger's durable receipt for one inbound event — the handoff between
 *  the capture half (pre-ack) and the dispatch half (post-ack). */
export interface CapturedTriggerEvent {
  triggerId: TriggerId;
  teamId: TeamId;
  triggerEvent: TriggerEvent;
  /** Absent when the receipt store itself failed — dispatch still runs, just
   *  unreceipted (losing the event entirely would be worse than losing its
   *  audit row). */
  storedEventId?: string;
  /** A redelivery whose receipt already exists — dispatch MUST be skipped. */
  duplicate: boolean;
}

export interface DiscriminableEventInput {
  triggerId: TriggerId;
  movementId: string | null;
  event: DiscriminableEvent;
  /** Resolved adapter slug. */
  adapterType: string;
  triggerType: TriggerType;
  /** The adapter's `listEventTypes()` union, fetched once by the caller. */
  eventTypes: readonly EventType[];
  teamId: TeamId;
  now?: Date;
  /**
   * Re-throw a dispatch failure after recording it, so the test-harness inject
   * response can surface the engine error synchronously. The webhook handler
   * sets this for test-harness teams; the poll worker leaves it false (its
   * per-row try/catch already isolates failures and it has no live caller to
   * surface to).
   */
  surfaceErrors?: boolean;
}

/**
 * Dispatch ONE normalized inbound event to ONE movement-derived trigger.
 *
 * Movement-derived triggers (`movementId` set) are the only inbound execution
 * surface — a trigger with no movement is dropped here. The caller owns
 * fan-out: the webhook handler loops (event × candidate trigger); the poll
 * worker loops (event) over the single polled trigger.
 *
 * Capture-then-dispatch back to back. A front door that acks its sender before
 * running the movement (the webhook_sync door) calls the two halves separately
 * instead — `captureDiscriminableEvent` pre-ack, `dispatchCapturedTriggerEvent`
 * after — so the receipt is durable before the 200 and nothing but the receipt
 * write sits inside the request.
 */
export async function dispatchDiscriminableEvent(
  input: DiscriminableEventInput,
): Promise<void> {
  const captured = await captureDiscriminableEvent(input);
  if (captured === null) return;
  await dispatchCapturedTriggerEvent({
    captured,
    ...(input.surfaceErrors ? { surfaceErrors: true } : {}),
  });
}

/**
 * Capture half: discriminate the event, build the `TriggerEvent`, and store the
 * durable receipt. Everything here is cheap and local — no movement runs — so
 * an acking front door can complete this inside the request cycle.
 *
 * `null` means there is nothing to dispatch (no movement bound to the trigger).
 */
export async function captureDiscriminableEvent(
  input: DiscriminableEventInput,
): Promise<CapturedTriggerEvent | null> {
  const {
    triggerId,
    movementId,
    event,
    adapterType,
    triggerType,
    eventTypes,
    teamId,
  } = input;
  const now = input.now ?? new Date();

  if (movementId === null) return null;

  // Discriminate into a concrete root type (honours a pre-set `tag`) so the
  // engine seeds a typed record position rather than the raw payload.
  let rootRecordType: string | undefined;
  if (eventTypes.length > 0) {
    const discriminated = discriminateEvent({ adapterType, event, eventTypes });
    if (discriminated) {
      rootRecordType = discriminated.eventType.positionType;
    } else {
      logger.info('[InboundDispatch] event matched no declared event type', {
        triggerId,
        adapterType,
      });
    }
  }

  // The external-side record type: the source's own type id when the adapter
  // names it directly (Attio's object id), else the discriminated position
  // type (the poll path's behaviour).
  const externalRecordRefType = event.recordType ?? rootRecordType;

  const triggerEvent: TriggerEvent = {
    pipelineInputId: `trigger:${triggerId}`,
    adapterType,
    triggerType,
    payload: event.payload,
    ...(event.changeType ? { changeType: event.changeType } : {}),
    ...(rootRecordType ? { rootRecordType } : {}),
    ...(event.externalId !== undefined
      ? {
          externalRecordRef: {
            adapterType,
            externalId: event.externalId,
            ...(externalRecordRefType ? { recordType: externalRecordRefType } : {}),
          },
        }
      : {}),
    ...(event.actor ? { actor: event.actor } : {}),
    ...(event.changedFields ? { changedFields: event.changedFields } : {}),
    ...(event.idempotencyKey ? { idempotencyKey: event.idempotencyKey } : {}),
    occurredAt: event.occurredAt ?? now.toISOString(),
  };

  // Durable receipt before dispatch — a crash mid-run loses nothing and any
  // event can be played back. Idempotent on the source's delivery id: a
  // redelivery (Slack retries an event it didn't 200 in time) comes back
  // `duplicate` and the dispatch half skips it — the first delivery already
  // owns the run. A store failure yields no id: the event still dispatches,
  // unreceipted, because losing the run is worse than losing its audit row.
  const stored = await storeTriggerEvent({
    teamId,
    triggerId,
    event: triggerEvent,
  }).catch((err) => {
    logger.error('[InboundDispatch] failed to store trigger event', {
      triggerId,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  });
  if (stored?.duplicate) {
    logger.info('[InboundDispatch] duplicate delivery ignored', {
      triggerId,
      idempotencyKey: event.idempotencyKey,
    });
  }

  return {
    triggerId,
    teamId,
    triggerEvent,
    ...(stored?.id !== undefined ? { storedEventId: stored.id } : {}),
    duplicate: stored?.duplicate === true,
  };
}

/**
 * Dispatch half: hand a captured receipt to the movement engine and record the
 * outcome on the receipt. This is the expensive part — it runs movements — so
 * the acking front door calls it after its 200.
 *
 * A duplicate capture never dispatches: the first delivery already owns the run.
 */
export async function dispatchCapturedTriggerEvent(input: {
  captured: CapturedTriggerEvent;
  /** See `DiscriminableEventInput.surfaceErrors`. */
  surfaceErrors?: boolean;
}): Promise<void> {
  const { captured } = input;
  const { triggerId, teamId, triggerEvent, storedEventId } = captured;
  if (captured.duplicate) return;

  try {
    const result = await dispatchTriggerByIdEvent({
      triggerId,
      event: triggerEvent,
      teamId,
      platformTokenRegistry,
      storedEventId,
    });
    // A dropped event (actor-unregistered ownership gate, opt-in echo
    // suppression, or any other `droppedReason`) means the router already
    // owns the receipt's outcome — it marked it 'suppressed' with a reason
    // where applicable, or otherwise never touched it. Only a dispatch that
    // actually ran gets marked 'dispatched' here; overwriting a drop would
    // clobber the audit trail (status back to 'dispatched', reason nulled)
    // even though nothing ran.
    if (storedEventId !== undefined && result.droppedReason === undefined) {
      await markTriggerEventDispatched(storedEventId);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (storedEventId !== undefined) await markTriggerEventFailed(storedEventId, message);
    logger.error('[InboundDispatch] dispatch failed', { triggerId, error: message });
    if (input.surfaceErrors) throw err;
  }
}

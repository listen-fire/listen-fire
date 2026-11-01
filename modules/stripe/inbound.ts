// The connection's door: a Stripe webhook delivery, checked against the
// endpoint's signing secret (module-kit's Stripe check, the one `@lf/webhook`
// uses), becomes one arrival on the `Changes` of the object the event is
// about (an invoice's, a subscription's, a customer's or a charge's), carrying
// that object as the event had it. Stripe retries a delivery until it is
// answered 2xx, and re-sends an event for up to three days: the event id names
// the delivery and the arrival, so a retry runs nothing.
//
// An event of a type this module does not type (a payout, a dispute, …) is
// answered 200 and runs nothing: the endpoint may be subscribed to more than
// the program listens for, and a non-2xx answer would only make Stripe retry.

import type { Arrival, AwaitLanding } from 'engine-contracts';
import type { InboundCheck, InboundCheckInput } from 'movement-engine/public/adapter';
import type { SchemaTypeDescriptor } from 'movement-engine/public/catalog';
import { accepted, inboundRequest, refused, reply, verifyStripeSignature } from 'module-kit';

import { isObject, normalizeCharge, normalizeCustomer, normalizeInvoice, normalizeSubscription, type StripeObject } from './api_client';
import { describeStripeType } from './schema';
import {
  STRIPE_CHANGES_EDGE_NAME,
  STRIPE_EVENT_TYPES,
  changedObjectOf,
  isStripeEventType,
  kindOf,
  type StripeChangedObject,
  type StripeEventPayload,
} from './types';

export interface StripeDoorSources {
  /** The endpoint's signing secret (`whsec_…`), read off the credential per
   *  call; undefined when the credential holds none. */
  webhookSecret(): Promise<string | undefined>;
  /** Now, in unix seconds. */
  now(): number;
  log: { warn(message: string): void };
}

/** An event body as Stripe sends it, or why it is not one. */
export function eventOf(body: unknown): { ok: true; payload: StripeEventPayload } | { ok: false; ignored: boolean; message: string } {
  if (!isObject(body) || body['object'] !== 'event' || typeof body['id'] !== 'string' || typeof body['type'] !== 'string') {
    return { ok: false, ignored: false, message: 'the body is not a Stripe event: a JSON object with "object": "event", an "id" and a "type"' };
  }
  const type = body['type'];
  if (!isStripeEventType(type)) {
    return { ok: false, ignored: true, message: `${type} is not an event @lf/stripe types (${STRIPE_EVENT_TYPES.length} invoice, subscription, customer and charge events): it runs nothing` };
  }
  const data = body['data'];
  const object = isObject(data) ? data['object'] : undefined;
  if (!isObject(object)) return { ok: false, ignored: false, message: `the ${type} event carries no data.object` };
  const previous = isObject(data) && isObject(data['previous_attributes']) ? data['previous_attributes'] : null;
  const created = body['created'];
  return {
    ok: true,
    payload: {
      id: body['id'],
      type,
      kind: kindOf(type),
      created: typeof created === 'number' ? new Date(created * 1000).toISOString() : null,
      livemode: body['livemode'] === true,
      api_version: typeof body['api_version'] === 'string' ? body['api_version'] : null,
      previous_attributes: previous,
      object,
    },
  };
}

export async function checkStripeDelivery(input: InboundCheckInput, sources: StripeDoorSources): Promise<InboundCheck> {
  const request = inboundRequest(input);
  if (request.method !== 'POST') return reply(405, { json: { error: 'method_not_allowed', message: 'a Stripe webhook is a POST' } });
  const secret = await sources.webhookSecret();
  if (secret === undefined) {
    sources.log.warn('stripe delivery refused: the credential holds no webhookSecret (the endpoint’s whsec_… signing secret); set it with listen-fire credential add --module stripe <name>');
    return refused(401);
  }
  const verdict = verifyStripeSignature(request, { secret, nowSeconds: sources.now() });
  if (!verdict.ok) {
    sources.log.warn(`stripe delivery refused: ${verdict.reason}`);
    return refused(401);
  }
  const event = eventOf(request.json());
  if (!event.ok) {
    return event.ignored
      ? reply(200, { json: { received: true, ignored: event.message } })
      : reply(400, { json: { error: 'not_a_stripe_event', message: event.message } });
  }
  return accepted([], { deliveryId: event.payload.id, arrivals: [changeArrival(event.payload)] });
}

/** Each object's fields as Stripe's normalised record (by field id). */
const NORMALIZED: Record<StripeChangedObject['kind'], (o: StripeObject) => { id: string }> = {
  customer: normalizeCustomer,
  subscription: normalizeSubscription,
  invoice: normalizeInvoice,
  charge: normalizeCharge,
};

/**
 * An event as the arrival on its object's `Changes`: keyed by the object's id
 * (what a wait on that object's changes names), named by the event's id, about
 * the object, and carrying it, as the event had it, for the hop it is listed
 * by. An upcoming invoice has no id yet: the event's id stands in for it.
 */
export function changeArrival(payload: StripeEventPayload): Arrival {
  const changed = changedObjectOf(payload.type);
  const data = NORMALIZED[changed.kind](payload.object);
  const recordId = data.id !== '' ? data.id : `${payload.id}:${changed.kind}`;
  const object: AwaitLanding = { recordId, recordType: changed.displayName, fields: named(changed.typeId, { ...data }) };
  return {
    edge: STRIPE_CHANGES_EDGE_NAME,
    key: recordId,
    identity: payload.id,
    landing: { recordId: payload.id, recordType: changed.changeDisplayName, fields: named(changed.changeTypeId, { ...payload }) },
    parents: [object],
    about: { recordType: changed.displayName, externalId: recordId },
    ...(payload.created !== null ? { occurredAt: payload.created } : {}),
  };
}

/** A record's fields by id (what the adapter reads it by) and by display name
 *  too (what a listen's WHERE is judged by). */
function named(typeId: string, data: Record<string, unknown>): Record<string, unknown> {
  const descriptor: SchemaTypeDescriptor | null = describeStripeType(typeId);
  const fields: Record<string, unknown> = { ...data };
  for (const field of descriptor?.fields ?? []) {
    if (field.fieldId in data) fields[field.displayName] = data[field.fieldId];
  }
  return fields;
}

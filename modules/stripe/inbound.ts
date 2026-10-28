// The connection's door: a Stripe webhook delivery, checked against the
// endpoint's signing secret (module-kit's Stripe check, the one `@lf/webhook`
// uses), becomes one Event. Stripe retries a delivery until it is answered
// 2xx, so the event id names the delivery and a retry runs nothing.
//
// An event of a type this module does not type (a charge, a payout, …) is
// answered 200 and runs nothing: the endpoint may be subscribed to more than
// the program listens for, and a non-2xx answer would only make Stripe retry.

import type { InboundCheck, InboundCheckInput } from 'movement-engine/public/adapter';
import { accepted, inboundRequest, refused, reply, verifyStripeSignature } from 'module-kit';

import { isObject } from './api_client';
import { STRIPE_EVENT_TAG, STRIPE_EVENT_TYPES, isStripeEventType, type StripeEventPayload } from './types';

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
    return { ok: false, ignored: true, message: `${type} is not an event @lf/stripe types (${STRIPE_EVENT_TYPES.length} invoice, subscription and customer events): it runs nothing` };
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
    sources.log.warn('stripe delivery refused: the credential holds no webhookSecret (the endpoint’s whsec_… signing secret); set it with lf credential add --module stripe <name>');
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
  const { payload } = event;
  return accepted(
    [{ payload, tag: STRIPE_EVENT_TAG, eventType: payload.type, ...(payload.created !== null ? { occurredAt: payload.created } : {}) }],
    { deliveryId: payload.id },
  );
}

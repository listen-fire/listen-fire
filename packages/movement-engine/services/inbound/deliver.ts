// The webhook door: one pipeline for every provider's deliveries to
// `/api/public/webhook-sync/<provider>/<subscription>`, over whatever store the
// host keeps its subscriptions, receipts and work rows in (InboundStore).
//
//   intercepts → subscription → provider check → signature → preprocessInbound
//   → capture a receipt per matching trigger → keep the delivery in one write
//   (its pull cursor, a work row per receipt, what arrived, and the waits of
//   the runs it starts) → ack
//
// A module that checks its own inbound (`inbound.scheme: module`) replaces
// the signature and `preprocessInbound` with one `checkInbound` of the raw
// request; its answer may also be a reply to send as it is (a provider's
// handshake), and only such a module's door takes a GET. An acceptance may
// name what the door answers once the delivery is kept (a page saying an
// answer was recorded), in place of its acknowledgement.
//
// What a delivery says landed on listenable edges (its arrivals, adapter
// protocol 2.5) is logged in the same write, waking each wait parked on its
// record.
//
// Capture, keep, then ack: the sender's 200 means every receipt has its work
// row and every arrival is logged, so nothing it delivered can be lost after
// the ack, and the movements run off the request so a slow run never reads as
// a failed delivery. A delivery that cannot be kept answers 500, with nothing
// of it kept, so the sender's retry keeps it whole.

import type { Arrival, WireInboundIntercept } from 'engine-contracts';
import type { z } from 'zod';
import type { Adapter, DiscriminableEvent, EventType } from '../translation_graph/adapter';

import { logger } from '../logger';
import { CHECKED_BY_MODULE, isUsableInboundSecret, verifyInbound, type InboundHeaders, type InboundVerifier } from './verify';

export type InboundIntercept = z.infer<typeof WireInboundIntercept>;

/** The adapter surface a delivery is read through. */
export type InboundAdapter = Pick<Adapter, 'adapterType' | 'preprocessInbound' | 'listEventTypes' | 'checkInbound'>;


/** The row a door URL names. */
export interface InboundSubscription {
  id: string;
  teamId: string;
  /** The key the subscription was minted for; the URL's provider segment, upper-cased, must equal it. */
  providerKey: string;
  credentialsId: string | null;
  secret: string;
  /** Existed before signed inbound became the rule for its provider: while it
   *  holds no usable secret it is verified as its provider's door always did. */
  grandfatheredUnsigned: boolean;
  checkpoint?: unknown;
}

/** How a subscription's deliveries are checked and read. */
export interface InboundSource {
  verifier: InboundVerifier | typeof CHECKED_BY_MODULE;
  /** The key its deliveries are signed with: usually the subscription's own,
   *  a host-wide one for a provider with one app (WhatsApp). */
  secret: string;
  /** The adapter that reads the delivery, or null when none can. */
  open(): Promise<OpenedSource | null>;
}

export interface OpenedSource {
  adapterType: string;
  credentialsId: string;
  adapter: InboundAdapter;
  /** Reads a verified delivery before its events. 'handled' ends the delivery
   *  with nothing to run (a Telegram button tap); 'continue' carries on. */
  intercept?(body: unknown): Promise<'handled' | 'continue'>;
}

/** What a door needs from its host. `Captured` is the host's own receipt
 *  handle: the core only carries it from capture to the delivery's keep. */
export interface InboundStore<Captured> {
  findSubscription(id: string): Promise<InboundSubscription | null>;
  /** Whether a provider key is one this host serves itself (so a missing row
   *  is `subscription_not_found` rather than `unknown_provider`). */
  knowsProvider(providerKey: string): boolean;
  /** The requests a provider's door answers before anything is looked up. */
  intercepts(providerKey: string): readonly InboundIntercept[];
  sourceFor(subscription: InboundSubscription): Promise<InboundSource | null>;
  /** False only for deliveries the host fabricates itself (the dev loop's test team). */
  verifiesSignature(subscription: InboundSubscription): boolean;
  /** One event's receipt: one per trigger it matches, what `keepDelivery`
   *  queues. A receipt that cannot be made drops its event from the count;
   *  the rest go on. */
  capture(input: {
    event: DiscriminableEvent;
    subscription: InboundSubscription;
    source: OpenedSource;
    eventTypes: readonly EventType[];
  }): Promise<Captured>;
  /**
   * What the delivery leaves, kept in one write (the store slot's
   * `inbound.keepDelivery`): its pull cursor (absent: left as it is), a
   * work row per receipt, and its arrivals logged (`waits.log`, under the
   * module's re-send window), waking each wait parked on their records. The
   * host mints each run a receipt or an arrival starts, and opens the waits
   * its function awaits off its trigger (the edges the checker stamps
   * `opensWaits` on its parameter, keyed by the module's `awaitKeys`) from
   * the mark before the delivery's arrivals, in the same write: a reply that
   * lands while the run sits in the queue, or later in the same delivery,
   * answers it, and the trigger's own arrival, noted on its waits, does not.
   * `arrivalMark` is that mark, each queued run's. `kept: false`, and
   * nothing kept, for a duplicate. A failure keeps nothing: the sender's
   * retry keeps the delivery whole.
   */
  keepDelivery(input: {
    subscription: InboundSubscription;
    source: OpenedSource;
    captured: ReadonlyArray<{ event: DiscriminableEvent; captured: Captured }>;
    arrivals: readonly Arrival[];
    checkpoint?: unknown;
  }): Promise<{ kept: boolean; arrivalMark?: number }>;
}

export interface InboundDelivery {
  /** The URL's provider segment, as sent. */
  provider: string;
  subscriptionId: string;
  rawBody: Buffer;
  headers: InboundHeaders;
  /** POST when absent; any other is answered only by a module that checks
   *  its own inbound. */
  method?: string;
  /** The path as it arrived (percent-encoded, no query), for a module's check. */
  path?: string;
  /** What followed the `?`, or empty. */
  query?: string;
}

export type DeliveryRefusal =
  | 'unknown_provider'
  | 'subscription_not_found'
  | 'provider_mismatch'
  | 'signature_invalid'
  | 'method_not_allowed'
  | 'adapter cannot preprocess inbound';

export interface EventError {
  event: DiscriminableEvent;
  error: string;
}

/** What `queue` kept. */
export interface QueuedDelivery<Captured> {
  teamId: string;
  enqueued: { event: DiscriminableEvent; captured: Captured }[];
  /** Events whose receipt could not be stored: dropped from the count, logged. */
  captureErrors: EventError[];
  /** Kept before under the provider's id: nothing was kept this time. */
  duplicate: boolean;
}

export type ReceivedDelivery<Captured> =
  | {
      ok: false;
      error: DeliveryRefusal;
      eventsProcessed: 0;
      /** The status a module asked its refusal be answered with. */
      status?: number;
    }
  /** The module's reply (a handshake), to send as it is; nothing ran. */
  | { ok: true; eventsProcessed: 0; reply: InboundAnswer }
  | {
      ok: true;
      /** Events CAPTURED — receipted and ready to run. */
      eventsProcessed: number;
      /** The delivery's one write, made before the ack. Absent when the
       *  delivery carried nothing to run or log. Rejects when it could not
       *  be kept. */
      queue?: () => Promise<QueuedDelivery<Captured>>;
      /** The host drains the rows before acking (the dev loop's test team). */
      drainFirst?: boolean;
      /** What the door answers once the delivery is kept, in place of its
       *  acknowledgement: the module's reply on its acceptance. */
      replyOnceKept?: InboundAnswer;
    };

const refused = (error: DeliveryRefusal, status?: number) => ({
  ok: false as const,
  error,
  eventsProcessed: 0 as const,
  ...(status !== undefined ? { status } : {}),
});

/** What a door hands a module's `checkInbound`: the request as it arrived. */
function wireRequest(delivery: Omit<InboundDelivery, 'provider'>): {
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  body: string;
} {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(delivery.headers)) {
    const first = typeof value === 'string' ? value : value?.[0];
    if (first !== undefined) headers[name.toLowerCase()] = first;
  }
  return {
    method: delivery.method ?? 'POST',
    path: delivery.path ?? '',
    query: delivery.query ?? '',
    headers,
    body: delivery.rawBody.toString('base64'),
  };
}

/** A module's reply as the door sends it: a handshake's, or an acceptance's. */
function replyAnswer(reply: { status: number; text?: string; html?: string; json?: unknown }): InboundAnswer {
  if (reply.text !== undefined) return { status: reply.status, body: reply.text, contentType: 'text/plain' };
  if (reply.html !== undefined) return { status: reply.status, body: reply.html, contentType: 'text/html' };
  if (reply.json !== undefined) return { status: reply.status, body: reply.json };
  return { status: reply.status, body: '', contentType: 'text/plain' };
}

/** Verify and capture one delivery; the work rows wait in `queue`. */
export async function receiveDelivery<Captured>(
  store: InboundStore<Captured>,
  delivery: Omit<InboundDelivery, 'provider'> & { providerKey: string },
): Promise<ReceivedDelivery<Captured>> {
  const { providerKey, subscriptionId } = delivery;

  const subscription = await store.findSubscription(subscriptionId);
  if (!subscription) {
    return refused(store.knowsProvider(providerKey) ? 'subscription_not_found' : 'unknown_provider');
  }
  if (subscription.providerKey !== providerKey) return refused('provider_mismatch');

  const source = await store.sourceFor(subscription);
  if (!source) return refused('unknown_provider');

  const read =
    'checkedBy' in source.verifier
      ? await readCheckedByModule<Captured>(source, subscription, delivery)
      : await readSigned(store, source, subscription, delivery);
  if ('result' in read) return read.result;
  const { opened, extraction } = read;
  const { adapter } = opened;
  const { events, arrivals } = extraction;
  const replyOnceKept = read.replyOnceKept;

  // Capture: the durable receipts, one per matching trigger. Nothing here runs
  // a movement; the receipt is what makes the queued half safe to replay.
  const eventTypes = events.length > 0 && adapter.listEventTypes ? await adapter.listEventTypes() : [];
  const captured: { event: DiscriminableEvent; captured: Captured }[] = [];
  const captureErrors: EventError[] = [];
  for (const event of events) {
    try {
      captured.push({ event, captured: await store.capture({ event, subscription, source: opened, eventTypes }) });
    } catch (err) {
      logger.error(`Webhook event capture failed:`, { event, err });
      captureErrors.push({ event, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Arrivals are independent of the events: a delivery may land on a wait
  // whether or not a trigger listens for it.
  if (!events.length && !arrivals.length) {
    return { ok: true, eventsProcessed: 0, ...(replyOnceKept !== undefined ? { replyOnceKept } : {}) };
  }

  // One write: the pull cursor rides with the receipts it moved past, and the
  // arrivals with the runs they start, never one without the other.
  const queue = async (): Promise<QueuedDelivery<Captured>> => {
    const { kept } = await store.keepDelivery({
      subscription,
      source: opened,
      captured,
      arrivals,
      ...(extraction.checkpoint !== undefined ? { checkpoint: extraction.checkpoint } : {}),
    });
    return { teamId: subscription.teamId, enqueued: kept ? captured : [], captureErrors, duplicate: !kept };
  };

  return {
    ok: true,
    eventsProcessed: captured.length,
    queue,
    ...(store.verifiesSignature(subscription) ? {} : { drainFirst: true }),
    ...(replyOnceKept !== undefined ? { replyOnceKept } : {}),
  };
}

/** A delivery read: its adapter, its events, arrivals and cursor, and what
 *  the door answers once it is kept; or the answer that ends it first. */
type DeliveryRead<Captured> =
  | { result: ReceivedDelivery<Captured> }
  | {
      opened: OpenedSource;
      extraction: { events: DiscriminableEvent[]; arrivals: Arrival[]; checkpoint?: unknown };
      replyOnceKept?: InboundAnswer;
    };

/**
 * A delivery's body as its module reads it: JSON, or a form's fields when it
 * says it is form-encoded (Slack posts a press as `payload=<json>`). Each field
 * is text; one sent more than once is the list of its values, in order. What a
 * field holds is the module's to read.
 */
export function deliveryBody(rawBody: Buffer, headers: InboundHeaders): unknown {
  const declared = Object.entries(headers).find(([name]) => name.toLowerCase() === 'content-type')?.[1];
  const contentType = typeof declared === 'string' ? declared : declared?.[0];
  if (contentType?.split(';')[0]?.trim().toLowerCase() !== 'application/x-www-form-urlencoded') {
    return JSON.parse(rawBody.toString('utf-8'));
  }
  const fields: Record<string, string | string[]> = {};
  for (const [name, value] of new URLSearchParams(rawBody.toString('utf-8'))) {
    const held = fields[name];
    fields[name] = held === undefined ? value : Array.isArray(held) ? [...held, value] : [held, value];
  }
  return fields;
}

/** A provider the host verifies: the scheme, then `preprocessInbound`. */
async function readSigned<Captured>(
  store: InboundStore<Captured>,
  source: InboundSource,
  subscription: InboundSubscription,
  delivery: Omit<InboundDelivery, 'provider'>,
): Promise<DeliveryRead<Captured>> {
  const { rawBody, headers } = delivery;
  if ((delivery.method ?? 'POST') !== 'POST') return { result: refused('method_not_allowed') };
  if (!store.verifiesSignature(subscription)) {
    logger.info(`[webhook] test-harness team — skipping signature verification`);
  } else if ('checkedBy' in source.verifier || !verifyInbound(source.verifier, { rawBody, headers, secret: source.secret })) {
    logger.warn(`Webhook signature verification failed for subscription ${subscription.id}`);
    return { result: refused('signature_invalid') };
  }

  const body = deliveryBody(rawBody, headers);
  const opened = await source.open();
  // `preprocessInbound` is THE raw→events seam every inbound adapter
  // implements; a delivery whose adapter lacks it is a wiring bug, refused
  // loudly rather than dropped.
  const preprocess = opened?.adapter.preprocessInbound;
  if (!opened || !preprocess) {
    logger.error(
      `[webhook] adapter for provider ${subscription.providerKey} has no preprocessInbound — delivery dropped`,
    );
    return { result: refused('adapter cannot preprocess inbound') };
  }
  if (opened.intercept && (await opened.intercept(body)) === 'handled') return { result: { ok: true, eventsProcessed: 0 } };

  const { events, arrivals = [], checkpoint } = await preprocess.call(opened.adapter, {
    raw: body,
    checkpoint: subscription.checkpoint ?? undefined,
  });
  return { opened, extraction: { events, arrivals, ...(checkpoint !== undefined ? { checkpoint } : {}) } };
}

/** A module that checks its own inbound: the raw request to `checkInbound`. */
async function readCheckedByModule<Captured>(
  source: InboundSource,
  subscription: InboundSubscription,
  delivery: Omit<InboundDelivery, 'provider'>,
): Promise<DeliveryRead<Captured>> {
  const opened = await source.open();
  const checkInbound = opened?.adapter.checkInbound;
  if (!opened || !checkInbound) {
    logger.error(
      `[webhook] adapter for provider ${subscription.providerKey} declares that it checks its inbound but has no checkInbound — delivery dropped`,
    );
    return { result: refused('adapter cannot preprocess inbound') };
  }
  const answer = await checkInbound.call(opened.adapter, {
    request: wireRequest(delivery),
    ...(isUsableInboundSecret(source.secret) ? { secret: source.secret } : {}),
    ...(subscription.checkpoint !== null && subscription.checkpoint !== undefined ? { checkpoint: subscription.checkpoint } : {}),
  });
  switch (answer.outcome) {
    case 'reply':
      return { result: { ok: true, eventsProcessed: 0, reply: replyAnswer(answer) } };
    case 'refused':
      logger.warn(`Webhook refused by its module for subscription ${subscription.id}`);
      return { result: refused('signature_invalid', answer.status) };
    case 'accepted':
      return {
        opened,
        extraction: {
          events: answer.events,
          arrivals: answer.arrivals ?? [],
          ...(answer.checkpoint !== undefined ? { checkpoint: answer.checkpoint } : {}),
        },
        ...(answer.reply !== undefined ? { replyOnceKept: replyAnswer(answer.reply) } : {}),
      };
    default: {
      const unknown: never = answer;
      throw new Error(`unknown inbound check outcome ${JSON.stringify(unknown)}`);
    }
  }
}

/** An HTTP answer, framework-free: every host's door sends exactly this. */
export interface InboundAnswer {
  status: number;
  /** JSON, unless `contentType` says text (then a string, sent as it is). */
  body: unknown;
  contentType?: 'text/plain' | 'text/html';
  /** Run once the answer is sent (poke the work drain). */
  afterAnswer?: () => void;
}

/** A body over the door's limit, answered in the doors' own error shape. */
export const PAYLOAD_TOO_LARGE: InboundAnswer = { status: 413, body: { error: 'payload_too_large' } };

const REFUSAL_STATUS: Record<DeliveryRefusal, number> = {
  unknown_provider: 404,
  subscription_not_found: 404,
  provider_mismatch: 400,
  signature_invalid: 401,
  // A GET to a door that takes only POST answers as it did before the handshake
  // existed, when the route was not there at all.
  method_not_allowed: 404,
  'adapter cannot preprocess inbound': 500,
};

/** The requests a door answers before it looks anything up (null: none of them). */
export function answerIntercepts(intercepts: readonly InboundIntercept[], rawBody: Buffer): InboundAnswer | null {
  for (const intercept of intercepts) {
    switch (intercept) {
      case 'slack_url_verification': {
        // Slack's one-shot setup check: echo the challenge, unsigned, within 3s.
        let parsed: unknown;
        try {
          parsed = JSON.parse(rawBody.toString('utf-8'));
        } catch {
          continue;
        }
        if (!parsed || typeof parsed !== 'object' || (parsed as { type?: unknown }).type !== 'url_verification') continue;
        const challenge = (parsed as { challenge?: unknown }).challenge;
        return typeof challenge === 'string'
          ? { status: 200, body: { challenge } }
          : { status: 400, body: { error: 'missing_challenge' } };
      }
      default: {
        const unknown: never = intercept;
        throw new Error(`unknown inbound intercept ${String(unknown)}`);
      }
    }
  }
  return null;
}

export interface DeliveryHost<Captured> {
  /** Poke whatever drains the work rows. */
  notify(): void;
  /** Queue and drain the rows before acking (a delivery with `drainFirst`),
   *  reporting what ran. */
  drainBeforeAck?(queue: () => Promise<QueuedDelivery<Captured>>): Promise<{
    eventsProcessed: number;
    perEventErrors: EventError[];
  }>;
}

/** The whole webhook door: one delivery in, the HTTP answer out. */
export async function answerDelivery<Captured>(
  store: InboundStore<Captured>,
  host: DeliveryHost<Captured>,
  delivery: InboundDelivery,
): Promise<InboundAnswer> {
  const providerKey = delivery.provider.toUpperCase();
  const intercepted =
    (delivery.method ?? 'POST') === 'POST' ? answerIntercepts(store.intercepts(providerKey), delivery.rawBody) : null;
  if (intercepted) return intercepted;
  try {
    const result = await receiveDelivery(store, { ...delivery, providerKey });
    if (!result.ok) return { status: result.status ?? REFUSAL_STATUS[result.error], body: { error: result.error } };
    if ('reply' in result) return result.reply;

    if (result.queue && result.drainFirst && host.drainBeforeAck) {
      const drained = await host.drainBeforeAck(result.queue);
      return (
        result.replyOnceKept ?? {
          status: 200,
          body: {
            ok: true,
            eventsProcessed: drained.eventsProcessed,
            ...(drained.perEventErrors.length > 0 ? { perEventErrors: drained.perEventErrors } : {}),
          },
        }
      );
    }
    if (result.queue && (await result.queue()).duplicate) return { status: 200, body: { ok: true, duplicate: true, eventsProcessed: 0 } };
    const kept = result.replyOnceKept ?? { status: 200, body: { ok: true, eventsProcessed: result.eventsProcessed } };
    return { ...kept, afterAnswer: () => host.notify() };
  } catch (err) {
    logger.error('Webhook sync endpoint error:', err);
    return { status: 500, body: { error: 'internal' } };
  }
}

// Slack's inbound: one delivery is either an Events API envelope (JSON) or
// an interaction payload (a press on a message's control, which Slack posts
// form-encoded as `payload=<json>`; the host hands the module the form's
// fields). Only an `event_callback` carries an event; `url_verification`
// (answered by the host's door before it gets here), `app_rate_limited` and
// anything else carry none. The inner event is forwarded whole — the adapter
// reads `text` / `user` / `channel` / `ts` / `files` straight off a
// position's data — keyed by its `ts`, with the envelope's `event_id` as the
// idempotency key Slack's retries share.
//
// A delivery also reports what arrived on a message's listenable edges: a
// press is an arrival on the pressed message's `Interactions`, a thread reply
// one on its thread root's `Replies`, and a deleted message ends both. Each
// is keyed by its message, `channel:ts`, the key `awaitKeys` names for a
// message a run waits on. Pure: both of the platform's doors (a team's own
// app, the shared app) and every other host parse a delivery here.

import { z } from 'zod';

import type { Arrival } from 'engine-contracts';
import type { DiscriminableEvent } from 'movement-engine/public/adapter';

/**
 * Slack file attachment subset. Only the fields the SlackAdapter's
 * `getResources` actually reads — anything else passes through verbatim
 * on `rawPayload`. Kept loose (`.passthrough()`) so future Slack file
 * fields don't reject otherwise-valid payloads.
 */
const slackFileSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
    title: z.string().optional(),
    mimetype: z.string().optional(),
    url_private: z.string().optional(),
    url_private_download: z.string().optional(),
    size: z.number().optional(),
  })
  .passthrough();

/**
 * Inner Slack event (the `event_callback.event` field). Slack delivers
 * many event subtypes — `message`, `app_mention`, `reaction_added`, … —
 * but only `message` matters for the wave-1 dealflow path. We accept any
 * `type` and forward the payload; downstream filters on the trigger entry
 * decide what to act on.
 */
const slackInnerEventSchema = z
  .object({
    type: z.string(),
    user: z.string().optional(),
    channel: z.string().optional(),
    ts: z.string().optional(),
    event_ts: z.string().optional(),
    thread_ts: z.string().optional(),
    text: z.string().optional(),
    files: z.array(slackFileSchema).optional(),
    // `reaction_added` fields: the emoji name, the reacted item (a message —
    // its channel + ts), and the reacted message's author. `channel` is nested
    // under `item` for reactions (not at the top level like messages).
    reaction: z.string().optional(),
    item: z
      .object({
        type: z.string().optional(),
        channel: z.string().optional(),
        ts: z.string().optional(),
      })
      .passthrough()
      .optional(),
    item_user: z.string().optional(),
    // `message_deleted` (and other hidden subtypes): the subtype, and the
    // deleted message's `ts`.
    subtype: z.string().optional(),
    hidden: z.boolean().optional(),
    deleted_ts: z.string().optional(),
  })
  .passthrough();

/**
 * Slack envelope. Slack sends three envelope flavours:
 *
 *   • `url_verification` — one-shot setup challenge. The provider parses
 *     it but emits no events; the REST handler is responsible for
 *     responding with the challenge token. parseEvents returns [].
 *   • `event_callback` — the real payload; wraps a single `event` object.
 *   • `app_rate_limited` — informational; we drop on the floor.
 *
 * `.passthrough()` so unknown envelope fields don't break parsing.
 */
const slackEnvelopeSchema = z
  .object({
    type: z.string(),
    event_id: z.string().optional(),
    event_time: z.number().optional(),
    team_id: z.string().optional(),
    api_app_id: z.string().optional(),
    challenge: z.string().optional(),
    event: slackInnerEventSchema.optional(),
  })
  .passthrough();

/** The id Slack events normalise to: the one entry type, `slack:message`. */
export const SLACK_INBOUND_OBJECT_ID = 'slack:message';

/** The inner-event types that are a message (and so a `create`). */
export const SLACK_MESSAGE_EVENT_TYPES = ['message', 'app_mention'] as const;

function isSlackMessageEventType(type: string): type is (typeof SLACK_MESSAGE_EVENT_TYPES)[number] {
  return SLACK_MESSAGE_EVENT_TYPES.some((messageType) => messageType === type);
}

/** One delivered event. */
export interface SlackDelivery {
  /** The inner event's `type`, verbatim (`message`, `app_mention`, …). */
  eventType: string;
  /** The message `ts`, else `event_ts`, else the envelope's `event_id`. */
  recordId: string;
  idempotencyKey: string | undefined;
  /** The inner event, whole. */
  event: z.infer<typeof slackInnerEventSchema>;
}

/** The events in one delivery: none, or the one an `event_callback` carries. */
export function parseSlackDeliveries(body: unknown): SlackDelivery[] {
  const parsed = slackEnvelopeSchema.safeParse(body);
  if (!parsed.success || parsed.data.type !== 'event_callback' || !parsed.data.event) return [];
  const inner = parsed.data.event;
  return [
    {
      eventType: inner.type,
      recordId: inner.ts ?? inner.event_ts ?? parsed.data.event_id ?? '',
      idempotencyKey: parsed.data.event_id,
      event: inner,
    },
  ];
}

/** A record verb an event type spells, for the few Slack types that are one
 *  (`channel_created`, …). */
function changeTypeOf(eventType: string): 'create' | 'update' | 'delete' | undefined {
  if (eventType.includes('created')) return 'create';
  if (eventType.includes('updated')) return 'update';
  if (eventType.includes('deleted')) return 'delete';
  return undefined;
}

/**
 * The events one delivery fires. A message (or a mention) is a `create`, so
 * the engine seeds a STABLE message position a reply can anchor on; the
 * engine discriminates the rest by the inner event's `type`.
 */
export function slackInboundEvents(body: unknown): DiscriminableEvent[] {
  return parseSlackDeliveries(body).map((delivery) => {
    const changeType = isSlackMessageEventType(delivery.eventType)
      ? ('create' as const)
      : changeTypeOf(delivery.eventType);
    return {
      payload: delivery.event,
      externalId: delivery.recordId,
      recordType: SLACK_INBOUND_OBJECT_ID,
      eventType: delivery.eventType,
      ...(delivery.idempotencyKey ? { idempotencyKey: delivery.idempotencyKey } : {}),
      ...(changeType !== undefined ? { changeType } : {}),
    };
  });
}

/** For a door that answers `url_verification` itself: the envelope, read. */
export const slackEnvelope = slackEnvelopeSchema;

// ── Arrivals ─────────────────────────────────────────────────────────────

/** The key a message's listenable edges are waited on under, and its
 *  arrivals reported on: the message's channel and `ts`. A thread's `Replies`
 *  are keyed by its root message. */
export function slackMessageKey(channel: string, ts: string): string {
  return `${channel}:${ts}`;
}

/** The natural names an arrival's landing is typed by. */
export const SLACK_INTERACTION_TYPE_NAME = 'Interaction';
const SLACK_MESSAGE_TYPE_NAME = 'Message';

/** The edges a message's arrivals land on, by their natural names. */
export const SLACK_INTERACTIONS_EDGE_NAME = 'Interactions';
export const SLACK_REPLIES_EDGE_NAME = 'Replies';

const slackTextObject = z.object({ text: z.string().optional() }).passthrough();

/** One control used in a press, as `block_actions` carries it. A button
 *  answers its `value`; a select its chosen option; a picker what was picked. */
const slackActionSchema = z
  .object({
    type: z.string().optional(),
    action_id: z.string().optional(),
    block_id: z.string().optional(),
    value: z.string().optional(),
    text: slackTextObject.optional(),
    action_ts: z.string().optional(),
    selected_option: z.object({ value: z.string().optional(), text: slackTextObject.optional() }).passthrough().optional(),
    selected_date: z.string().optional(),
    selected_time: z.string().optional(),
  })
  .passthrough();

/**
 * A `block_actions` interaction payload: who pressed (`user`), where
 * (`container.channel_id` + `container.message_ts`, or `channel.id` +
 * `message.ts`), and the controls used (`actions`). `trigger_id` names the
 * press. A press outside a message (a modal, the Home tab) names no message,
 * and arrives on nothing.
 */
const slackBlockActionsSchema = z
  .object({
    type: z.literal('block_actions'),
    trigger_id: z.string().min(1),
    // Slack may send an optional member field as null: a press that says so
    // still lands.
    user: z.object({ id: z.string(), username: z.string().nullish(), name: z.string().nullish(), team_id: z.string().nullish() }).passthrough(),
    container: z.object({ channel_id: z.string().optional(), message_ts: z.string().optional() }).passthrough().optional(),
    channel: z.object({ id: z.string() }).passthrough().optional(),
    message: z.object({ ts: z.string() }).passthrough().optional(),
    actions: z.array(slackActionSchema),
  })
  .passthrough();

/** One control used in a press, as an `Interaction`'s `Actions` land. */
export interface SlackActionData {
  value: string | null;
  text: string | null;
  action_id?: string;
  block_id?: string;
  type?: string;
}

/** A press, as the `Interaction` it lands as: what `getFieldValue` and
 *  `getRelated` read an interaction's fields and edges off. */
export interface SlackInteractionData {
  /** The press's `trigger_id`. */
  id: string;
  /** The first action's `action_ts`, a Slack timestamp. */
  at: string | null;
  actions: SlackActionData[];
  /** The member who pressed, as Slack names them. */
  user: { id: string; username?: string; name?: string; team_id?: string };
}

function slackAction(action: z.infer<typeof slackActionSchema>): SlackActionData {
  const value = action.value ?? action.selected_option?.value ?? action.selected_date ?? action.selected_time ?? null;
  const text = action.text?.text ?? action.selected_option?.text?.text ?? null;
  return {
    value,
    text,
    ...(action.action_id !== undefined ? { action_id: action.action_id } : {}),
    ...(action.block_id !== undefined ? { block_id: action.block_id } : {}),
    ...(action.type !== undefined ? { type: action.type } : {}),
  };
}

/** A form-encoded interaction delivery: its JSON in the `payload` field. */
const slackInteractionFormSchema = z.object({ payload: z.string() }).passthrough();

/** The `block_actions` payload a form-encoded delivery carries, if it is one. */
function blockActionsOf(raw: unknown): z.infer<typeof slackBlockActionsSchema> | undefined {
  const form = slackInteractionFormSchema.safeParse(raw);
  if (!form.success) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(form.data.payload);
  } catch {
    return undefined;
  }
  const read = slackBlockActionsSchema.safeParse(parsed);
  return read.success ? read.data : undefined;
}

/** A press as one arrival on its message's `Interactions`. */
function interactionArrival(press: z.infer<typeof slackBlockActionsSchema>): Arrival | undefined {
  const channel = press.container?.channel_id ?? press.channel?.id;
  const ts = press.container?.message_ts ?? press.message?.ts;
  if (channel === undefined || ts === undefined) return undefined;
  const { id, username, name, team_id } = press.user;
  const fields: SlackInteractionData = {
    id: press.trigger_id,
    at: press.actions[0]?.action_ts ?? null,
    actions: press.actions.map(slackAction),
    user: {
      id,
      ...(username != null ? { username } : {}),
      ...(name != null ? { name } : {}),
      ...(team_id != null ? { team_id } : {}),
    },
  };
  return {
    edge: SLACK_INTERACTIONS_EDGE_NAME,
    key: slackMessageKey(channel, ts),
    identity: press.trigger_id,
    landing: { recordType: SLACK_INTERACTION_TYPE_NAME, fields: { ...fields } },
  };
}

/** What one Events API event says arrived: a thread reply on its root's
 *  `Replies`; a deleted message the end of both its edges. A reply that
 *  mentions the app comes twice, as a `message` and an `app_mention`, under
 *  the one identity, so the second is a repeat. */
function eventArrivals(event: z.infer<typeof slackInnerEventSchema>): Arrival[] {
  if (!isSlackMessageEventType(event.type) || event.channel === undefined) return [];
  const channel = event.channel;
  if (event.subtype === 'message_deleted') {
    const deleted = typeof event.deleted_ts === 'string' ? event.deleted_ts : undefined;
    if (deleted === undefined) return [];
    const key = slackMessageKey(channel, deleted);
    return [
      { edge: SLACK_INTERACTIONS_EDGE_NAME, key, gone: true },
      { edge: SLACK_REPLIES_EDGE_NAME, key, gone: true },
    ];
  }
  // An edit or a deletion is hidden; a root message carries no `thread_ts`,
  // or its own `ts` there.
  if (event.hidden === true || event.ts === undefined || event.thread_ts === undefined || event.thread_ts === event.ts) return [];
  // Named by its record id, `channel:ts`: the name the same reply has when
  // the thread is listed, so a reply both listed and announced counts once.
  const recordId = slackMessageKey(channel, event.ts);
  return [
    {
      edge: SLACK_REPLIES_EDGE_NAME,
      key: slackMessageKey(channel, event.thread_ts),
      identity: recordId,
      landing: { recordId, recordType: SLACK_MESSAGE_TYPE_NAME, fields: { ...event, channel } },
    },
  ];
}

/** What one delivery says arrived on messages' listenable edges. */
export function slackArrivals(raw: unknown): Arrival[] {
  const press = blockActionsOf(raw);
  if (press !== undefined) {
    const arrival = interactionArrival(press);
    return arrival === undefined ? [] : [arrival];
  }
  return parseSlackDeliveries(raw).flatMap((delivery) => eventArrivals(delivery.event));
}

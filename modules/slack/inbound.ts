// Slack's inbound: one delivery is either an Events API envelope (JSON) or
// an interaction payload (a press on a message's control, which Slack posts
// form-encoded as `payload=<json>`; the host hands the module the form's
// fields). Only an `event_callback` carries an event; `url_verification`
// (answered by the host's door before it gets here), `app_rate_limited` and
// anything else carry none.
//
// A delivery reports what arrived on the workspace's listenable edges, each
// landing on its own record type:
//
//   Channel -[:Messages]->     Message      a top-level message
//   Message -[:Replies]->      Message      a reply in its thread
//   Message -[:Reactions]->    Reaction     an emoji added to it
//   Message -[:Interactions]-> Interaction  a press on one of its controls
//
// Each arrival carries the records above it that its edge declares it
// carries: a message and a reaction their channel, a press its channel and
// its message. So a listen's filter on those hops is judged on the arrival
// itself, with no listing of channels or history. A message's channel name
// comes from the module's cached channel read; its `Topic` from the block id
// its buttons were posted under (`lf:<topic>`), which Slack hands back with
// the pressed message.
//
// An arrival on a message's edge is keyed by its message, `channel:ts` (the
// key `awaitKeys` names for a message a run waits on); one on a channel's
// `Messages` by the channel's id. A deleted message ends its edges.

import { z } from 'zod';

import type { ActorIdentity, Arrival, AwaitLanding } from 'engine-contracts';

import { SLACK_ADAPTER_TYPE } from './types';

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
    // The app that posted a bot's message, whatever its `user`.
    bot_id: z.string().optional(),
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
        // A reaction on a file names the file, not a message.
        file: z.string().optional(),
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

/** The inner-event types that are a message. */
const SLACK_MESSAGE_EVENT_TYPES = ['message', 'app_mention'] as const;

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

/** For a door that answers `url_verification` itself: the envelope, read. */
export const slackEnvelope = slackEnvelopeSchema;

// ── Arrivals ─────────────────────────────────────────────────────────────

/** Who acted on an arrival, as its delivery names them: the member's id,
 *  from a message's, a reaction's or a press's `user`. Pure parse — no email
 *  or name, which would take a `users.info` round trip, so the identity is
 *  `opaque` and resolves to no Listen-Fire user until the candidate path
 *  looks the member up. None when the delivery names no member (a bot's
 *  post). `proven`: the host admits only a delivery signed with the app's
 *  secret (`slack_v0`), so the member id is Slack's own. */
function slackActorOf(userId: string | undefined): { actor: ActorIdentity } | Record<string, never> {
  if (userId === undefined || userId.length === 0) return {};
  return { actor: { identifier: userId, scheme: 'opaque', adapterType: SLACK_ADAPTER_TYPE, label: userId, proven: true } };
}

/** The key a message's listenable edges are waited on under, and its
 *  arrivals reported on: the message's channel and `ts`. A thread's `Replies`
 *  are keyed by its root message. It is also a message's record id. */
export function slackMessageKey(channel: string, ts: string): string {
  return `${channel}:${ts}`;
}

/** The natural names an arrival's landing and parents are typed by. */
export const SLACK_INTERACTION_TYPE_NAME = 'Interaction';
export const SLACK_MESSAGE_TYPE_NAME = 'Message';
export const SLACK_REACTION_TYPE_NAME = 'Reaction';
export const SLACK_CHANNEL_TYPE_NAME = 'Channel';

/** The edges arrivals land on, by their natural names. */
export const SLACK_MESSAGES_EDGE_NAME = 'Messages';
export const SLACK_INTERACTIONS_EDGE_NAME = 'Interactions';
export const SLACK_REPLIES_EDGE_NAME = 'Replies';
export const SLACK_REACTIONS_EDGE_NAME = 'Reactions';

/** The ids of the fields a landing derives from a raw Slack value (`ts`, a
 *  press's `action_ts`): each its own, carrying the derived value, since a
 *  host reads a landing's fields by id before judging it and the raw key
 *  holds the raw value. */
export const SLACK_MESSAGE_TIMESTAMP_ID = 'timestamp';
export const SLACK_PRESSED_AT_ID = 'pressed_at';

/**
 * The `Timestamp` field's value: Slack's `ts` (epoch seconds,
 * microseconds after the point) read as the instant it denotes. The raw `ts`
 * stays an IDENTIFIER everywhere it is one (record ids, thread anchors);
 * the field is the time a movement compares.
 */
export function isoInstantFromSlackTs(ts: string | null | undefined): string | null {
  if (!ts) return null;
  const seconds = Number(ts);
  if (!Number.isFinite(seconds)) return null;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// ── A message's Topic ──────────────────────────────────────────────────────
//
// Slack keeps no metadata on a message that comes back with a press, so a
// message's `Topic` is stored where a press does carry it: the id of the
// block its buttons sit in, `lf:<topic>`. Written only with Buttons, and read
// back from that one place, on a pressed message and on a listed one alike.

export const SLACK_TOPIC_BLOCK_PREFIX = 'lf:';

/** Slack's own limit on a block id. */
export const SLACK_MAX_TOPIC_LENGTH = 255 - SLACK_TOPIC_BLOCK_PREFIX.length;

/** The block id a message's buttons are posted under, marking its topic. */
export function slackTopicBlockId(topic: string): string {
  return `${SLACK_TOPIC_BLOCK_PREFIX}${topic}`;
}

/** A message's topic: the marked block id of the block its buttons sit in. */
export function slackTopicOfBlocks(blocks: unknown): string | null {
  if (!Array.isArray(blocks)) return null;
  for (const block of blocks) {
    if (typeof block !== 'object' || block === null || Reflect.get(block, 'type') !== 'actions') continue;
    const id: unknown = Reflect.get(block, 'block_id');
    if (typeof id === 'string' && id.startsWith(SLACK_TOPIC_BLOCK_PREFIX)) return id.slice(SLACK_TOPIC_BLOCK_PREFIX.length);
  }
  return null;
}

/** Whether a message mentions the connected app: Slack says so of an
 *  `app_mention`; any other names the app's bot user in its text. Unknown
 *  (null) when the bot user is. */
export function slackMentionsApp(message: { type?: unknown; text?: unknown }, botUserId: string | null): boolean | null {
  if (message.type === 'app_mention') return true;
  if (botUserId === null) return null;
  return typeof message.text === 'string' && message.text.includes(`<@${botUserId}>`);
}

/** A Slack message as a landing or a carried parent: its payload as Slack
 *  sent it (what a read of the record finds), with its channel, and its
 *  fields by the names a listen's WHERE compares. `Mentions App` is null and
 *  named `unknown` when the bot user could not be read, so a listen whose
 *  filter reads it is not judged on a guess: the host reports it, and judges
 *  every other listen as usual. */
export function slackMessageRecord(input: { channel: string; message: Record<string, unknown>; botUserId: string | null }): AwaitLanding & { recordId: string } {
  const { channel, message, botUserId } = input;
  const ts = typeof message.ts === 'string' ? message.ts : '';
  const recordId = slackMessageKey(channel, ts);
  const mentionsApp = slackMentionsApp(message, botUserId);
  return {
    recordId,
    recordType: SLACK_MESSAGE_TYPE_NAME,
    fields: {
      ...message,
      channel,
      Id: recordId,
      Message: typeof message.text === 'string' ? message.text : null,
      User: typeof message.user === 'string' ? message.user : null,
      Channel: channel,
      Timestamp: isoInstantFromSlackTs(ts),
      [SLACK_MESSAGE_TIMESTAMP_ID]: isoInstantFromSlackTs(ts),
      Topic: slackTopicOfBlocks(message.blocks),
      'Mentions App': mentionsApp,
    },
    ...(mentionsApp === null ? { unknown: ['Mentions App'] } : {}),
  };
}

/** A channel as a carried parent, named from the module's channel read.
 *  When the name could not be read, `Name` is null and named `unknown`, so
 *  a filter on it is not judged on a guess (the host reports it, and judges
 *  every other listen as usual). */
function slackChannelRecord(id: string, name: string | null): AwaitLanding {
  return { recordId: id, recordType: SLACK_CHANNEL_TYPE_NAME, fields: { id, name, Id: id, Name: name }, ...(name === null ? { unknown: ['Name'] } : {}) };
}

/** What an arrival needs that the delivery does not hold: a channel's name
 *  (cached by the module) and the app's bot user (who a mention names).
 *  Each is bounded, and null when Slack could not say in time: the arrival
 *  goes on with what is known. */
export interface SlackArrivalLookups {
  channelName(channelId: string): Promise<string | null>;
  botUserId(): Promise<string | null>;
  botId(): Promise<string | null>;
  /** The connection's `drop_own_messages`: a message the app itself posted is
   *  no arrival. */
  dropOwnMessages: boolean;
  warn(message: string): void;
  /** The messages that share a file (`files.info`'s `shares`): none for a
   *  file in no conversation, null when Slack could not say. */
  fileShares(fileId: string): Promise<SlackMessageAt[] | null>;
}

/** A message by where it is: its channel and its `ts`. */
export interface SlackMessageAt {
  channel: string;
  ts: string;
}

const fileSharesSchema = z.record(z.string(), z.array(z.object({ ts: z.string() }).passthrough()));

/** The messages a `files.info` file names in its `shares`, public and
 *  private, each conversation's in the order Slack lists them. */
export function slackFileShares(file: unknown): SlackMessageAt[] {
  const shares = z.object({ shares: z.object({ public: fileSharesSchema.optional(), private: fileSharesSchema.optional() }).optional() }).safeParse(file);
  if (!shares.success) return [];
  const { public: open, private: closed } = shares.data.shares ?? {};
  return [open, closed].flatMap((byChannel) => Object.entries(byChannel ?? {}).flatMap(([channel, posts]) => posts.map(({ ts }) => ({ channel, ts }))));
}

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
 * `message.ts`), the message pressed as Slack holds it (`message`, its
 * blocks included), and the controls used (`actions`). `trigger_id` names the
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
  /** The channel pressed in. */
  channel?: string;
  /** The message pressed, as Slack sent it with the press (`Message`). */
  message?: Record<string, unknown>;
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

/** A press as one arrival on its message's `Interactions`, carrying the
 *  channel and the message it was on. */
async function interactionArrival(press: z.infer<typeof slackBlockActionsSchema>, lookups: SlackArrivalLookups): Promise<Arrival | undefined> {
  const channel = press.container?.channel_id ?? press.channel?.id;
  const ts = press.container?.message_ts ?? press.message?.ts;
  if (channel === undefined || ts === undefined) return undefined;
  const { id, username, name, team_id } = press.user;
  const at = press.actions[0]?.action_ts ?? null;
  const pressed = press.message !== undefined ? { ...press.message } : undefined;
  const fields: SlackInteractionData = {
    id: press.trigger_id,
    at,
    actions: press.actions.map(slackAction),
    user: {
      id,
      ...(username != null ? { username } : {}),
      ...(name != null ? { name } : {}),
      ...(team_id != null ? { team_id } : {}),
    },
    channel,
    ...(pressed !== undefined ? { message: pressed } : {}),
  };
  const key = slackMessageKey(channel, ts);
  const occurredAt = isoInstantFromSlackTs(at);
  const message = pressed !== undefined ? slackMessageRecord({ channel, message: pressed, botUserId: await lookups.botUserId() }) : null;
  return {
    edge: SLACK_INTERACTIONS_EDGE_NAME,
    key,
    identity: press.trigger_id,
    landing: { recordType: SLACK_INTERACTION_TYPE_NAME, fields: { ...fields, Id: press.trigger_id, At: occurredAt, [SLACK_PRESSED_AT_ID]: occurredAt } },
    parents: [slackChannelRecord(channel, await lookups.channelName(channel)), message],
    about: { recordType: SLACK_MESSAGE_TYPE_NAME, externalId: key },
    ...slackActorOf(id),
    ...(occurredAt !== null ? { occurredAt } : {}),
  };
}

/** A reaction added to a message, as one arrival on its `Reactions`. A
 *  reaction on a file arrives on the `Reactions` of each message that shares
 *  the file, as a reaction on one of those messages does. */
async function reactionArrival(event: z.infer<typeof slackInnerEventSchema>, lookups: SlackArrivalLookups): Promise<Arrival[]> {
  const { item, reaction } = event;
  if (item === undefined || reaction === undefined) return [];
  if (item.type === 'message' && item.channel !== undefined && item.ts !== undefined) {
    return [await messageReactionArrival({ event, reaction, on: { channel: item.channel, ts: item.ts }, lookups })];
  }
  if (item.type === 'file' && item.file !== undefined) {
    const shares = await lookups.fileShares(item.file);
    // Its key is the message it is on: no arrival can be placed without the
    // shares, and Slack sends a delivery it saw fail again.
    if (shares === null) throw new Error(`slack: a reaction on file ${item.file} could not be placed on the messages sharing it: Slack did not answer files.info`);
    return Promise.all(shares.map((on) => messageReactionArrival({ event, reaction, on, lookups })));
  }
  return [];
}

async function messageReactionArrival(input: { event: z.infer<typeof slackInnerEventSchema>; reaction: string; on: SlackMessageAt; lookups: SlackArrivalLookups }): Promise<Arrival> {
  const { event, reaction, on: message, lookups } = input;
  const { channel } = message;
  const key = slackMessageKey(channel, message.ts);
  const occurredAt = isoInstantFromSlackTs(event.event_ts);
  return {
    edge: SLACK_REACTIONS_EDGE_NAME,
    key,
    // A reaction taken off and put back is another reaction: its event's
    // own time tells them apart, and a retried delivery repeats it.
    identity: `${key}:${event.user ?? ''}:${reaction}:${event.event_ts ?? ''}`,
    landing: {
      // The id a run's own reaction write is handed, so the host matches
      // a reaction it caused to its write.
      recordId: `reaction:${key}:${reaction}`,
      recordType: SLACK_REACTION_TYPE_NAME,
      // `item` names the message, as a reaction's `Channel` and `Message`
      // read it: for a file's, the message sharing it, beside the file.
      fields: { ...event, item: { ...event.item, channel, ts: message.ts }, Emoji: reaction, Channel: channel, Reactor: event.user ?? null },
    },
    parents: [slackChannelRecord(channel, await lookups.channelName(channel))],
    about: { recordType: SLACK_MESSAGE_TYPE_NAME, externalId: key },
    ...slackActorOf(event.user),
    ...(occurredAt !== null ? { occurredAt } : {}),
  };
}

/** Whether the app itself posted or reacted in `event`: as its bot user, or as
 *  its bot (a `bot_message` names no user). When Slack cannot say who the app is, nothing
 *  is dropped: a message that cannot be identified is a message. */
async function postedByApp(event: z.infer<typeof slackInnerEventSchema>, botUserId: string | null, lookups: SlackArrivalLookups): Promise<boolean> {
  const botId = await lookups.botId();
  if (botUserId === null && botId === null) {
    lookups.warn('drop_own_messages is on, but Slack did not say who the app is, so its own messages are delivered');
    return false;
  }
  return (botUserId !== null && event.user === botUserId) || (botId !== null && event.bot_id === botId);
}

/** What one Events API event says arrived: a top-level message on its
 *  channel's `Messages`; a thread reply on its root's `Replies`; a reaction
 *  on its message's `Reactions`; a deleted message the end of its edges. A
 *  message that mentions the app comes twice, as a `message` and an
 *  `app_mention`, under the one identity, so the second is a repeat. */
async function eventArrivals(event: z.infer<typeof slackInnerEventSchema>, lookups: SlackArrivalLookups): Promise<Arrival[]> {
  if (event.type === 'reaction_added') {
    // The app's own reaction is its own act, as its post is: a listen on
    // Reactions whose run reacts would otherwise fire itself.
    if (lookups.dropOwnMessages && (await postedByApp(event, await lookups.botUserId(), lookups))) return [];
    return reactionArrival(event, lookups);
  }
  if (!isSlackMessageEventType(event.type) || event.channel === undefined) return [];
  const channel = event.channel;
  if (event.subtype === 'message_deleted') {
    const deleted = typeof event.deleted_ts === 'string' ? event.deleted_ts : undefined;
    if (deleted === undefined) return [];
    const key = slackMessageKey(channel, deleted);
    return [
      { edge: SLACK_INTERACTIONS_EDGE_NAME, key, gone: true },
      { edge: SLACK_REPLIES_EDGE_NAME, key, gone: true },
      { edge: SLACK_REACTIONS_EDGE_NAME, key, gone: true },
    ];
  }
  // An edit or a deletion is hidden.
  if (event.hidden === true || event.ts === undefined) return [];
  const botUserId = await lookups.botUserId();
  if (lookups.dropOwnMessages && (await postedByApp(event, botUserId, lookups))) return [];
  const message = slackMessageRecord({ channel, message: { ...event }, botUserId });
  const occurredAt = isoInstantFromSlackTs(event.ts);
  const when = { ...slackActorOf(event.user), ...(occurredAt !== null ? { occurredAt } : {}) };
  // A root message carries no `thread_ts`, or its own `ts` there. Each is
  // named by its record id, `channel:ts`: the name the same message has
  // when its channel's history or its thread is listed, so a message both
  // listed and announced counts once.
  const parents = [slackChannelRecord(channel, await lookups.channelName(channel))];
  if (event.thread_ts === undefined || event.thread_ts === event.ts) {
    return [{ edge: SLACK_MESSAGES_EDGE_NAME, key: channel, identity: message.recordId, landing: message, parents, ...when }];
  }
  return [{ edge: SLACK_REPLIES_EDGE_NAME, key: slackMessageKey(channel, event.thread_ts), identity: message.recordId, landing: message, parents, ...when }];
}

/** What one delivery says arrived on the workspace's listenable edges. */
export async function slackArrivals(raw: unknown, lookups: SlackArrivalLookups): Promise<Arrival[]> {
  const press = blockActionsOf(raw);
  if (press !== undefined) {
    const arrival = await interactionArrival(press, lookups);
    return arrival === undefined ? [] : [arrival];
  }
  const arrivals = await Promise.all(parseSlackDeliveries(raw).map((delivery) => eventArrivals(delivery.event, lookups)));
  return arrivals.flat();
}

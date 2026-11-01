// WhatsApp's inbound: Meta's `messages` webhook (an envelope,
// `entry[].changes[].value.messages[]`, per delivery) flattened into the
// payload the adapter reads (`from`/`body`/`attachments`, with Twilio-raw
// tolerance), one arrival per message on the root edge of its kind (`Messages`,
// `Reactions`, `Locations`). Pure: the platform's doors and every other host
// parse a delivery here.
//
// Media: Meta delivers media by *id*, not a URL, so the parse leaves the id in
// the attachment `key`. The platform's Meta door downloads it and hands the
// adapter an exposed URL instead.

import { z } from 'zod';

import type { Arrival } from 'engine-contracts';

import { normalizeWhatsappPhone } from './phone';
import {
  WHATSAPP_ARRIVAL_EDGES,
  WHATSAPP_LOCATION_DISPLAY_NAME,
  WHATSAPP_MESSAGE_DISPLAY_NAME,
  WHATSAPP_REACTION_DISPLAY_NAME,
  type WhatsappAttachment,
  type WhatsappPayload,
} from './types';

// ── Meta envelope schema (tolerant — extra fields pass through) ─────────────

const metaMediaSchema = z
  .object({ id: z.string(), mime_type: z.string().optional(), filename: z.string().optional(), caption: z.string().optional() })
  .passthrough();

const metaMessageSchema = z
  .object({
    from: z.string(),
    id: z.string(),
    timestamp: z.string().optional(),
    type: z.string().optional(),
    text: z.object({ body: z.string() }).passthrough().optional(),
    image: metaMediaSchema.optional(),
    document: metaMediaSchema.optional(),
    audio: metaMediaSchema.optional(),
    video: metaMediaSchema.optional(),
    sticker: metaMediaSchema.optional(),
    reaction: z
      .object({ message_id: z.string(), emoji: z.string().optional() })
      .passthrough()
      .optional(),
    location: z
      .object({
        latitude: z.number(),
        longitude: z.number(),
        name: z.string().optional(),
        address: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const metaContactSchema = z
  .object({ wa_id: z.string().optional(), profile: z.object({ name: z.string().optional() }).passthrough().optional() })
  .passthrough();

const metaChangeSchema = z
  .object({
    field: z.string().optional(),
    value: z
      .object({
        metadata: z.object({ display_phone_number: z.string().optional() }).passthrough().optional(),
        contacts: z.array(metaContactSchema).optional(),
        messages: z.array(metaMessageSchema).optional(),
      })
      .passthrough(),
  })
  .passthrough();

const metaWebhookSchema = z
  .object({ object: z.string().optional(), entry: z.array(z.object({ changes: z.array(metaChangeSchema).optional() }).passthrough()).optional() })
  .passthrough();

/** The inbound-message shape the dumb path reads. Hand-written (not a zod
 *  `.passthrough()` infer) so the webhook layer's `WhatsAppMessage` — which has
 *  no index signature — assigns to it cleanly. */
export interface MetaWhatsappMessage {
  from: string;
  id: string;
  timestamp?: string;
  type?: string;
  text?: { body: string };
  image?: { id: string; mime_type?: string; filename?: string; caption?: string };
  document?: { id: string; mime_type?: string; filename?: string; caption?: string };
  audio?: { id: string; mime_type?: string; filename?: string; caption?: string };
  video?: { id: string; mime_type?: string; filename?: string; caption?: string };
  sticker?: { id: string; mime_type?: string; filename?: string; caption?: string };
  reaction?: { message_id: string; emoji?: string };
  location?: { latitude: number; longitude: number; name?: string; address?: string };
}

/** Flatten a Meta message into the canonical `WhatsappPayload`. Attachments
 *  carry the Meta media *id* in `key` (resolved to a stored document by the
 *  inbound router before dispatch). Shared by the provider and the router. */
export function normalizeMetaMessage(
  message: MetaWhatsappMessage,
  ctx: { businessNumber?: string; businessPhoneNumberId?: string; profileName?: string } = {},
): WhatsappPayload {
  const media =
    message.image ?? message.document ?? message.audio ?? message.video ?? message.sticker;
  const attachments: WhatsappAttachment[] = media
    ? [
        {
          key: media.id,
          filename: media.filename ?? message.id,
          contentType: media.mime_type ?? 'application/octet-stream',
        },
      ]
    : [];
  return {
    messageId: message.id,
    from: normalizeWhatsappPhone(message.from) ?? message.from,
    to: ctx.businessNumber ? normalizeWhatsappPhone(ctx.businessNumber) ?? ctx.businessNumber : '',
    ...(ctx.businessPhoneNumberId ? { businessPhoneNumberId: ctx.businessPhoneNumberId } : {}),
    body: message.text?.body ?? media?.caption ?? '',
    waId: message.from,
    profileName: ctx.profileName,
    timestamp: message.timestamp,
    attachments,
  };
}

/** The kinds of inbound record, each arriving on an edge of its own. */
export type WhatsappEventKind = keyof typeof WHATSAPP_ARRIVAL_EDGES;

export interface ClassifiedWhatsappEvent {
  kind: WhatsappEventKind;
  payload: Record<string, unknown>;
}

/**
 * Classify one inbound Meta message into its event kind + typed payload.
 * Text/media/sticker are a `message` (sticker = one more media attachment);
 * reactions and locations are their own event types (a reaction used to
 * parse as an EMPTY message and fire movements spuriously). Anything else
 * (contacts, interactive replies, system notices) returns undefined — the
 * caller drops it with a log, never a silent empty-message firing.
 */
export function classifyMetaMessage(
  message: MetaWhatsappMessage,
  ctx: { businessNumber?: string; businessPhoneNumberId?: string; profileName?: string } = {},
): ClassifiedWhatsappEvent | undefined {
  const common = {
    messageId: message.id,
    from: normalizeWhatsappPhone(message.from) ?? message.from,
    waId: message.from,
    profileName: ctx.profileName,
    timestamp: message.timestamp,
    // The receiving number id rides every kind (message / reaction / location)
    // so a reply, reaction, or typing indicator goes out from that number.
    ...(ctx.businessPhoneNumberId ? { businessPhoneNumberId: ctx.businessPhoneNumberId } : {}),
  };
  if (message.reaction !== undefined) {
    return {
      kind: 'reaction',
      payload: {
        ...common,
        emoji: message.reaction.emoji ?? '',
        reactedMessageId: message.reaction.message_id,
      },
    };
  }
  if (message.location !== undefined) {
    return {
      kind: 'location',
      payload: {
        ...common,
        latitude: message.location.latitude,
        longitude: message.location.longitude,
        name: message.location.name,
        address: message.location.address,
      },
    };
  }
  const media = message.image ?? message.document ?? message.audio ?? message.video ?? message.sticker;
  if (message.text !== undefined || media !== undefined || message.type === 'text') {
    return {
      kind: 'message',
      payload: { ...normalizeMetaMessage(message, ctx) },
    };
  }
  return undefined;
}

/** The record type each kind lands on. */
const LANDS_ON: Record<WhatsappEventKind, string> = {
  message: WHATSAPP_MESSAGE_DISPLAY_NAME,
  reaction: WHATSAPP_REACTION_DISPLAY_NAME,
  location: WHATSAPP_LOCATION_DISPLAY_NAME,
};

/** Meta stamps a message with Unix seconds; an ISO instant is kept as it is. */
function instantOf(timestamp: string | undefined): string | undefined {
  if (timestamp === undefined || timestamp === '') return undefined;
  const instant = /^\d+$/.test(timestamp) ? new Date(Number(timestamp) * 1000) : new Date(timestamp);
  return Number.isNaN(instant.getTime()) ? undefined : instant.toISOString();
}

/** A record's fields under the names the schema gives them, the ones a
 *  listen's WHERE compares. Absent values are left out. */
function schemaFields(kind: WhatsappEventKind, payload: Record<string, unknown>): Record<string, unknown> {
  const named: Record<WhatsappEventKind, Record<string, string>> = {
    message: { 'Message Id': 'messageId', From: 'from', To: 'to', Body: 'body', 'WhatsApp Id': 'waId', 'Profile Name': 'profileName', Timestamp: 'timestamp' },
    reaction: { Emoji: 'emoji', 'Reacted Message Id': 'reactedMessageId', 'Message Id': 'messageId', From: 'from', 'Profile Name': 'profileName', Timestamp: 'timestamp' },
    location: { Latitude: 'latitude', Longitude: 'longitude', Name: 'name', Address: 'address', 'Message Id': 'messageId', From: 'from', 'Profile Name': 'profileName', Timestamp: 'timestamp' },
  };
  return Object.fromEntries(Object.entries(named[kind]).flatMap(([field, key]) => (payload[key] === undefined ? [] : [[field, payload[key]]])));
}

/**
 * One delivery's arrivals, each on the root edge of its kind: a message on
 * `Messages`, a reaction on `Reactions`, a location on `Locations`. A message
 * is named by its WhatsApp id, which Meta repeats when it resends a delivery
 * it saw no 2xx for, so a resend runs a listen once. The chat is the sender's
 * number (`From`), which a listen's WHERE compares. A reaction is `about` the
 * message it is on. A kind no edge takes (a contact card, a button tap, a
 * status update) is no arrival.
 */
export function whatsappInboundArrivals(body: unknown): Arrival[] {
  const parsed = metaWebhookSchema.safeParse(body);
  if (!parsed.success) return [];
  const arrivals: Arrival[] = [];
  for (const entry of parsed.data.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field && change.field !== 'messages') continue;
      const value = change.value;
      const businessNumber = value.metadata?.display_phone_number;
      const profileName = value.contacts?.[0]?.profile?.name;
      for (const message of value.messages ?? []) {
        const classified = classifyMetaMessage(message, { businessNumber, profileName });
        if (classified === undefined) continue; // unsupported kind — never an empty-message firing
        const { kind, payload } = classified;
        const occurredAt = instantOf(message.timestamp);
        arrivals.push({
          edge: WHATSAPP_ARRIVAL_EDGES[kind],
          identity: message.id,
          landing: { recordId: message.id, recordType: LANDS_ON[kind], fields: { ...payload, ...schemaFields(kind, payload) } },
          ...(kind === 'reaction' && message.reaction !== undefined
            ? { about: { recordType: WHATSAPP_MESSAGE_DISPLAY_NAME, externalId: message.reaction.message_id } }
            : {}),
          ...(occurredAt !== undefined ? { occurredAt } : {}),
        });
      }
    }
  }
  return arrivals;
}

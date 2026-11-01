// Email checks its own inbound requests (`inbound.scheme: module`): one door,
// `/api/public/webhook-sync/email/<install>`, that either provider may post
// to. A Resend (Svix) notification is told apart by its `svix-*` headers;
// anything else is read as a Mailgun form post. The key each is signed with
// is the subscription's secret (listen-fire: the install's `webhook_secret`): the
// Mailgun HTTP webhook signing key, or Resend's `whsec_` secret.
//
// The answers keep the platform's own mail doors' statuses, so a provider
// sees the same thing from either host: no key 401; a bad or unreadable
// delivery 406 (a code neither provider retries); a Resend event that is not
// mail arriving 200 with nothing run. Each message arrives on the
// connection's `Emails` with the plus-suffix it was sent to as its `Key`; the
// host fires the listens whose `e.Key` it is.

import { randomUUID } from 'node:crypto';

import { accepted, inboundRequest, refused, type InboundRequest } from 'module-kit';

import type { Arrival } from 'engine-contracts';
import type { InboundCheck, InboundCheckInput } from 'movement-engine/public/adapter';

import { normaliseInboundEmailPayload } from '../adapter';
import { inboxKeyOf } from '../address';
import { DEFAULT_API_BASE_URL } from '../resend';
import { fetchResendEmailPayload } from '../resend_inbound';
import { EMAILS_EDGE, EMAIL_KEY_FIELD } from '../types';
import { RESEND_RECEIVED_EVENT_TYPE, mailgunSignatureVerifies, readMailgunMessage, readResendEnvelope } from './mail';
import { verifySvixSignature } from './svix';

import type { EmailProviderAccess } from '../providers';

/** What checking takes besides the request: the Resend API, read per call. */
export interface EmailInboundSources {
  access(): Promise<EmailProviderAccess>;
}

/** The email an inbound message is, arriving on the connection's `Emails`:
 *  its fields as the message holds them, and the key it was routed by. */
function emailArrival(payload: Record<string, unknown>, deliveryId?: string): Arrival {
  const messageId = typeof payload['messageId'] === 'string' && payload['messageId'].length > 0 ? payload['messageId'] : undefined;
  const recipient = typeof payload['recipient'] === 'string' ? payload['recipient'] : undefined;
  return {
    edge: EMAILS_EDGE,
    // Both providers redeliver on anything but a 2xx: one email, one run.
    identity: messageId ?? deliveryId ?? randomUUID(),
    landing: { recordType: 'Email', fields: { ...payload, [EMAIL_KEY_FIELD]: inboxKeyOf(recipient) } },
  };
}

/** One email, kept under the id its provider delivered it by. */
function acceptedEmail(payload: Record<string, unknown>, deliveryId?: string): InboundCheck {
  return accepted([], { arrivals: [emailArrival(payload, deliveryId)] });
}

function checkMailgun(request: InboundRequest): InboundCheck {
  const form = request.form();
  const message = readMailgunMessage(form);
  if (message === null) return refused(406);
  // A replayed request is the host's own capture: the host vouches for it.
  if (!request.replayed) {
    if (request.secret === undefined) return refused(401);
    // 406 rather than 401: Mailgun retries hard on anything it reads as
    // transient, and a bad signature will never become good.
    if (!mailgunSignatureVerifies(message, request.secret)) return refused(406);
  }
  return acceptedEmail(normaliseInboundEmailPayload(form), message.token || undefined);
}

async function checkResend(request: InboundRequest, sources: EmailInboundSources): Promise<InboundCheck> {
  const body = request.text();
  // A replayed request is the host's own capture, signed (and stamped) long ago: the host vouches for it.
  if (!request.replayed) {
    if (request.secret === undefined) return refused(401);
    const verdict = verifySvixSignature({
      secret: request.secret,
      headers: {
        id: request.header('svix-id') ?? '',
        timestamp: request.header('svix-timestamp') ?? '',
        signature: request.header('svix-signature') ?? '',
      },
      body,
    });
    if (verdict !== 'verified') return refused(406);
  }
  // Resend sends its whole event stream to one endpoint: anything that is not
  // mail arriving is acknowledged and ignored.
  const type = (request.json() as { type?: unknown } | undefined)?.type;
  if (type !== RESEND_RECEIVED_EVENT_TYPE) return accepted([]);
  const envelope = readResendEnvelope(body);
  if (envelope === null) return refused(406);

  // The notification carries ids only: the message is fetched. A failure
  // throws, which the host answers 500, so Resend retries.
  const access = await sources.access();
  if (access.resendApiKey === undefined) {
    throw new Error('email: there is no Resend API key (resendApiKey) — a Resend notification carries only ids, and the message is fetched with it');
  }
  const payload = await fetchResendEmailPayload(
    { apiKey: access.resendApiKey, baseUrl: access.resendBaseUrl ?? DEFAULT_API_BASE_URL, fetch: access.fetch },
    envelope.email_id,
  );
  return acceptedEmail(payload, envelope.email_id);
}

/** One request at email's inbound door. */
export async function checkEmailInbound(input: InboundCheckInput, sources: EmailInboundSources): Promise<InboundCheck> {
  const request = inboundRequest(input);
  if (request.method !== 'POST') return refused(405);
  return request.header('svix-id') !== undefined || request.header('svix-signature') !== undefined
    ? checkResend(request, sources)
    : checkMailgun(request);
}

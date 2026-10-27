// Gmail adapter — the send side, and drafts.
//
// One operation underneath a send, `users.messages.send`, and two things an
// author can mean by it. Which one is decided by WHERE the write is anchored, never by a
// field: a Message written along the mailbox's `Messages` edge is new mail, and
// a Message written along another message's `Replies` edge is a reply. That is
// the same shape as a Slack post versus a Slack thread reply, and it is what
// keeps the difference inside the checker — a reply whose parent is missing
// cannot be written at all, rather than failing halfway through a run because
// one of a pair of fields was set and the other was not.
//
// Everything a reply needs beyond its body — the conversation, the subject, the
// address to answer, the `In-Reply-To` chain — is READ OFF THE PARENT. None of
// it is authorable, because none of it is a decision: getting any of it wrong
// produces a message that lands outside the thread it was meant for.
//
// A DRAFT is the same message kept unsent (`users.drafts.create`): a Draft
// written along the mailbox's `Drafts` edge is a new one, and along a message's
// `Drafts` edge a reply, threaded exactly as a sent reply is. A person finishes
// it, so it may be written without recipients or words.

import type { FileRef, ParentLink, WriteResult } from 'movement-engine/public/adapter';
import type { ModuleLog } from 'module-kit';

import { hasFileSource } from 'movement-engine/public/files';
import {
  GmailApiError,
  gmailMissingComposeScopeMessage,
  gmailMissingSendScopeMessage,
  type GmailApiClient,
  type GmailConnectMethod,
} from './api_client';
import {
  buildRfc2822,
  toGmailRaw,
  type ComposeOptions,
  type GmailOutboundAttachment,
} from './compose';
import { splitAddressHeader } from './mime';
import { GMAIL_ADAPTER_TYPE, GMAIL_DRAFT_DISPLAY_NAME, GMAIL_MESSAGE_DISPLAY_NAME } from './types';

/** The parent of a reply, as the write path reads it off the position that was
 *  handed over. Every value is optional because a parent is data that travelled
 *  from somewhere else — what the write REQUIRES is checked below, loudly. */
export interface GmailReplyTarget {
  threadId?: string;
  rfcMessageId?: string;
  rfcReferences?: string[];
  subject?: string;
  from?: string;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function strings(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const raw = Array.isArray(value) ? value : [value];
  return raw.flatMap((entry) => (typeof entry === 'string' ? splitAddressHeader(entry) : []));
}

/** Read the reply's anchor off the parent link's payload — the Gmail message
 *  record every Message position carries (`decodeGmailMessage`'s output). */
export function replyTargetFromParent(parent: ParentLink): GmailReplyTarget {
  const data = parent.data ?? {};
  const references = data['rfcReferences'];
  return {
    ...(str(data['threadId']) !== undefined ? { threadId: str(data['threadId']) } : {}),
    ...(str(data['rfcMessageId']) !== undefined
      ? { rfcMessageId: str(data['rfcMessageId']) }
      : {}),
    ...(Array.isArray(references)
      ? { rfcReferences: references.filter((id): id is string => typeof id === 'string') }
      : {}),
    ...(str(data['subject']) !== undefined ? { subject: str(data['subject']) } : {}),
    ...(str(data['from']) !== undefined ? { from: str(data['from']) } : {}),
  };
}

/** `Re:` once. A conversation that has already been replied to carries the
 *  prefix, and stacking them is how a thread ends up titled "Re: Re: Re:". */
export function replySubject(parentSubject: string | undefined): string {
  const subject = parentSubject ?? '';
  return /^re:/i.test(subject.trim()) ? subject.trim() : `Re: ${subject}`.trim();
}

/** What a send or a draft is handed: `fields` in the adapter's INTERNAL
 *  currency (the caller resolved the author's natural names first), and
 *  `replyTo` present exactly when the write was anchored on another message. */
export interface GmailOutboundInput {
  client: GmailApiClient;
  /** The bytes of a file the write was handed (at its url, else through the
   *  host's files). */
  readFile: (ref: FileRef) => Promise<Uint8Array>;
  log: ModuleLog;
  fields: Record<string, unknown>;
  replyTo?: GmailReplyTarget;
  /** Injectable so a test can assert a whole message rather than one with a
   *  random boundary cut out of it. */
  compose?: ComposeOptions;
}

/** The message a send or a draft hands Gmail, with the headers it carries. */
interface ComposedMessage {
  raw: string;
  to: string[];
  cc: string[];
  subject: string;
}

/**
 * Build the message. A send must be addressed and say something; a draft is
 * finished by a person, so it may be neither yet. A reply of either kind needs
 * the conversation it joins.
 */
async function composeOutbound(
  input: GmailOutboundInput,
  purpose: 'send' | 'draft',
): Promise<ComposedMessage> {
  const { fields, replyTo } = input;
  const to = pickRecipients({ field: fields['to'], replyTo });
  const cc = strings(fields['cc']);
  const bodyText = str(fields['body']);
  const bodyHtml = str(fields['bodyHtml']);
  const subject = str(fields['subject']) ?? (replyTo ? replySubject(replyTo.subject) : '');

  if (purpose === 'send' && to.length === 0) {
    throw new Error(
      replyTo === undefined
        ? 'GmailAdapter.createRecord: a new message needs at least one `To` address.'
        : 'GmailAdapter.createRecord: this reply has no address to answer — the ' +
          'message it replies to carries no `From`, so set `To` on the reply.',
    );
  }
  if (purpose === 'send' && bodyText === undefined && bodyHtml === undefined) {
    throw new Error(
      'GmailAdapter.createRecord: a message needs a `Body` (plain text) or an ' +
        '`HTML Body` — Gmail will not send an empty one.',
    );
  }
  if (replyTo !== undefined && replyTo.threadId === undefined) {
    throw new Error(
      'GmailAdapter.createRecord: the message this reply is written along ' +
        'carries no `Thread Id`, so Gmail has no conversation to file it in. ' +
        'Reply along a message a listener delivered or a `Messages` walk read.',
    );
  }
  const attachments = await resolveAttachments(fields['files'], input.readFile);

  const raw = buildRfc2822(
    {
      from: input.client.credentials.mailbox,
      to,
      ...(cc.length > 0 ? { cc } : {}),
      subject,
      ...(bodyText !== undefined ? { bodyText } : {}),
      ...(bodyHtml !== undefined ? { bodyHtml } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(replyTo?.rfcMessageId !== undefined ? { inReplyTo: replyTo.rfcMessageId } : {}),
      ...(replyTo !== undefined ? { references: referenceChain(replyTo) } : {}),
    },
    input.compose ?? {},
  );
  return { raw: toGmailRaw(raw), to, cc, subject };
}

/** Send as the connected mailbox. */
export async function sendGmailMessage(input: GmailOutboundInput): Promise<WriteResult> {
  const { client, replyTo } = input;
  const mailbox = client.credentials.mailbox;
  const message = await composeOutbound(input, 'send');

  let sent;
  try {
    sent = await client.sendMessage({
      raw: message.raw,
      ...(replyTo?.threadId !== undefined ? { threadId: replyTo.threadId } : {}),
    });
  } catch (error) {
    throw sendFailure(error, mailbox, client.credentials.method);
  }

  input.log.info(
    `[GmailAdapter.write] sent ${sent.id} as ${mailbox}` +
      `${replyTo ? ` (reply in thread ${replyTo.threadId})` : ''}`,
  );

  // The id is GMAIL'S — the message reads back through `readRecord`, so the
  // write's handle names a message that really exists rather than a token this
  // adapter invented.
  return {
    adapterType: GMAIL_ADAPTER_TYPE,
    externalId: sent.id,
    recordType: GMAIL_MESSAGE_DISPLAY_NAME,
    data: {
      id: sent.id,
      ...(sent.threadId ? { threadId: sent.threadId } : {}),
      from: mailbox,
      to: message.to,
      ...(message.cc.length > 0 ? { cc: message.cc } : {}),
      subject: message.subject,
    },
  };
}

/** Keep a message in the mailbox unsent. The handle carries the Draft's
 *  catalog field names, which is what a program reads off it. */
export async function draftGmailMessage(input: GmailOutboundInput): Promise<WriteResult> {
  const { client, replyTo } = input;
  const mailbox = client.credentials.mailbox;
  const message = await composeOutbound(input, 'draft');

  let draft;
  try {
    draft = await client.createDraft({
      raw: message.raw,
      ...(replyTo?.threadId !== undefined ? { threadId: replyTo.threadId } : {}),
    });
  } catch (error) {
    if (error instanceof GmailApiError && error.failure === 'missing_compose_scope') {
      throw new Error(gmailMissingComposeScopeMessage(mailbox, client.credentials.method));
    }
    throw error;
  }

  input.log.info(
    `[GmailAdapter.write] drafted ${draft.id} in ${mailbox}` +
      `${replyTo ? ` (reply in thread ${replyTo.threadId})` : ''}`,
  );

  const threadId = draft.message?.threadId ?? replyTo?.threadId;
  return {
    adapterType: GMAIL_ADAPTER_TYPE,
    externalId: draft.id,
    recordType: GMAIL_DRAFT_DISPLAY_NAME,
    data: {
      Id: draft.id,
      ...(draft.message ? { 'Message Id': draft.message.id } : {}),
      ...(threadId ? { 'Thread Id': threadId } : {}),
      To: message.to,
      ...(message.cc.length > 0 ? { Cc: message.cc } : {}),
      Subject: message.subject,
    },
  };
}

/** Who the message goes to: whoever the author named, or — on a reply that
 *  named nobody — whoever sent the message being replied to. */
function pickRecipients(input: {
  field: unknown;
  replyTo: GmailReplyTarget | undefined;
}): string[] {
  const named = strings(input.field);
  if (named.length > 0) return named;
  return input.replyTo?.from !== undefined ? splitAddressHeader(input.replyTo.from) : [];
}

/** The conversation's chain, extended by the message being replied to. A client
 *  that knows nothing about Gmail's thread ids draws the thread from this. */
function referenceChain(replyTo: GmailReplyTarget): string[] {
  const chain = [...(replyTo.rfcReferences ?? [])];
  if (replyTo.rfcMessageId !== undefined && !chain.includes(replyTo.rfcMessageId)) {
    chain.push(replyTo.rfcMessageId);
  }
  return chain;
}

/**
 * A refusal, reported as the thing the deployment can act on.
 *
 * The one refusal a deployment will actually meet is the scope: a mailbox that
 * holds the read scope and not the send one lists mail all day and fails the
 * first time a movement answers any of it. Under a sign-in the client knows
 * that before it asks; under delegation only Google does, and the send call
 * requests ONLY the send scope (apiClient.ts) so a token refusal there can mean
 * nothing else. Both arrive here as `missing_send_scope`, and the remedy named
 * depends on which method connected the mailbox.
 */
function sendFailure(
  error: unknown,
  mailbox: string,
  method: GmailConnectMethod,
): Error {
  if (error instanceof GmailApiError && error.failure === 'missing_send_scope') {
    return new Error(gmailMissingSendScopeMessage(mailbox, method));
  }
  return error instanceof Error ? error : new Error(String(error));
}

// ── Attachments ─────────────────────────────────────────────────────────────
// A `Files` value is whatever the run is holding: an attachment read off
// another message, a document a movement produced. Same currency as every other
// adapter's file write — a FileRef, or a list of them.

interface FileValue extends FileRef {
  content?: string;
}

function asFileValue(raw: unknown): FileValue | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return raw as FileValue;
}

async function resolveAttachments(
  raw: unknown,
  readFile: (ref: FileRef) => Promise<Uint8Array>,
): Promise<GmailOutboundAttachment[]> {
  if (raw === undefined || raw === null) return [];
  const values = (Array.isArray(raw) ? raw : [raw])
    .map(asFileValue)
    .filter((value): value is FileValue => value !== null);

  const attachments: GmailOutboundAttachment[] = [];
  for (const value of values) {
    const bytes = await fileBytes(value, readFile);
    if (bytes === null) {
      // Loud, and fatal: an email that silently goes out without the document
      // it was about is worse than one that does not go out at all.
      throw new Error(
        `GmailAdapter.createRecord: could not read the bytes of the attached file ` +
          `"${value.name ?? 'unnamed'}", so the message was not sent.`,
      );
    }
    attachments.push({
      filename: value.name ?? 'attachment',
      contentType: bytes.contentType,
      content: bytes.body,
    });
  }
  return attachments;
}

/** A file the write can read: one a host exposed at a url, or one whose
 *  owner the host can redeem. */
function isServed(value: FileValue): boolean {
  return typeof value.url === 'string' || hasFileSource(value);
}

async function fileBytes(
  value: FileValue,
  readFile: (ref: FileRef) => Promise<Uint8Array>,
): Promise<{ body: Buffer; contentType: string } | null> {
  if (isServed(value)) {
    return {
      body: Buffer.from(await readFile(value)),
      contentType: value.contentType ?? 'application/octet-stream',
    };
  }
  if (typeof value.content === 'string') {
    return {
      body: Buffer.from(value.content, 'utf8'),
      contentType: value.contentType ?? 'text/plain',
    };
  }
  return null;
}

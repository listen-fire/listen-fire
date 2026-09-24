// Gmail HTTP transport — the one owner of the wire shape for the movements
// adapter (services/translation_graph/adapters/gmail) and its poll source.
//
// The mailbox is reached by DELEGATION: the deployment's Google service account
// acts as the connected address, which a Workspace admin grants once against the
// account's client id. There is no per-user sign-in and no consent screen, so
// the stored credential is just the address (plus the dev loop's fake base URL);
// everything secret lives in the deployment's own environment.
//
// Every reply is parsed here with zod. The googleapis client types its responses
// as "every field optional", which is a claim about the SDK's surface rather
// than about what Gmail sent — so the schemas below are what the rest of the
// package trusts, and an unparseable reply fails loudly at the boundary instead
// of reading as a message with no subject.

import { google, type gmail_v1 } from 'googleapis';
import { z } from 'zod';

import {
  GMAIL_READONLY_SCOPE,
  GMAIL_SEND_SCOPE,
  delegatedGoogleAuth,
  gmailMailboxAllowlist,
  isGoogleServiceAccountConfigured,
} from '../../lib/google_cloud';
import { neverAsAny } from '../../lib/utils/types';

/** The scopes a connected mailbox is reached through — read and send, nothing
 *  else. Exported so `describe` can name them without a second spelling. */
export const GMAIL_SCOPES = [GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE] as const;

/**
 * Each Gmail call asks for exactly the ONE scope it needs, never both
 * together — so a delegation grant that covers reads but not sends (or the
 * reverse) fails only the calls that actually need the missing scope. A
 * single combined-scope token would fail every call the moment either scope
 * were absent, reads included.
 */
const GMAIL_READ_SCOPES = [GMAIL_READONLY_SCOPE] as const;
const GMAIL_SEND_SCOPES = [GMAIL_SEND_SCOPE] as const;

/** The mailbox the delegated client addresses. Gmail's own alias for "the
 *  authenticated user", which under delegation IS the impersonated mailbox. */
const SELF = 'me';

/** Gmail's ceiling on one `messages.list` page. */
export const GMAIL_MAX_PAGE = 500;

/**
 * Stored Gmail credential. One field the user typed — the mailbox address —
 * plus the dev loop's injected base URL. No token, because there is none: the
 * deployment's service account is the whole authority, and this row only names
 * whose mail it acts on.
 */
export const gmailCredsParser = z.object({
  mailbox: z.string().email(),
  baseUrl: z.string().url().optional(),
});
export type GmailCredentials = z.infer<typeof gmailCredsParser>;

// ── Wire shapes ─────────────────────────────────────────────────────────────

const headerSchema = z.object({
  name: z.string().nullish(),
  value: z.string().nullish(),
});

const partBodySchema = z.object({
  attachmentId: z.string().nullish(),
  size: z.number().nullish(),
  data: z.string().nullish(),
});

/**
 * A MIME part. Gmail nests these arbitrarily deep (a `multipart/mixed` holding
 * a `multipart/alternative` holding the two body alternatives), so the schema is
 * recursive and the decode walks it.
 */
export interface GmailPart {
  partId?: string | null;
  mimeType?: string | null;
  filename?: string | null;
  headers?: z.infer<typeof headerSchema>[] | null;
  body?: z.infer<typeof partBodySchema> | null;
  parts?: GmailPart[] | null;
}

export const gmailPartSchema: z.ZodType<GmailPart> = z.lazy(() =>
  z.object({
    partId: z.string().nullish(),
    mimeType: z.string().nullish(),
    filename: z.string().nullish(),
    headers: z.array(headerSchema).nullish(),
    body: partBodySchema.nullish(),
    parts: z.array(gmailPartSchema).nullish(),
  }),
);

export const gmailMessageSchema = z.object({
  id: z.string(),
  threadId: z.string().nullish(),
  labelIds: z.array(z.string()).nullish(),
  snippet: z.string().nullish(),
  historyId: z.string().nullish(),
  /** Epoch milliseconds, as a string. */
  internalDate: z.string().nullish(),
  sizeEstimate: z.number().nullish(),
  payload: gmailPartSchema.nullish(),
  /** Only on `format: 'raw'` — the whole RFC 822 message, base64url. */
  raw: z.string().nullish(),
});
export type GmailMessage = z.infer<typeof gmailMessageSchema>;

const messageRefSchema = z.object({
  id: z.string(),
  threadId: z.string().nullish(),
});
export type GmailMessageRef = z.infer<typeof messageRefSchema>;

const messageListSchema = z.object({
  messages: z.array(messageRefSchema).nullish(),
  nextPageToken: z.string().nullish(),
  resultSizeEstimate: z.number().nullish(),
});

export const gmailProfileSchema = z.object({
  emailAddress: z.string(),
  messagesTotal: z.number().nullish(),
  threadsTotal: z.number().nullish(),
  historyId: z.string(),
});
export type GmailProfile = z.infer<typeof gmailProfileSchema>;

const historyRecordSchema = z.object({
  id: z.string().nullish(),
  messagesAdded: z
    .array(z.object({ message: messageRefSchema.nullish() }))
    .nullish(),
});

const historyListSchema = z.object({
  history: z.array(historyRecordSchema).nullish(),
  nextPageToken: z.string().nullish(),
  historyId: z.string().nullish(),
});

const attachmentSchema = z.object({
  size: z.number().nullish(),
  data: z.string().nullish(),
});

/** What `users.messages.send` hands back — the message as Gmail now holds it,
 *  which is where the REAL id comes from. */
const sentMessageSchema = z.object({
  id: z.string(),
  threadId: z.string().nullish(),
  labelIds: z.array(z.string()).nullish(),
});
export type GmailSentMessage = z.infer<typeof sentMessageSchema>;

// ── Errors ──────────────────────────────────────────────────────────────────

/** Why a Gmail call failed, in the terms the callers actually branch on. */
export type GmailFailure =
  /** The mailbox refused the impersonation — delegation is not granted. */
  | 'delegation'
  /** The token request for `gmail.send` was refused — reads still work, only
   *  the send scope is missing from the delegation grant. */
  | 'missing_send_scope'
  /** Google accepted the impersonation but the address is not a mailbox. */
  | 'no_such_mailbox'
  /** `history.list` was given a marker Gmail has since dropped. */
  | 'history_expired'
  | 'other';

export class GmailApiError extends Error {
  constructor(
    readonly failure: GmailFailure,
    readonly status: number | undefined,
    readonly operation: string,
    detail: string,
  ) {
    super(`Gmail ${operation} failed (${failure}${status ? ` ${status}` : ''}): ${detail}`);
    this.name = 'GmailApiError';
  }
}

/** Read a property off a value that may be anything — the shape of a thrown
 *  error is not something the type system knows. */
function prop(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function statusOf(err: unknown): number | undefined {
  const direct = prop(err, 'status');
  if (typeof direct === 'number') return direct;
  const response = prop(err, 'response');
  const fromResponse = prop(response, 'status');
  return typeof fromResponse === 'number' ? fromResponse : undefined;
}

function messageOf(err: unknown): string {
  const data = prop(prop(err, 'response'), 'data');
  const nested = text(prop(prop(data, 'error'), 'message'));
  if (nested !== '') return nested;
  const description = text(prop(data, 'error_description'));
  if (description !== '') return description;
  return text(prop(err, 'message'));
}

/**
 * Classify a thrown Gmail/auth error.
 *
 * The two connect-time failures are told apart by WHERE they happen: an
 * impersonation Google never agreed to is refused at the token exchange, which
 * the auth library reports as `unauthorized_client`; an address Google is happy
 * to impersonate but that owns no mailbox reaches Gmail and comes back 400/404.
 * That difference is the whole diagnostic a user needs, so it is decided once,
 * here.
 *
 * A token refusal on `users.messages.send` is reported separately
 * (`missing_send_scope`) rather than as `delegation`: each Gmail call now asks
 * for exactly the one scope it needs, so a refused SEND token means the grant
 * covers reads but not sends — Google reports it the same way it reports "no
 * delegation at all", and which scope set was being requested is the only
 * signal that tells the two apart.
 */
export function classifyGmailError(err: unknown, operation: string): GmailApiError {
  if (err instanceof GmailApiError) return err;
  const status = statusOf(err);
  const detail = messageOf(err) || String(err);
  const lower = detail.toLowerCase();

  const tokenRefused =
    lower.includes('unauthorized_client') ||
    lower.includes('invalid_grant') ||
    status === 401 ||
    status === 403;
  if (tokenRefused) {
    return operation === 'users.messages.send'
      ? new GmailApiError('missing_send_scope', status, operation, detail)
      : new GmailApiError('delegation', status, operation, detail);
  }
  if (operation === 'history.list' && status === 404) {
    return new GmailApiError('history_expired', status, operation, detail);
  }
  if (status === 400 || status === 404) {
    return new GmailApiError('no_such_mailbox', status, operation, detail);
  }
  return new GmailApiError('other', status, operation, detail);
}

/** What a deployment reads when a send fails because its delegation grant
 *  covers `gmail.readonly` but not `gmail.send`. Names the mailbox and the
 *  scope, and says reads are unaffected — the one thing a "send failed"
 *  message must not do here is suggest the mailbox is disconnected. */
export function gmailMissingSendScopeMessage(mailbox: string): string {
  return (
    `Google's domain wide delegation for ${mailbox} does not include ` +
    `${GMAIL_SEND_SCOPE}, so this mailbox cannot send mail. Reads still work — ` +
    'ask a Workspace admin to add the send scope alongside the read one.'
  );
}

// ── The client ──────────────────────────────────────────────────────────────

/**
 * Gmail for ONE mailbox.
 *
 * `baseUrl` is the dev loop's redirect at fake-channels (googleapis resolves
 * request paths against the rootUrl ORIGIN, so the fake serves `/gmail/v1/*`
 * from its root). It also decides the auth: a fake needs no bearer token, and
 * minting one would mean impersonating a mailbox that does not exist against a
 * Google that was never asked — so the redirected client authenticates with a
 * stub key and never leaves the machine.
 */
export class GmailApiClient {
  /** Scoped to `gmail.readonly` — every call except the send. */
  private readonly readApi: gmail_v1.Gmail;
  /** Scoped to `gmail.send` — the send call ONLY, so it never depends on the
   *  read scope having been granted, nor grants read access itself. */
  private readonly sendApi: gmail_v1.Gmail;

  constructor(readonly credentials: GmailCredentials) {
    const fake = credentials.baseUrl;
    this.readApi = GmailApiClient.buildApi(credentials, fake, GMAIL_READ_SCOPES);
    this.sendApi = GmailApiClient.buildApi(credentials, fake, GMAIL_SEND_SCOPES);
  }

  private static buildApi(
    credentials: GmailCredentials,
    fake: string | undefined,
    scopes: readonly string[],
  ): gmail_v1.Gmail {
    return google.gmail({
      version: 'v1',
      auth: fake ? 'dev-loop-gmail-key' : delegatedGoogleAuth({ subject: credentials.mailbox, scopes }),
      ...(fake ? { rootUrl: fake } : {}),
    });
  }

  private async call<T>(
    operation: string,
    schema: z.ZodType<T>,
    run: () => Promise<{ data: unknown }>,
  ): Promise<T> {
    let payload: unknown;
    try {
      payload = (await run()).data;
    } catch (err) {
      throw classifyGmailError(err, operation);
    }
    return schema.parse(payload);
  }

  /** The mailbox's own profile — the connect-time proof that the delegation
   *  works AND the source of the first poll's change marker. */
  async getProfile(): Promise<GmailProfile> {
    return this.call('users.getProfile', gmailProfileSchema, () =>
      this.readApi.users.getProfile({ userId: SELF }),
    );
  }

  /** One page of message ids matching a Gmail search query. */
  async listMessages(input: {
    query?: string;
    labelIds?: readonly string[];
    maxResults?: number;
    pageToken?: string;
  }): Promise<{ messages: GmailMessageRef[]; nextPageToken?: string }> {
    const page = await this.call('users.messages.list', messageListSchema, () =>
      this.readApi.users.messages.list({
        userId: SELF,
        ...(input.query !== undefined ? { q: input.query } : {}),
        ...(input.labelIds !== undefined ? { labelIds: [...input.labelIds] } : {}),
        ...(input.maxResults !== undefined
          ? { maxResults: Math.min(input.maxResults, GMAIL_MAX_PAGE) }
          : {}),
        ...(input.pageToken !== undefined ? { pageToken: input.pageToken } : {}),
      }),
    );
    return {
      messages: page.messages ?? [],
      ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}),
    };
  }

  /** One message, with its MIME tree. */
  async getMessage(id: string): Promise<GmailMessage> {
    return this.call('users.messages.get', gmailMessageSchema, () =>
      this.readApi.users.messages.get({ userId: SELF, id, format: 'full' }),
    );
  }

  /** One message as the raw RFC 822 bytes, base64url — what a forward or an
   *  archive wants, and what the fake serves under `format=raw`. */
  async getRawMessage(id: string): Promise<GmailMessage> {
    return this.call('users.messages.get(raw)', gmailMessageSchema, () =>
      this.readApi.users.messages.get({ userId: SELF, id, format: 'raw' }),
    );
  }

  /**
   * The messages added to a label since a change marker.
   *
   * Throws `history_expired` when Gmail has dropped the marker — about a week
   * of inactivity is enough — which the poll answers by resyncing from the last
   * seen time rather than failing forever.
   */
  async listHistory(input: {
    startHistoryId: string;
    labelId?: string;
    pageToken?: string;
  }): Promise<{ added: GmailMessageRef[]; nextPageToken?: string; historyId?: string }> {
    const page = await this.call('history.list', historyListSchema, () =>
      this.readApi.users.history.list({
        userId: SELF,
        startHistoryId: input.startHistoryId,
        historyTypes: ['messageAdded'],
        ...(input.labelId !== undefined ? { labelId: input.labelId } : {}),
        ...(input.pageToken !== undefined ? { pageToken: input.pageToken } : {}),
      }),
    );
    const added: GmailMessageRef[] = [];
    for (const record of page.history ?? []) {
      for (const entry of record.messagesAdded ?? []) {
        if (entry.message) added.push(entry.message);
      }
    }
    return {
      added,
      ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}),
      ...(page.historyId ? { historyId: page.historyId } : {}),
    };
  }

  /**
   * Send a message as the connected mailbox.
   *
   * The whole message travels as one base64url RFC 2822 blob (`compose.ts`
   * builds it) — Gmail has no field-by-field send. `threadId` is the ONE thing
   * beside the bytes that Gmail decides on: given one, it files the message in
   * that conversation, which is what makes a reply a reply on Gmail's side
   * rather than only in the headers.
   */
  async sendMessage(input: { raw: string; threadId?: string }): Promise<GmailSentMessage> {
    return this.call('users.messages.send', sentMessageSchema, () =>
      this.sendApi.users.messages.send({
        userId: SELF,
        requestBody: {
          raw: input.raw,
          ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
        },
      }),
    );
  }

  /** One attachment's bytes, base64url. Fetched on demand: Gmail serves them
   *  separately from the message, so a movement that never reads a file never
   *  pays for one. */
  async getAttachment(input: { messageId: string; attachmentId: string }): Promise<Buffer> {
    const part = await this.call('users.messages.attachments.get', attachmentSchema, () =>
      this.readApi.users.messages.attachments.get({
        userId: SELF,
        messageId: input.messageId,
        id: input.attachmentId,
      }),
    );
    return Buffer.from(part.data ?? '', 'base64url');
  }
}

// ── Connect-time validation ─────────────────────────────────────────────────

/** What the connect form tells the user when the mailbox will not answer. */
export const GMAIL_DELEGATION_MESSAGE =
  'Google refused to act as this mailbox. A Workspace admin has to grant this ' +
  'deployment domain wide delegation for the Gmail read and send scopes before ' +
  'any mailbox can be connected.';

export const GMAIL_NO_MAILBOX_MESSAGE =
  'That address is not a mailbox in your Google Workspace. Use a real user or ' +
  'shared mailbox — a group address has no inbox to read.';

export const GMAIL_UNCONFIGURED_MESSAGE =
  'This server has no Google service account configured, so it cannot act as a ' +
  'mailbox at all.';

/** The env var naming this installation's ONE authority over which mailboxes
 *  the Gmail connector may touch. */
const ALLOWLIST_VAR = 'GMAIL_MAILBOX_ALLOWLIST';

/**
 * The ONE check every enforcement site shares: connect-time validation, the
 * in-app modal's save path, and the delegated client built at use time
 * (`resolveGmailClient`). Google's own delegation has no per-mailbox limit —
 * this installation's list is the whole of it — so all three read the same
 * verdict rather than each re-deriving it.
 */
export function checkGmailMailboxAllowed(
  mailbox: string,
  env: NodeJS.ProcessEnv = process.env,
): { ok: true } | { ok: false; message: string } {
  const allowlist = gmailMailboxAllowlist(env);
  if (allowlist.has(mailbox.trim().toLowerCase())) return { ok: true };
  if (allowlist.size === 0) {
    return {
      ok: false,
      message:
        `${ALLOWLIST_VAR} is not set, so this installation cannot connect or use ` +
        'any Gmail mailbox. Set it to a comma separated list of the addresses ' +
        'automations may act as, for example ops@example.com,deals@example.com.',
    };
  }
  return {
    ok: false,
    message: `${mailbox} is not on this installation's ${ALLOWLIST_VAR}. Add it there before connecting or using this mailbox.`,
  };
}

/**
 * Prove a mailbox before storing it. First the allowlist — a mailbox this
 * installation has not named is refused before anything asks Google — then
 * one call as the mailbox: either Google refuses the impersonation, or it
 * does not and Gmail says whether the address owns an inbox. Anything else is
 * reported as itself rather than guessed at.
 */
export async function validateGmailMailbox(
  credentials: GmailCredentials,
): Promise<{ ok: true; profile: GmailProfile } | { ok: false; message: string }> {
  const allowed = checkGmailMailboxAllowed(credentials.mailbox);
  if (!allowed.ok) return allowed;
  if (credentials.baseUrl === undefined && !isGoogleServiceAccountConfigured()) {
    return { ok: false, message: GMAIL_UNCONFIGURED_MESSAGE };
  }
  try {
    const profile = await new GmailApiClient(credentials).getProfile();
    return { ok: true, profile };
  } catch (err) {
    const failure = classifyGmailError(err, 'users.getProfile');
    switch (failure.failure) {
      case 'delegation':
        return { ok: false, message: GMAIL_DELEGATION_MESSAGE };
      case 'no_such_mailbox':
        return { ok: false, message: GMAIL_NO_MAILBOX_MESSAGE };
      // `users.getProfile` only ever asks for the readonly scope, so a
      // send-scope failure can never actually classify this way — kept
      // explicit rather than folded into `other` so the switch stays
      // exhaustive against `GmailFailure` without an `as`.
      case 'missing_send_scope':
      case 'history_expired':
      case 'other':
        return { ok: false, message: `Google could not be reached: ${failure.message}` };
      default:
        return { ok: false, message: String(neverAsAny(failure.failure)) };
    }
  }
}

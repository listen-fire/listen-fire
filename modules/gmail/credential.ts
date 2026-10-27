// The credential Gmail declares, and how its fields become a client.
//
// The fields a host hands the module, whichever way the mailbox was
// connected:
//
//   access_token       the token for the read scope (a sign-in's one token)
//   mailbox            the address the mailbox is
//   method             `oauth` (absent) or `delegated`
//   granted_scopes     a sign-in's granted scopes, space separated; absent
//                      means the ones the declaration asks for
//   send_access_token  delegated only: the token for the send scope
//   send_refusal       delegated only: why the host holds no send token
//   compose_access_token, compose_refusal
//                      the same pair for the compose scope (drafts), on the
//                      `gmail_drafts` credential only
//
// Drafts are opted into by WHICH credential the mailbox is signed in under:
// `gmail` asks for read and send, `gmail_drafts` for compose too. A host that
// asks for scopes of its own says what was granted in `granted_scopes`.
//
// The host keeps the tokens fresh. A sign-in is refreshed by the standard
// grant over Google's endpoints (or by the platform's own Gmail client); a
// delegated mailbox has no refresh token at all — its host mints both tokens
// with the service account it holds, and the module never sees that key.
// Which mailboxes a host will hand over at all (its allowlist) is the host's
// policy, enforced before the credential reaches the module.

import type { WireCredentialDeclarationShape } from 'engine-contracts';
import type { CredentialFields, ModuleContext } from 'module-kit';
import type { OAuth2Declaration } from 'movement-engine/public/secrets';

import { GOOGLE_OAUTH2_ENDPOINTS, GOOGLE_OFFLINE_CONSENT } from '@listen-fire/google-sheets/google_oauth';

import { GMAIL_CONNECT_METHODS, GMAIL_DRAFTS_SCOPES, GMAIL_SCOPES, GmailApiClient, GmailApiError, type GmailConnectMethod, type GmailScope } from './api_client';
import type { GmailClientSource } from './adapter';

/** How a mailbox is signed into: Google's endpoints, read and send, the
 *  client in the form body, with PKCE and offline consent. */
export const GMAIL_OAUTH2: OAuth2Declaration = {
  ...GOOGLE_OAUTH2_ENDPOINTS,
  scopes: [...GMAIL_SCOPES],
  clientAuth: 'body',
  pkce: true,
  authorizeParams: { ...GOOGLE_OFFLINE_CONSENT },
};

const GMAIL_FIELDS = [
  { name: 'mailbox', label: 'Mailbox', secret: false },
  { name: 'method', label: 'Connected by', secret: false, optional: true },
  { name: 'granted_scopes', label: 'Granted scopes', secret: false, optional: true },
  { name: 'send_access_token', label: 'Send token', optional: true },
  { name: 'send_refusal', label: 'Why sending is refused', secret: false, optional: true },
];

export const GMAIL_CREDENTIAL: WireCredentialDeclarationShape = {
  name: 'gmail',
  kind: 'oauth2',
  fields: GMAIL_FIELDS,
  oauth2: GMAIL_OAUTH2,
};

/** The same mailbox, signed in with drafts enabled: the one declaration that
 *  asks for the compose scope. */
export const GMAIL_DRAFTS_CREDENTIAL: WireCredentialDeclarationShape = {
  name: 'gmail_drafts',
  kind: 'oauth2',
  fields: [
    ...GMAIL_FIELDS,
    { name: 'compose_access_token', label: 'Drafts token', optional: true },
    { name: 'compose_refusal', label: 'Why drafts are refused', secret: false, optional: true },
  ],
  oauth2: { ...GMAIL_OAUTH2, scopes: [...GMAIL_DRAFTS_SCOPES] },
};

/** The credential a mailbox was signed in under. */
export type GmailCredentialName = 'gmail' | 'gmail_drafts';

/** The scopes a sign-in under each credential asked for: what it holds when
 *  the host does not say what was granted. */
const ASKED: Record<GmailCredentialName, readonly string[]> = {
  gmail: GMAIL_SCOPES,
  gmail_drafts: GMAIL_DRAFTS_SCOPES,
};

const isMethod = (value: string): value is GmailConnectMethod => GMAIL_CONNECT_METHODS.some((method) => method === value);

/** A client for the mailbox the fields name, signed in under `declared`
 *  (default `gmail`). */
export function gmailClientFromFields(
  fields: CredentialFields,
  host: { fetch: typeof fetch; baseUrl?: string; declared?: GmailCredentialName },
): GmailApiClient {
  const declared = host.declared ?? 'gmail';
  const readToken = fields.access_token;
  const mailbox = fields.mailbox;
  if (readToken === undefined || readToken === '' || mailbox === undefined || mailbox === '') {
    throw new Error('GmailAdapter: the connected credential names no mailbox or holds no access token. Connect Gmail.');
  }
  const rawMethod = fields.method ?? 'oauth';
  if (!isMethod(rawMethod)) {
    throw new Error(`GmailAdapter: the credential says it was connected by '${rawMethod}', which is not ${GMAIL_CONNECT_METHODS.join(' or ')}.`);
  }
  const method = rawMethod;
  // A sign-in has one token for every scope it holds; a delegated host mints
  // one per scope, and says why when it could not.
  const scoped = (token: string | undefined, refusal: () => GmailApiError): string => {
    if (method === 'oauth') return readToken;
    if (token === undefined || token === '') throw refusal();
    return token;
  };
  const accessToken = async (scope: GmailScope): Promise<string> => {
    switch (scope) {
      case 'read':
        return readToken;
      case 'send':
        return scoped(fields.send_access_token, () => new GmailApiError('missing_send_scope', undefined, 'users.messages.send', fields.send_refusal ?? 'the host holds no token for the send scope'));
      case 'compose':
        return scoped(fields.compose_access_token, () => new GmailApiError('missing_compose_scope', undefined, 'users.drafts.create', fields.compose_refusal ?? 'the host holds no token for the compose scope'));
      default:
        return unreachable(scope);
    }
  };
  return new GmailApiClient(
    {
      mailbox,
      method,
      ...(method === 'oauth' ? { grantedScopes: fields.granted_scopes !== undefined ? fields.granted_scopes.split(/\s+/).filter((s) => s !== '') : [...ASKED[declared]] } : {}),
    },
    { accessToken, fetch: host.fetch, ...(host.baseUrl !== undefined ? { baseUrl: host.baseUrl } : {}) },
  );
}

function unreachable(value: never): never {
  throw new Error(`GmailAdapter: no token for the scope '${String(value)}'`);
}

const isDeclared = (name: string): name is GmailCredentialName => name === 'gmail' || name === 'gmail_drafts';

/** The client the context's credential reaches the mailbox with. */
export function gmailClientFrom(ctx: Pick<ModuleContext, 'credential' | 'fetch' | 'config'>): GmailClientSource {
  // The client for the fields last read: a host hands back the same fields
  // until the credential changes (a refresh), so one client serves until then.
  let last: { fields: CredentialFields; client: GmailApiClient } | undefined;
  return async () => {
    const fields = await ctx.credential.fields();
    if (last?.fields === fields) return last.client;
    const declared = isDeclared(ctx.credential.name) ? ctx.credential.name : 'gmail';
    const client = gmailClientFromFields(fields, {
      fetch: ctx.fetch,
      declared,
      ...(ctx.config.baseUrlOverride !== undefined ? { baseUrl: ctx.config.baseUrlOverride } : {}),
    });
    last = { fields, client };
    return client;
  };
}

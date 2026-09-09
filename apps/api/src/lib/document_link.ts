import { createHmac, timingSafeEqual } from 'node:crypto';

import { apiBaseUrl } from './api_base_url';
import { getEnvVar } from './utils/environment';

/**
 * The public document route serves BYTES, and its only input is a document id.
 * A uuid is not an authorisation: the loader behind it reads across tenants, so
 * anyone holding (or guessing) an id used to read any team's document. The URL
 * itself is now the capability — a link nobody can mint without the server's
 * secret — and the signature is what the route checks instead of a tenant.
 *
 * EXPIRY IS MECHANISM, NOT POLICY, and the pipeline's policy is NO expiry.
 * These URLs get written into third-party CRM fields and Slack messages, where
 * they outlive the run that wrote them by months; an expiry would turn every
 * one of them into a dead link long after anyone could connect the failure to
 * this decision — silent degradation, the ST-9 class of failure. The capability
 * is bounded by the document's EXISTENCE, not by a clock: revocation is
 * deleting the document. `expiresAt` exists so a future caller that genuinely
 * wants a short-lived link (a one-off share, a preview handed to a browser) can
 * ask for one; nothing today does.
 */
function linkSecret(): string {
  // Read lazily, per call: a deployment that never serves a document must still
  // boot, so this cannot throw at module load the way a top-level read would.
  return getEnvVar('DOCUMENT_LINK_SECRET', {
    devDefault: 'dev-document-link-secret',
    because:
      'it signs the public document links this deployment hands to the outside ' +
      'world (CRM fields, chat messages) — the signature is the ONLY thing ' +
      'authorising a download, so a guessable value is an open door to every ' +
      "team's documents",
  });
}

function signature(documentId: string, exp: number | undefined): string {
  return createHmac('sha256', linkSecret())
    .update(`${documentId}.${exp ?? ''}`)
    .digest('base64url');
}

/** The absolute, signed URL for a document's bytes. */
function signDocumentUrl(documentId: string, opts?: { expiresAt?: Date }): string {
  const exp = opts?.expiresAt ? Math.floor(opts.expiresAt.getTime() / 1000) : undefined;

  const url = new URL(`/api/public/document/${documentId}/data`, apiBaseUrl());
  url.searchParams.set('sig', signature(documentId, exp));
  if (exp !== undefined) url.searchParams.set('exp', String(exp));
  return url.toString();
}

/**
 * Whether `sig` was minted by this deployment for `documentId` (and has not
 * expired, when the link carried a TTL). A missing, malformed or stale
 * signature is simply `false` — the route answers 404 either way, so a probe
 * cannot tell a refusal from a document that does not exist.
 */
function verifyDocumentSignature({
  documentId,
  sig,
  exp,
}: {
  documentId: string;
  sig: string | undefined;
  exp?: string | undefined;
}): boolean {
  if (!sig) return false;

  let expiry: number | undefined;
  if (exp !== undefined) {
    expiry = Number(exp);
    if (!Number.isInteger(expiry)) return false;
    if (expiry * 1000 < Date.now()) return false;
  }

  const expected = Buffer.from(signature(documentId, expiry), 'utf-8');
  const presented = Buffer.from(sig, 'utf-8');
  if (expected.length !== presented.length) return false;
  return timingSafeEqual(expected, presented);
}

export { signDocumentUrl, verifyDocumentSignature };

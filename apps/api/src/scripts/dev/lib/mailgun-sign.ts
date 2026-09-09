/**
 * Compute the Mailgun webhook HMAC signature for a synthetic payload.
 *
 * Mirrors the verification logic in
 * `apps/api/src/adapters/pipeline/inbound/mailgun.adapter.ts:verifyMailgunValues`
 * (and the equivalent in `lib/middleware/authentication/mailgun.ts`):
 *
 *     hmacSignature = HMAC-SHA256(apiKey, timestamp + token)
 *
 * Pure function — exported separately from the CLI wrapper so it can be
 * unit-tested against the verifier without spinning up an HTTP server.
 */
import { createHmac, randomBytes } from 'node:crypto';

interface MailgunSignatureInputs {
  apiKey: string;
  /** Unix seconds. Defaults to the current time. */
  timestamp?: string;
  /** Opaque per-request nonce. Defaults to a random hex string. */
  token?: string;
}

interface MailgunSignature {
  timestamp: string;
  token: string;
  signature: string;
}

function signMailgunPayload({
  apiKey,
  timestamp,
  token,
}: MailgunSignatureInputs): MailgunSignature {
  const ts = timestamp ?? Math.floor(Date.now() / 1000).toString();
  const tok = token ?? randomBytes(16).toString('hex');
  const signature = createHmac('sha256', apiKey)
    .update(ts + tok)
    .digest('hex');
  return { timestamp: ts, token: tok, signature };
}

export { signMailgunPayload, type MailgunSignature, type MailgunSignatureInputs };

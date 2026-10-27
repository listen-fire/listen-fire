// How a connection's deliveries are signed, read off its credential, and the
// check of one request against it. The credential holds the scheme and the
// secret; the program never sees either.
//
// - `stripe`: the `Stripe-Signature` header, `t=<unix seconds>,v1=<hex>`, a
//   hex HMAC-SHA256 of `<t>.<body>` keyed by the whole signing secret
//   (`whsec_…`). A `t` older than the tolerance is refused, so a captured
//   delivery cannot be replayed later. Its event id (`id`) names the delivery.
// - `hmac-sha256`: a header the credential names carries the HMAC-SHA256 of
//   the exact body, hex or base64 (an optional `sha256=` prefix is read).
// - `none`: unsigned, accepted as it comes. A choice written down in the
//   credential, never a default.
//
// A sender retries a delivery, so the same event must run once: `idField`, a
// top-level body field the credential names, is the sender's id for the
// delivery (`stripe` always uses `id`). Without it nothing is deduplicated.

import { createHmac, timingSafeEqual } from 'node:crypto';

export const SCHEMES = ['stripe', 'hmac-sha256', 'none'] as const;
export type SchemeName = (typeof SCHEMES)[number];

/** A Stripe event's id, the same on every retry. */
export const STRIPE_ID_FIELD = 'id';
export const STRIPE_SIGNATURE_HEADER = 'stripe-signature';
/** Stripe's own default tolerance. */
export const STRIPE_TOLERANCE_SECONDS = 5 * 60;

export type Signing = (
  | { scheme: 'stripe'; secret: string; toleranceSeconds: number }
  | { scheme: 'hmac-sha256'; secret: string; header: string; encoding: 'hex' | 'base64' }
  | { scheme: 'none' }
) & {
  /** The top-level body field holding the sender's id for a delivery. */
  idField?: string;
};

function isScheme(value: string): value is SchemeName {
  return (SCHEMES as readonly string[]).includes(value);
}

/** The connection's signing, or why its credential does not say one. */
export function signingOf(name: string, fields: Readonly<Record<string, string | undefined>>): Signing {
  const scheme = (fields['scheme'] ?? '').trim();
  if (!isScheme(scheme)) {
    const wrote = scheme === '' ? 'names no scheme' : `names the scheme "${scheme}"`;
    throw new Error(`the webhook credential ${name} ${wrote}: it is one of ${SCHEMES.join(', ')} (lf credential add --module webhook ${name})`);
  }
  const secret = (fields['secret'] ?? '').trim();
  const needsSecret = () => {
    if (secret === '') throw new Error(`the webhook credential ${name} is signed with ${scheme} but holds no secret: set its "secret"`);
    return secret;
  };
  const named = (fields['idField'] ?? '').trim();
  const idField = named === '' ? undefined : named;
  switch (scheme) {
    case 'none':
      return { scheme, ...(idField !== undefined ? { idField } : {}) };
    case 'stripe':
      return { scheme, secret: needsSecret(), toleranceSeconds: STRIPE_TOLERANCE_SECONDS, idField: STRIPE_ID_FIELD };
    case 'hmac-sha256': {
      const header = (fields['header'] ?? '').trim().toLowerCase();
      if (header === '') throw new Error(`the webhook credential ${name} is signed with hmac-sha256 but names no header: set its "header" (e.g. x-signature)`);
      const encoding = (fields['encoding'] ?? '').trim().toLowerCase() || 'hex';
      if (encoding !== 'hex' && encoding !== 'base64') {
        throw new Error(`the webhook credential ${name} names the encoding "${encoding}": it is hex or base64`);
      }
      return { scheme, secret: needsSecret(), header, encoding, ...(idField !== undefined ? { idField } : {}) };
    }
    default: {
      const unknown: never = scheme;
      throw new Error(`unknown scheme ${String(unknown)}`);
    }
  }
}

/** What a check reads of a request. */
export interface Signed {
  header(name: string): string | undefined;
  bytes: Buffer;
}

export type Verdict = { ok: true } | { ok: false; reason: string };

const REFUSED = (reason: string): Verdict => ({ ok: false, reason });

function sameBytes(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

function hmac(secret: string, data: Buffer): Buffer {
  return createHmac('sha256', secret).update(data).digest();
}

function verifyStripe(signing: Extract<Signing, { scheme: 'stripe' }>, request: Signed, nowSeconds: number): Verdict {
  const header = request.header(STRIPE_SIGNATURE_HEADER);
  if (header === undefined || header.trim() === '') return REFUSED(`no ${STRIPE_SIGNATURE_HEADER} header`);
  const parts = header.split(',').map((part) => part.trim().split('=', 2) as [string, string | undefined]);
  const timestamp = parts.find(([key]) => key === 't')?.[1];
  const signatures = parts.filter(([key, value]) => key === 'v1' && value !== undefined).map(([, value]) => value as string);
  if (timestamp === undefined || !/^\d+$/.test(timestamp) || signatures.length === 0) return REFUSED(`the ${STRIPE_SIGNATURE_HEADER} header has no t= and v1=`);
  const expected = hmac(signing.secret, Buffer.concat([Buffer.from(`${timestamp}.`, 'utf-8'), request.bytes]));
  if (!signatures.some((signature) => /^[0-9a-f]+$/i.test(signature) && sameBytes(expected, Buffer.from(signature, 'hex')))) {
    return REFUSED('the signature does not match the secret');
  }
  if (nowSeconds - Number(timestamp) > signing.toleranceSeconds) {
    return REFUSED(`the signature is older than ${signing.toleranceSeconds} seconds`);
  }
  return { ok: true };
}

function verifyHmac(signing: Extract<Signing, { scheme: 'hmac-sha256' }>, request: Signed): Verdict {
  const presented = request.header(signing.header)?.trim().replace(/^sha256=/i, '');
  if (presented === undefined || presented === '') return REFUSED(`no ${signing.header} header`);
  const decoded = signing.encoding === 'hex' ? (/^[0-9a-f]+$/i.test(presented) ? Buffer.from(presented, 'hex') : Buffer.alloc(0)) : Buffer.from(presented, 'base64');
  return sameBytes(hmac(signing.secret, request.bytes), decoded) ? { ok: true } : REFUSED('the signature does not match the secret');
}

/** One request against the connection's signing. */
export function verify(signing: Signing, request: Signed, nowSeconds: number): Verdict {
  switch (signing.scheme) {
    case 'none':
      return { ok: true };
    case 'stripe':
      return verifyStripe(signing, request, nowSeconds);
    case 'hmac-sha256':
      return verifyHmac(signing, request);
    default: {
      const unknown: never = signing;
      return REFUSED(`unknown scheme ${String(unknown)}`);
    }
  }
}

/** Stripe's header for `body` at `timestamp`: what a test (or a sender) signs with. */
export function stripeSignature(secret: string, body: string, timestamp: number): string {
  return `t=${timestamp},v1=${hmac(secret, Buffer.from(`${timestamp}.${body}`, 'utf-8')).toString('hex')}`;
}

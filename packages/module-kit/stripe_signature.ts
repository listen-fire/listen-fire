// Stripe's webhook signature, checked once for every module that takes
// Stripe's deliveries (`@lf/webhook`'s `stripe` scheme, `@lf/stripe`).
//
// The `Stripe-Signature` header is `t=<unix seconds>,v1=<hex>[,v1=<hex>…]`:
// each `v1` a hex HMAC-SHA256 of `<t>.<body>` keyed by the endpoint's whole
// signing secret (`whsec_…`). Stripe sends one `v1` per live secret while one
// is being rolled, so any match is enough. A `t` older than the tolerance is
// refused, so a captured delivery cannot be replayed later.

import { createHmac, timingSafeEqual } from 'node:crypto';

export const STRIPE_SIGNATURE_HEADER = 'stripe-signature';
/** Stripe's own default tolerance. */
export const STRIPE_TOLERANCE_SECONDS = 5 * 60;

/** What a signature check reads of a request. */
export interface SignedRequest {
  header(name: string): string | undefined;
  bytes: Buffer;
}

export type SignatureVerdict = { ok: true } | { ok: false; reason: string };

const REFUSED = (reason: string): SignatureVerdict => ({ ok: false, reason });

function hmac(secret: string, data: Buffer): Buffer {
  return createHmac('sha256', secret).update(data).digest();
}

/** One request against an endpoint's signing secret, at `nowSeconds`. */
export function verifyStripeSignature(
  request: SignedRequest,
  options: { secret: string; nowSeconds: number; toleranceSeconds?: number },
): SignatureVerdict {
  const tolerance = options.toleranceSeconds ?? STRIPE_TOLERANCE_SECONDS;
  const header = request.header(STRIPE_SIGNATURE_HEADER);
  if (header === undefined || header.trim() === '') return REFUSED(`no ${STRIPE_SIGNATURE_HEADER} header`);
  const parts = header.split(',').map((part) => {
    const [key, value] = part.trim().split('=', 2);
    return { key, value };
  });
  const timestamp = parts.find((part) => part.key === 't')?.value;
  const signatures = parts.flatMap((part) => (part.key === 'v1' && part.value !== undefined ? [part.value] : []));
  if (timestamp === undefined || !/^\d+$/.test(timestamp) || signatures.length === 0) return REFUSED(`the ${STRIPE_SIGNATURE_HEADER} header has no t= and v1=`);
  const expected = hmac(options.secret, Buffer.concat([Buffer.from(`${timestamp}.`, 'utf-8'), request.bytes]));
  const matches = (signature: string) => {
    const presented = /^[0-9a-f]+$/i.test(signature) ? Buffer.from(signature, 'hex') : Buffer.alloc(0);
    return presented.length === expected.length && timingSafeEqual(expected, presented);
  };
  if (!signatures.some(matches)) return REFUSED('the signature does not match the secret');
  if (options.nowSeconds - Number(timestamp) > tolerance) return REFUSED(`the signature is older than ${tolerance} seconds`);
  return { ok: true };
}

/** Stripe's header for `body` at `timestamp`: what a test (or a sender) signs with. */
export function stripeSignature(secret: string, body: string, timestamp: number): string {
  return `t=${timestamp},v1=${hmac(secret, Buffer.from(`${timestamp}.${body}`, 'utf-8')).toString('hex')}`;
}

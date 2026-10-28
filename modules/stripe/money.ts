// Stripe's amounts are integers in the currency's minor unit; a program sees
// them in major units, so `Currency.formatFigure(i.`Amount Due`, i.Currency)`
// is right for every currency without a program knowing which divide by what.
//
// The exponent is Stripe's, not ISO 4217's (Stripe's "Supported currencies"
// page): zero-decimal currencies are given as is, three-decimal ones in
// thousandths, everything else in hundredths. ISK and UGX are Stripe's special
// cases: zero-decimal in fact, but given as two-decimal values for backward
// compatibility (5 ISK is `500`), so they divide by 100 like the rest. HUF and
// TWD are two-decimal for charges.

/** Given as is: `500` JPY is ¥500. Stripe's zero-decimal list less UGX, which
 *  its special cases say is sent as a two-decimal value. */
export const ZERO_DECIMAL_CURRENCIES = ['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'vnd', 'vuv', 'xaf', 'xof', 'xpf'] as const;

/** Given in thousandths: `5120` KWD is 5.120 KWD. */
export const THREE_DECIMAL_CURRENCIES = ['bhd', 'jod', 'kwd', 'omr', 'tnd'] as const;

const ZERO = new Set<string>(ZERO_DECIMAL_CURRENCIES);
const THREE = new Set<string>(THREE_DECIMAL_CURRENCIES);

/** How many digits of an amount in `currency` are below its major unit. */
export function minorDigits(currency: string): 0 | 2 | 3 {
  const code = currency.trim().toLowerCase();
  if (ZERO.has(code)) return 0;
  if (THREE.has(code)) return 3;
  return 2;
}

/** An amount Stripe sent in `currency`'s minor unit, in major units. Null
 *  stays null, and so does a non-zero amount with no currency to read it by
 *  (a customer's balance before it has a currency is 0). */
export function majorUnits(amount: number | null | undefined, currency: string | null | undefined): number | null {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return null;
  if (typeof currency !== 'string' || currency === '') return amount === 0 ? 0 : null;
  const digits = minorDigits(currency);
  // Divide by a power of ten, then round to its digits: 1999 / 100 is the
  // closest double to 19.99 already, and the rounding keeps it so.
  return digits === 0 ? amount : Number((amount / 10 ** digits).toFixed(digits));
}

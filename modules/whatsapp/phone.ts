// WhatsApp phone normalization, shared by every place the module reads a
// sender's number, so one number is spelled one way. `normalizeWhatsappPhone`
// strips only the `whatsapp:` transport prefix and surrounding whitespace and
// leaves the number's internal characters alone; `whatsappE164` builds the
// `Sender Phone` claim from it.

export function normalizeWhatsappPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const stripped = raw.trim().replace(/^whatsapp:/i, '').trim();
  return stripped.length > 0 ? stripped : null;
}

/**
 * A sender's number as the `claim:phone/e164` the module vouches for: a plus,
 * then the country code and the subscriber digits (`+447700900123`). None for
 * a number that is not one in that form, so a malformed `From` is no claim
 * rather than a wrong one.
 */
export function whatsappE164(raw: string | null | undefined): string | null {
  const stripped = normalizeWhatsappPhone(raw)?.replace(/[\s().-]/g, '').replace(/^\+/, '');
  return stripped !== undefined && /^[1-9]\d{6,14}$/.test(stripped) ? `+${stripped}` : null;
}

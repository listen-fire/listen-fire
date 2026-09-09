// Inbound gate: which code path a WhatsApp message is allowed to take, decided
// purely by which of our numbers received it.
//
// Once a movements number is configured the two numbers HARD-partition — the
// movements number reaches movements only, the primary number reaches the
// legacy pipeline only, and neither can cross into the other. Before a
// movements number is configured (the dev loop, or prod before the cutover) the
// single primary number keeps its original movement-first-then-legacy
// behaviour, so nothing partitions until a second number actually exists.

export type WhatsappInboundRoute = 'movement-only' | 'legacy-only' | 'movement-then-legacy';

export function resolveWhatsappRoute(input: {
  /** The Meta `phone_number_id` this message was received on (undefined for an
   *  old position or a bare primary-door delivery). */
  businessPhoneNumberId: string | undefined;
  /** The configured movements number's `phone_number_id`, or null when none. */
  movementsPhoneNumberId: string | null;
}): WhatsappInboundRoute {
  const { businessPhoneNumberId, movementsPhoneNumberId } = input;
  if (movementsPhoneNumberId == null) return 'movement-then-legacy';
  return businessPhoneNumberId === movementsPhoneNumberId ? 'movement-only' : 'legacy-only';
}

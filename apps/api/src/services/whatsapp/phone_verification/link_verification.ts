// How THIS deployment decides that a WhatsApp number belongs to the person
// claiming it. Inbound routing only trusts a verified link, so this setting is
// the whole of what stands between a claimed number and its messages.
//
//   otp (the default) — the number is sent a one-time code over WhatsApp and
//     the link is verified only when that code comes back. Proof of possession.
//   trust — a signed-in user's claim is verified on the spot: no template, no
//     code. Anyone with an account can claim any number, so it only suits a
//     deployment whose accounts are all one organisation's.

export const WHATSAPP_LINK_VERIFICATION_MODES = ['otp', 'trust'] as const;
export type WhatsappLinkVerification = (typeof WHATSAPP_LINK_VERIFICATION_MODES)[number];

const MODE_VAR = 'WHATSAPP_LINK_VERIFICATION';

function isLinkVerification(value: string): value is WhatsappLinkVerification {
  return WHATSAPP_LINK_VERIFICATION_MODES.some((mode) => mode === value);
}

/**
 * This deployment's WhatsApp link verification. Unset means `otp`.
 *
 * Anything else throws rather than falling back: an operator who typed
 * `WHATSAPP_LINK_VERIFICATION=trusted` meant to skip the code, and silently
 * sending one from a deployment with no OTP template would leave every link
 * stuck with nothing saying why.
 */
export function whatsappLinkVerification(
  env: NodeJS.ProcessEnv = process.env,
): WhatsappLinkVerification {
  const raw = (env[MODE_VAR] ?? '').trim();
  if (raw === '') return 'otp';
  if (isLinkVerification(raw)) return raw;
  throw new Error(
    `${MODE_VAR}='${raw}' is not a WhatsApp link verification mode. Set it to ` +
      `${WHATSAPP_LINK_VERIFICATION_MODES.join(' or ')}, or leave it unset for ` +
      `${WHATSAPP_LINK_VERIFICATION_MODES[0]}.`,
  );
}

/** A number as it may appear in a log line: all but the last three digits
 *  masked, so a log stream never becomes a directory of users' numbers. */
export function maskPhoneNumber(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return `+${'*'.repeat(Math.max(0, digits.length - 3))}${digits.slice(-3)}`;
}

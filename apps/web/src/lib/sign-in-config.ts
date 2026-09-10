// Which sign-in providers this deployment offers, read at RUN time.
//
// These are OAuth client ids, and they used to be `NEXT_PUBLIC_*` — which Next
// inlines at `next build`. A published image therefore carried the release
// build's values (none), and no amount of configuring the container brought the
// Google or Microsoft button back. They now come from the API's
// `/api/public/config`, which serves the very variables it validates tokens
// against, so the button and the door cannot disagree.

interface SignInConfig {
  /** Absent when this deployment has no such client. */
  googleClientId?: string;
  microsoftClientId?: string;
  version?: string;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Anything unrecognised is "no providers", which is the same answer an
 *  unreachable API gives — a login page with email and password on it. */
function parseSignInConfig(body: unknown): SignInConfig {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return {};
  const record = body as Record<string, unknown>;
  return {
    googleClientId: stringOrUndefined(record.googleClientId),
    microsoftClientId: stringOrUndefined(record.microsoftClientId),
    version: stringOrUndefined(record.version),
  };
}

export { type SignInConfig, parseSignInConfig };

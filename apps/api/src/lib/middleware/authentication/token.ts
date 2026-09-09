import { sign, verify, JwtPayload } from 'jsonwebtoken';
import { z } from 'zod';

import { requireEnv } from '../../utils/environment';
import { sessionJwtAudience } from './session_jwt_audience';
import { unauthorisedGetUserByEmail } from './identify_user';

// Read at first USE, not at module load: importing this module (e.g. via the
// movement_engine → principal → token.ts chain) must not force the audience
// / TOKEN_SECRET to exist for units that never touch auth. Still memoized —
// one read, one throw if genuinely missing — and still throws loudly (no
// silent fallback, D30(e)); it just throws on first call instead of on import.
let env: { TOKEN_SECRET: string } | undefined;
const getEnv = () => (env ??= requireEnv('TOKEN_SECRET'));

const generateJWT = (email: string) => {
  const payload = {
    'listen-fire-token/email': email,
  };

  return sign(payload, getEnv().TOKEN_SECRET, {
    algorithm: 'HS256',
    expiresIn: '180d',
    audience: sessionJwtAudience(),
  });
};

/**
 * A SHORT-LIVED token (same `listen-fire-token/email` claim the WS `authorise` reads)
 * for realtime/WebSocket auth. The web client fetches this from a same-origin
 * cookie-authed endpoint and passes it as the `ListenFireToken` subprotocol — so the
 * long-lived session token can stay httpOnly (never exposed to JS).
 */
const generateRealtimeToken = (email: string) =>
  sign({ 'listen-fire-token/email': email }, getEnv().TOKEN_SECRET, {
    algorithm: 'HS256',
    // Session-length so an active WS doesn't drop mid-session; still FAR shorter
    // than the 180d session cookie, and never persisted (fetched fresh per load).
    expiresIn: '12h',
    audience: sessionJwtAudience(),
  });

const generateMagicLinkToken = (
  email: string,
  options: { expiresIn: string } = { expiresIn: '1h' },
) => {
  return sign({ email }, getEnv().TOKEN_SECRET, options);
};

const verifyMagicLinkToken = (token: string) => {
  const verified = verify(token, getEnv().TOKEN_SECRET);

  return z
    .object({
      email: z.string(),
    })
    .parse(verified);
};

const getCookieAuthUser = async (token: string) => {
  const decoded = verify(token, getEnv().TOKEN_SECRET, {
    algorithms: ['HS256'],
    audience: sessionJwtAudience(),
  }) as JwtPayload;

  const email = decoded['listen-fire-token/email'];
  if (typeof email !== 'string') {
    throw new Error('Invalid cookie token: missing email');
  }

  return unauthorisedGetUserByEmail(email);
};

export {
  generateJWT,
  generateRealtimeToken,
  getCookieAuthUser,
  generateMagicLinkToken,
  verifyMagicLinkToken,
};

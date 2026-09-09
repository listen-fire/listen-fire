// The session token a static-identity deployment mints for its own UI.
//
// Core's session cookie names a USER by email and is resolved against the user
// table. A static install has no such table row to resolve — it has one tenant
// — so the claims are the team id and the key that bought the session, both
// verified against the configured tenant. Same secret, same audience, same
// cookie, so nothing downstream of the cookie has to know which of the two
// minted it.
//
// Binding the session to the key is what makes rotation mean something: the
// key is the only credential this deployment has, so replacing it must end
// every session bought with the old one — otherwise a leaked key keeps its
// browsers signed in for 180 days after the operator believes they revoked it.

import { createHash } from 'node:crypto';

import jwt from 'jsonwebtoken';

import { requireEnv } from '../../lib/utils/environment';
import { sessionJwtAudience } from '../../lib/middleware/authentication/session_jwt_audience';

const STATIC_TEAM_CLAIM = 'listen-fire-token/static-team';
const STATIC_KEY_CLAIM = 'listen-fire-token/static-key';

/** The digest, never the key: a session cookie is readable by anything that
 *  gets hold of it, and `secretsMatch` compares over the same sha256. */
function keyDigest(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex');
}

/** The tenant a session belongs to. `apiKey` is optional because an anonymous
 *  install has none — and a session no key could have bought never verifies. */
interface StaticTenant {
  readonly teamId: string;
  readonly apiKey?: string;
}

function mintStaticSessionToken(tenant: { teamId: string; apiKey: string }): string {
  const { TOKEN_SECRET } = requireEnv('TOKEN_SECRET');
  return jwt.sign(
    { [STATIC_TEAM_CLAIM]: tenant.teamId, [STATIC_KEY_CLAIM]: keyDigest(tenant.apiKey) },
    TOKEN_SECRET,
    {
      algorithm: 'HS256',
      expiresIn: '180d',
      audience: sessionJwtAudience(),
    },
  );
}

function verifyStaticSessionToken(token: string, tenant: StaticTenant): boolean {
  if (tenant.apiKey === undefined) return false;
  try {
    const { TOKEN_SECRET } = requireEnv('TOKEN_SECRET');
    const decoded = jwt.verify(token, TOKEN_SECRET, {
      algorithms: ['HS256'],
      audience: sessionJwtAudience(),
    });
    if (typeof decoded === 'string') return false;
    return (
      decoded[STATIC_TEAM_CLAIM] === tenant.teamId &&
      decoded[STATIC_KEY_CLAIM] === keyDigest(tenant.apiKey)
    );
  } catch {
    return false;
  }
}

export { type StaticTenant, mintStaticSessionToken, verifyStaticSessionToken };

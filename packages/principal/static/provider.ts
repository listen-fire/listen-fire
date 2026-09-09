// The static single-tenant PrincipalProvider (core plan §3): one team, one
// secret, no infrastructure. `pinnedTeamId` is always the static team, so every
// "which team?" branch in product code takes the pinned path unchanged.

import { createHash, timingSafeEqual } from 'node:crypto';

import {
  TeamScopeError,
  type Principal,
  type PrincipalProvider,
  type PrincipalRequest,
  type PrincipalResult,
  type TeamRef,
} from '../principal';
import type { StaticIdentityConfig } from './config';

const BEARER = /^Bearer[ \t]+(\S.*)$/i;

/** Compare over digests rather than the raw strings: equal-length buffers keep
 *  `timingSafeEqual` usable without leaking the secret's length. */
function secretsMatch(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function presentedSecret(req: PrincipalRequest): string | undefined {
  const authorization = req.header('authorization');
  if (authorization !== undefined) {
    const match = BEARER.exec(authorization.trim());
    const token = match?.[1]?.trim();
    if (token !== undefined && token !== '') return token;
  }

  const apiKeyHeader = req.header('x-api-key')?.trim();
  return apiKeyHeader !== undefined && apiKeyHeader !== '' ? apiKeyHeader : undefined;
}

/** How the host lets a browser session stand in for the API key. The package
 *  must not know what a session token IS — only how to ask. */
interface StaticSessionOption {
  readonly cookie: string;
  verify(value: string): boolean;
}

interface StaticProviderOptions {
  readonly session?: StaticSessionOption;
}

function createStaticPrincipalProvider(
  config: StaticIdentityConfig,
  options: StaticProviderOptions = {},
): PrincipalProvider {
  const principal: Principal = {
    teamId: config.teamId,
    userId: config.userId,
    access: config.access,
    scopes: config.scopes,
    pinnedTeamId: config.teamId,
    credentialId: 'static',
  };

  const teamRef: TeamRef = {
    teamId: config.teamId,
    name: config.teamName,
    access: config.access,
    // The installation's team, whoever uses it — not one person's workspace.
    isPersonal: false,
  };

  const unauthorised = (message: string): PrincipalResult => ({
    ok: false,
    status: 401,
    message,
    wwwAuthenticate: 'Bearer realm="listen-fire"',
  });

  return {
    async authenticate(req: PrincipalRequest): Promise<PrincipalResult> {
      // A browser cannot hold the API key on every request, so the login route
      // trades it for a cookie this deployment signed. Checked FIRST: a session
      // is the same tenant by construction, and falling through would refuse it
      // for want of a header it will never carry.
      const session = options.session;
      if (session !== undefined) {
        const value = req.cookie(session.cookie);
        if (value !== undefined && value !== '' && session.verify(value)) {
          return { ok: true, principal };
        }
      }

      const presented = presentedSecret(req);

      if (presented === undefined) {
        return config.allowAnonymous
          ? { ok: true, principal }
          : unauthorised('Missing API key: send it as `Authorization: Bearer …` or `x-api-key`.');
      }

      // An anonymous install has no secret to compare against; a presented
      // credential is neither trusted nor rejected, it is simply not the gate.
      if (config.apiKey === undefined) return { ok: true, principal };

      return secretsMatch(presented, config.apiKey)
        ? { ok: true, principal }
        : unauthorised('Invalid API key.');
    },

    async listTeams(): Promise<TeamRef[]> {
      return [teamRef];
    },

    async resolveTeam(_p: Principal, requested?: string): Promise<TeamRef> {
      if (requested !== undefined && requested !== config.teamId) {
        throw new TeamScopeError(
          'This installation serves a single team; remove the `team` argument (or pass that team).',
          [teamRef],
        );
      }
      return teamRef;
    },
  };
}

export {
  createStaticPrincipalProvider,
  secretsMatch,
  type StaticProviderOptions,
  type StaticSessionOption,
};

import { PermissionService } from '../../../services/permission';

/**
 * The single auth-resolution seam: given the authenticated identity and the
 * client-supplied team signals, decide which team the request acts as.
 *
 * Both the REST middleware (`authentication/index.ts`) and the tRPC-WS mirror
 * (`interfaces/trpc/index.ts`) call this so the membership guard lives in one
 * place. The two seams currently trust a client-supplied team with no
 * membership check — this closes that privilege-escalation hole.
 *
 * Resolution rules:
 *  1. Candidate acting team = `apiKey.teamId` (if api-key-authed and non-null)
 *     ?? `xRequestTeamId` (if set) ?? `defaultTeamId`.
 *  2. api_key.team_id is a hard restriction when set: if the key pins a team
 *     AND a request-team header is also supplied AND they differ → reject. The
 *     key may not be escaped via the header.
 *  3. Membership validation: a `team_membership(user_id, candidate)` row must
 *     exist — for EVERY candidate, the default team included. Otherwise reject;
 *     we never silently fall back, because a silently-ignored override hides
 *     bugs.
 *
 * `default_team_id` is a preference — where a person lands when nothing else
 * names a team — and says nothing about whether they may act there (C-6/D20).
 * Honouring it without a membership lookup made removing someone from their
 * home team remove nothing.
 */

export type ActingTeamResolution =
  | { ok: true; teamId: string }
  | { ok: false; status: 401 | 403; message: string };

interface ResolveActingTeamInput {
  userId: string;
  /** The user's preferred landing team (`user.default_team_id`) — the fallback
   *  candidate, membership-checked like any other. */
  defaultTeamId: string;
  /** The team pinned on the api key, when the request is api-key-authed. */
  apiKeyTeamId?: string | null;
  /** The client-supplied `x-request-team-id` / `listen_fire_team_id` override. */
  xRequestTeamId?: string | null;
}

async function resolveActingTeam({
  userId,
  defaultTeamId,
  apiKeyTeamId,
  xRequestTeamId,
}: ResolveActingTeamInput): Promise<ActingTeamResolution> {
  // Rule 2: a key pinned to a team may not be escaped by a divergent header.
  if (apiKeyTeamId && xRequestTeamId && xRequestTeamId !== apiKeyTeamId) {
    return {
      ok: false,
      status: 403,
      message: 'This API key is scoped to a team; the request-team override may not escape it.',
    };
  }

  // Rule 1: candidate = key pin ?? request override ?? default.
  const candidate = apiKeyTeamId ?? xRequestTeamId ?? defaultTeamId;

  // Rule 3: every candidate must be a real membership, the default included.
  const isMember = await PermissionService.hasAccess(userId, candidate);
  if (!isMember) {
    return {
      ok: false,
      status: 403,
      message: 'The requested team is not one you have access to.',
    };
  }

  return { ok: true, teamId: candidate };
}

export { resolveActingTeam };

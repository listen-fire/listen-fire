// Team-scoping for the user-anchored MCP surface, expressed against the
// Principal contract.
//
// These three questions — which teams can this connection act in, which team
// does a team-specific write land in, which set does a spanning read cover —
// ARE `listTeams`/`resolveTeam` (core plan §3), so the decisions live in the
// provider and this file is the REST surface's vocabulary for them. It used to
// carry a second implementation reading the Context and `PermissionService`
// directly; two copies of a team gate is one copy too many, and the copies had
// already drifted (this one reported a pinned key's access as `write` whatever
// the membership said).

import { currentPrincipal, TeamScopeError, type TeamRef } from 'principal';

import { principalProvider } from '../../../services/principal';
import { teamNames } from '../../../services/principal/core_teams';

/** The teams a connection can act in. Structurally the contract's `TeamRef`. */
export type AccessibleTeam = TeamRef;

/** An error a tool handler should surface to the MCP caller (mapped to 400).
 *  Carries the caller's accessible teams when the failure is a team-ambiguity
 *  one, so the agent can recover in a single retry instead of a separate
 *  listTeams round-trip. */
export const ToolTeamError = TeamScopeError;
export type ToolTeamError = TeamScopeError;

export { teamNames };

/**
 * The teams this connection can act in. Pinned → just the pinned team; unpinned
 * → every team the user is a member of. Each entry carries the team name and
 * the membership access level.
 */
export async function listAccessibleTeams(): Promise<AccessibleTeam[]> {
  return principalProvider().listTeams(currentPrincipal());
}

/**
 * Resolve the team a team-specific tool must run as.
 *
 *  - pinned key: always the pinned team. A divergent `requestedTeam` is rejected
 *    (the key may not be escaped).
 *  - unpinned + `requestedTeam`: allowed iff the user is a member of it.
 *  - unpinned + omitted: the user's single accessible team if they have exactly
 *    one; if they have several, refuse with a nudge to `listTeams` + `team` —
 *    never silently place the write in the home team.
 */
export async function resolveToolTeam(requestedTeam?: string): Promise<string> {
  const team = await principalProvider().resolveTeam(currentPrincipal(), requestedTeam);
  return team.teamId;
}

/**
 * The team-id set a spanning read/list tool should cover: pinned → [pin];
 * unpinned → every membership team id (falling back to the acting team when the
 * connection has no membership rows at all).
 */
export async function teamSetForReads(): Promise<string[]> {
  const principal = currentPrincipal();
  const teams = await principalProvider().listTeams(principal);
  if (teams.length === 0) return [principal.teamId];
  return teams.map((team) => team.teamId);
}

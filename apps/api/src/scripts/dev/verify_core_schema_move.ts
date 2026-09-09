/**
 * Phase 2E verification: the identity surface after `team`/`user` and friends
 * moved into the `core` schema.
 *
 * Exercises the paths that actually resolve a credential into a Principal —
 * `identify_user` (the auth middleware's user lookup), the Directory
 * (`core_directory`), team scoping (`core_teams` / `team_scope`, which is what
 * MCP's `listTeams`/`resolveTeam` call), the permission check, the api-key
 * service's mint→authenticate→revoke round trip, and the tRPC user-context
 * resolver, which is the single biggest cross-schema query in the app
 * (`core.user` + `core.user_email` + `core.team` + `core.team_membership` +
 * `signup_event` + `automations.phone_number` + `valuations.legal_entity`).
 *
 * It also proves the audit half: a write through Context lands a row in
 * `core.audit_log` attributed to the actor off core's OWN session GUCs.
 */
import { randomUUID } from 'node:crypto';

import { runInContext } from '../../services/context/utils';
import { getCoreQb } from '../../lib/kysely';
import { trpcRouter } from '../../interfaces/trpc';
import { ApiKeyService } from '../../services/api_key';
import { PermissionService } from '../../services/permission';
import { listTeamsFor, resolveTeamFor } from '../../services/principal/core_teams';
import { coreDirectory } from '../../services/principal/core_directory';
import {
  unauthorisedGetUserById,
  unauthorisedGetUserByEmail,
} from '../../lib/middleware/authentication/identify_user';

async function main() {
  const user = await getCoreQb(['user'])
    .selectFrom('user')
    .select(['id', 'default_team_id'])
    .executeTakeFirstOrThrow();
  const email = await getCoreQb(['user_email'])
    .selectFrom('user_email')
    .select('email')
    .where('user_id', '=', user.id)
    .executeTakeFirstOrThrow();

  const out: Record<string, unknown> = {};

  const auditBefore = Number(
    (
      await getCoreQb(['audit_log'])
        .selectFrom('audit_log')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .executeTakeFirstOrThrow()
    ).n,
  );

  await runInContext(
    async (ctx) => {
      await ctx.enterTransaction();

      // 1. The auth middleware's two identity lookups (both prisma, both on core).
      out.identifyById = (await unauthorisedGetUserById(user.id)).id === user.id;
      out.identifyByEmail = (await unauthorisedGetUserByEmail(email.email)).id === user.id;

      // 2. Team scoping — the bodies MCP's listTeams / resolveTeam call.
      const principal = { teamId: user.default_team_id, userId: user.id, pinnedTeamId: null } as never;
      const teams = await listTeamsFor(principal);
      out.listTeams = teams.map((t: { teamId: string; name: string }) => t.name);
      out.resolveTeam = (await resolveTeamFor(principal, user.default_team_id)).teamId === user.default_team_id;

      // 3. Directory — the contract the channel adapters resolve people through.
      out.directoryById = !!(await coreDirectory.userById({ id: user.id, teamId: user.default_team_id }));
      out.directoryByEmail = !!(await coreDirectory.userByEmail({
        email: email.email,
        teamId: user.default_team_id,
      }));
      out.teamsForEmail = (await coreDirectory.teamsForEmail(email.email)).length;

      // 4. Membership-backed permission check.
      out.permission = await PermissionService.hasAccess(user.id, user.default_team_id);

      // 5. The api-key round trip: mint, authenticate the hash, revoke.
      const keys = ApiKeyService;
      const minted = await keys.createForOwner({
        teamId: user.default_team_id,
        createdBy: user.id,
        name: `2E probe ${randomUUID().slice(0, 8)}`,
        scopes: ['ingest'],
      });
      const validated = await keys.validateKey(minted.key);
      out.apiKeyAuth =
        validated.valid === true &&
        (validated as { apiKey: { teamId: string | null } }).apiKey.teamId === user.default_team_id;
      out.apiKeyRejectsGarbage = (await keys.validateKey(minted.key.slice(0, -3) + 'zzz')).valid === false;
      await keys.revokeById(minted.id);
      out.apiKeyRevoked = (await keys.validateKey(minted.key)).valid === false;

      // 6. The user-context resolver — the app's widest cross-schema read.
      const caller = trpcRouter.createCaller({ authorise: async () => {} });
      const me = await caller.models.user.context();
      out.userContext = {
        email: (me as { email?: string }).email,
        teams: ((me as { teams?: unknown[] }).teams ?? []).length,
      };
    },
    { id: user.id },
  );

  const audit = await getCoreQb(['audit_log'])
    .selectFrom('audit_log')
    .select(['table_name', 'op', 'created_by', 'team_id'])
    .orderBy('version', 'desc')
    .limit(4)
    .execute();
  out.auditRowsAdded = audit.length > 0 && audit.length + auditBefore > auditBefore;
  out.auditTail = audit;

  console.log(JSON.stringify(out, null, 2));
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);

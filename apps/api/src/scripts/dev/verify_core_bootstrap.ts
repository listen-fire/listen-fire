/**
 * Prove core's first-boot provisioning against a real database (D51(d)).
 *
 * Point DATABASE_URL at a SCRATCH database — this script truncates core's
 * identity tables between scenarios:
 *
 *   DATABASE_URL='postgresql://listenfire:localdevpassword@localhost:9432/listenfire_bootstrap_probe' \
 *     pnpm ts-node --project tsconfig.dev.json --transpile-only -r dotenv/config \
 *     src/scripts/dev/verify_core_bootstrap.ts
 */
import { sql } from 'kysely';

import { getCoreQb } from '../../lib/kysely';
import { bootstrapCoreInstall } from '../../startup/core';

const CONFIGURED = {
  LISTEN_FIRE_BOOTSTRAP_TEAM_NAME: 'Probe Co',
  LISTEN_FIRE_BOOTSTRAP_USER_EMAIL: 'Owner@Probe.test',
  PUBLIC_USER_ID: '40087837-1509-4eeb-935d-ce004ca4a5c7',
};

async function emptyCore() {
  await sql`TRUNCATE core.team, core."user", core.user_email, core.team_membership CASCADE`.execute(
    getCoreQb(['team']),
  );
}

async function rows() {
  const teams = await getCoreQb(['team']).selectFrom('team').select(['id', 'name']).execute();
  const users = await getCoreQb(['user'])
    .selectFrom('user')
    .select(['id', 'username', 'granted_access_at', 'default_team_id'])
    .execute();
  const emails = await getCoreQb(['user_email'])
    .selectFrom('user_email')
    .select(['email', 'is_primary'])
    .execute();
  const memberships = await getCoreQb(['team_membership'])
    .selectFrom('team_membership')
    .select(['user_id', 'team_id', 'access'])
    .execute();
  return { teams, users, emails, memberships };
}

async function main() {
  console.warn('\n=== 1. empty database, configured — expect PROVISION ===');
  await emptyCore();
  await bootstrapCoreInstall(CONFIGURED);
  console.warn(JSON.stringify(await rows(), null, 2));

  console.warn('\n=== 2. same database, second boot — expect SKIP ===');
  await bootstrapCoreInstall(CONFIGURED);

  console.warn('\n=== 3. provisioned but the public identity is missing — expect SKIP + alarm ===');
  await getCoreQb(['team_membership'])
    .deleteFrom('team_membership')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .where('user_id', '=', CONFIGURED.PUBLIC_USER_ID as any)
    .execute();
  await getCoreQb(['user'])
    .deleteFrom('user')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .where('id', '=', CONFIGURED.PUBLIC_USER_ID as any)
    .execute();
  await bootstrapCoreInstall(CONFIGURED);

  console.warn('\n=== 4. empty database, nothing configured — expect UNCONFIGURED, no rows ===');
  await emptyCore();
  await bootstrapCoreInstall({});
  console.warn(JSON.stringify(await rows(), null, 2));

  console.warn('\n=== 5. empty database, half configured — expect UNCONFIGURED naming the gap ===');
  await bootstrapCoreInstall({ LISTEN_FIRE_BOOTSTRAP_TEAM_NAME: 'Probe Co' });

  console.warn('\n=== 6. crash-resumability: public identity only — expect PROVISION ===');
  await emptyCore();
  await bootstrapCoreInstall({ ...CONFIGURED, LISTEN_FIRE_BOOTSTRAP_TEAM_NAME: '' }); // no-op
  const { ensurePublicIdentity } = await import('../../startup/core');
  await ensurePublicIdentity(CONFIGURED.PUBLIC_USER_ID);
  await bootstrapCoreInstall(CONFIGURED);
  console.warn(JSON.stringify(await rows(), null, 2));

  process.exit(0);
}

void main();

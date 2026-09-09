// Integration test for the journey transition seam (real DB). The entire
// design rests on `ON CONFLICT ... WHERE col IS NULL ... RETURNING` returning
// a row IFF this call was the first — that is a property of the emitted SQL,
// so it can only be proven against a real Postgres.

import { randomUUID } from 'node:crypto';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { UserId } from '../../../generated/kysely/core/User';

import { getCoreQb, getQb } from '../../kysely';
import { cleanupTeam } from '../../../test/harness/cleanup';
import { journeyKey as userJourneyKey, recordUserMilestone } from '../user';
import { journeyKey as teamJourneyKey, recordTeamMilestone } from '../team';
import { JOURNEY_LAUNCH_AT } from '../cohort';
jest.mock('../../ops/emit', () => ({ emitOpsEvent: jest.fn().mockResolvedValue('evt') }));
import { emitOpsEvent } from '../../ops/emit';

// This suite is about the transition-detection mechanism (RETURNING a row IFF
// this call was first) — a different concern from the cohort emit gate
// (covered below). Seed created_at safely past JOURNEY_LAUNCH_AT so these
// tests exercise "should emit" deterministically, independent of the
// wall-clock date the suite happens to run on (JOURNEY_LAUNCH_AT is a fixed
// future release date, not "today").
const WELL_AFTER_LAUNCH = new Date(JOURNEY_LAUNCH_AT.getTime() + 365 * 24 * 60 * 60 * 1000);

describe('journey milestone recording (real DB)', () => {
  let teamId: TeamId;
  let userId: UserId;

  beforeEach(async () => {
    jest.clearAllMocks();
    teamId = randomUUID() as TeamId;
    userId = randomUUID() as UserId;
    await getCoreQb(['team'])
      .insertInto('team')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({
        id: teamId,
        name: `jr-${teamId.slice(0, 8)}`,
        created_at: WELL_AFTER_LAUNCH,
      } as any)
      .execute();
    await getCoreQb(['user'])
      .insertInto('user')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({
        id: userId,
        default_team_id: teamJourneyKey(teamId),
        username: `jr-${userId.slice(0, 8)}`,
        created_at: WELL_AFTER_LAUNCH,
      } as any)
      .execute();
  });

  afterEach(async () => {
    await getQb(['team_journey']).deleteFrom('team_journey').where('team_id', '=', teamJourneyKey(teamId)).execute();
    await cleanupTeam(teamId);
  });

  it('records the first call and emits exactly one event', async () => {
    const first = await recordUserMilestone(userId, {
      milestone: 'first_mcp_call',
      teamId,
      tool: 'listAutomations',
    });
    expect(first).toBe(true);
    expect(emitOpsEvent).toHaveBeenCalledTimes(1);

    const row = await getQb(['user_journey'])
      .selectFrom('user_journey')
      .where('user_id', '=', userJourneyKey(userId))
      .select(['first_mcp_call_at', 'first_mcp_tool'])
      .executeTakeFirstOrThrow();
    expect(row.first_mcp_call_at).not.toBeNull();
    expect(row.first_mcp_tool).toBe('listAutomations');
  });

  it('is idempotent — a second call neither re-stamps nor re-emits', async () => {
    await recordUserMilestone(userId, { milestone: 'first_mcp_call', teamId, tool: 'listAutomations' });
    const before = await getQb(['user_journey'])
      .selectFrom('user_journey')
      .where('user_id', '=', userJourneyKey(userId))
      .select(['first_mcp_call_at'])
      .executeTakeFirstOrThrow();

    (emitOpsEvent as jest.Mock).mockClear();
    const second = await recordUserMilestone(userId, { milestone: 'first_mcp_call', teamId, tool: 'runAutomation' });

    expect(second).toBe(false);
    expect(emitOpsEvent).not.toHaveBeenCalled();

    const after = await getQb(['user_journey'])
      .selectFrom('user_journey')
      .where('user_id', '=', userJourneyKey(userId))
      .select(['first_mcp_call_at', 'first_mcp_tool'])
      .executeTakeFirstOrThrow();
    expect(after.first_mcp_call_at).toEqual(before.first_mcp_call_at);
    expect(after.first_mcp_tool).toBe('listAutomations');
  });

  it('records independent milestones on one row without clobbering', async () => {
    await recordUserMilestone(userId, { milestone: 'mcp_connected', teamId });
    await recordUserMilestone(userId, { milestone: 'first_mcp_call', teamId, tool: 'listAutomations' });

    const row = await getQb(['user_journey'])
      .selectFrom('user_journey')
      .where('user_id', '=', userJourneyKey(userId))
      .select(['mcp_connected_at', 'first_mcp_call_at', 'first_automation_saved_at'])
      .executeTakeFirstOrThrow();
    expect(row.mcp_connected_at).not.toBeNull();
    expect(row.first_mcp_call_at).not.toBeNull();
    expect(row.first_automation_saved_at).toBeNull();
  });

  it('records a team milestone and stays silent on first_automation_saved', async () => {
    const saved = await recordTeamMilestone(teamId, { milestone: 'first_automation_saved' });
    expect(saved).toBe(true);
    expect(emitOpsEvent).not.toHaveBeenCalled();

    const ran = await recordTeamMilestone(teamId, { milestone: 'first_run' });
    expect(ran).toBe(true);
    expect(emitOpsEvent).toHaveBeenCalledTimes(1);
  });

  // Without this the team-side WHERE clause is untested: delete it and every
  // other test still passes, while first_run re-emits a feed event on EVERY
  // run. This test must fail if `.where(... is null)` is removed from team.ts.
  it('is idempotent per team — a second first_run neither re-stamps nor re-emits', async () => {
    await recordTeamMilestone(teamId, { milestone: 'first_run' });
    const before = await getQb(['team_journey'])
      .selectFrom('team_journey')
      .where('team_id', '=', teamJourneyKey(teamId))
      .select(['first_run_at'])
      .executeTakeFirstOrThrow();

    (emitOpsEvent as jest.Mock).mockClear();
    const second = await recordTeamMilestone(teamId, { milestone: 'first_run' });

    expect(second).toBe(false);
    expect(emitOpsEvent).not.toHaveBeenCalled();

    const after = await getQb(['team_journey'])
      .selectFrom('team_journey')
      .where('team_id', '=', teamJourneyKey(teamId))
      .select(['first_run_at'])
      .executeTakeFirstOrThrow();
    expect(after.first_run_at).toEqual(before.first_run_at);
  });

  // The tool name must survive the UPDATE path — the path every real user takes.
  it('persists first_mcp_tool when the journey row already exists', async () => {
    await recordUserMilestone(userId, { milestone: 'mcp_connected', teamId });
    await recordUserMilestone(userId, {
      milestone: 'first_mcp_call',
      teamId,
      tool: 'listAutomations',
    });

    const row = await getQb(['user_journey'])
      .selectFrom('user_journey')
      .where('user_id', '=', userJourneyKey(userId))
      .select(['first_mcp_tool'])
      .executeTakeFirstOrThrow();
    expect(row.first_mcp_tool).toBe('listAutomations');
  });
});

// The emit gate: the milestone RECORD means "the first we observed"; the feed
// EVENT claims "their first, ever" — only true for subjects created inside
// the instrumented cohort. Below the cutoff, record silently; at/after it,
// record and announce. See lib/journey/cohort.ts.
describe('journey milestone recording — cohort emit gate (real DB)', () => {
  const BEFORE_LAUNCH = new Date(JOURNEY_LAUNCH_AT.getTime() - 24 * 60 * 60 * 1000);
  const AFTER_LAUNCH = new Date(JOURNEY_LAUNCH_AT.getTime() + 24 * 60 * 60 * 1000);

  let preLaunchTeamId: TeamId;
  let preLaunchUserId: UserId;
  let postLaunchTeamId: TeamId;
  let postLaunchUserId: UserId;

  beforeEach(async () => {
    jest.clearAllMocks();
    preLaunchTeamId = randomUUID() as TeamId;
    preLaunchUserId = randomUUID() as UserId;
    postLaunchTeamId = randomUUID() as TeamId;
    postLaunchUserId = randomUUID() as UserId;

    await getCoreQb(['team'])
      .insertInto('team')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({
        id: preLaunchTeamId,
        name: `jr-pre-${preLaunchTeamId.slice(0, 8)}`,
        created_at: BEFORE_LAUNCH,
      } as any)
      .execute();
    await getCoreQb(['user'])
      .insertInto('user')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({
        id: preLaunchUserId,
        default_team_id: teamJourneyKey(preLaunchTeamId),
        username: `jr-pre-${preLaunchUserId.slice(0, 8)}`,
        created_at: BEFORE_LAUNCH,
      } as any)
      .execute();

    await getCoreQb(['team'])
      .insertInto('team')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({
        id: postLaunchTeamId,
        name: `jr-post-${postLaunchTeamId.slice(0, 8)}`,
        created_at: AFTER_LAUNCH,
      } as any)
      .execute();
    await getCoreQb(['user'])
      .insertInto('user')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({
        id: postLaunchUserId,
        default_team_id: teamJourneyKey(postLaunchTeamId),
        username: `jr-post-${postLaunchUserId.slice(0, 8)}`,
        created_at: AFTER_LAUNCH,
      } as any)
      .execute();
  });

  afterEach(async () => {
    await getQb(['team_journey'])
      .deleteFrom('team_journey')
      .where('team_id', 'in', [teamJourneyKey(preLaunchTeamId), teamJourneyKey(postLaunchTeamId)])
      .execute();
    await cleanupTeam(preLaunchTeamId);
    await cleanupTeam(postLaunchTeamId);
  });

  it('records a PRE-launch user milestone but emits NO event', async () => {
    const first = await recordUserMilestone(preLaunchUserId, {
      milestone: 'mcp_connected',
      teamId: preLaunchTeamId,
    });
    expect(first).toBe(true);
    expect(emitOpsEvent).not.toHaveBeenCalled();

    const row = await getQb(['user_journey'])
      .selectFrom('user_journey')
      .where('user_id', '=', userJourneyKey(preLaunchUserId))
      .select(['mcp_connected_at'])
      .executeTakeFirstOrThrow();
    expect(row.mcp_connected_at).not.toBeNull();
  });

  it('records a POST-launch user milestone AND emits', async () => {
    const first = await recordUserMilestone(postLaunchUserId, {
      milestone: 'mcp_connected',
      teamId: postLaunchTeamId,
    });
    expect(first).toBe(true);
    expect(emitOpsEvent).toHaveBeenCalledTimes(1);

    const row = await getQb(['user_journey'])
      .selectFrom('user_journey')
      .where('user_id', '=', userJourneyKey(postLaunchUserId))
      .select(['mcp_connected_at'])
      .executeTakeFirstOrThrow();
    expect(row.mcp_connected_at).not.toBeNull();
  });

  it('records a PRE-launch team milestone but emits NO event', async () => {
    const first = await recordTeamMilestone(preLaunchTeamId, { milestone: 'first_run' });
    expect(first).toBe(true);
    expect(emitOpsEvent).not.toHaveBeenCalled();

    const row = await getQb(['team_journey'])
      .selectFrom('team_journey')
      .where('team_id', '=', teamJourneyKey(preLaunchTeamId))
      .select(['first_run_at'])
      .executeTakeFirstOrThrow();
    expect(row.first_run_at).not.toBeNull();
  });

  it('records a POST-launch team milestone AND emits', async () => {
    const first = await recordTeamMilestone(postLaunchTeamId, { milestone: 'first_run' });
    expect(first).toBe(true);
    expect(emitOpsEvent).toHaveBeenCalledTimes(1);

    const row = await getQb(['team_journey'])
      .selectFrom('team_journey')
      .where('team_id', '=', teamJourneyKey(postLaunchTeamId))
      .select(['first_run_at'])
      .executeTakeFirstOrThrow();
    expect(row.first_run_at).not.toBeNull();
  });
});

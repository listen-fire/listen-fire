// Real-DB proof that a RESUMED run closes the ops feed event its first firing
// opened, instead of leaving it open forever.
//
// The ops event is opened by the initial firing and closed by `finish()` — but
// that close is guarded on the recorder's `opsRunId`, and a resumed firing
// builds a FRESH recorder whose `opsRunId` starts null. So a run that parked on
// an `ask`, got answered, resumed and finished left its event `running`: in the
// feed, a run the user had already dealt with still looked like it was going,
// and the "running now" count (which counts exactly that status) never came
// back down.
//
// The id was on the run row the whole time; the resume just never read it back.

import { randomUUID } from 'node:crypto';

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { TriggerRunId } from '../../../../generated/kysely/automations/TriggerRun';
import type { OpsEventId } from '../../../../generated/kysely/public/OpsEvent';

import { getAutomationsQb, getCoreQb, getQb } from '../../../../lib/kysely';
import OpsEventType from '../../../../generated/kysely/public/OpsEventType';
import OpsSeverity from '../../../../generated/kysely/public/OpsSeverity';
import OpsRunStatus from '../../../../generated/kysely/public/OpsRunStatus';
import { TriggerRunRecorder } from '../trigger_run';

let teamId: TeamId;
let runId: TriggerRunId;
let opsRunId: OpsEventId;
let triggerId: string;

beforeAll(async () => {
  const team = await getCoreQb(['team'])
    .insertInto('team')
    .values({ name: `resume-ops-${randomUUID().slice(0, 8)}` })
    .returning('id')
    .executeTakeFirstOrThrow();
  teamId = team.id as TeamId;
});

beforeEach(async () => {
  // The ops event the FIRST firing opened, still running because the run parked.
  const ops = await getQb(['ops_event'])
    .insertInto('ops_event')
    .values({
      type: OpsEventType.AUTOMATION,
      severity: OpsSeverity.info,
      status: OpsRunStatus.running,
      team_id: teamId,
      title: 'Automation received an event',
      updated_at: new Date(),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  opsRunId = ops.id;

  triggerId = randomUUID();
  runId = randomUUID() as TriggerRunId;
  await getAutomationsQb(['trigger_run'])
    .insertInto('trigger_run')
    .values({
      id: runId,
      team_id: teamId,
      trigger_id: triggerId,
      trigger_type: 'manual',
      status: 'parked',
      ops_run_id: opsRunId,
    } as never)
    .execute();
});

const opsStatus = async (): Promise<string | undefined> => {
  const row = await getQb(['ops_event'])
    .selectFrom('ops_event')
    .select(['status'])
    .where('id', '=', opsRunId)
    .executeTakeFirst();
  return row?.status ?? undefined;
};

/** `finish()` closes the feed event fire-and-forget by design — "a failure here
 *  must never affect the firing outcome" — so a test that reads straight after
 *  it is racing the close, not testing it. Poll for the settled state. */
const waitForOpsStatus = async (predicate: (s: string | undefined) => boolean): Promise<string | undefined> => {
  for (let i = 0; i < 50; i++) {
    const status = await opsStatus();
    if (predicate(status)) return status;
    await new Promise((r) => setTimeout(r, 20));
  }
  return opsStatus();
};

const resumedRecorder = (): TriggerRunRecorder =>
  new TriggerRunRecorder({
    teamId,
    triggerId,
    triggerType: 'manual',
    triggerEvent: { triggerType: 'manual', teamId, adapterType: 'manual', payload: {} },
    existingRunId: runId,
  } as never);

describe('parking is its own feed state', () => {
  it('markParked moves the event to `parked`, not a slow-looking `running`', async () => {
    // A run waiting on a person can wait for days. Left as `running` it is
    // indistinguishable from live work and inflates the "running now" tile for
    // as long as nobody answers.
    const recorder = resumedRecorder();
    await recorder.adoptOpsRun();
    await recorder.markParked();
    expect(await opsStatus()).toBe(OpsRunStatus.parked);
  });

  it('adopting on resume flips it BACK to running — the answer arrived', async () => {
    const parking = resumedRecorder();
    await parking.adoptOpsRun();
    await parking.markParked();
    expect(await opsStatus()).toBe(OpsRunStatus.parked);

    const resuming = resumedRecorder();
    await resuming.adoptOpsRun();
    expect(await opsStatus()).toBe(OpsRunStatus.running);
  });

  it('a parked event still CLOSES when the resumed run finishes', async () => {
    // The park state must not become a second way to strand an event.
    const parking = resumedRecorder();
    await parking.adoptOpsRun();
    await parking.markParked();

    const resuming = resumedRecorder();
    await resuming.adoptOpsRun();
    await resuming.finish();
    const status = await waitForOpsStatus(
      (v) => v !== OpsRunStatus.running && v !== OpsRunStatus.parked,
    );
    expect(status).not.toBe(OpsRunStatus.running);
    expect(status).not.toBe(OpsRunStatus.parked);
  });
});

describe('a resumed run closes the ops event its first firing opened', () => {
  it('adopts the run row\'s ops_run_id, so finishing CLOSES it', async () => {
    const recorder = resumedRecorder();
    await recorder.adoptOpsRun();
    await recorder.finish();
    // Terminal either way — what matters is that it stopped being `running`.
    expect(await waitForOpsStatus((v) => v !== OpsRunStatus.running)).not.toBe(
      OpsRunStatus.running,
    );
  });

  it('WITHOUT adopting, the event is stranded — the bug this pins', async () => {
    // Same resume, minus the adoption: the close is guarded on an id the fresh
    // recorder doesn't have, so nothing closes and the feed shows it running
    // forever. Kept as a test so the guard can't quietly come back.
    const recorder = resumedRecorder();
    await recorder.finish();
    // Give the (absent) close every chance to happen before asserting it didn't.
    await new Promise((r) => setTimeout(r, 200));
    expect(await opsStatus()).toBe(OpsRunStatus.running);
  });

  it('does not open a SECOND event — one firing is one row in the feed', async () => {
    const before = await getQb(['ops_event'])
      .selectFrom('ops_event')
      .select(['id'])
      .where('team_id', '=', teamId)
      .where('parent_run_id', 'is', null)
      .execute();
    const recorder = resumedRecorder();
    await recorder.adoptOpsRun();
    await recorder.finish();
    const after = await getQb(['ops_event'])
      .selectFrom('ops_event')
      .select(['id'])
      .where('team_id', '=', teamId)
      .where('parent_run_id', 'is', null)
      .execute();
    // Starting a new run instead of adopting would close cleanly AND still
    // strand the first, showing one firing twice.
    expect(after.length).toBe(before.length);
  });
});

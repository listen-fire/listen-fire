// Real-DB proof of the per-frame pending-count completion mechanism (§5.4,
// chunk 3.2b) — the atomic `UPDATE … SET pending = pending - 1 … RETURNING
// pending` that the resume worker rides. The standing gate for the join-
// completion race: with N concurrent decrements of one join (N siblings answered
// in the same window), EXACTLY ONE observes 0 and is the completer.

import { randomUUID } from 'node:crypto';
import { getAutomationsQb, getCoreQb } from '../../../lib/kysely';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { TriggerRunId } from '../../../generated/kysely/automations/TriggerRun';
import {
  decrementJoin,
  decrementJoinClose,
  persistBranchExport,
  collectBranchExports,
  runHasPendingJoins,
  clearJoins,
} from '../join_pending';

let teamId: TeamId;
let runId: TriggerRunId;

beforeAll(async () => {
  teamId = randomUUID() as TeamId;
  runId = randomUUID() as TriggerRunId;
  await getCoreQb(['team'])
    .insertInto('team')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({ id: teamId, name: `join-pending-${teamId.slice(0, 8)}` } as any)
    .execute();
  await getAutomationsQb(['trigger_run'])
    .insertInto('trigger_run')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({
      id: runId,
      team_id: teamId,
      trigger_id: 'join-pending-trigger',
      trigger_type: 'webhook',
      status: 'parked',
      started_at: new Date(),
    } as any)
    .execute();
});

afterAll(async () => {
  await clearJoins(runId);
  await getAutomationsQb(['trigger_run']).deleteFrom('trigger_run').where('id', '=', runId).execute();
  await getCoreQb(['team']).deleteFrom('team').where('id', '=', teamId).execute();
});

afterEach(async () => {
  await clearJoins(runId);
});

async function seedJoin(frameAddress: string, pending: number): Promise<void> {
  await getAutomationsQb(['join_pending'])
    .insertInto('join_pending')
    .values({ run_id: runId, frame_address: frameAddress as never, pending })
    .onConflict((oc) => oc.columns(['run_id', 'frame_address']).doUpdateSet({ pending }))
    .execute();
}

/** Seed a branch's export row — decrementJoinClose's per-leaf exactly-once claim
 *  (§7) requires this row to exist (persist-before-decrement); a decrement with no
 *  export row is never claimed and never decrements. */
async function seedBranchExport(
  frameAddress: string,
  branchAddress: string,
  branchIndex: number,
): Promise<void> {
  await persistBranchExport({
    runId,
    frameAddress,
    branchAddress,
    branchIndex,
    exports: {},
  });
}

describe('decrementJoin — the race-free completer (§5.4)', () => {
  it('decrements toward zero; only the decrement reaching 0 completes (and deletes the row)', async () => {
    await seedJoin('s1', 2);

    const first = await decrementJoin({ runId, frameAddress: 's1' });
    expect(first).toEqual({ completed: false, pending: 1 });
    // The run is still parked (pending > 0).
    expect(await runHasPendingJoins(runId)).toBe(true);

    const second = await decrementJoin({ runId, frameAddress: 's1' });
    expect(second).toEqual({ completed: true, pending: 0 });
    // The row is gone — the join is dissolved.
    expect(await runHasPendingJoins(runId)).toBe(false);
  });

  it('a missing join (no enclosing join / already completed) returns not-completed', async () => {
    const result = await decrementJoin({ runId, frameAddress: 's0' });
    expect(result).toEqual({ completed: false, pending: 0 });
  });

  it('THE RACE: N concurrent decrements of one join — exactly one completes', async () => {
    const N = 8;
    await seedJoin('s7', N);

    // Fire all N decrements concurrently (siblings answered in the same window).
    const results = await Promise.all(
      Array.from({ length: N }, () => decrementJoin({ runId, frameAddress: 's7' })),
    );

    // Exactly ONE observed 0 → the unique completer.
    const completers = results.filter((r) => r.completed);
    expect(completers).toHaveLength(1);
    expect(completers[0].pending).toBe(0);
    // The other N-1 saw a positive remaining count, never 0.
    expect(results.filter((r) => !r.completed).every((r) => r.pending > 0)).toBe(true);
    // The pending values the non-completers observed are 1..N-1, each once.
    expect(
      results
        .map((r) => r.pending)
        .sort((a, b) => a - b),
    ).toEqual(Array.from({ length: N }, (_, i) => i));
    // The row is fully dissolved.
    expect(await runHasPendingJoins(runId)).toBe(false);
  });

  it('independent joins of one run decrement independently', async () => {
    await seedJoin('s1', 1);
    await seedJoin('s2', 2);
    const a = await decrementJoin({ runId, frameAddress: 's1' });
    expect(a.completed).toBe(true);
    // s2 untouched — still pending.
    const b = await decrementJoin({ runId, frameAddress: 's2' });
    expect(b).toEqual({ completed: false, pending: 1 });
    expect(await runHasPendingJoins(runId)).toBe(true);
  });
});

async function readClosedBy(frameAddress: string): Promise<string | null | undefined> {
  const row = await getAutomationsQb(['join_pending'])
    .selectFrom('join_pending')
    .where('run_id', '=', runId)
    .where('frame_address', '=', frameAddress as never)
    .select('closed_by_address')
    .executeTakeFirst();
  return row?.closed_by_address;
}

describe('decrementJoinClose — mark-closed decrement (§6.4)', () => {
  it('decrements toward close; the closer is marked and the row is retained; re-scan is idempotent for the closer, false for a sibling', async () => {
    await seedJoin('f0', 2);
    await seedBranchExport('f0', 'f0.b0', 0);
    await seedBranchExport('f0', 'f0.b1', 1);

    // First branch: pending 2 -> 1, not the closer.
    const first = await decrementJoinClose({
      runId,
      frameAddress: 'f0',
      branchAddress: 'f0.b0',
      leafAddress: 'f0.s0.b0',
    });
    expect(first).toEqual({ closed: false });
    expect(await runHasPendingJoins(runId)).toBe(true);
    expect(await readClosedBy('f0')).toBeNull();

    // Second branch: pending 1 -> 0, the closer. Row NOT deleted; closer marked.
    const closerLeaf = 'f0.s0.b1';
    const second = await decrementJoinClose({
      runId,
      frameAddress: 'f0',
      branchAddress: 'f0.b1',
      leafAddress: closerLeaf,
    });
    expect(second).toEqual({ closed: true });
    expect(await readClosedBy('f0')).toBe(closerLeaf);
    // The closed row (pending 0) no longer counts as waiting.
    expect(await runHasPendingJoins(runId)).toBe(false);

    // Re-scanned closer (crash-retry, same leaf) → still the closer.
    const reScan = await decrementJoinClose({
      runId,
      frameAddress: 'f0',
      branchAddress: 'f0.b1',
      leafAddress: closerLeaf,
    });
    expect(reScan).toEqual({ closed: true });

    // A DIFFERENT leaf re-scanned after close → NOT the closer.
    const sibling = await decrementJoinClose({
      runId,
      frameAddress: 'f0',
      branchAddress: 'f0.b0',
      leafAddress: 'f0.s0.b0',
    });
    expect(sibling).toEqual({ closed: false });
  });

  it('per-leaf EXACTLY-ONCE: a non-closer re-scanned while the join is still open does NOT decrement it a second time (§7)', async () => {
    // The amplified crash gap: a non-closer branch re-scanned in the window
    // between its decrement and its parked_run delete must not close the join
    // early. The claim (join_branch_export.decremented) makes each branch's
    // decrement fire exactly once.
    await seedJoin('c0', 3);
    await seedBranchExport('c0', 'c0.b0', 0);
    await seedBranchExport('c0', 'c0.b1', 1);
    await seedBranchExport('c0', 'c0.b2', 2);

    // b0 decrements once (pending 3 -> 2).
    const b0 = await decrementJoinClose({
      runId,
      frameAddress: 'c0',
      branchAddress: 'c0.b0',
      leafAddress: 'c0.s0.b0',
    });
    expect(b0).toEqual({ closed: false });

    // b0 re-scanned (crash window): its export row is decremented=true already, so
    // the claim finds no row → NO second decrement. Pending must stay 2.
    const b0Rescan = await decrementJoinClose({
      runId,
      frameAddress: 'c0',
      branchAddress: 'c0.b0',
      leafAddress: 'c0.s0.b0',
    });
    expect(b0Rescan).toEqual({ closed: false });
    expect(await readClosedBy('c0')).toBeNull(); // NOT closed early
    expect(await runHasPendingJoins(runId)).toBe(true);

    // b1 (pending 2 -> 1), then b2 (pending 1 -> 0) closes — proving the count
    // still reflects EACH branch exactly once despite b0's re-scan.
    const b1 = await decrementJoinClose({
      runId,
      frameAddress: 'c0',
      branchAddress: 'c0.b1',
      leafAddress: 'c0.s0.b1',
    });
    expect(b1).toEqual({ closed: false });
    const b2 = await decrementJoinClose({
      runId,
      frameAddress: 'c0',
      branchAddress: 'c0.b2',
      leafAddress: 'c0.s0.b2',
    });
    expect(b2).toEqual({ closed: true });
    expect(await readClosedBy('c0')).toBe('c0.s0.b2');
  });

  it('a missing frame is never the closer', async () => {
    const result = await decrementJoinClose({
      runId,
      frameAddress: 'nope',
      branchAddress: 'nope.b0',
      leafAddress: 'nope.s0',
    });
    expect(result).toEqual({ closed: false });
  });
});

describe('join_branch_export — persist + collect (§12)', () => {
  it('collects branches ordered by branch_index regardless of persist order', async () => {
    const frame = 'g0';
    await persistBranchExport({
      runId,
      frameAddress: frame,
      branchAddress: 'g0.b2',
      branchIndex: 2,
      exports: { c: 'third' },
    });
    await persistBranchExport({
      runId,
      frameAddress: frame,
      branchAddress: 'g0.b0',
      branchIndex: 0,
      exports: { a: 'first' },
    });
    await persistBranchExport({
      runId,
      frameAddress: frame,
      branchAddress: 'g0.b1',
      branchIndex: 1,
      exports: { b: 'second' },
    });

    const rows = await collectBranchExports({ runId, frameAddress: frame });
    expect(rows.map((r) => r.branchIndex)).toEqual([0, 1, 2]);
    expect(rows.map((r) => r.branchAddress)).toEqual(['g0.b0', 'g0.b1', 'g0.b2']);
    expect(rows.map((r) => r.exports)).toEqual([
      { a: 'first' },
      { b: 'second' },
      { c: 'third' },
    ]);
  });

  it('re-persisting the same branch (same PK) updates in place — no duplicate row', async () => {
    const frame = 'g1';
    await persistBranchExport({
      runId,
      frameAddress: frame,
      branchAddress: 'g1.b0',
      branchIndex: 0,
      exports: { v: 'original' },
    });
    await persistBranchExport({
      runId,
      frameAddress: frame,
      branchAddress: 'g1.b0',
      branchIndex: 0,
      exports: { v: 'updated' },
    });

    const rows = await collectBranchExports({ runId, frameAddress: frame });
    expect(rows).toHaveLength(1);
    expect(rows[0].exports).toEqual({ v: 'updated' });
  });
});

describe('runHasPendingJoins — closed rows no longer count (§6.4)', () => {
  it('a pending>0 row counts; after decrement-to-0-and-close it does not', async () => {
    await seedJoin('h0', 1);
    await seedBranchExport('h0', 'h0.b0', 0);
    expect(await runHasPendingJoins(runId)).toBe(true);

    const closed = await decrementJoinClose({
      runId,
      frameAddress: 'h0',
      branchAddress: 'h0.b0',
      leafAddress: 'h0.s0',
    });
    expect(closed).toEqual({ closed: true });
    // The row survives (closed_by_address marked) but pending 0 → not waiting.
    expect(await readClosedBy('h0')).toBe('h0.s0');
    expect(await runHasPendingJoins(runId)).toBe(false);
  });
});

describe('clearJoins — wipes both join_pending and join_branch_export (§12.6)', () => {
  it('deletes every join and every branch export for the run', async () => {
    await seedJoin('k0', 3);
    await persistBranchExport({
      runId,
      frameAddress: 'k0',
      branchAddress: 'k0.b0',
      branchIndex: 0,
      exports: { x: 1 },
    });

    expect(await runHasPendingJoins(runId)).toBe(true);
    expect(await collectBranchExports({ runId, frameAddress: 'k0' })).toHaveLength(1);

    await clearJoins(runId);

    expect(await runHasPendingJoins(runId)).toBe(false);
    expect(await collectBranchExports({ runId, frameAddress: 'k0' })).toEqual([]);
  });
});

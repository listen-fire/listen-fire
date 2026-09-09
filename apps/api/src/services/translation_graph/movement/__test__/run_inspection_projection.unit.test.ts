// The run-inspection write projection (pure): persisted step plans → the
// agent-facing write list + the per-run committed/captured summary. This is
// the surface that replaced the misleading run-level `dryRun` boolean — a
// write's own `committed` flag is the truth (a live run can still CAPTURE a
// `dry_run` instance's write), with a fallback for runs recorded before the
// per-write flag existed.

import { projectRunWrites } from '../run_now';

function steps(plans: Array<Record<string, unknown>>): unknown {
  return [{ appliedActionPlans: plans }];
}

describe('projectRunWrites — per-write committed + summary', () => {
  it('carries each write\'s committed flag and counts committed vs captured', () => {
    const projected = projectRunWrites(
      steps([
        { nodeId: 'co', adapterType: 'attio', recordType: 'Company', created: true, committed: true, writtenValues: { name: 'Acme' } },
        { nodeId: 'msg', adapterType: 'slack', recordType: 'message', created: true, committed: false, writtenValues: { text: 'hi' } },
      ]),
      false,
    );

    expect(projected.writes.map((w) => w.committed)).toEqual([true, false]);
    expect(projected.committed).toBe(1);
    expect(projected.captured).toBe(1);
  });

  it('a live run that captured a dry_run instance reports the captured write, not "all committed"', () => {
    const projected = projectRunWrites(
      steps([
        { nodeId: 'msg', adapterType: 'slack', recordType: 'message', created: true, committed: false, writtenValues: {} },
      ]),
      false, // run-level dry_run is false — the OLD misleading signal
    );
    expect(projected.committed).toBe(0);
    expect(projected.captured).toBe(1);
  });

  it('counts the writes a FAILED run landed before it died — a failure is not zero writes', () => {
    // Writes hit external systems inline, so a run that threw on its second
    // write really did create the first record. The failed step carries it.
    const projected = projectRunWrites(
      [
        {
          status: 'failed',
          appliedActionPlans: [
            { nodeId: 'co', adapterType: 'attio', recordType: 'Company', created: true, committed: true, writtenValues: { name: 'Acme' } },
          ],
          errors: [{ message: 'slack: 422 Unprocessable Entity' }],
        },
      ],
      false,
    );

    expect(projected.committed).toBe(1);
    expect(projected.captured).toBe(0);
    expect(projected.writes[0].externalId).toBeUndefined();
    expect(projected.writes[0].target).toBe('attio:Company');
  });

  it('falls back to the run-level dry_run for writes recorded before the per-write flag', () => {
    const oldPlan = { nodeId: 'co', adapterType: 'attio', recordType: 'Company', created: true, writtenValues: {} };

    const liveRun = projectRunWrites(steps([oldPlan]), false);
    expect(liveRun.writes[0].committed).toBe(true);
    expect(liveRun.committed).toBe(1);

    const dryRun = projectRunWrites(steps([oldPlan]), true);
    expect(dryRun.writes[0].committed).toBe(false);
    expect(dryRun.captured).toBe(1);
  });
});

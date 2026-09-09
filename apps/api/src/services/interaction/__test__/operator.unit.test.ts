// Operator run-actions (control tower) — each delegates to an engine primitive
// after a team-scoped ownership check. We mock kysely (the ownership lookups) +
// the primitive and pin that abortRun → failRunAndCancelRequests, and that a
// cross-team / missing id is rejected BEFORE the primitive fires. (Ask answering
// / re-delivery are no longer operator run-actions — asks are adapter records
// answered through the one answer door; see ask_records.)

const TEAM_ID = 'team-1' as never;

// One configurable qb stub: `executeTakeFirst` returns whatever the test sets,
// so we can simulate "owned" (a row) vs "not found / wrong team" (undefined).
let ownedRow: Record<string, unknown> | undefined;
function makeQbStub() {
  const stub: any = {
    selectFrom: () => stub,
    where: () => stub,
    select: () => stub,
    executeTakeFirst: async () => ownedRow,
  };
  return stub;
}

const failRunAndCancelRequests = jest.fn();

jest.mock('../../../lib/kysely', () => ({
  getQb: jest.fn(() => makeQbStub()),
  getCoreQb: jest.fn(() => makeQbStub()),
  getKnowledgeQb: jest.fn(() => makeQbStub()),
  getAutomationsQb: jest.fn(() => makeQbStub()),
}));
jest.mock('../run_failure', () => ({
  failRunAndCancelRequests: (...args: unknown[]) => failRunAndCancelRequests(...args),
}));

import { abortRun } from '../operator';
import { MovementEngineError } from '../../movement_engine/errors';

beforeEach(() => {
  failRunAndCancelRequests.mockReset().mockResolvedValue(undefined);
});

describe('abortRun', () => {
  it('delegates to failRunAndCancelRequests for an owned parked run', async () => {
    // The dual-behavior branching (running vs parked) is covered in depth by
    // abort_running.unit.test.ts; this just pins the still-immediate parked path.
    ownedRow = { id: 'run-1', status: 'parked' };
    const result = await abortRun({ runId: 'run-1', teamId: TEAM_ID, abortedBy: 'Ada' });
    expect(failRunAndCancelRequests).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-1', message: 'Cancelled by Ada' }),
    );
    expect(result.runId).toBe('run-1');
  });

  it('rejects a cross-team / missing run before cancelling', async () => {
    ownedRow = undefined;
    await expect(
      abortRun({ runId: 'nope', teamId: TEAM_ID }),
    ).rejects.toBeInstanceOf(MovementEngineError);
    expect(failRunAndCancelRequests).not.toHaveBeenCalled();
  });
});

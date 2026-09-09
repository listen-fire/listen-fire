// The control-tower runs view (runs-cancel task 6): `listTeamRuns`
// (observability.ts) shapes every running/parked run into a `TeamRunSummary`
// — Task 7's UI consumes this shape verbatim.
//
// The DB is a small in-memory table + predicate double so these tests exercise
// the real `.where(...)` query shape, not a scripted return FIFO.

import type { TeamId } from '../../../generated/kysely/core/Team';

type Row = Record<string, unknown>;
type Where = { col: string; op: string; val: unknown };

const triggerRunRows: Row[] = [];
const parkedRunRows: Row[] = [];
const knowledgeTriggerRows: Row[] = [];

// One table map for every accessor. A double that branches on WHICH accessor
// asked goes stale the moment a table changes schema -- `getAutomationsQb`
// here used to answer `knowledgeTriggerRows` for any table at all, which
// silently emptied every `trigger_run` scan and left this suite red from the
// chunk that moved the engine runtime into `automations` (2C1's lesson,
// re-learned). Key on the TABLE.
function tableRows(table: string): Row[] {
  if (table === 'trigger_run') return triggerRunRows;
  if (table === 'parked_run') return parkedRunRows;
  if (table === 'trigger' || table === 'movement') return knowledgeTriggerRows;
  throw new Error(`unmocked table: ${table}`);
}

function matches(row: Row, w: Where): boolean {
  const v = row[w.col];
  switch (w.op) {
    case '=':
      return v === w.val;
    case '!=':
      return v !== w.val;
    case 'is':
      return w.val === null ? v === null || v === undefined : v === w.val;
    case 'in':
      return Array.isArray(w.val) && w.val.includes(v);
    default:
      throw new Error(`unsupported where op: ${w.op}`);
  }
}

function project(row: Row, spec: string | string[]): Row {
  if (typeof spec === 'string') return { [spec]: row[spec] };
  const out: Row = {};
  for (const col of spec) out[col] = row[col];
  return out;
}

function makeSelectChain(rows: Row[]) {
  const wheres: Where[] = [];
  let selectSpec: string | string[] = [];
  let order: { col: string; dir: string } | null = null;
  let limitN: number | null = null;

  const chain: Record<string, unknown> = {};
  chain.where = (col: string, op: string, val: unknown) => {
    wheres.push({ col, op, val });
    return chain;
  };
  chain.select = (spec: string | string[]) => {
    selectSpec = spec;
    return chain;
  };
  chain.orderBy = (col: string, dir: string) => {
    order = { col, dir };
    return chain;
  };
  chain.limit = (n: number) => {
    limitN = n;
    return chain;
  };
  chain.distinct = () => chain;

  function evaluate(): Row[] {
    let out = rows.filter((row) => wheres.every((w) => matches(row, w)));
    if (order) {
      const { col, dir } = order;
      out = [...out].sort((a, b) => {
        const av = a[col] as string | number;
        const bv = b[col] as string | number;
        const cmp = av < bv ? -1 : av > bv ? 1 : 0;
        return dir === 'desc' ? -cmp : cmp;
      });
    }
    if (limitN !== null) out = out.slice(0, limitN);
    return out;
  }

  chain.execute = async () => evaluate().map((row) => project(row, selectSpec));
  chain.executeTakeFirst = async () => {
    const rows2 = evaluate();
    return rows2.length ? project(rows2[0], selectSpec) : undefined;
  };
  return chain;
}

function makeUpdateChain(rows: Row[]) {
  const wheres: Where[] = [];
  let setValues: Row = {};
  let returningCol: string | null = null;
  const chain: Record<string, unknown> = {};
  chain.where = (col: string, op: string, val: unknown) => {
    wheres.push({ col, op, val });
    return chain;
  };
  chain.set = (values: Row) => {
    setValues = values;
    return chain;
  };
  chain.returning = (col: string) => {
    returningCol = col;
    return chain;
  };
  function apply(): Row[] {
    const matched = rows.filter((row) => wheres.every((w) => matches(row, w)));
    for (const row of matched) Object.assign(row, setValues);
    return matched;
  }
  chain.execute = async () => apply();
  chain.executeTakeFirst = async () => {
    const matched = apply();
    if (matched.length === 0) return undefined;
    return returningCol ? project(matched[0], returningCol) : matched[0];
  };
  return chain;
}

function makeQb() {
  return {
    selectFrom: (t: string) => makeSelectChain(tableRows(t)),
    updateTable: (t: string) => makeUpdateChain(tableRows(t)),
  };
}

jest.mock('../../../lib/kysely', () => ({
  getQb: () => makeQb(),
  getCoreQb: () => makeQb(),
  getKnowledgeQb: () => makeQb(),
  getAutomationsQb: () => makeQb(),
}));

import { listTeamRuns, deriveWaitingOn } from '../observability';

const TEAM = 'team-1' as TeamId;

function resetFixtures() {
  triggerRunRows.length = 0;
  parkedRunRows.length = 0;
  knowledgeTriggerRows.length = 0;
}

beforeEach(resetFixtures);

function pushRun(overrides: Partial<Row> = {}): Row {
  const row: Row = {
    id: `run-${triggerRunRows.length + 1}`,
    team_id: TEAM,
    trigger_id: 'trig-1',
    status: 'running',
    started_at: new Date('2026-07-14T10:00:00Z'),
    cancel_requested_at: null,
    ...overrides,
  };
  triggerRunRows.push(row);
  return row;
}

function pushParkedLeaf(runId: string, reason: string, overrides: Partial<Row> = {}) {
  parkedRunRows.push({
    id: `park-${parkedRunRows.length + 1}`,
    run_id: runId,
    park_reason: reason,
    status: 'parked',
    ...overrides,
  });
}

function pushTriggerName(triggerId: string, name: string) {
  knowledgeTriggerRows.push({ id: triggerId, name });
}

describe('deriveWaitingOn — priority (await > timer)', () => {
  it('picks an await (ask) over a timer', () => {
    expect(deriveWaitingOn(['timer', 'await'])).toBe('ask');
  });
  it('falls back to the timer when nothing waits on a person', () => {
    expect(deriveWaitingOn(['timer'])).toBe('timer');
  });
  it('returns null for no reasons', () => {
    expect(deriveWaitingOn([])).toBeNull();
  });
});

describe('listTeamRuns', () => {
  it('shapes a running run', async () => {
    const run = pushRun({ status: 'running' });
    pushTriggerName('trig-1', 'Deal Sync');

    const [summary] = await listTeamRuns(TEAM);

    expect(summary).toEqual({
      runId: run.id,
      automationName: 'Deal Sync',
      status: 'running',
      startedAt: run.started_at,
      waitingOn: null,
      openAskCount: 0,
      cancelRequested: false,
    });
  });

  it('shapes a parked run with await leaves (the open-ask count is the await-park count)', async () => {
    const run = pushRun({ status: 'parked' });
    pushParkedLeaf(run.id as string, 'await');
    pushParkedLeaf(run.id as string, 'await');
    pushTriggerName('trig-1', 'Deal Sync');

    const [summary] = await listTeamRuns(TEAM);

    expect(summary.waitingOn).toBe('ask');
    expect(summary.openAskCount).toBe(2);
  });

  it('shapes a parked run with a timer leaf', async () => {
    const run = pushRun({ status: 'parked' });
    pushParkedLeaf(run.id as string, 'timer');
    pushTriggerName('trig-1', 'Deal Sync');

    const [summary] = await listTeamRuns(TEAM);

    expect(summary.waitingOn).toBe('timer');
    expect(summary.openAskCount).toBe(0);
  });

  it('flags cancelRequested from the stamp', async () => {
    const run = pushRun({ status: 'running', cancel_requested_at: new Date() });
    pushTriggerName('trig-1', 'Deal Sync');

    const [summary] = await listTeamRuns(TEAM);

    expect(summary.cancelRequested).toBe(true);
  });

  it('falls back to a sensible automation name when the trigger is gone', async () => {
    pushRun({ status: 'running' });
    // No knowledgeTriggerRows pushed — trigger.name lookup misses.

    const [summary] = await listTeamRuns(TEAM);

    expect(summary.automationName).toBe('an automation');
  });

  it('excludes terminal runs and other teams', async () => {
    pushRun({ status: 'success' });
    pushRun({ team_id: 'team-2' as TeamId, status: 'running' });

    const summaries = await listTeamRuns(TEAM);

    expect(summaries).toEqual([]);
  });

  it('returns [] with no queries beyond the run scan when the team has no live runs', async () => {
    const summaries = await listTeamRuns(TEAM);
    expect(summaries).toEqual([]);
  });
});

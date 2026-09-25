import type { RunCostSummary } from '../llm_usage';

// `runCostSummaries` is one grouped SELECT over `llm_usage` — assert it
// builds that query (not N+1 lookups) and maps each grouped row onto its
// run id, leaving runs with no usage rows absent from the map.

const execute = jest.fn();
const groupBy = jest.fn(() => ({ execute }));
const where = jest.fn(() => ({ groupBy }));
const select = jest.fn(() => ({ where }));
const selectFrom = jest.fn(() => ({ select }));
jest.mock('../kysely', () => ({ getQb: jest.fn(() => ({ selectFrom })) }));

function load() {
  let mod: typeof import('../llm_usage') | undefined;
  jest.isolateModules(() => {
    mod = require('../llm_usage');
  });
  if (!mod) throw new Error('module did not load');
  return mod;
}

beforeEach(() => {
  execute.mockReset();
  selectFrom.mockClear();
  select.mockClear();
  where.mockClear();
  groupBy.mockClear();
});

describe('runCostSummaries', () => {
  it('returns an empty map without querying, for no run ids', async () => {
    const mod = load();
    const result = await mod.runCostSummaries([]);
    expect(result.size).toBe(0);
    expect(selectFrom).not.toHaveBeenCalled();
  });

  it('rolls up cost, calls and tokens per run from one grouped query', async () => {
    execute.mockResolvedValue([
      { trigger_run_id: 'run-1', calls: 3, input_tokens: 900, output_tokens: 300, cost_microdollars: 4500 },
      { trigger_run_id: 'run-2', calls: 1, input_tokens: 100, output_tokens: 50, cost_microdollars: 200 },
    ]);
    const mod = load();
    const result = await mod.runCostSummaries(['run-1', 'run-2', 'run-3'] as never);

    expect(selectFrom).toHaveBeenCalledWith('llm_usage');
    expect(where).toHaveBeenCalledWith('trigger_run_id', 'in', ['run-1', 'run-2', 'run-3']);
    expect(groupBy).toHaveBeenCalledWith('trigger_run_id');

    expect(result.get('run-1')).toEqual<RunCostSummary>({
      runId: 'run-1',
      costMicrodollars: 4500,
      calls: 3,
      inputTokens: 900,
      outputTokens: 300,
    });
    expect(result.get('run-2')).toEqual<RunCostSummary>({
      runId: 'run-2',
      costMicrodollars: 200,
      calls: 1,
      inputTokens: 100,
      outputTokens: 50,
    });
    // run-3 was asked for but has no usage rows — absent, not zeroed.
    expect(result.has('run-3')).toBe(false);
  });

  it('drops a row with no trigger_run_id rather than keying the map on null', async () => {
    execute.mockResolvedValue([
      { trigger_run_id: null, calls: 2, input_tokens: 10, output_tokens: 5, cost_microdollars: 20 },
    ]);
    const mod = load();
    const result = await mod.runCostSummaries(['run-1'] as never);
    expect(result.size).toBe(0);
  });
});

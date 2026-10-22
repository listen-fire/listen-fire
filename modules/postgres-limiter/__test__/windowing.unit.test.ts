import type { LimitRequest, WindowCall } from 'movement-engine/public/limiter';
import { decide, type HeldState } from '../windowing';
import { schemaIdentifier } from '../schema';

const NOW = 1_000_000;

function request(limits: LimitRequest['limits'], cost = 1): LimitRequest {
  return { key: 'caller', cost, limits, holdMs: 60_000 };
}

function run(limits: LimitRequest['limits'], options: { windows?: [string, WindowCall[]][]; held?: [string, HeldState][]; cost?: number; now?: number } = {}) {
  return decide({ request: request(limits, options.cost), windows: new Map(options.windows), held: new Map(options.held), now: options.now ?? NOW });
}

const calls = (...ats: number[]): WindowCall[] => ats.map((at) => ({ at, cost: 1 }));

describe('rate windows', () => {
  const rate = { key: 'r', calls: 4, perMs: 1_000 };

  test('an empty window grants and counts the call now', () => {
    expect(run([rate])).toEqual({ granted: true, counted: [{ bucket: 'r', call: { at: NOW, cost: 1 } }], holds: [] });
  });

  test('a full window refuses until its oldest call leaves', () => {
    const windows: [string, WindowCall[]][] = [['r', calls(NOW - 900, NOW - 100, NOW - 50, NOW)]];
    expect(run([rate], { windows })).toEqual({ granted: false, retryAt: NOW + 100 });
  });

  test('a call that has left the window counts for nothing', () => {
    expect(run([rate], { windows: [['r', calls(NOW - 1_000, NOW - 100, NOW - 50, NOW)]] })).toMatchObject({ granted: true });
  });

  test('a cost waits until enough of the oldest calls have left', () => {
    const windows: [string, WindowCall[]][] = [['r', calls(NOW - 900, NOW - 600, NOW - 300)]];
    expect(run([rate], { windows, cost: 3 })).toEqual({ granted: false, retryAt: NOW + 400 });
  });

  test('a cost above the whole window waits for an empty one, then takes it all', () => {
    expect(run([rate], { cost: 10, windows: [['r', calls(NOW - 900, NOW - 200)]] })).toEqual({ granted: false, retryAt: NOW + 800 });
    expect(run([rate], { cost: 10 })).toMatchObject({ granted: true, counted: [{ bucket: 'r', call: { at: NOW, cost: 4 } }] });
  });
});

describe('concurrency', () => {
  const one = { key: 'c', concurrent: 2 };

  test('room under the limit grants and holds a place in the bucket', () => {
    expect(run([one], { held: [['c', { count: 1, soonestLapse: NOW + 5 }]] })).toMatchObject({ granted: true, holds: ['c'] });
  });

  test('a full bucket refuses until the first permit lapses', () => {
    expect(run([one], { held: [['c', { count: 2, soonestLapse: NOW + 300 }]] })).toEqual({ granted: false, retryAt: NOW + 300 });
  });

  test('a lapse further off than the recheck interval is not waited for', () => {
    expect(run([one], { held: [['c', { count: 2, soonestLapse: NOW + 60_000 }]] })).toEqual({ granted: false, retryAt: NOW + 1_000 });
  });
});

describe('several limits at once', () => {
  test('a refusal counts the call in none of them', () => {
    const decision = run([{ key: 'r', calls: 5, perMs: 1_000 }, { key: 'c', concurrent: 1 }], { held: [['c', { count: 1, soonestLapse: NOW + 100 }]] });
    expect(decision.granted).toBe(false);
  });

  test('the latest retry among the refusals stands', () => {
    const decision = run([{ key: 'r', calls: 1, perMs: 1_000 }, { key: 'c', concurrent: 1 }], {
      windows: [['r', calls(NOW)]],
      held: [['c', { count: 1, soonestLapse: NOW + 100 }]],
    });
    expect(decision).toEqual({ granted: false, retryAt: NOW + 1_000 });
  });

  test('a grant counts in every limit', () => {
    const decision = run([{ key: 'r', calls: 5, perMs: 1_000 }, { key: 'c', concurrent: 1 }]);
    expect(decision).toEqual({ granted: true, counted: [{ bucket: 'r', call: { at: NOW, cost: 1 } }], holds: ['c'] });
  });
});

describe('the schema name', () => {
  test('is quoted, and refuses anything that could be SQL', () => {
    expect(schemaIdentifier('lf_postgres_limiter')).toBe('"lf_postgres_limiter"');
    expect(() => schemaIdentifier('x"; drop table y; --')).toThrow();
    expect(() => schemaIdentifier('1abc')).toThrow();
  });
});

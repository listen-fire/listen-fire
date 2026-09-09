// Loop-guard store — the Redis sliding-window counter.
//
// Covers: bucketed windowing (sum over trailing buckets, old buckets fall off),
// the single-pipeline increment+read, the reset, and FAIL-OPEN on Redis error.
//
// The pooled ioredis client is replaced with an in-memory fake that implements
// exactly the surface store.ts touches (pipeline → incrby/expire/mget, del),
// plus a switch to make every op throw so we can prove fail-open.

const fakeStore = new Map<string, number>();
let failNext = false;

class FakePipeline {
  private ops: Array<() => unknown> = [];
  incrby(key: string, amount: number) {
    this.ops.push(() => {
      fakeStore.set(key, (fakeStore.get(key) ?? 0) + amount);
      return fakeStore.get(key);
    });
    return this;
  }
  expire() {
    this.ops.push(() => 1);
    return this;
  }
  mget(...keys: string[]) {
    this.ops.push(() => keys.map((k) => (fakeStore.has(k) ? String(fakeStore.get(k)) : null)));
    return this;
  }
  async exec() {
    if (failNext) throw new Error('redis down');
    return this.ops.map((op) => [null, op()] as [Error | null, unknown]);
  }
}

const fakeClient = {
  pipeline: () => new FakePipeline(),
  del: async (...keys: string[]) => {
    if (failNext) throw new Error('redis down');
    let n = 0;
    for (const k of keys) if (fakeStore.delete(k)) n += 1;
    return n;
  },
};

jest.mock('../../../redisPool', () => ({
  getRedisPool: () => ({
    acquire: async () => fakeClient,
    release: async () => {},
  }),
}));

import { guardKeys, incrementAndSum, resetWindow } from '../store';

beforeEach(() => {
  fakeStore.clear();
  failNext = false;
});

describe('incrementAndSum (sliding window by buckets)', () => {
  it('accumulates within the window and returns the running total', async () => {
    const key = 'loopguard:test:a';
    const base = 1_000_000; // a fixed second-aligned clock (ms)
    const r1 = await incrementAndSum({ key, windowSeconds: 60, amount: 1, nowMs: base });
    const r2 = await incrementAndSum({ key, windowSeconds: 60, amount: 1, nowMs: base + 500 });
    const r3 = await incrementAndSum({ key, windowSeconds: 60, amount: 1, nowMs: base + 1500 });
    expect(r1.total).toBe(1);
    expect(r2.total).toBe(2); // same second bucket → still summed
    expect(r3.total).toBe(3); // next second, still within the 60s window
    expect(r3.failOpen).toBe(false);
  });

  it('drops buckets that have aged out of the window', async () => {
    const key = 'loopguard:test:b';
    const base = 2_000_000;
    await incrementAndSum({ key, windowSeconds: 5, amount: 10, nowMs: base });
    // 10 seconds later — the first bucket is well outside the 5s window.
    const later = await incrementAndSum({
      key,
      windowSeconds: 5,
      amount: 1,
      nowMs: base + 10_000,
    });
    expect(later.total).toBe(1);
  });

  it('sums weighted amounts (writes/tokens, not just firings)', async () => {
    const key = 'loopguard:test:c';
    const base = 3_000_000;
    await incrementAndSum({ key, windowSeconds: 60, amount: 100, nowMs: base });
    const r = await incrementAndSum({ key, windowSeconds: 60, amount: 250, nowMs: base + 100 });
    expect(r.total).toBe(350);
  });

  it('FAILS OPEN on a Redis error (total reflects amount, failOpen flagged)', async () => {
    failNext = true;
    const r = await incrementAndSum({
      key: 'loopguard:test:d',
      windowSeconds: 60,
      amount: 1,
      nowMs: 4_000_000,
    });
    expect(r.failOpen).toBe(true);
    // The amount is returned (never NaN/huge) so a downstream threshold check
    // can't spuriously trip on a broken Redis.
    expect(r.total).toBe(1);
  });
});

describe('resetWindow', () => {
  it('clears the buckets so the next sum starts from zero', async () => {
    const key = 'loopguard:test:e';
    const base = 5_000_000;
    await incrementAndSum({ key, windowSeconds: 60, amount: 5, nowMs: base });
    await resetWindow({ key, windowSeconds: 60, nowMs: base });
    const r = await incrementAndSum({ key, windowSeconds: 60, amount: 1, nowMs: base + 1000 });
    expect(r.total).toBe(1);
  });
});

describe('guardKeys', () => {
  it('namespaces per team and per trigger', () => {
    expect(guardKeys.triggerRate('team1', 'trig1')).toBe('loopguard:rate:team1:trig1');
    expect(guardKeys.teamRuns('team1')).toBe('loopguard:team:runs:team1');
    expect(guardKeys.teamExternalWrites('team1')).toBe('loopguard:team:writes:team1');
  });
});

// The in-memory run host backend held to the contract every backend is held
// to (contract.ts): the live state families and the core's rules over them;
// and to the waits cases every store runs (store_waits.ts, over
// engine-contracts' conformance/store-waits.json).

import { runHostContractCases } from '../contract';
import { memoryRunHostStore } from '../memory_store';
import { storeWaitsCaseNames, storeWaitsCases } from '../store_waits';

const TEAM = '00000000-0000-4000-8000-0000000000a1';

describe('memoryRunHostStore', () => {
  for (const contractCase of runHostContractCases) {
    it(contractCase.name, async () => {
      const store = memoryRunHostStore();
      let runs = 0;
      await contractCase.run({ store, teamId: TEAM, newRun: async () => `run-${++runs}` });
    });
  }
});

describe('memoryRunHostStore keeps waits as every store does', () => {
  const cases = storeWaitsCases();
  for (const waitsCase of cases) {
    it(waitsCase.name, async () => {
      const store = memoryRunHostStore();
      await waitsCase.run({ store, runRows: store, deliveries: store });
    });
  }

  it('every case in the file runs here', () => {
    const named = storeWaitsCaseNames();
    expect(named.length).toBeGreaterThan(0);
    expect(cases.map((c) => c.name)).toEqual(named);
  });
});

// Its own, not the contract's: a store that serves one tenant (listen-fire's,
// a store module over the wire) keeps no row's team to claim by.
describe('memoryRunHostStore keeps each row under its team', () => {
  it("a claim naming a team leases only that team's rows; another team's stay due", async () => {
    const store = memoryRunHostStore();
    await store.work.enqueue({ kind: 'wake_await', key: 'acme-wake', payload: {}, teamId: 'acme' });
    await store.work.enqueue({ kind: 'wake_await', key: 'globex-wake', payload: {}, teamId: 'globex' });
    expect((await store.work.claimDue({ limit: 1, leaseMs: 60_000, teamId: 'globex' })).map((row) => row.key)).toEqual(['globex-wake']);
    expect((await store.work.claimDue({ limit: 10, leaseMs: 60_000 })).map((row) => row.key)).toEqual(['acme-wake']);
  });
});

describe('memoryRunHostStore starts a run an arrival fires under its receipt', () => {
  const start = (teamId: string, listen: string, runId: string) => ({
    teamId,
    listen,
    key: 'Notes::n1:',
    runId,
    file: 'a',
    movement: 'f',
    startedAt: '2026-10-31T09:00:00.000Z',
    input: '{}',
    deliveryId: null,
  });

  it("starts it once per listen and arrival, a team's receipts its own", async () => {
    const store = memoryRunHostStore();
    expect(await store.startArrivalRun(start('acme', 'listen:a:f:1', 'r1'))).toBe(true);
    expect(await store.runStatus({ runId: 'r1' })).toBe('running');
    expect(await store.startArrivalRun(start('acme', 'listen:a:f:1', 'r2'))).toBe(false);
    expect(await store.runStatus({ runId: 'r2' })).toBeNull();
    expect(await store.startArrivalRun(start('acme', 'listen:a:g:1', 'r3'))).toBe(true);
    expect(await store.startArrivalRun(start('globex', 'listen:a:f:1', 'r4'))).toBe(true);
  });

  it("forgets a kept delivery's provider id, so its sender's retry is kept again", async () => {
    const store = memoryRunHostStore();
    const keep = (id: string) =>
      store.keepDelivery({ subscriptionId: 's', delivery: { id, externalId: 'evt-1', receivedAt: '2026-10-31T09:00:00.000Z', source: 'emit', inline: true, events: [] }, work: [] });
    expect(await keep('d1')).toMatchObject({ kept: true });
    expect(await keep('d2')).toEqual({ kept: false });
    await store.forgetDeliveryId({ id: 'd1' });
    expect(await keep('d3')).toMatchObject({ kept: true });
    expect(await keep('d4')).toEqual({ kept: false });
  });
});

// The in-memory run host backend held to the contract every backend is held
// to (contract.ts): the live state families and the core's rules over them;
// and to the waits cases every store runs (store_waits.ts, over
// engine-contracts' conformance/store-waits.json).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { runHostContractCases } from '../contract';
import { memoryRunHostStore } from '../memory_store';
import { storeWaitsCases } from '../store_waits';

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
      await waitsCase.run({ store, segments: store });
    });
  }

  it('every case in the file runs here', () => {
    const file: unknown = JSON.parse(readFileSync(join(dirname(require.resolve('engine-contracts/conformance')), 'store-waits.json'), 'utf8'));
    const named = Array.isArray(Reflect.get(Object(file), 'cases')) ? Reflect.get(Object(file), 'cases').map((c: unknown) => Reflect.get(Object(c), 'case')) : [];
    expect(named.length).toBeGreaterThan(0);
    expect(cases.map((c) => c.name)).toEqual(named);
  });
});

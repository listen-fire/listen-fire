// The run host's contract suite (packages/movement-engine/services/run_host/
// contract.ts) against listen-fire's SQLite backend, driven over its stdio JSON-RPC
// bridge (`listen-fire --contract-store`) by `RpcStoreBackend`: the same cases the
// hosted Postgres backend is held to (the live state families and the cancel
// cases), one fresh state file per case. Then the same cases
// through a third-party store module filling a project's store slot
// (`listen-fire --contract-store-slot`): listen-fire drives the module over the store wire,
// and the module (store_module/forward.mjs) forwards to `listen-fire --contract-store`.
// The delivery receipt's cases (`inbound.*`) run over both bridges too.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cancelContractCases,
  deliveryContractCases,
  rerunContractCases,
  runHostContractCases,
  type DeliveryContractBackend,
  type RerunContractBackend,
  type RecordsContractBackend,
} from 'movement-engine/services/run_host/contract';
import { RpcStoreBackend } from 'movement-engine/services/run_host/rpc_store';
// The tenant every local run belongs to.
const LOCAL_TENANT = 'local';
import { lfBinary } from './lf_bin';
import { withStoreModule } from './store_module/project';
import { RELEASE } from './release';

/** A project whose store slot a store module fills, its state in `path`. */
function storeModuleProject(path: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'lf-contract-slot-'));
  writeFileSync(join(dir, 'lf.yaml'), `engine: ${RELEASE}\n`);
  withStoreModule(dir, path);
  return dir;
}

const bridges = [
  { over: 'the SQLite store', args: (path: string) => ['--contract-store', path] },
  { over: 'a store module', args: (path: string) => ['--contract-store-slot', '--dir', storeModuleProject(path)] },
];

for (const bridge of bridges)
for (const contractCase of [...runHostContractCases, ...cancelContractCases]) {
  test(`${bridge.over}: ${contractCase.name}`, async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'lf-contract-')), 'state.db');
    const backend = new RpcStoreBackend(lfBinary(), bridge.args(path));
    const records: RecordsContractBackend = {
      store: backend.store,
      runs: backend.runs,
      teamId: LOCAL_TENANT,
      newRun: async () => {
        const id = randomUUID();
        await backend.startRun({ id, file: 'f', movement: 'm', startedAt: new Date().toISOString(), input: '{}' });
        return id;
      },
      requestCancel: (input) => backend.requestCancel(input),
      runStatus: (runId) => backend.runStatus(runId),
      completeRun: (runId) => backend.completeRun(runId),
    };
    try {
      await contractCase.run(records);
    } finally {
      await backend.close();
    }
  });
}

for (const bridge of bridges)
for (const contractCase of deliveryContractCases) {
  test(`${bridge.over}: ${contractCase.name}`, async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'lf-contract-')), 'state.db');
    const backend = new RpcStoreBackend(lfBinary(), bridge.args(path));
    const deliveries: DeliveryContractBackend = {
      teamId: LOCAL_TENANT,
      keepDelivery: (input) => backend.keepDelivery(input),
      deliveries: (input) => backend.deliveries(input),
      delivery: (input) => backend.delivery(input),
      sweepDeliveries: (input) => backend.sweepDeliveries(input),
      checkpoint: (input) => backend.checkpoint(input),
      startRun: (input) => backend.startRun(input),
      completeRun: (runId) => backend.completeRun(runId),
      runGet: (input) => backend.runGet(input),
      claimDue: (input) => backend.store.work.claimDue(input),
    };
    try {
      await contractCase.run(deliveries);
    } finally {
      await backend.close();
    }
  });
}

for (const bridge of bridges)
for (const contractCase of rerunContractCases) {
  test(`${bridge.over}: ${contractCase.name}`, async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'lf-contract-')), 'state.db');
    const backend = new RpcStoreBackend(lfBinary(), bridge.args(path));
    try {
      await contractCase.run(rerunBackend(backend));
    } finally {
      await backend.close();
    }
  });
}

function rerunBackend(backend: RpcStoreBackend): RerunContractBackend {
  return {
    startRun: (input) => backend.startRun(input),
    runGet: (input) => backend.runGet(input),
    runSettle: (input) => backend.runSettle(input),
    runRerun: (input) => backend.runRerun(input),
    markFailed: (input) => backend.runs.markFailed(input),
    claimLease: (input) => backend.store.leases.claim(input),
    releaseLease: (input) => backend.store.leases.release(input),
  };
}

// A run an arrival starts, as the embedded host starts one
// (`ArrivalRunStore`): its receipt and its run row in one write, the row
// holding what the run started with, and the receipt its team's.
for (const bridge of bridges) {
  test(`${bridge.over}: an arrival's run takes its receipt with its row, and a receipt is its team's`, async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'lf-contract-')), 'state.db');
    const backend = new RpcStoreBackend(lfBinary(), bridge.args(path));
    const start = (runId: string, teamId: string) => ({
      teamId,
      listen: 'listen:threads:answer:0a1b2c3d',
      key: 'Messages::m1:',
      runId,
      file: 'threads',
      movement: 'answer',
      startedAt: '2026-10-31T09:00:00.000Z',
      input: '{"movementName":"answer"}',
      deliveryId: null,
    });
    try {
      const first = randomUUID();
      assert.equal(await backend.arrivalRuns.startArrivalRun(start(first, LOCAL_TENANT)), true);
      assert.deepEqual(await backend.runGet({ runId: first }).then((row) => row && { file: row.file, movement: row.movement, status: row.status, startedAt: row.startedAt, input: row.input }), {
        file: 'threads',
        movement: 'answer',
        status: 'running',
        startedAt: '2026-10-31T09:00:00.000Z',
        input: '{"movementName":"answer"}',
      });
      // The arrival again: no run.
      const again = randomUUID();
      assert.equal(await backend.arrivalRuns.startArrivalRun(start(again, LOCAL_TENANT)), false);
      assert.equal(await backend.runGet({ runId: again }), null);
      // Another team's listen of the same name takes its own receipt.
      assert.equal(await backend.arrivalRuns.startArrivalRun(start(randomUUID(), 'globex')), true);
    } finally {
      await backend.close();
    }
  });
}

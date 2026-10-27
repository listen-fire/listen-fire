// The run host's contract suite (packages/movement-engine/services/run_host/
// contract.ts) against the Rust lf's Postgres store (@lf/postgres-store, in its
// own `lf` schema), driven over its stdio JSON-RPC bridge
// (`lf --contract-store postgres://… --team <uuid>`) by
// `RpcStoreBackend`: the same cases the hosted Postgres backend and both
// SQLite backends are held to, the callback, cancel and delivery receipt
// cases included.
// Every case's rows are one fresh team's, cleared after it.

import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  callbackContractCases,
  cancelContractCases,
  deliveryContractCases,
  rerunContractCases,
  runHostContractCases,
  type DeliveryContractBackend,
  type RerunContractBackend,
  type RecordsContractBackend,
} from 'movement-engine/services/run_host/contract';
import { RpcStoreBackend } from 'movement-engine/services/run_host/rpc_store';
import { lfBinary } from '../lf_bin';
import { freshTeam, POSTGRES_URL } from './pg';

for (const contractCase of [...runHostContractCases, ...callbackContractCases, ...cancelContractCases]) {
  test(contractCase.name, async () => {
    const { team, clear } = freshTeam();
    const backend = new RpcStoreBackend(lfBinary(), ['--contract-store', POSTGRES_URL, '--team', team]);
    const records: RecordsContractBackend = {
      store: backend.store,
      callbacks: backend.callbacks,
      runs: backend.runs,
      teamId: team,
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
      clear();
    }
  });
}

for (const contractCase of deliveryContractCases) {
  test(contractCase.name, async () => {
    const { team, clear } = freshTeam();
    const backend = new RpcStoreBackend(lfBinary(), ['--contract-store', POSTGRES_URL, '--team', team]);
    const deliveries: DeliveryContractBackend = {
      teamId: team,
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
      clear();
    }
  });
}

for (const contractCase of rerunContractCases) {
  test(contractCase.name, async () => {
    const { team, clear } = freshTeam();
    const backend = new RpcStoreBackend(lfBinary(), ['--contract-store', POSTGRES_URL, '--team', team]);
    try {
      await contractCase.run({
        startRun: (input) => backend.startRun(input),
        runGet: (input) => backend.runGet(input),
        runSettle: (input) => backend.runSettle(input),
        runRerun: (input) => backend.runRerun(input),
        markFailed: (input) => backend.runs.markFailed(input),
        claimLease: (input) => backend.store.leases.claim(input),
        releaseLease: (input) => backend.store.leases.release(input),
      } satisfies RerunContractBackend);
    } finally {
      await backend.close();
      clear();
    }
  });
}

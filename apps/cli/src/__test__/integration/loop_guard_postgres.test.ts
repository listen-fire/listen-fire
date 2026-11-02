// The built-in loop guard over Postgres (`url`: the memory every listen-fire worker
// shares, in its own `lf_guard` schema) held to the loop guard contract
// suite, and shown shared: a second guard opened on the same database replaces
// what the first recorded.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loopGuardContractCases } from 'movement-engine/services/loop_guard/contract';
import { RpcLoopGuard } from 'movement-engine/services/loop_guard/rpc_loop_guard';
import { lfBinary } from '../lf_bin';
import { POSTGRES_URL, psql } from './pg';

for (const contractCase of loopGuardContractCases) {
  test(`over Postgres: ${contractCase.name}`, async () => {
    const guard = new RpcLoopGuard(lfBinary(), ['--contract-guard']);
    try {
      await guard.open({ url: POSTGRES_URL });
      await contractCase.run(guard);
    } finally {
      await guard.close();
    }
  });
}

test('over Postgres: another process opened on the database shares the memory: its write replaces the first one', async () => {
  const [first, second] = [new RpcLoopGuard(lfBinary(), ['--contract-guard']), new RpcLoopGuard(lfBinary(), ['--contract-guard'])];
  try {
    await first.open({ url: POSTGRES_URL });
    await second.open({ url: POSTGRES_URL });
    const one = { adapter: 'attio', recordType: 'Companies', externalId: `shared-${Date.now()}`, writer: 'listen:sync:stamp' };
    await first.recordWrite({ ...one, record: { name: 'Acme' } });
    const remembered = () => psql(`select fingerprint from lf_guard.write_fingerprint where external_id = '${one.externalId}'`);
    const [[byFirst]] = remembered();
    // The second's write to the same record, by the same writer, replaces the first's row.
    await second.recordWrite({ ...one, record: { name: 'Acme Corp' } });
    const rows = remembered();
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0][0], byFirst);
  } finally {
    await first.close();
    await second.close();
  }
});

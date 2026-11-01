// The store slot through the real `listen-fire` binary: a third-party store module
// (store_module/forward.mjs, a process listen-fire drives over the store wire) keeps a
// run's state, and an event carrying an `idempotencyKey` runs each listen
// once — over the default SQLite store and over the store module alike. A
// run's waits cross the wire too: the shared waits cases
// (packages/engine-contracts/conformance/store-waits.json, run by the run
// host's own runner over `RpcStoreBackend`'s families), each sent to
// `listen-fire --contract-store-slot`, which drives the module.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RpcStoreBackend } from 'movement-engine/services/run_host/rpc_store';
import { storeWaitsCases } from 'movement-engine/services/run_host/store_waits';
import { companies, lf, project, served } from './example';
import { lfBinary } from './lf_bin';
import { withStoreModule } from './store_module/project';

function moduleProject(): { dir: string; statePath: string } {
  const dir = project();
  const statePath = join(mkdtempSync(join(tmpdir(), 'lf-store-module-')), 'kept.db');
  withStoreModule(dir, statePath);
  return { dir, statePath };
}

test('a store module fills the store slot: listen-fire run keeps its run there', () => {
  const { dir, statePath } = moduleProject();
  const run = lf(dir, 'run', '--event', 'events/company_created.json');
  assert.equal(run.code, 0, run.out);
  const runId = /^run (\S+) companies:\S+ (?:completed|parked)/m.exec(run.out)?.[1];
  assert.ok(runId !== undefined, run.out);
  assert.match(lf(dir, 'runs').out, new RegExp(`^${runId} .* (?:completed|parked)$`, 'm'));
  // The module's own state file holds it; listen-fire's default one was never made.
  assert.match(lf(dir, 'runs', '--store', statePath).out, new RegExp(`^${runId} `, 'm'));
  assert.throws(() => readFileSync(join(dir, '.lf/state.db')));
});

test('a drain over a store module written before waits sweeps no arrivals and carries on', () => {
  const dir = project();
  withStoreModule(dir, join(mkdtempSync(join(tmpdir(), 'lf-store-module-')), 'kept.db'), { without: ['waits.sweep'] });
  const drained = lf(dir, 'drain', '--until-idle');
  assert.equal(drained.code, 0, drained.out);
});

test('a store module written before arrivals refuses a delivery that reports some, keeping nothing, so its sender sends it again', async () => {
  const dir = project();
  withStoreModule(dir, join(mkdtempSync(join(tmpdir(), 'lf-store-module-')), 'kept.db'), { without: ['waits.log'] });
  const serving = await served(dir);
  try {
    const body = Buffer.from(JSON.stringify({ comments: [{ id: 'comment-1', thread: 'company-1', text: 'hi' }] }));
    const delivered = await fetch(`http://127.0.0.1:${serving.port}/hooks/acme_crm/acme`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-listen-fire-signature': createHmac('sha256', 'dev-acme-webhook-secret').update(body).digest('hex') },
      body,
    });
    assert.equal(delivered.status, 503);
    assert.deepEqual(await delivered.json(), {
      error: 'arrivals_not_kept',
      message: 'the store module acme_store does not answer waits.log (adapter protocol 2.5); a delivery that reports arrivals needs it',
    });
    await serving.waitFor(/not kept: the store module acme_store does not answer waits\.log/);
  } finally {
    await serving.stop();
  }
  // Nothing was kept: no receipt holds the delivery's id, so the resend is not a duplicate.
  const kept = lf(dir, 'deliveries', '--json');
  assert.deepEqual(JSON.parse(kept.out), { deliveries: [] }, kept.out);
});

test('listen-fire connect lists an installed store module beside the built-ins', () => {
  const { dir } = moduleProject();
  assert.match(lf(dir, 'connect').out, /^acme_store {2}installed store module; set up \(listen-fire connect acme_store\)$/m);
});

function keyedEvent(dir: string, key: string): string {
  const file = join(dir, 'events/keyed.json');
  const event = JSON.parse(readFileSync(join(dir, 'events/company_created.json'), 'utf8')) as { event: { arrivals: Array<Record<string, unknown>> } };
  for (const arrival of event.event.arrivals) arrival.identity = key;
  writeFileSync(file, JSON.stringify(event));
  return 'events/keyed.json';
}

for (const [over, make] of [
  ['the SQLite store', () => project()],
  ['a store module', () => moduleProject().dir],
] as const) {
  test(`${over}: a redelivered arrival (same identity) runs nothing`, () => {
    const dir = make();
    const event = keyedEvent(dir, 'delivery-1');
    const first = lf(dir, 'run', '--event', event);
    assert.match(first.out, /^run \S+ companies:\S+ (?:completed|parked)/m);
    const again = lf(dir, 'run', '--event', event);
    assert.equal(again.code, 0, again.out);
    assert.match(again.out, /companies:welcome has run the arrival delivery-1 on Company before: this delivery runs nothing/);
    assert.doesNotMatch(again.out, /^run /m);
    assert.equal(companies(dir).length, 1, companies(dir).join(', '));
    // Another identity is another occurrence.
    assert.match(lf(dir, 'run', '--event', keyedEvent(dir, 'delivery-2')).out, /^run \S+ companies:\S+ (?:completed|parked)/m);
  });
}

for (const waitsCase of storeWaitsCases()) {
  test(`a store module keeps a run's waits: ${waitsCase.name}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lf-waits-slot-'));
    writeFileSync(join(dir, 'lf.yaml'), 'engine: 0.13.0\n');
    withStoreModule(dir, join(mkdtempSync(join(tmpdir(), 'lf-waits-state-')), 'kept.db'));
    const store = new RpcStoreBackend(lfBinary(), ['--contract-store-slot', '--dir', dir]);
    try {
      await waitsCase.run({ store: store.store, runRows: store.runRows, deliveries: store.deliveryRows });
    } finally {
      await store.close();
    }
  });
}

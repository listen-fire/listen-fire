// The store slot through the real `listen-fire` binary: a third-party store module
// (store_module/forward.mjs, a process listen-fire drives over the store wire) keeps a
// run's state, and an event carrying an `idempotencyKey` runs each listen
// once — over the default SQLite store and over the store module alike. A
// run's waits cross the wire too: the shared waits cases
// (packages/engine-contracts/conformance/store-waits.json), each sent to
// `listen-fire --contract-store-slot`, which drives the module.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { RpcStoreBackend } from 'movement-engine/services/run_host/rpc_store';
import { RunLeaseLost } from 'movement-engine/services/movement_engine/errors';
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
  const event = JSON.parse(readFileSync(join(dir, 'events/company_created.json'), 'utf8')) as { event: Record<string, unknown> };
  event.event.idempotencyKey = key;
  writeFileSync(file, JSON.stringify(event));
  return 'events/keyed.json';
}

for (const [over, make] of [
  ['the SQLite store', () => project()],
  ['a store module', () => moduleProject().dir],
] as const) {
  test(`${over}: a redelivered event (same idempotencyKey) runs nothing; a dry run notes no receipt`, () => {
    const dir = make();
    const event = keyedEvent(dir, 'delivery-1');
    const dry = lf(dir, 'run', '--dry-run', '--event', event);
    assert.equal(dry.code, 0, dry.out);
    const first = lf(dir, 'run', '--event', event);
    assert.match(first.out, /^run \S+ companies:\S+ (?:completed|parked)/m);
    const again = lf(dir, 'run', '--event', event);
    assert.equal(again.code, 0, again.out);
    assert.match(again.out, /has run the event delivery-1 before: this delivery runs nothing/);
    assert.doesNotMatch(again.out, /^run /m);
    assert.equal(companies(dir).length, 1, companies(dir).join(', '));
    // Another key is another occurrence.
    assert.match(lf(dir, 'run', '--event', keyedEvent(dir, 'delivery-2')).out, /^run \S+ companies:\S+ (?:completed|parked)/m);
  });
}

const WaitsCases = z.object({ cases: z.array(z.object({ case: z.string(), steps: z.array(z.record(z.string(), z.unknown())) })) });
const waitsCases = WaitsCases.parse(
  JSON.parse(readFileSync(join(__dirname, '../../../../packages/engine-contracts/conformance/store-waits.json'), 'utf8')),
).cases;
const Wake = z.object({ runId: z.string(), waitId: z.string(), address: z.string() });
const Arrivals = z.object({
  gone: z.boolean(),
  arrivals: z.array(z.object({ seq: z.number(), identity: z.string(), version: z.string().nullable(), landing: z.unknown() })),
});

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;
}

function text(value: unknown, key: string): string {
  const found = field(value, key);
  if (typeof found !== 'string') throw new Error(`${key}: expected a string in ${JSON.stringify(value)}`);
  return found;
}

function items(value: unknown, key: string): unknown[] {
  const found = field(value, key);
  if (!Array.isArray(found)) throw new Error(`${key}: expected a list in ${JSON.stringify(value)}`);
  return found;
}

const byWait = (a: z.infer<typeof Wake>, b: z.infer<typeof Wake>) => a.waitId.localeCompare(b.waitId);

/** One case, step by step, over the wire (the Rust runner in crates/lf/src/waits.rs reads it alike). */
async function runWaitsCase(store: RpcStoreBackend, steps: Record<string, unknown>[]): Promise<void> {
  const ids = new Map<string, string>();
  const id = (name: string) => {
    const known = ids.get(name);
    if (known !== undefined) return known;
    const made = randomUUID();
    ids.set(name, made);
    return made;
  };
  const marks = new Map<string, number>();
  const waits = new Map<string, string>();
  const wait = (name: string) => waits.get(name) ?? assert.fail(`no wait named ${name}`);
  const listed = new Map<string, { seq: number; identity: string }>();
  const leases = new Map<string, string>();
  const listedArrival = (name: string) => listed.get(name) ?? assert.fail(`no arrival named ${name}`);
  // Given, or a listed arrival's (`identityOf`), or a listed arrival's seq as bare text (`identityIsSeqOf`).
  const identityIn = (value: unknown): unknown => {
    const of = field(value, 'identityOf');
    if (typeof of === 'string') return listedArrival(of).identity;
    const seqOf = field(value, 'identityIsSeqOf');
    if (typeof seqOf === 'string') return String(listedArrival(seqOf).seq);
    return field(value, 'identity') ?? null;
  };
  for (const run of new Set(steps.flatMap((step) => (typeof step.run === 'string' ? [step.run] : [])))) {
    await store.startRun({ id: id(run), file: 'f', movement: 'm', startedAt: new Date().toISOString(), input: '{}' });
  }
  for (const [index, step] of steps.entries()) {
    const at = `step ${index + 1}`;
    const teamId = id(typeof step.team === 'string' ? step.team : 't');
    const adapterType = typeof step.adapter === 'string' ? step.adapter : 'acme';
    const offset = (key: string) => {
      const ms = step[key];
      return new Date(Date.now() + (typeof ms === 'number' ? ms : 0)).toISOString();
    };
    switch (text(step, 'do')) {
      case 'mark':
        marks.set(text(step, 'as'), await store.call('waits.mark', {}, z.number()));
        break;
      case 'log': {
        const arrivals = items(step, 'arrivals').map((a) => ({ ...Object(a), identity: identityIn(a) }));
        const wakes = await store.call('waits.log', { teamId, adapterType, arrivals, at: offset('at') }, z.array(Wake));
        const expected = items(step, 'wakes').map((w) => ({ runId: id(text(w, 'run')), waitId: wait(text(w, 'wait')), address: text(w, 'address') }));
        assert.deepEqual(wakes.sort(byWait), expected.sort(byWait), `${at}: the wakes`);
        break;
      }
      case 'open': {
        const since = marks.get(text(step, 'since')) ?? assert.fail(`no mark named ${text(step, 'since')}`);
        const params = { runId: id(text(step, 'run')), teamId, adapterType, edge: text(step, 'edge'), key: text(step, 'key'), since };
        const { waitId } = await store.call('waits.open', params, z.object({ waitId: z.string() }));
        if (typeof step.same === 'string') assert.equal(waitId, wait(step.same), `${at}: the same wait`);
        else assert.ok(![...waits.values()].includes(waitId), `${at}: a new wait`);
        waits.set(text(step, 'as'), waitId);
        break;
      }
      case 'arrivals': {
        const got = await store.call('waits.arrivals', { waitId: wait(text(step, 'wait')) }, Arrivals);
        assert.equal(got.gone, step.gone === true, `${at}: gone`);
        const expected = items(step, 'arrivals');
        assert.equal(got.arrivals.length, expected.length, `${at}: ${JSON.stringify(got.arrivals)}`);
        got.arrivals.forEach((arrival, i) => {
          if (i > 0) assert.ok(got.arrivals[i - 1].seq < arrival.seq, `${at}: in log order`);
          for (const key of ['identity', 'version', 'landing'] as const) {
            if (Object.hasOwn(Object(expected[i]), key)) assert.deepEqual(arrival[key], field(expected[i], key), `${at}: ${key}`);
          }
          const name = field(expected[i], 'as');
          if (typeof name === 'string') listed.set(name, arrival);
        });
        break;
      }
      case 'note': {
        const leaf = typeof step.leaf === 'string' ? { leaf: step.leaf } : {};
        const fence = typeof step.fence === 'string' ? { fence: leases.get(step.fence) ?? assert.fail(`no lease named ${step.fence}`) } : {};
        const params = { waitId: wait(text(step, 'wait')), identity: identityIn(step), version: step.version ?? null, matched: step.matched === true, ...leaf, ...fence };
        if (step.leaseLost === true) await assert.rejects(store.call('waits.note', params, z.boolean()), RunLeaseLost, `${at}: the lease is lost`);
        else assert.equal(await store.call('waits.note', params, z.boolean()), step.counts === true, `${at}: counts`);
        break;
      }
      case 'park': {
        const park = { kind: 'wait', waitId: wait(text(step, 'wait')) };
        await store.call('parks.commit', { runId: id(text(step, 'run')), address: text(step, 'address'), state: null, fence: null, park }, z.null());
        break;
      }
      case 'commitSegment': {
        const parks = items(step, 'parks').map((held) => {
          const named = field(held, 'wait');
          const park = typeof named === 'string' ? { kind: 'wait', waitId: wait(named) } : { kind: 'timer', wakeAt: new Date(Date.now() + Number(field(held, 'wakeAt'))).toISOString() };
          return { address: text(held, 'address'), state: null, park };
        });
        const joins = (Array.isArray(step.joins) ? step.joins : []).map((join) => ({ frameAddress: text(join, 'frame'), pending: field(join, 'pending') }));
        const fence = typeof step.fence === 'string' ? (leases.get(step.fence) ?? assert.fail(`no lease named ${step.fence}`)) : null;
        const resumed = typeof step.resumed === 'string' ? step.resumed : null;
        const params = { runId: id(text(step, 'run')), teamId, fence, resumed, joins, parks };
        if (step.leaseLost === true) await assert.rejects(store.call('parks.commitSegment', params, z.array(Wake)), RunLeaseLost, `${at}: the lease is lost`);
        else if (step.refused === true) await assert.rejects(store.call('parks.commitSegment', params, z.array(Wake)), `${at}: refused`);
        else {
          const wakes = await store.call('parks.commitSegment', params, z.array(Wake));
          const expected = items(step, 'wakes').map((w) => ({ runId: id(text(w, 'run')), waitId: wait(text(w, 'wait')), address: text(w, 'address') }));
          assert.deepEqual(wakes.sort(byWait), expected.sort(byWait), `${at}: the wakes`);
        }
        break;
      }
      case 'pendingJoins':
        assert.equal(await store.call('joins.hasPendingJoins', { runId: id(text(step, 'run')) }, z.boolean()), step.pending === true, `${at}: pending joins`);
        break;
      case 'claim': {
        const claimed = await store.call('parks.claimLeaf', { runId: id(text(step, 'run')), address: text(step, 'address'), reason: null }, z.unknown());
        assert.equal(claimed !== null, step.parked !== false, `${at}: the leaf is parked`);
        break;
      }
      case 'lease': {
        const ttlMs = typeof step.ttlMs === 'number' ? step.ttlMs : 60_000;
        const lease = await store.call('leases.claim', { runId: id(text(step, 'run')), ttlMs }, z.object({ token: z.string() }).nullable());
        leases.set(text(step, 'as'), lease?.token ?? assert.fail(`${at}: the lease is free`));
        break;
      }
      case 'finish':
        await store.call('parks.finishLeaf', { runId: id(text(step, 'run')), address: text(step, 'address'), fence: null }, z.null());
        break;
      case 'lapse': {
        const lease = await store.call('leases.claim', { runId: id(text(step, 'run')), ttlMs: 60_000 }, z.unknown());
        assert.notEqual(lease, null, `${at}: the lease is free`);
        break;
      }
      case 'deleteLeaves':
        await store.call('parks.deleteLeaves', { runId: id(text(step, 'run')), addresses: items(step, 'addresses') }, z.null());
        break;
      case 'drop':
        assert.equal(await store.call('leases.dropRunState', { runId: id(text(step, 'run')), fence: null }, z.boolean()), true, `${at}: dropped`);
        break;
      case 'sweep':
        await store.call('waits.sweep', { before: offset('before'), limit: 1000 }, z.number());
        break;
      default:
        assert.fail(`${at}: no step ${text(step, 'do')}`);
    }
  }
}

for (const { case: name, steps } of waitsCases) {
  test(`a store module keeps a run's waits: ${name}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lf-waits-slot-'));
    writeFileSync(join(dir, 'lf.yaml'), 'engine: 0.13.0\n');
    withStoreModule(dir, join(mkdtempSync(join(tmpdir(), 'lf-waits-state-')), 'kept.db'));
    const store = new RpcStoreBackend(lfBinary(), ['--contract-store-slot', '--dir', dir]);
    try {
      await runWaitsCase(store, steps);
    } finally {
      await store.close();
    }
  });
}

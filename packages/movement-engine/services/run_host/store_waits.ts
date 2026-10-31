// The waits cases every store is held to (engine-contracts'
// conformance/store-waits.json, whose `about` says what each step does), run
// over a store's families as this package's run host reaches them. The Rust
// runner in crates/lf/src/waits.rs reads the same file over listen-fire's
// stores; this one holds the in-memory store (its jest set) and a store
// module over the store slot's wire (`RpcStoreBackend`, apps/cli's set).
//
// Runner-agnostic: each case is a name and an async body that throws on
// failure (node:assert), so jest and node:test both wrap the same list.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { RunLeaseLost } from '../movement_engine/errors';
import { DEFAULT_RESEND_WINDOW_MS } from './rules';
import { WAKE_AWAIT_WORK_KIND } from './store';
import type { DeliveryRowStore, DeliveryWait, ListedArrival, NewArrival, ParkKind, RunHostStore, RunRowStore, StrandedWait, WaitWake } from './store';

export interface StoreWaitsBackend {
  store: RunHostStore;
  runRows: RunRowStore;
  deliveries: DeliveryRowStore;
}

export interface StoreWaitsCase {
  name: string;
  run(backend: StoreWaitsBackend): Promise<void>;
}

type Step = Record<string, unknown>;

/** Beside engine-contracts' conformance entry, in its source and its build. */
function casesFile(): string {
  return join(dirname(require.resolve('engine-contracts/conformance')), 'store-waits.json');
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;
}

function text(value: unknown, key: string): string {
  const found = field(value, key);
  if (typeof found !== 'string') throw new Error(`${key}: expected a string in ${JSON.stringify(value)}`);
  return found;
}

function optionalText(value: unknown, key: string): string | null {
  const found = field(value, key);
  return typeof found === 'string' ? found : null;
}

function items(value: unknown, key: string): unknown[] {
  const found = field(value, key);
  if (!Array.isArray(found)) throw new Error(`${key}: expected a list in ${JSON.stringify(value)}`);
  return found;
}

function texts(value: unknown, key: string): string[] {
  return items(value, key).map((item) => {
    if (typeof item !== 'string') throw new Error(`${key}: expected strings in ${JSON.stringify(value)}`);
    return item;
  });
}

const byWait = (a: WaitWake, b: WaitWake): number => a.waitId.localeCompare(b.waitId);

/** One case's names for the ids it makes: runs and teams a fresh uuid each,
 *  marks, waits and leases as the store answered them. */
class Names {
  private readonly ids = new Map<string, string>();
  readonly marks = new Map<string, number>();
  readonly waits = new Map<string, string>();
  readonly listed = new Map<string, ListedArrival>();
  readonly leases = new Map<string, string>();

  id(name: string): string {
    const known = this.ids.get(name);
    if (known !== undefined) return known;
    const made = randomUUID();
    this.ids.set(name, made);
    return made;
  }

  wait(name: string): string {
    return this.waits.get(name) ?? assert.fail(`no wait named ${name}`);
  }

  lease(name: string): string {
    return this.leases.get(name) ?? assert.fail(`no lease named ${name}`);
  }

  /** An arrival's or a note's identity: given, or a listed arrival's
   *  (`identityOf`), or a listed arrival's seq as bare text (`identityIsSeqOf`). */
  identity(step: unknown): string | null {
    const of = optionalText(step, 'identityOf');
    if (of !== null) return (this.listed.get(of) ?? assert.fail(`no arrival named ${of}`)).identity;
    const seqOf = optionalText(step, 'identityIsSeqOf');
    if (seqOf !== null) return String((this.listed.get(seqOf) ?? assert.fail(`no arrival named ${seqOf}`)).seq);
    return optionalText(step, 'identity');
  }

  /** The case's name for an id it made: a wait's or a run's. */
  nameOf(id: string): string {
    for (const named of [this.waits, this.ids]) for (const [name, made] of named) if (made === id) return name;
    return id;
  }

  /** A stranded wait as a case writes it: by its wait's and (`withRun`)
   *  its run's names, its keys in that order. */
  stranded(wait: StrandedWait, withRun: boolean): Record<string, unknown> {
    const shown: Record<string, unknown> = { wait: this.nameOf(wait.waitId), edge: wait.edge, key: wait.key, parked: wait.parked };
    return withRun ? { ...shown, run: this.nameOf(wait.runId) } : shown;
  }

  /** The step's list `key` of `{ run, wait, address }`. */
  wakes(step: unknown, key: 'wakes' | 'queued' = 'wakes'): WaitWake[] {
    return items(step, key).map((w) => ({ runId: this.id(text(w, 'run')), waitId: this.wait(text(w, 'wait')), address: text(w, 'address') }));
  }
}

const fromNow = (ms: unknown): string => new Date(Date.now() + (typeof ms === 'number' ? ms : 0)).toISOString();

/** A log step's arrivals, as `waits.log` takes them. */
function newArrivals(names: Names, step: Step): NewArrival[] {
  return items(step, 'arrivals').map((a) => ({
    edge: text(a, 'edge'),
    key: text(a, 'key'),
    identity: names.identity(a),
    version: optionalText(a, 'version'),
    landing: field(a, 'landing') ?? null,
    gone: field(a, 'gone') === true,
  }));
}

/** The step's re-send window: an hour when it gives none, as a module that declares none has. */
const resendWindowOf = (step: Step): number => (typeof step.resendWindowMs === 'number' ? step.resendWindowMs : DEFAULT_RESEND_WINDOW_MS);

const fireKeyOf = (names: Names, step: Step): string => `fire_event:${names.id(text(step, 'fire'))}`;

async function runCase({ store, runRows, deliveries }: StoreWaitsBackend, steps: readonly Step[], unstarted: readonly string[]): Promise<void> {
  const names = new Names();
  // A run a delivery queued is started only by a `start` step, as the drain starts it.
  for (const run of new Set(steps.flatMap((step) => (typeof step.run === 'string' && !unstarted.includes(step.run) ? [step.run] : [])))) {
    await runRows.startRun({ runId: names.id(run) });
  }
  for (const [index, step] of steps.entries()) {
    const at = `step ${index + 1}`;
    const teamId = names.id(optionalText(step, 'team') ?? 't');
    const adapterType = optionalText(step, 'adapter') ?? 'acme';
    const runId = (): string => names.id(text(step, 'run'));
    const fence = (): { fence?: string } => {
      const named = optionalText(step, 'fence');
      return named === null ? {} : { fence: names.lease(named) };
    };
    const action = text(step, 'do');
    switch (action) {
      case 'mark':
        names.marks.set(text(step, 'as'), await store.waits.mark());
        break;
      case 'log': {
        const arrivals = newArrivals(names, step);
        const { wakes, stranded } = await store.waits.log({ teamId, adapterType, arrivals, at: fromNow(step.at), resendWindowMs: resendWindowOf(step) });
        assert.deepEqual(wakes.sort(byWait), names.wakes(step).sort(byWait), `${at}: the wakes`);
        const strands = Array.isArray(step.stranded) ? texts(step, 'stranded').map((name) => names.wait(name)) : [];
        assert.deepEqual(stranded.map((wait) => wait.waitId).sort(), strands.sort(), `${at}: the waits stranded`);
        if (step.queued !== undefined) {
          const rows = await store.work.claimDue({ limit: 1000, leaseMs: 60_000, kinds: [WAKE_AWAIT_WORK_KIND] });
          const queued = rows.map(({ payload }) => ({ runId: text(payload, 'runId'), waitId: text(payload, 'waitId'), address: text(payload, 'address') }));
          assert.deepEqual(queued.sort(byWait), names.wakes(step, 'queued').sort(byWait), `${at}: the wake rows queued`);
        }
        break;
      }
      case 'open': {
        const since = names.marks.get(text(step, 'since')) ?? assert.fail(`no mark named ${text(step, 'since')}`);
        const { waitId } = await store.waits.open({ runId: runId(), teamId, adapterType, edge: text(step, 'edge'), key: optionalText(step, 'key'), since });
        const same = optionalText(step, 'same');
        if (same !== null) assert.equal(waitId, names.wait(same), `${at}: the same wait`);
        else assert.ok(![...names.waits.values()].includes(waitId), `${at}: a new wait`);
        names.waits.set(text(step, 'as'), waitId);
        break;
      }
      case 'arrivals': {
        const got = await store.waits.arrivals({ waitId: names.wait(text(step, 'wait')) });
        const expected = items(step, 'arrivals');
        assert.equal(got.arrivals.length, expected.length, `${at}: ${JSON.stringify(got.arrivals)}`);
        got.arrivals.forEach((arrival, i) => {
          if (i > 0) assert.ok(got.arrivals[i - 1].seq < arrival.seq, `${at}: in log order`);
          for (const key of ['identity', 'version', 'landing'] as const) {
            if (Object.hasOwn(Object(expected[i]), key)) assert.deepEqual(arrival[key] ?? null, field(expected[i], key), `${at}: ${key}`);
          }
          const name = optionalText(expected[i], 'as');
          if (name !== null) names.listed.set(name, arrival);
        });
        break;
      }
      case 'note': {
        const identity = names.identity(step) ?? assert.fail(`${at}: no identity`);
        const leaf = optionalText(step, 'leaf');
        const noted = store.waits.note({
          waitId: names.wait(text(step, 'wait')),
          identity,
          version: optionalText(step, 'version'),
          matched: step.matched === true,
          ...(leaf !== null ? { leaf } : {}),
          ...fence(),
        });
        if (step.leaseLost === true) await assert.rejects(noted, RunLeaseLost, `${at}: the lease is lost`);
        else assert.equal(await noted, step.counts === true, `${at}: counts`);
        break;
      }
      case 'park':
        await store.parks.commit({ runId: runId(), teamId, address: text(step, 'address'), state: null, park: { kind: 'wait', waitId: names.wait(text(step, 'wait')) } });
        break;
      case 'commitSegment': {
        const parks = items(step, 'parks').map((held) => {
          const named = optionalText(held, 'wait');
          const park: ParkKind = named !== null ? { kind: 'wait', waitId: names.wait(named) } : { kind: 'timer', wakeAt: fromNow(field(held, 'wakeAt')) };
          return { address: text(held, 'address'), state: null, park };
        });
        const joins = (Array.isArray(step.joins) ? step.joins : []).map((join) => ({ frameAddress: text(join, 'frame'), pending: Number(field(join, 'pending')) }));
        const settle = optionalText(step, 'settle');
        const committed = store.parks.commitSegment({
          runId: runId(),
          teamId,
          ...fence(),
          resumed: optionalText(step, 'resumed'),
          joins,
          parks,
          settle: settle !== null ? { status: settle, outcome: {}, at: fromNow(0) } : null,
          owedRaces: (Array.isArray(step.owes) ? texts(step, 'owes') : []).map((frameAddress) => ({ frameAddress, state: null })),
          settledRace: optionalText(step, 'settles'),
        });
        if (step.leaseLost === true) await assert.rejects(committed, RunLeaseLost, `${at}: the lease is lost`);
        else if (step.refused === true) await assert.rejects(committed, `${at}: refused`);
        else assert.deepEqual((await committed).sort(byWait), names.wakes(step).sort(byWait), `${at}: the wakes`);
        break;
      }
      case 'status':
        assert.equal(await runRows.runStatus({ runId: runId() }), text(step, 'status'), `${at}: the run's status`);
        break;
      case 'owed':
        assert.deepEqual((await store.parks.owedRaces({ runId: runId() })).map((race) => race.frameAddress), texts(step, 'races'), `${at}: the races owed`);
        break;
      case 'deleteFrames':
        await store.joins.deleteFrames({ runId: runId(), frameAddresses: texts(step, 'frames') });
        break;
      case 'pendingJoins':
        assert.equal(await store.joins.hasPendingJoins({ runId: runId() }), step.pending === true, `${at}: pending joins`);
        break;
      case 'claim': {
        const claimed = await store.parks.claimLeaf({ runId: runId(), address: text(step, 'address') });
        assert.equal(claimed !== null, step.parked !== false, `${at}: the leaf is parked`);
        break;
      }
      case 'lease': {
        const lease = await store.leases.claim({ runId: runId(), ttlMs: typeof step.ttlMs === 'number' ? step.ttlMs : 60_000 });
        names.leases.set(text(step, 'as'), lease?.token ?? assert.fail(`${at}: the lease is free`));
        break;
      }
      case 'finish':
        await store.parks.finishLeaf({ runId: runId(), address: text(step, 'address') });
        break;
      case 'lapse':
        assert.notEqual(await store.leases.claim({ runId: runId(), ttlMs: 60_000 }), null, `${at}: the lease is free`);
        break;
      case 'deleteLeaves':
        await store.parks.deleteLeaves({ runId: runId(), addresses: texts(step, 'addresses') });
        break;
      case 'drop':
        assert.equal(await store.leases.dropRunState({ runId: runId() }), true, `${at}: dropped`);
        break;
      case 'sweep': {
        const floor = optionalText(step, 'floor');
        const held = floor === null ? {} : { floor: names.marks.get(floor) ?? assert.fail(`no mark named ${floor}`) };
        assert.deepEqual(await store.waits.sweep({ limit: Number(step.limit), ...held }), { swept: Number(step.expect) }, `${at}: how many the sweep forgot`);
        break;
      }
      case 'keepDelivery': {
        const fireKey = fireKeyOf(names, step);
        const waits: DeliveryWait[] = items(step, 'waits').map((w) => {
          const noted = field(w, 'preNoted');
          return {
            runId: names.id(text(w, 'run')),
            edge: text(w, 'edge'),
            key: optionalText(w, 'key'),
            fireKey,
            ...(noted !== undefined ? { preNoted: { identity: text(noted, 'identity'), version: optionalText(noted, 'version') } } : {}),
          };
        });
        const kept = await deliveries.keepDelivery({
          subscriptionId: names.id('subscription'),
          delivery: { id: randomUUID(), externalId: null, receivedAt: fromNow(0), source: 'webhook', inline: false, events: [] },
          work: [{ kind: 'fire_event', key: fireKey, payload: {}, teamId }],
          arrivals: { teamId, adapterType, arrivals: newArrivals(names, step), at: fromNow(0), resendWindowMs: resendWindowOf(step) },
          waits,
        });
        assert.ok(kept.kept, `${at}: kept`);
        const mark = text(step, 'arrivalMark');
        assert.equal(kept.arrivalMark, names.marks.get(mark) ?? assert.fail(`no mark named ${mark}`), `${at}: the mark before its arrivals`);
        for (const [i, wait] of waits.entries()) {
          // The wait its run's own open finds: the one the delivery opened.
          const { waitId } = await store.waits.open({ runId: wait.runId, teamId, adapterType, edge: wait.edge, key: wait.key, since: 0 });
          names.waits.set(text(items(step, 'waits')[i], 'as'), waitId);
        }
        break;
      }
      case 'start':
        await runRows.startRun({ runId: names.id(text(step, 'minted')) });
        break;
      case 'bury': {
        const key = fireKeyOf(names, step);
        const rows = await store.work.claimDue({ limit: 1000, leaseMs: 60_000, kinds: ['fire_event'], teamId });
        const row = rows.find((claimed) => claimed.key === key) ?? assert.fail(`${at}: ${key} is not queued`);
        await deliveries.bury({ ...row, reason: 'gave up' });
        break;
      }
      case 'stranded': {
        const got = (await store.waits.stranded({ runId: runId() })).map((wait) => names.stranded(wait, false));
        const expected = items(step, 'waits').map((want) => ({ wait: field(want, 'wait'), edge: field(want, 'edge'), key: field(want, 'key'), parked: field(want, 'parked') }));
        assert.deepEqual(got, expected, `${at}: the run's stranded waits`);
        break;
      }
      case 'everyStranded': {
        const limit = Number(step.limit);
        const every: StrandedWait[] = [];
        for (;;) {
          const last = every.at(-1);
          const page = await store.waits.stranded(last === undefined ? { limit } : { after: { at: last.at, waitId: last.waitId }, limit });
          assert.ok(page.length <= limit, `${at}: a page of at most ${limit}`);
          if (page.length === 0) break;
          every.push(...page);
        }
        every.forEach((wait, i) => {
          const before = every[i - 1];
          if (before !== undefined) assert.ok(before.at < wait.at || (before.at === wait.at && before.waitId < wait.waitId), `${at}: oldest stranded first`);
        });
        const named = new Set(names.waits.values());
        const got = every.filter((wait) => named.has(wait.waitId)).map((wait) => names.stranded(wait, true));
        const expected = items(step, 'waits').map((want) => ({ wait: field(want, 'wait'), edge: field(want, 'edge'), key: field(want, 'key'), parked: field(want, 'parked'), run: field(want, 'run') }));
        assert.deepEqual(got, expected, `${at}: every run's stranded waits`);
        break;
      }
      default:
        assert.fail(`${at}: no step ${action}`);
    }
  }
}

function fileCases(): unknown[] {
  const parsed: unknown = JSON.parse(readFileSync(casesFile(), 'utf8'));
  return items(parsed, 'cases');
}

/** The name of every case in the file, in its order. */
export function storeWaitsCaseNames(): string[] {
  return fileCases().map((entry) => text(entry, 'case'));
}

/** Every case in the file, in its order. */
export function storeWaitsCases(): StoreWaitsCase[] {
  return fileCases().map((entry) => {
    const steps = items(entry, 'steps').map((step) => (typeof step === 'object' && step !== null ? Object.fromEntries(Object.entries(step)) : assert.fail('a step is an object')));
    const unstarted = Array.isArray(field(entry, 'unstarted')) ? texts(entry, 'unstarted') : [];
    return { name: text(entry, 'case'), run: (backend) => runCase(backend, steps, unstarted) };
  });
}

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
import type { ListedArrival, NewArrival, ParkKind, RunHostStore, SegmentCommitStore, WaitWake } from './store';

export interface StoreWaitsBackend {
  store: RunHostStore;
  segments: SegmentCommitStore;
}

export interface StoreWaitsCase {
  name: string;
  run(backend: StoreWaitsBackend): Promise<void>;
}

type Step = Record<string, unknown>;

/** Beside engine-contracts' conformance entry, in its source and its build. */
const CASES_FILE = join(dirname(require.resolve('engine-contracts/conformance')), 'store-waits.json');

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

  wakes(step: unknown): WaitWake[] {
    return items(step, 'wakes').map((w) => ({ runId: this.id(text(w, 'run')), waitId: this.wait(text(w, 'wait')), address: text(w, 'address') }));
  }
}

const fromNow = (ms: unknown): string => new Date(Date.now() + (typeof ms === 'number' ? ms : 0)).toISOString();

async function runCase({ store, segments }: StoreWaitsBackend, steps: readonly Step[]): Promise<void> {
  const names = new Names();
  for (const run of new Set(steps.flatMap((step) => (typeof step.run === 'string' ? [step.run] : [])))) {
    await segments.startRun({ runId: names.id(run) });
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
        const arrivals: NewArrival[] = items(step, 'arrivals').map((a) => ({
          edge: text(a, 'edge'),
          key: text(a, 'key'),
          identity: names.identity(a),
          version: optionalText(a, 'version'),
          landing: field(a, 'landing') ?? null,
          gone: field(a, 'gone') === true,
        }));
        const wakes = await store.waits.log({ teamId, adapterType, arrivals, at: fromNow(step.at) });
        assert.deepEqual(wakes.sort(byWait), names.wakes(step).sort(byWait), `${at}: the wakes`);
        break;
      }
      case 'open': {
        const since = names.marks.get(text(step, 'since')) ?? assert.fail(`no mark named ${text(step, 'since')}`);
        const { waitId } = await store.waits.open({ runId: runId(), teamId, adapterType, edge: text(step, 'edge'), key: text(step, 'key'), since });
        const same = optionalText(step, 'same');
        if (same !== null) assert.equal(waitId, names.wait(same), `${at}: the same wait`);
        else assert.ok(![...names.waits.values()].includes(waitId), `${at}: a new wait`);
        names.waits.set(text(step, 'as'), waitId);
        break;
      }
      case 'arrivals': {
        const got = await store.waits.arrivals({ waitId: names.wait(text(step, 'wait')) });
        assert.equal(got.gone, step.gone === true, `${at}: gone`);
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
        await store.parks.commit({ runId: runId(), address: text(step, 'address'), state: null, park: { kind: 'wait', waitId: names.wait(text(step, 'wait')) } });
        break;
      case 'commitSegment': {
        const parks = items(step, 'parks').map((held) => {
          const named = optionalText(held, 'wait');
          const park: ParkKind = named !== null ? { kind: 'wait', waitId: names.wait(named) } : { kind: 'timer', wakeAt: fromNow(field(held, 'wakeAt')) };
          return { address: text(held, 'address'), state: null, park };
        });
        const joins = (Array.isArray(step.joins) ? step.joins : []).map((join) => ({ frameAddress: text(join, 'frame'), pending: Number(field(join, 'pending')) }));
        const settle = optionalText(step, 'settle');
        const committed = segments.commitSegment({
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
        assert.equal(await segments.runStatus({ runId: runId() }), text(step, 'status'), `${at}: the run's status`);
        break;
      case 'owed':
        assert.deepEqual((await segments.owedRaces({ runId: runId() })).map((race) => race.frameAddress), texts(step, 'races'), `${at}: the races owed`);
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
      case 'sweep':
        await store.waits.sweep({ before: fromNow(step.before), limit: 1000 });
        break;
      default:
        assert.fail(`${at}: no step ${action}`);
    }
  }
}

/** Every case in the file, in its order. */
export function storeWaitsCases(): StoreWaitsCase[] {
  const parsed: unknown = JSON.parse(readFileSync(CASES_FILE, 'utf8'));
  return items(parsed, 'cases').map((entry) => {
    const steps = items(entry, 'steps').map((step) => (typeof step === 'object' && step !== null ? Object.fromEntries(Object.entries(step)) : assert.fail('a step is an object')));
    return { name: text(entry, 'case'), run: (backend) => runCase(backend, steps) };
  });
}

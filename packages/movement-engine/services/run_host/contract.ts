// The run host's contract suite: one set of cases, written against the backend
// families (store.ts) and the core's rules over them, run against every
// backend (the hosted Postgres one in lf-platform's apps/api integration set, `lf`'s
// SQLite one in apps/cli's tests). Ported from the hosted integration tests
// (work store, join_pending, park sink, run lease, await correlation, the
// resume drivers) and lf's state tests, keeping the cases about what the
// state MEANS rather than how one database stores it.
//
// Runner-agnostic: each case is a name and an async body that throws on
// failure (node:assert), so jest and node:test both wrap the same list.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { RunLeaseLost } from '../movement_engine/errors';
import { drainRun, wakeAwaits, type StepLeaf, type StepOutcome, type StepRequest } from './drain';
import { cancelSubtrees, clearIfQuiescent, parkSources, runCompleteWithout, runParkSink, settleIfCancelRequested, abandonRun, type RunHost, type RunRecords } from './rules';
import type { AwaitKeeper, CallbackStore, ClaimedWork, RunHostStore } from './store';
import { CALLBACK_AWAIT_TYPE } from 'engine-contracts';
import {
  callbackAwaitKeeper,
  callbackSink,
  CALLBACK_BODY_WORK_KIND,
  isCallbackId,
  recordCallbackCall,
  runCallbackBody,
  type CallbackBodyOutcome,
} from './callbacks';
import type { HeldRunLease } from './lease';
import type { DeliveryRow, NewDelivery, NewWorkRow, RunRow } from './rpc_store';

export interface ContractBackend {
  store: RunHostStore;
  /** The tenant every run of the case belongs to. */
  teamId: string;
  /** A fresh run the backend can park against. */
  newRun(): Promise<string>;
}

export interface ContractCase {
  name: string;
  run(backend: ContractBackend): Promise<void>;
}

const PAST = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const FUTURE = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const SHORT_MS = 300;
const LAPSE_MS = 700;

function uniqueKey(prefix: string): string {
  return `${prefix}:${Math.random().toString(36).slice(2)}:${Date.now()}`;
}

/** Claim until the row with `key` is among the claims (other rows in a shared
 *  queue may be due too). */
async function claimKey(store: RunHostStore, key: string, leaseMs = 60_000): Promise<ClaimedWork | undefined> {
  const claimed = await store.work.claimDue({ limit: 1000, leaseMs });
  return claimed.find((w) => w.key === key);
}

async function park(store: RunHostStore, runId: string, address: string, extra: { reason?: 'timer' | 'await' | 'limit'; wakeAt?: string | null; state?: unknown } = {}): Promise<void> {
  const reason = extra.reason ?? 'timer';
  await store.parks.putLeaf({
    runId,
    address,
    reason,
    wakeAt: extra.wakeAt !== undefined ? extra.wakeAt : reason === 'timer' ? PAST(1) : null,
    state: extra.state ?? { address },
  });
}

async function branch(store: RunHostStore, runId: string, frame: string, branchAddress: string, index: number): Promise<void> {
  await store.joins.persistBranchExport({ runId, frameAddress: frame, branchAddress, branchIndex: index, exports: { i: index } });
}

async function parkedAddresses(store: RunHostStore, runId: string): Promise<string[]> {
  return (await store.parks.leaves({ runId, parkedOnly: true })).map((l) => l.address).sort();
}

/** A recording run host over the backend: the product's run records and one
 *  record-backed keeper, both in memory. */
function hostOf(backend: ContractBackend, opts: { cancelReason?: string | null; resolvable?: string[] } = {}) {
  const failed: Array<{ runId: string; message: string }> = [];
  const closed: string[] = [];
  const abandoned: Array<{ runId: string; addresses?: readonly string[] }> = [];
  const runs: RunRecords = {
    cancelRequest: async () => (opts.cancelReason === undefined ? null : { reason: opts.cancelReason }),
    markFailed: async (input) => {
      failed.push(input);
    },
    closeRun: async ({ runId }) => {
      closed.push(runId);
    },
  };
  const keeper: AwaitKeeper = {
    adapterType: 'ask',
    loadResolvable: async ({ runId }) => (opts.resolvable ?? []).map((address) => ({ runId, teamId: backend.teamId, address })),
    abandon: async (input) => {
      abandoned.push(input);
    },
  };
  const host: RunHost = { store: backend.store, keepers: [keeper], runs };
  return { host, failed, closed, abandoned };
}

/** A step scripted per leaf address (or race frame): what it does and what it
 *  answers. Records every request. */
function scriptedStep(script: Record<string, (req: StepRequest, settle: { runComplete(): Promise<boolean> }) => Promise<StepOutcome>>) {
  const requests: StepRequest[] = [];
  const step: StepLeaf = async (req, settle) => {
    requests.push(req);
    const key = req.kind === 'leaf' ? req.address : `race:${req.frameAddress}`;
    const body = script[key];
    if (body === undefined) throw new Error(`no scripted step for ${key}`);
    return body(req, settle);
  };
  return { step, requests };
}

export const runHostContractCases: ContractCase[] = [
  // ── Work queue (work/store.integration.test.ts) ──────────────────────────
  {
    name: 'work: a key enqueued twice while unleased keeps the earliest due time and the newest payload',
    async run({ store }) {
      const key = uniqueKey('wake_await');
      await store.work.enqueue({ kind: 'wake_await', key, payload: { n: 1 }, dueAt: FUTURE(10) });
      await store.work.enqueue({ kind: 'wake_await', key, payload: { n: 2 }, dueAt: FUTURE(20) });
      assert.equal(await claimKey(store, key), undefined, 'not due yet');
      await store.work.enqueue({ kind: 'wake_await', key, payload: { n: 3 }, dueAt: PAST(1) });
      const claimed = await claimKey(store, key);
      assert.deepEqual(claimed?.payload, { n: 3 });
      if (claimed) await store.work.complete(claimed);
    },
  },
  {
    name: 'work: a key queued if absent is queued once; a row there, due later or leased, is left as it was',
    async run({ store }) {
      const key = uniqueKey('poll_listen');
      assert.equal(await store.work.enqueueIfAbsent({ kind: 'poll_listen', key, payload: { n: 1 }, dueAt: FUTURE(10) }), true);
      assert.equal(await store.work.enqueueIfAbsent({ kind: 'poll_listen', key, payload: { n: 2 }, dueAt: PAST(1) }), false);
      assert.equal(await claimKey(store, key), undefined, 'still due later: the second arm moved nothing');
      await store.work.enqueue({ kind: 'poll_listen', key, payload: { n: 3 }, dueAt: PAST(1) });
      const held = await claimKey(store, key);
      assert.deepEqual(held?.payload, { n: 3 });
      assert.ok(held);
      // Another worker arms the same listen while the row is held: nothing changes,
      // so the holder's release decides when it is next due.
      assert.equal(await store.work.enqueueIfAbsent({ kind: 'poll_listen', key, payload: { n: 4 }, dueAt: PAST(1) }), false);
      await store.work.release({ ...held, dueAt: FUTURE(30) });
      assert.equal(await claimKey(store, key), undefined, 'due at the release time, not polled again at once');
      const later = await store.work.claimDue({ limit: 1000, leaseMs: 60_000, dueBy: FUTURE(31) });
      const again = later.find((w) => w.key === key);
      assert.deepEqual(again?.payload, { n: 3 }, 'the payload the row had');
      for (const w of later) if (w.key === key) await store.work.complete(w);
      assert.equal(await store.work.enqueueIfAbsent({ kind: 'poll_listen', key, payload: { n: 5 }, dueAt: PAST(1) }), true, 'completed and gone, it is queued again');
      const last = await claimKey(store, key);
      if (last) await store.work.complete(last);
    },
  },
  {
    name: 'work: only due, unleased rows are claimed; a live lease blocks a second claim',
    async run({ store }) {
      const due = uniqueKey('wake_await');
      const later = uniqueKey('wake_await');
      await store.work.enqueue({ kind: 'wake_await', key: due, payload: {}, dueAt: PAST(1) });
      await store.work.enqueue({ kind: 'wake_await', key: later, payload: {}, dueAt: FUTURE(10) });
      const first = await store.work.claimDue({ limit: 1000, leaseMs: 60_000 });
      assert.ok(first.some((w) => w.key === due));
      assert.ok(!first.some((w) => w.key === later));
      const second = await store.work.claimDue({ limit: 1000, leaseMs: 60_000 });
      assert.ok(!second.some((w) => w.key === due), 'leased row is not claimed again');
      for (const w of first) if (w.key === due) await store.work.complete(w);
    },
  },
  {
    name: 'work: a claim naming kinds leases only rows of those kinds',
    async run({ store }) {
      const timer = uniqueKey('resume_timer');
      const wake = uniqueKey('wake_await');
      await store.work.enqueue({ kind: 'resume_timer', key: timer, payload: {}, dueAt: PAST(1) });
      await store.work.enqueue({ kind: 'wake_await', key: wake, payload: {}, dueAt: PAST(1) });
      const wakes = await store.work.claimDue({ limit: 1000, leaseMs: 60_000, kinds: ['wake_await'] });
      assert.ok(wakes.some((w) => w.key === wake));
      assert.ok(!wakes.some((w) => w.key === timer), 'a row of another kind is left for its own pool');
      const rest = await store.work.claimDue({ limit: 1000, leaseMs: 60_000 });
      assert.ok(rest.some((w) => w.key === timer));
      for (const w of [...wakes, ...rest]) if (w.key === timer || w.key === wake) await store.work.complete(w);
    },
  },
  {
    name: 'work: a lapsed lease is claimable again, and the stale claim can neither complete nor release it',
    async run({ store }) {
      const key = uniqueKey('wake_await');
      await store.work.enqueue({ kind: 'wake_await', key, payload: {}, dueAt: PAST(1) });
      const stale = await claimKey(store, key, SHORT_MS);
      assert.ok(stale);
      await sleep(LAPSE_MS);
      const fresh = await claimKey(store, key);
      assert.ok(fresh, 'lapsed lease re-claimed');
      await store.work.complete(stale);
      await store.work.release({ ...stale, dueAt: FUTURE(30) });
      assert.equal(await claimKey(store, key), undefined, 'still leased to the fresh claim');
      await store.work.complete(fresh);
    },
  },
  {
    name: 'work: completing a one-shot deletes it',
    async run({ store }) {
      const key = uniqueKey('wake_await');
      await store.work.enqueue({ kind: 'wake_await', key, payload: {}, dueAt: PAST(1) });
      const claimed = await claimKey(store, key, SHORT_MS);
      assert.ok(claimed);
      await store.work.complete(claimed);
      await sleep(LAPSE_MS);
      assert.equal(await claimKey(store, key), undefined);
    },
  },
  {
    name: 'work: a re-arm during the lease survives the completion, due at its new time',
    async run({ store }) {
      const key = uniqueKey('resume_timer');
      await store.work.enqueue({ kind: 'resume_timer', key, payload: { n: 1 }, dueAt: PAST(5) });
      const claimed = await claimKey(store, key);
      assert.ok(claimed);
      await store.work.enqueue({ kind: 'resume_timer', key, payload: { n: 2 }, dueAt: PAST(1) });
      await store.work.complete(claimed);
      const again = await claimKey(store, key);
      assert.deepEqual(again?.payload, { n: 2 }, 're-armed row stayed');
      if (again) await store.work.complete(again);
    },
  },
  {
    name: 'work: a release unleases the row due at its retry time; a re-arm since the claim wins over it',
    async run({ store }) {
      const key = uniqueKey('wake_await');
      await store.work.enqueue({ kind: 'wake_await', key, payload: {}, dueAt: PAST(1) });
      const claimed = await claimKey(store, key);
      assert.ok(claimed);
      await store.work.release({ ...claimed, dueAt: FUTURE(30) });
      assert.equal(await claimKey(store, key), undefined, 'due later now');

      const rearmed = uniqueKey('wake_await');
      await store.work.enqueue({ kind: 'wake_await', key: rearmed, payload: {}, dueAt: PAST(5) });
      const held = await claimKey(store, rearmed);
      assert.ok(held);
      await store.work.enqueue({ kind: 'wake_await', key: rearmed, payload: {}, dueAt: PAST(1) });
      await store.work.release({ ...held, dueAt: FUTURE(30) });
      const again = await claimKey(store, rearmed);
      assert.ok(again, 'the re-arm due time stood');
      await store.work.complete(again);
    },
  },
  {
    name: 'work: two concurrent claims take disjoint rows',
    async run({ store }) {
      const keys = Array.from({ length: 6 }, () => uniqueKey('wake_await'));
      for (const key of keys) await store.work.enqueue({ kind: 'wake_await', key, payload: {}, dueAt: PAST(1) });
      const [a, b] = await Promise.all([store.work.claimDue({ limit: 1000, leaseMs: 60_000 }), store.work.claimDue({ limit: 1000, leaseMs: 60_000 })]);
      const ours = (rows: ClaimedWork[]) => rows.filter((w) => keys.includes(w.key));
      const taken = [...ours(a), ...ours(b)];
      assert.equal(new Set(taken.map((w) => w.key)).size, taken.length, 'no row claimed twice');
      assert.equal(taken.length, keys.length);
      for (const w of taken) await store.work.complete(w);
    },
  },

  // ── Joins (join_pending.integration.test.ts) ─────────────────────────────
  {
    name: 'joins: a re-recorded frame rewrites its count; the last decrement closes it, marking its closer',
    async run({ store, newRun }) {
      const runId = await newRun();
      await store.joins.recordJoin({ runId, frameAddress: 's1', pending: 2 });
      await store.joins.recordJoin({ runId, frameAddress: 's1', pending: 2 });
      await branch(store, runId, 's1', 's1.b0', 0);
      await branch(store, runId, 's1', 's1.b1', 1);
      assert.deepEqual(await store.joins.decrementJoin({ runId, frameAddress: 's1', branchAddress: 's1.b0', leafAddress: 's1.b0.s0' }), { closed: false });
      assert.equal(await store.joins.hasPendingJoins({ runId }), true);
      assert.deepEqual(await store.joins.decrementJoin({ runId, frameAddress: 's1', branchAddress: 's1.b1', leafAddress: 's1.b1.s0' }), { closed: true });
      assert.equal(await store.joins.hasPendingJoins({ runId }), false);
      // A retry of the closer (re-scanned after a crash) is still the closer.
      assert.deepEqual(await store.joins.decrementJoin({ runId, frameAddress: 's1', branchAddress: 's1.b1', leafAddress: 's1.b1.s0' }), { closed: true });
      assert.deepEqual(await store.joins.decrementJoin({ runId, frameAddress: 's1', branchAddress: 's1.b0', leafAddress: 's1.b0.s0' }), { closed: false });
    },
  },
  {
    name: 'joins: a branch decrements exactly once, even re-persisted',
    async run({ store, newRun }) {
      const runId = await newRun();
      await store.joins.recordJoin({ runId, frameAddress: 's1', pending: 2 });
      await branch(store, runId, 's1', 's1.b0', 0);
      await store.joins.decrementJoin({ runId, frameAddress: 's1', branchAddress: 's1.b0', leafAddress: 's1.b0' });
      await branch(store, runId, 's1', 's1.b0', 0);
      assert.deepEqual(await store.joins.decrementJoin({ runId, frameAddress: 's1', branchAddress: 's1.b0', leafAddress: 's1.b0' }), { closed: false });
      assert.equal(await store.joins.hasPendingJoins({ runId }), true, 'one branch still owed');
    },
  },
  {
    name: 'joins: a missing frame never closes; frames of one run are independent',
    async run({ store, newRun }) {
      const runId = await newRun();
      await branch(store, runId, 's9', 's9.b0', 0);
      assert.deepEqual(await store.joins.decrementJoin({ runId, frameAddress: 's9', branchAddress: 's9.b0', leafAddress: 's9.b0' }), { closed: false });
      await store.joins.recordJoin({ runId, frameAddress: 's1', pending: 1 });
      await store.joins.recordJoin({ runId, frameAddress: 's2', pending: 1 });
      await branch(store, runId, 's1', 's1.b0', 0);
      assert.deepEqual(await store.joins.decrementJoin({ runId, frameAddress: 's1', branchAddress: 's1.b0', leafAddress: 's1.b0' }), { closed: true });
      assert.equal(await store.joins.hasPendingJoins({ runId }), true, 's2 still waits');
      assert.deepEqual((await store.joins.frames({ runId })).sort(), ['s1', 's2']);
    },
  },
  {
    name: 'joins: exports collect in branch order; a re-persist rewrites in place',
    async run({ store, newRun }) {
      const runId = await newRun();
      await store.joins.recordJoin({ runId, frameAddress: 's1', pending: 3 });
      await store.joins.persistBranchExport({ runId, frameAddress: 's1', branchAddress: 's1.b2', branchIndex: 2, exports: { v: 'c' } });
      await store.joins.persistBranchExport({ runId, frameAddress: 's1', branchAddress: 's1.b0', branchIndex: 0, exports: { v: 'a' } });
      await store.joins.persistBranchExport({ runId, frameAddress: 's1', branchAddress: 's1.b0', branchIndex: 0, exports: { v: 'a2' } });
      const collected = await store.joins.collectBranchExports({ runId, frameAddress: 's1' });
      assert.deepEqual(collected, [
        { branchAddress: 's1.b0', branchIndex: 0, exports: { v: 'a2' } },
        { branchAddress: 's1.b2', branchIndex: 2, exports: { v: 'c' } },
      ]);
      await store.joins.deleteFrames({ runId, frameAddresses: ['s1'] });
      assert.deepEqual(await store.joins.frames({ runId }), []);
      assert.deepEqual(await store.joins.collectBranchExports({ runId, frameAddress: 's1' }), []);
    },
  },

  // ── Parks and the run lease (park_sink, run_lease) ───────────────────────
  {
    name: 'parks: a re-reached park rewrites its one row; a leaf is claimed once and its claimed row finished',
    async run({ store, newRun }) {
      const runId = await newRun();
      await park(store, runId, 's0', { state: { v: 1 } });
      await park(store, runId, 's0', { state: { v: 2 } });
      assert.deepEqual(await parkedAddresses(store, runId), ['s0']);
      const claimed = await store.parks.claimLeaf({ runId, address: 's0' });
      assert.deepEqual(claimed, { state: { v: 2 }, reason: 'timer' });
      assert.equal(await store.parks.claimLeaf({ runId, address: 's0' }), null);
      assert.deepEqual(await parkedAddresses(store, runId), [], 'a claimed leaf is not parked');
      await store.parks.finishLeaf({ runId, address: 's0' });
      assert.deepEqual(await store.parks.leaves({ runId }), []);
    },
  },
  {
    name: 'parks: a leaf parked again by its own step survives the finish',
    async run({ store, newRun }) {
      const runId = await newRun();
      await park(store, runId, 's0', { reason: 'await' });
      await store.parks.claimLeaf({ runId, address: 's0' });
      await park(store, runId, 's0', { reason: 'await' });
      await store.parks.finishLeaf({ runId, address: 's0' });
      assert.deepEqual(await parkedAddresses(store, runId), ['s0']);
    },
  },
  {
    name: 'parks: claiming by reason and listing by reason and due time',
    async run({ store, newRun }) {
      const runId = await newRun();
      await park(store, runId, 's0', { reason: 'timer', wakeAt: PAST(1) });
      await park(store, runId, 's1', { reason: 'timer', wakeAt: FUTURE(60) });
      await park(store, runId, 's2', { reason: 'await' });
      const due = await store.parks.leaves({ runId, parkedOnly: true, reason: 'timer', dueBy: new Date().toISOString() });
      assert.deepEqual(due.map((l) => l.address), ['s0']);
      assert.equal(await store.parks.claimLeaf({ runId, address: 's2', reason: 'timer' }), null);
      const timers = await store.parks.leaves({ runId, reason: 'timer' });
      assert.deepEqual(timers.map((l) => l.address).sort(), ['s0', 's1']);
      assert.ok(timers.every((t) => t.wakeAt !== null && !Number.isNaN(Date.parse(t.wakeAt))));
    },
  },
  {
    name: 'lease: one holder at a time; a lapsed lease is taken over and the stale token can neither renew nor release it',
    async run({ store, newRun }) {
      const runId = await newRun();
      const first = await store.leases.claim({ runId, ttlMs: SHORT_MS });
      assert.ok(first);
      assert.equal(await store.leases.claim({ runId, ttlMs: 60_000 }), null);
      assert.equal(await store.leases.renew({ runId, token: first.token, ttlMs: SHORT_MS }), true);
      await sleep(LAPSE_MS);
      assert.equal(await store.leases.renew({ runId, token: first.token, ttlMs: SHORT_MS }), false, 'a lapsed lease is not revived');
      const second = await store.leases.claim({ runId, ttlMs: 60_000 });
      assert.ok(second);
      await store.leases.release({ runId, token: first.token });
      assert.equal(await store.leases.claim({ runId, ttlMs: 60_000 }), null, 'stale release changed nothing');
      await store.leases.release({ runId, token: second.token });
      assert.ok(await store.leases.claim({ runId, ttlMs: 60_000 }));
    },
  },
  {
    name: 'lease: taking the lease returns a dead holder\'s claimed leaves to parked',
    async run({ store, newRun }) {
      const runId = await newRun();
      await park(store, runId, 's0');
      const dead = await store.leases.claim({ runId, ttlMs: SHORT_MS });
      assert.ok(dead);
      await store.parks.claimLeaf({ runId, address: 's0' });
      await sleep(LAPSE_MS);
      assert.ok(await store.leases.claim({ runId, ttlMs: 60_000 }));
      assert.deepEqual(await parkedAddresses(store, runId), ['s0']);
    },
  },
  {
    name: 'fence: park and join writes under a lapsed holder\'s token are refused with RunLeaseLost',
    async run({ store, newRun }) {
      const runId = await newRun();
      const mine = await store.leases.claim({ runId, ttlMs: SHORT_MS });
      assert.ok(mine);
      await store.parks.putLeaf({ runId, address: 's0', reason: 'await', wakeAt: null, state: {}, fence: mine.token });
      await store.joins.recordJoin({ runId, frameAddress: 's1', pending: 1, fence: mine.token });
      await sleep(LAPSE_MS);
      assert.ok(await store.leases.claim({ runId, ttlMs: 60_000 }));
      await assert.rejects(store.parks.putLeaf({ runId, address: 's2', reason: 'await', wakeAt: null, state: {}, fence: mine.token }), RunLeaseLost);
      await assert.rejects(store.joins.recordJoin({ runId, frameAddress: 's3', pending: 1, fence: mine.token }), RunLeaseLost);
      assert.deepEqual(await parkedAddresses(store, runId), ['s0']);
      assert.deepEqual(await store.joins.frames({ runId }), ['s1']);
    },
  },
  {
    name: 'fence: a lapsed holder finishes no leaf and drops no state',
    async run({ store, newRun }) {
      const runId = await newRun();
      await park(store, runId, 's0');
      await store.joins.recordJoin({ runId, frameAddress: 's1', pending: 1 });
      const mine = await store.leases.claim({ runId, ttlMs: SHORT_MS });
      assert.ok(mine);
      await store.parks.claimLeaf({ runId, address: 's0' });
      await sleep(LAPSE_MS);
      const theirs = await store.leases.claim({ runId, ttlMs: 60_000 });
      assert.ok(theirs);
      await store.parks.claimLeaf({ runId, address: 's0' });
      await store.parks.finishLeaf({ runId, address: 's0', fence: mine.token });
      assert.equal(await store.leases.dropRunState({ runId, fence: mine.token }), false);
      assert.equal((await store.parks.leaves({ runId })).length, 1, 'the new holder still has its claimed leaf');
      assert.deepEqual(await store.joins.frames({ runId }), ['s1']);
      assert.equal(await store.leases.dropRunState({ runId, fence: theirs.token }), true);
      assert.deepEqual(await store.parks.leaves({ runId }), []);
      assert.deepEqual(await store.joins.frames({ runId }), []);
    },
  },

  // ── Await correlation (await_correlation, adapter doors) ─────────────────
  {
    name: 'correlation: one entry per park, team-scoped, dropped per park or per run',
    async run({ store, newRun, teamId }) {
      const runId = await newRun();
      const key = uniqueKey('thread');
      await park(store, runId, 's0', { reason: 'await' });
      await park(store, runId, 's1', { reason: 'await' });
      await store.correlations.correlate({ runId, teamId, address: 's0', adapterType: 'slack', correlationKey: 'old' });
      await store.correlations.correlate({ runId, teamId, address: 's0', adapterType: 'slack', correlationKey: key });
      await store.correlations.correlate({ runId, teamId, address: 's1', adapterType: 'slack', correlationKey: key });
      assert.deepEqual((await store.correlations.correlated({ adapterType: 'slack', teamId, correlationKey: 'old' })).filter((c) => c.runId === runId), []);
      const found = await store.correlations.correlated({ adapterType: 'slack', teamId, correlationKey: key });
      assert.deepEqual(found.map((c) => c.address).sort(), ['s0', 's1']);
      assert.deepEqual(await store.correlations.correlated({ adapterType: 'slack', teamId: '00000000-0000-4000-8000-00000000beef', correlationKey: key }), []);
      assert.deepEqual((await store.correlations.ofRun({ runId, adapterType: 'slack' })).map((c) => c.correlationKey), [key, key]);
      await store.correlations.drop({ runId, address: 's0' });
      assert.deepEqual((await store.correlations.correlated({ adapterType: 'slack', teamId, correlationKey: key })).map((c) => c.address), ['s1']);
      await store.correlations.dropRun({ runId });
      assert.deepEqual(await store.correlations.correlated({ adapterType: 'slack', teamId, correlationKey: key }), []);
    },
  },

  // ── The core's rules over the backend ────────────────────────────────────
  {
    name: 'completion: a run completes only when no join waits and no other leaf is parked; a quiescent run\'s joins clear',
    async run(backend) {
      const { store, newRun } = backend;
      const runId = await newRun();
      await park(store, runId, 's1.b0');
      await park(store, runId, 's1.b1');
      await store.joins.recordJoin({ runId, frameAddress: 's1', pending: 1 });
      assert.equal(await runCompleteWithout(store, { runId, leafAddress: 's1.b0' }), false, 'join pending');
      await branch(store, runId, 's1', 's1.b0', 0);
      await store.joins.decrementJoin({ runId, frameAddress: 's1', branchAddress: 's1.b0', leafAddress: 's1.b0' });
      assert.equal(await runCompleteWithout(store, { runId, leafAddress: 's1.b0' }), false, 'a sibling is parked');
      await store.parks.deleteLeaves({ runId, addresses: ['s1.b1'] });
      assert.equal(await runCompleteWithout(store, { runId, leafAddress: 's1.b0' }), true);
      assert.equal(await clearIfQuiescent(store, { runId }), false, 'its own leaf is still there');
      await store.parks.deleteLeaves({ runId, addresses: ['s1.b0'] });
      assert.equal(await clearIfQuiescent(store, { runId }), true);
      assert.deepEqual(await store.joins.frames({ runId }), [], 'completion clears joins');
    },
  },
  {
    name: 'race: losing subtrees go by parsed address, sparing the winner, with their joins, correlations and keeper records',
    async run(backend) {
      const { store, newRun, teamId } = backend;
      const { host, abandoned } = hostOf(backend);
      const runId = await newRun();
      for (const address of ['s1.b1.s0', 's1.b1.s2', 's1.b10.s0', 's1.b2.s0']) {
        await park(store, runId, address, { reason: 'await' });
        await store.correlations.correlate({ runId, teamId, address, adapterType: 'slack', correlationKey: `k-${address}` });
      }
      await store.joins.recordJoin({ runId, frameAddress: 's1.b1.s3', pending: 1 });
      await branch(store, runId, 's1.b1.s3', 's1.b1.s3.b0', 0);
      await store.joins.recordJoin({ runId, frameAddress: 's1', pending: 2 });
      await cancelSubtrees(host, { runId, subtreeAddresses: ['s1.b1', 's1.b2'], excludeLeaf: 's1.b1.s2' });
      assert.deepEqual(await parkedAddresses(store, runId), ['s1.b1.s2', 's1.b10.s0']);
      assert.deepEqual(await store.joins.frames({ runId }), ['s1']);
      assert.deepEqual(await store.joins.collectBranchExports({ runId, frameAddress: 's1.b1.s3' }), []);
      assert.deepEqual((await store.correlations.ofRun({ runId, adapterType: 'slack' })).map((c) => c.address).sort(), ['s1.b1.s2', 's1.b10.s0']);
      assert.deepEqual(abandoned.map((a) => [...(a.addresses ?? [])].sort()), [['s1.b1.s0', 's1.b2.s0']]);
    },
  },
  {
    name: 'drain: branches completing in one batch defer their race, which settles once with every winner',
    async run(backend) {
      const { store, newRun, teamId } = backend;
      const { host } = hostOf(backend);
      const runId = await newRun();
      for (const address of ['s1.b0.s0', 's1.b1.s0']) {
        await park(store, runId, address, { reason: 'await' });
        await store.correlations.correlate({ runId, teamId, address, adapterType: 'slack', correlationKey: 'k' });
      }
      let settledComplete: boolean | undefined;
      const { step, requests } = scriptedStep({
        's1.b0.s0': async () => ({ kind: 'completed', deferredRaceFrames: ['s1'] }),
        's1.b1.s0': async () => ({ kind: 'completed', deferredRaceFrames: ['s1'] }),
        'race:s1': async (_req, settle) => {
          settledComplete = await settle.runComplete();
          return { kind: 'completed', deferredRaceFrames: [] };
        },
      });
      const lease = await store.leases.claim({ runId, ttlMs: 60_000 });
      assert.ok(lease);
      const outcome = await drainRun(host, {
        runId,
        leaves: { addresses: ['s1.b0.s0', 's1.b1.s0'] },
        lease: { runId, token: lease.token, isLost: () => false, release: async () => {} },
        step,
      });
      assert.equal(outcome, 'done');
      assert.deepEqual(requests.map((r) => (r.kind === 'leaf' ? `${r.address}:${r.reenter}` : `race:${r.frameAddress}`)), ['s1.b0.s0:true', 's1.b1.s0:true', 'race:s1']);
      assert.equal(settledComplete, true);
      assert.deepEqual(await store.parks.leaves({ runId }), []);
      assert.deepEqual(await store.correlations.ofRun({ runId, adapterType: 'slack' }), []);
    },
  },
  {
    name: 'drain: an await re-armed at its own address keeps its row and correlation; a slept timer steps past its sleep',
    async run(backend) {
      const { store, newRun, teamId } = backend;
      const { host } = hostOf(backend);
      const runId = await newRun();
      await park(store, runId, 's0', { reason: 'await' });
      await store.correlations.correlate({ runId, teamId, address: 's0', adapterType: 'slack', correlationKey: 'k' });
      await park(store, runId, 's1', { reason: 'timer' });
      const { step, requests } = scriptedStep({
        s0: async () => {
          await park(store, runId, 's0', { reason: 'await' });
          return { kind: 'parked', parkedAddress: 's0', deferredRaceFrames: [] };
        },
        s1: async () => {
          await park(store, runId, 's2', { reason: 'timer', wakeAt: FUTURE(5) });
          return { kind: 'parked', parkedAddress: 's2', deferredRaceFrames: [] };
        },
      });
      assert.equal(await drainRun(host, { runId, leaves: { addresses: ['s0', 's1'] }, step }), 'done');
      assert.deepEqual(requests.map((r) => (r.kind === 'leaf' ? r.reenter : null)), [true, false]);
      assert.deepEqual(await parkedAddresses(store, runId), ['s0', 's2']);
      assert.deepEqual((await store.correlations.ofRun({ runId, adapterType: 'slack' })).map((c) => c.address), ['s0']);
    },
  },
  {
    name: 'drain: an engine failure tears the run down, closing its keeper records and correlations',
    async run(backend) {
      const { store, newRun, teamId } = backend;
      const { host, abandoned, closed } = hostOf(backend);
      const runId = await newRun();
      await park(store, runId, 's0', { reason: 'await' });
      await park(store, runId, 's1', { reason: 'await' });
      await store.correlations.correlate({ runId, teamId, address: 's1', adapterType: 'slack', correlationKey: 'k' });
      await store.joins.recordJoin({ runId, frameAddress: 's9', pending: 1 });
      const { step } = scriptedStep({ s0: async () => ({ kind: 'failed', error: 'boom' }) });
      assert.equal(await drainRun(host, { runId, leaves: { addresses: ['s0', 's1'] }, step }), 'done');
      assert.deepEqual(await store.parks.leaves({ runId }), []);
      assert.deepEqual(await store.joins.frames({ runId }), []);
      assert.deepEqual(await store.correlations.ofRun({ runId, adapterType: 'slack' }), []);
      assert.deepEqual(abandoned, [{ runId }]);
      assert.deepEqual(closed, [runId]);
    },
  },
  {
    name: 'drain: a run an operator asked to cancel is settled failed with their reason, and nothing is stepped',
    async run(backend) {
      const { store, newRun } = backend;
      const { host, failed } = hostOf(backend, { cancelReason: 'wrong customer' });
      const runId = await newRun();
      await park(store, runId, 's0', { reason: 'await' });
      const { step, requests } = scriptedStep({});
      assert.equal(await drainRun(host, { runId, leaves: { addresses: ['s0'] }, step }), 'done');
      assert.deepEqual(requests, []);
      assert.deepEqual(failed, [{ runId, message: 'wrong customer' }]);
      assert.deepEqual(await store.parks.leaves({ runId }), []);
    },
  },
  {
    name: 'drain: a lease lost mid-batch stops before the next leaf, leaving every row',
    async run(backend) {
      const { store, newRun } = backend;
      const { host } = hostOf(backend);
      const runId = await newRun();
      await park(store, runId, 's0', { reason: 'await' });
      await park(store, runId, 's1', { reason: 'await' });
      let lost = false;
      const { step, requests } = scriptedStep({
        s0: async () => {
          lost = true;
          return { kind: 'completed', deferredRaceFrames: [] };
        },
      });
      const lease = { runId, token: 'gone', isLost: () => lost, release: async () => {} };
      assert.equal(await drainRun(host, { runId, leaves: { addresses: ['s0', 's1'] }, lease, step }), 'leaseLost');
      assert.equal(requests.length, 1);
      assert.deepEqual(await parkedAddresses(store, runId), ['s1']);
    },
  },
  {
    name: 'wake: a signal drives every run parked on its key, each under its lease; a run held elsewhere is busy',
    async run(backend) {
      const { store, newRun, teamId } = backend;
      const { host } = hostOf(backend);
      const key = uniqueKey('thread');
      const free = await newRun();
      const held = await newRun();
      for (const runId of [free, held]) {
        await park(store, runId, 's0', { reason: 'await' });
        await store.correlations.correlate({ runId, teamId, address: 's0', adapterType: 'slack', correlationKey: key });
      }
      assert.ok(await store.leases.claim({ runId: held, ttlMs: 60_000 }));
      const stepped: string[] = [];
      const { busy } = await wakeAwaits(host, {
        wake: { adapterType: 'slack', teamId, correlationKey: key },
        stepper: async ({ runId }) => async () => {
          stepped.push(runId);
          return { kind: 'completed', deferredRaceFrames: [] };
        },
      });
      assert.deepEqual(stepped, [free]);
      assert.deepEqual(busy, [held]);
      assert.deepEqual(await store.parks.leaves({ runId: free }), []);
      assert.deepEqual(await parkedAddresses(store, held), ['s0']);
    },
  },
  {
    name: 'park sink: an await parks its leaf, then its correlation, and arms nothing; a timer arms its run\'s wake',
    async run(backend) {
      const { store, newRun, teamId } = backend;
      const { host } = hostOf(backend);
      const runId = await newRun();
      const marks: string[] = [];
      const sink = runParkSink(host, {
        runId,
        teamId,
        records: { ensureRun: async () => void marks.push('ensure'), markParked: async () => void marks.push('parked') },
      });
      await sink.commitAwaitPark({ address: 's0', state: { a: 1 }, adapterType: 'slack', correlationKey: 'k' });
      assert.deepEqual(await parkedAddresses(store, runId), ['s0']);
      assert.deepEqual((await store.correlations.ofRun({ runId, adapterType: 'slack' })).map((c) => c.correlationKey), ['k']);
      await sink.commitTimerPark({ address: 's1', state: {}, wakeAt: PAST(1) });
      const timerRow = await claimKey(store, `resume_timer:${runId}`);
      assert.deepEqual(timerRow?.payload, { runId });
      if (timerRow) await store.work.complete(timerRow);
      await sink.commitSuspension?.({ address: 's0', state: { a: 2 } });
      assert.deepEqual(await store.correlations.ofRun({ runId, adapterType: 'slack' }), [], 'a suspended await drops its correlation');
      assert.deepEqual(marks, ['ensure', 'parked', 'ensure', 'parked', 'ensure', 'parked']);
    },
  },
  {
    name: 'park sink: a cancel stamped while the run parked settles it at once; a lapsed holder\'s park is refused',
    async run(backend) {
      const { store, newRun, teamId } = backend;
      const cancelled = hostOf(backend, { cancelReason: null });
      const runId = await newRun();
      const records = { ensureRun: async () => {}, markParked: async () => {} };
      await runParkSink(cancelled.host, { runId, teamId, records }).commitAwaitPark({ address: 's0', state: {}, adapterType: 'slack', correlationKey: 'k' });
      assert.deepEqual(cancelled.failed, [{ runId, message: 'Cancelled by an operator' }]);
      assert.deepEqual(await store.parks.leaves({ runId }), []);
      assert.deepEqual(await store.correlations.ofRun({ runId, adapterType: 'slack' }), []);

      const { host } = hostOf(backend);
      const other = await newRun();
      const lapsed = await store.leases.claim({ runId: other, ttlMs: SHORT_MS });
      assert.ok(lapsed);
      await sleep(LAPSE_MS);
      assert.ok(await store.leases.claim({ runId: other, ttlMs: 60_000 }));
      const sink = runParkSink(host, { runId: other, teamId, fence: lapsed.token, records });
      await assert.rejects(sink.commitTimerPark({ address: 's0', state: {}, wakeAt: FUTURE(1) }), RunLeaseLost);
      assert.deepEqual(await store.parks.leaves({ runId: other }), []);
    },
  },
  {
    name: 'sources: a library text is kept once by its hash, and read back by it; another tenant does not read it',
    async run({ store, teamId }) {
      const source = `export function f() {\n  return "${uniqueKey('text')}"\n}`;
      const sources = parkSources(store.sources, teamId);
      const first = await sources.save({ source });
      const again = await sources.save({ source });
      assert.equal(again.hash, first.hash);
      assert.match(first.hash, /^sha256:[0-9a-f]{64}$/);
      assert.deepEqual(await sources.load({ hash: first.hash }), { source });
      assert.equal(await sources.load({ hash: 'sha256:none' }), null);
      const elsewhere = parkSources(store.sources, '00000000-0000-0000-0000-00000000beef');
      assert.equal(await elsewhere.load({ hash: first.hash }), null);
    },
  },
];

// ── Callbacks and cancel ────────────────────────────────────────────────────
//
// What a backend keeps beyond the run's live state: its callbacks, and its
// run records (the status row, an operator's cancel request). Kept as their
// own lists, over a richer backend, so a store that serves only the live
// state families still runs the cases above.

export interface RecordsContractBackend extends ContractBackend {
  callbacks: CallbackStore;
  /** The product's run records over the same backend, `closeRun` revoking
   *  the run's callbacks. */
  runs: RunRecords;
  /** An operator asks to cancel the run, as the product's cancel door does. */
  requestCancel(input: { runId: string; reason: string | null }): Promise<void>;
  /** The run's status as its record holds it (each product names a
   *  completed run its own way; a failed one is `failed` in both). */
  runStatus(runId: string): Promise<string>;
  /** Mark the run completed, as the product does when a run settles. */
  completeRun(runId: string): Promise<void>;
}

export interface RecordsContractCase {
  name: string;
  run(backend: RecordsContractBackend): Promise<void>;
}

function recordsHost(backend: RecordsContractBackend): RunHost {
  return { store: backend.store, keepers: [callbackAwaitKeeper(backend.store, backend.callbacks)], runs: backend.runs };
}

async function mintFor(backend: RecordsContractBackend, runId: string, extra: { singleUse?: boolean; expiresAt?: string; params?: Array<{ name: string; type: 'text' | 'number' }> } = {}) {
  return backend.callbacks.mint({
    teamId: backend.teamId,
    runId,
    address: 's0.c1',
    params: extra.params ?? [{ name: 'note', type: 'text' }],
    state: { version: 2, address: 's0.c1', marker: uniqueKey('state') },
    singleUse: extra.singleUse ?? true,
    ...(extra.expiresAt !== undefined ? { expiresAt: extra.expiresAt } : {}),
  });
}

const BODY_DUE = () => FUTURE(10);

/** A lease held on the run, as the product holds one around a body. */
async function holdLease(store: RunHostStore, runId: string, ttlMs = 60_000): Promise<HeldRunLease> {
  const claimed = await store.leases.claim({ runId, ttlMs });
  assert.ok(claimed, 'the run is free');
  return { runId, token: claimed.token, isLost: () => false, release: () => store.leases.release({ runId, token: claimed.token }) };
}

export const callbackContractCases: RecordsContractCase[] = [
  {
    name: 'callbacks: a mint is live with an empty ledger, its signature and state kept; ids are cb_-prefixed and distinct',
    async run(backend) {
      const runId = await backend.newRun();
      const one = await mintFor(backend, runId);
      const two = await mintFor(backend, runId);
      assert.ok(isCallbackId(one.id) && isCallbackId(two.id));
      assert.notEqual(one.id, two.id);
      const got = await backend.callbacks.get({ id: one.id });
      assert.ok(got);
      assert.equal(got.status, 'live');
      assert.equal(got.runId, runId);
      assert.equal(got.teamId, backend.teamId);
      assert.equal(got.address, 's0.c1');
      assert.deepEqual(got.params, [{ name: 'note', type: 'text' }]);
      assert.deepEqual(got.calls, []);
      assert.equal(got.singleUse, true);
      assert.equal(got.expiresAt, null);
      assert.equal((got.state as { address: string }).address, 's0.c1');
      assert.equal(await backend.callbacks.get({ id: 'cb_never-minted' }), null);
      assert.equal(await backend.callbacks.get({ id: 'not-a-callback' }), null);
    },
  },
  {
    name: 'callbacks: a single-use callback takes one call, queued with its body; a second call is closed and queues nothing',
    async run(backend) {
      const runId = await backend.newRun();
      const { id } = await mintFor(backend, runId);
      const first = await backend.callbacks.record({ id, values: { note: 'yes' }, bodyDueAt: PAST(1) });
      assert.equal(first.kind, 'recorded');
      assert.ok(first.kind === 'recorded');
      assert.equal(first.callIndex, 0);
      assert.equal(first.callback.status, 'fired');
      assert.deepEqual(first.callback.calls.map((c) => c.values), [{ note: 'yes' }]);
      assert.ok(!Number.isNaN(Date.parse(first.callback.calls[0]?.at ?? '')), 'the call carries its instant');
      const body = await claimKey(backend.store, `${CALLBACK_BODY_WORK_KIND}:${id}:0`);
      assert.deepEqual(body?.payload, { callbackId: id, teamId: backend.teamId, callIndex: 0 });
      assert.equal(body?.kind, CALLBACK_BODY_WORK_KIND);
      if (body) await backend.store.work.complete(body);
      const second = await backend.callbacks.record({ id, values: { note: 'again' }, bodyDueAt: PAST(1) });
      assert.equal(second.kind, 'closed');
      assert.equal(await claimKey(backend.store, `${CALLBACK_BODY_WORK_KIND}:${id}:1`), undefined);
      assert.equal((await backend.callbacks.get({ id }))?.calls.length, 1);
    },
  },
  {
    name: 'callbacks: a repeatable callback stays live and appends each call at the next index',
    async run(backend) {
      const runId = await backend.newRun();
      const { id } = await mintFor(backend, runId, { singleUse: false });
      const a = await backend.callbacks.record({ id, values: { note: 'a' }, bodyDueAt: BODY_DUE() });
      const b = await backend.callbacks.record({ id, values: { note: 'b' }, bodyDueAt: BODY_DUE() });
      assert.ok(a.kind === 'recorded' && b.kind === 'recorded');
      assert.deepEqual([a.callIndex, b.callIndex], [0, 1]);
      const got = await backend.callbacks.get({ id });
      assert.equal(got?.status, 'live');
      assert.deepEqual(got?.calls.map((c) => c.values), [{ note: 'a' }, { note: 'b' }]);
    },
  },
  {
    name: 'callbacks: an expired callback refuses a call and records nothing; one inside its window records',
    async run(backend) {
      const runId = await backend.newRun();
      const gone = await mintFor(backend, runId, { expiresAt: PAST(1) });
      const open = await mintFor(backend, runId, { expiresAt: FUTURE(10) });
      assert.equal((await backend.callbacks.record({ id: gone.id, values: { note: 'x' }, bodyDueAt: BODY_DUE() })).kind, 'expired');
      assert.deepEqual((await backend.callbacks.get({ id: gone.id }))?.calls, []);
      assert.equal((await backend.callbacks.record({ id: open.id, values: { note: 'x' }, bodyDueAt: BODY_DUE() })).kind, 'recorded');
      assert.equal((await backend.callbacks.record({ id: 'cb_never-minted', values: {}, bodyDueAt: BODY_DUE() })).kind, 'not_found');
      assert.equal((await backend.callbacks.record({ id: 'foreign', values: {}, bodyDueAt: BODY_DUE() })).kind, 'not_found');
    },
  },
  {
    name: 'callbacks: a values mismatch is refused before the claim, so a single-use callback stays live; a recorded call queues a coalesced wake',
    async run(backend) {
      const host = recordsHost(backend);
      const runId = await backend.newRun();
      const { id } = await mintFor(backend, runId, { params: [{ name: 'n', type: 'number' }] });
      const wrong = await recordCallbackCall(host, backend.callbacks, { id, values: { n: 'many' }, bodyDueAt: BODY_DUE(), wakeDueAt: PAST(1) });
      assert.equal(wrong.kind, 'mismatch');
      const extra = await recordCallbackCall(host, backend.callbacks, { id, values: { n: 1, other: 2 }, bodyDueAt: BODY_DUE(), wakeDueAt: PAST(1) });
      assert.equal(extra.kind, 'mismatch');
      assert.equal((await backend.callbacks.get({ id }))?.status, 'live');
      const right = await recordCallbackCall(host, backend.callbacks, { id, values: { n: '3' }, bodyDueAt: BODY_DUE(), wakeDueAt: PAST(1) });
      assert.ok(right.kind === 'recorded');
      assert.deepEqual(right.callback.calls[0]?.values, { n: 3 }, 'coerced to its declared type');
      const wake = await claimKey(backend.store, `wake_await:callback_backstop:${id}`);
      assert.deepEqual(wake?.payload, { adapterType: CALLBACK_AWAIT_TYPE, teamId: backend.teamId, correlationKey: id });
      if (wake) await backend.store.work.complete(wake);
    },
  },
  {
    name: 'callbacks: a call lands only once its body is marked started; the keeper then finds the await parked on it',
    async run(backend) {
      const { store, teamId } = backend;
      const keeper = callbackAwaitKeeper(store, backend.callbacks);
      const runId = await backend.newRun();
      const { id } = await mintFor(backend, runId);
      const other = await mintFor(backend, runId);
      for (const [address, key] of [['s1', id], ['s2', other.id]] as const) {
        await park(store, runId, address, { reason: 'await' });
        await store.correlations.correlate({ runId, teamId, address, adapterType: CALLBACK_AWAIT_TYPE, correlationKey: key });
      }
      const sink = callbackSink(backend.callbacks, { runId, teamId, url: (cb) => `http://lf.test/api/cb/${cb}` });
      assert.ok((await backend.callbacks.record({ id, values: { note: 'n' }, bodyDueAt: BODY_DUE() })).kind === 'recorded');
      assert.deepEqual(await sink.calls({ callbackId: id }), [], 'recorded, not landed');
      assert.deepEqual(await keeper.loadResolvable({ runId }), []);
      assert.deepEqual(await backend.callbacks.landed({ ids: [id, other.id] }), []);
      assert.equal(await backend.callbacks.markBodyStarted({ id, callIndex: 0 }), true);
      assert.deepEqual((await sink.calls({ callbackId: id })).map((c) => c.values), [{ note: 'n' }]);
      assert.deepEqual(await backend.callbacks.landed({ ids: [id, other.id] }), [id]);
      assert.deepEqual(await keeper.loadResolvable({ runId }), [{ runId, teamId, address: 's1' }]);
    },
  },
  {
    name: 'callbacks: a body is marked started only under the run\'s current lease; a lapsed holder marks nothing',
    async run(backend) {
      const { store } = backend;
      const runId = await backend.newRun();
      const { id } = await mintFor(backend, runId, { singleUse: false });
      await backend.callbacks.record({ id, values: { note: 'n' }, bodyDueAt: BODY_DUE() });
      const lapsed = await store.leases.claim({ runId, ttlMs: SHORT_MS });
      assert.ok(lapsed);
      await sleep(LAPSE_MS);
      const current = await store.leases.claim({ runId, ttlMs: 60_000 });
      assert.ok(current);
      assert.equal(await backend.callbacks.markBodyStarted({ id, callIndex: 0, fence: lapsed.token }), false);
      assert.equal((await backend.callbacks.get({ id }))?.calls[0]?.bodyStartedAt, undefined);
      assert.equal(await backend.callbacks.markBodyStarted({ id, callIndex: 0, fence: current.token }), true);
      assert.ok((await backend.callbacks.get({ id }))?.calls[0]?.bodyStartedAt !== undefined);
      await store.leases.release({ runId, token: current.token });
    },
  },
  {
    name: 'callbacks: a body runs once under the lease, then wakes the run\'s await on it; the same call never runs twice',
    async run(backend) {
      const { store, teamId } = backend;
      const host = recordsHost(backend);
      const runId = await backend.newRun();
      const { id } = await mintFor(backend, runId);
      await park(store, runId, 's1', { reason: 'await' });
      await store.correlations.correlate({ runId, teamId, address: 's1', adapterType: CALLBACK_AWAIT_TYPE, correlationKey: id });
      assert.ok((await backend.callbacks.record({ id, values: { note: 'go' }, bodyDueAt: BODY_DUE() })).kind === 'recorded');
      const bodies: unknown[] = [];
      const stepped: string[] = [];
      const lease = await holdLease(store, runId);
      const run = (body: (values: unknown) => Promise<CallbackBodyOutcome>) =>
        runCallbackBody(host, backend.callbacks, {
          id,
          callIndex: 0,
          lease,
          now: new Date().toISOString(),
          runOpen: async () => true,
          body: async ({ values }) => body(values),
          stepper: async () => async (request) => {
            stepped.push(request.kind === 'leaf' ? request.address : request.frameAddress);
            return { kind: 'completed', deferredRaceFrames: [] };
          },
        });
      const first = await run(async (values) => {
        bodies.push(values);
        // The call has landed by the time its body runs.
        assert.equal((await backend.callbacks.landed({ ids: [id] })).length, 1);
        return { kind: 'ran' };
      });
      assert.equal(first.kind, 'ran');
      assert.deepEqual(bodies, [{ note: 'go' }]);
      assert.deepEqual(stepped, ['s1']);
      assert.deepEqual(await store.parks.leaves({ runId }), []);
      const again = await run(async () => {
        throw new Error('ran twice');
      });
      assert.deepEqual(again, { kind: 'refused', reason: 'its body already started' });
      await lease.release();
    },
  },
  {
    name: 'callbacks: a run that ends revokes its live callbacks (a fired one stays fired), and a later call is closed',
    async run(backend) {
      const host = recordsHost(backend);
      const runId = await backend.newRun();
      const live = await mintFor(backend, runId, { singleUse: false });
      const fired = await mintFor(backend, runId);
      await backend.callbacks.record({ id: fired.id, values: { note: 'x' }, bodyDueAt: BODY_DUE() });
      const elsewhere = await mintFor(backend, await backend.newRun());
      assert.equal(await abandonRun(host, { runId }), true);
      assert.equal((await backend.callbacks.get({ id: live.id }))?.status, 'revoked');
      assert.equal((await backend.callbacks.get({ id: fired.id }))?.status, 'fired');
      assert.equal((await backend.callbacks.get({ id: elsewhere.id }))?.status, 'live', 'another run\'s callback is untouched');
      assert.equal((await backend.callbacks.record({ id: live.id, values: { note: 'late' }, bodyDueAt: BODY_DUE() })).kind, 'closed');
      await backend.callbacks.revokeRun({ runId });
      assert.equal((await backend.callbacks.get({ id: live.id }))?.status, 'revoked', 'idempotent');
    },
  },
];

export const cancelContractCases: RecordsContractCase[] = [
  {
    name: 'cancel: a run nobody asked to cancel is not settled, and keeps its leaves',
    async run(backend) {
      const host = recordsHost(backend);
      const runId = await backend.newRun();
      await park(backend.store, runId, 's0', { reason: 'await' });
      assert.equal(await backend.runs.cancelRequest({ runId }), null);
      assert.equal(await settleIfCancelRequested(host, { runId }), false);
      assert.deepEqual(await parkedAddresses(backend.store, runId), ['s0']);
    },
  },
  {
    name: 'cancel: a parked run with a cancel request settles failed with its reason; its leaves, correlations and callbacks close',
    async run(backend) {
      const { store, teamId } = backend;
      const host = recordsHost(backend);
      const runId = await backend.newRun();
      const { id } = await mintFor(backend, runId, { singleUse: false });
      await park(store, runId, 's0', { reason: 'await' });
      await store.correlations.correlate({ runId, teamId, address: 's0', adapterType: CALLBACK_AWAIT_TYPE, correlationKey: id });
      await park(store, runId, 's1', { reason: 'timer' });
      await backend.requestCancel({ runId, reason: 'not needed' });
      assert.deepEqual(await backend.runs.cancelRequest({ runId }), { reason: 'not needed' });
      const lease = await holdLease(store, runId);
      assert.equal(await settleIfCancelRequested(host, { runId, fence: lease.token }), true);
      assert.equal(await backend.runStatus(runId), 'failed');
      assert.deepEqual(await store.parks.leaves({ runId }), []);
      assert.deepEqual(await store.correlations.ofRun({ runId, adapterType: CALLBACK_AWAIT_TYPE }), []);
      assert.equal((await backend.callbacks.get({ id }))?.status, 'revoked');
      await lease.release();
    },
  },
  {
    name: 'cancel: a lapsed holder\'s settle tears nothing down, and a run that already completed stays completed',
    async run(backend) {
      const { store } = backend;
      const host = recordsHost(backend);
      const runId = await backend.newRun();
      await park(store, runId, 's0', { reason: 'await' });
      await backend.requestCancel({ runId, reason: null });
      const lapsed = await store.leases.claim({ runId, ttlMs: SHORT_MS });
      assert.ok(lapsed);
      await sleep(LAPSE_MS);
      assert.ok(await store.leases.claim({ runId, ttlMs: 60_000 }));
      await settleIfCancelRequested(host, { runId, fence: lapsed.token });
      assert.deepEqual(await parkedAddresses(store, runId), ['s0'], 'the new holder\'s leaves stand');

      const done = await backend.newRun();
      await backend.completeRun(done);
      const completed = await backend.runStatus(done);
      assert.notEqual(completed, 'failed');
      await backend.requestCancel({ runId: done, reason: 'too late' });
      await settleIfCancelRequested(host, { runId: done });
      assert.equal(await backend.runStatus(done), completed);
    },
  },
];

// ── Delivery receipts ───────────────────────────────────────────────────────
//
// What a door keeps of one delivery: the events it produced, kept with its
// cursor and its work rows in the door's one write (`inbound.keepDelivery`),
// a redelivery under the provider's delivery id kept out by that write. Their
// own list over their own backend: the TypeScript `RunHostStore` (store.ts)
// has no inbound family, since only lf's doors call it.

export interface DeliveryContractBackend {
  /** The tenant every row of the case belongs to. */
  teamId: string;
  keepDelivery(input: { subscriptionId: string; checkpoint?: unknown; delivery: NewDelivery; work: NewWorkRow[] }): Promise<{ kept: boolean }>;
  deliveries(input: { subscriptionId?: string | null; since?: string | null; limit: number }): Promise<DeliveryRow[]>;
  delivery(input: { id: string }): Promise<DeliveryRow | null>;
  sweepDeliveries(input: { before: string; limit: number }): Promise<number>;
  /** The subscription's saved pull cursor. */
  checkpoint(input: { subscriptionId: string }): Promise<{ checkpoint?: unknown } | null>;
  startRun(input: { id: string; file: string; movement: string; startedAt: string; input: string; deliveryId?: string }): Promise<void>;
  completeRun(runId: string): Promise<void>;
  runGet(input: { runId: string }): Promise<RunRow | null>;
  claimDue(input: { limit: number; leaseMs: number; kinds?: readonly string[] }): Promise<ClaimedWork[]>;
}

export interface DeliveryContractCase {
  name: string;
  run(backend: DeliveryContractBackend): Promise<void>;
}

const DAYS = (days: number) => PAST(days * 24 * 60);

function newDelivery(extra: Partial<NewDelivery> = {}): NewDelivery {
  return {
    id: randomUUID(),
    externalId: null,
    receivedAt: new Date().toISOString(),
    source: 'webhook',
    inline: false,
    replayOf: null,
    events: [{ external: 'crm', event: { n: 1 } }],
    ...extra,
  };
}

/** One of the delivery's events queued for the drain, as lf's doors queue it. */
function fireRow(deliveryId: string, n: number): NewWorkRow {
  return { kind: 'fire_event', key: uniqueKey('fire_event'), payload: { external: 'crm', event: { n }, deliveryId }, dueAt: PAST(1), teamId: null };
}

async function claimedKeys(backend: DeliveryContractBackend, keys: string[]): Promise<ClaimedWork[]> {
  const claimed = await backend.claimDue({ limit: 1000, leaseMs: 60_000, kinds: ['fire_event'] });
  return claimed.filter((w) => keys.includes(w.key));
}

async function startDeliveryRun(backend: DeliveryContractBackend, deliveryId: string | undefined): Promise<string> {
  const id = randomUUID();
  await backend.startRun({ id, file: 'f', movement: 'm', startedAt: new Date().toISOString(), input: '{}', ...(deliveryId !== undefined ? { deliveryId } : {}) });
  return id;
}

/** A first delivery under `externalId`, then its redelivery (a new id, another
 *  cursor, another row): the second is kept out and leaves nothing. */
async function redelivered(backend: DeliveryContractBackend, opts: { claimBetween: boolean }): Promise<void> {
  const subscriptionId = uniqueKey('sub');
  const externalId = uniqueKey('delivery');
  const first = newDelivery({ externalId });
  const firstRow = fireRow(first.id, 1);
  assert.deepEqual(await backend.keepDelivery({ subscriptionId, checkpoint: { cursor: 'c-1' }, delivery: first, work: [firstRow] }), { kept: true });
  if (opts.claimBetween) {
    const [claimed] = await claimedKeys(backend, [firstRow.key]);
    assert.ok(claimed, "the first's row was queued");
  }
  const second = newDelivery({ externalId });
  const secondRow = fireRow(second.id, 2);
  assert.deepEqual(await backend.keepDelivery({ subscriptionId, checkpoint: { cursor: 'c-2' }, delivery: second, work: [secondRow] }), { kept: false });
  assert.deepEqual(await backend.checkpoint({ subscriptionId }), { checkpoint: { cursor: 'c-1' } }, "the cursor is still the first's");
  assert.deepEqual(await claimedKeys(backend, [secondRow.key]), [], 'the redelivery queued nothing');
  assert.equal(await backend.delivery({ id: second.id }), null);
  assert.deepEqual((await backend.deliveries({ subscriptionId, limit: 10 })).map((d) => d.id), [first.id]);
}

export const deliveryContractCases: DeliveryContractCase[] = [
  {
    name: 'deliveries: a delivery is kept with its work as one write',
    async run(backend) {
      const subscriptionId = uniqueKey('sub');
      const delivery = newDelivery({ externalId: uniqueKey('delivery'), events: [{ external: 'crm', event: { n: 1 } }, { external: 'crm', event: { n: 2 } }] });
      const work = [fireRow(delivery.id, 1), fireRow(delivery.id, 2)];
      assert.deepEqual(await backend.keepDelivery({ subscriptionId, checkpoint: { cursor: 'c-1' }, delivery, work }), { kept: true });
      const keys = work.map((w) => w.key);
      assert.deepEqual((await claimedKeys(backend, keys)).map((w) => w.key).sort(), [...keys].sort());
      assert.deepEqual(await backend.checkpoint({ subscriptionId }), { checkpoint: { cursor: 'c-1' } });
      assert.deepEqual(await backend.delivery({ id: delivery.id }), {
        id: delivery.id,
        subscriptionId,
        externalId: delivery.externalId,
        receivedAt: delivery.receivedAt,
        source: 'webhook',
        inline: false,
        replayOf: null,
        eventCount: 2,
        runs: [],
        events: delivery.events,
      });
    },
  },
  {
    name: 'deliveries: a duplicate externalId is not kept, and writes nothing',
    run: (backend) => redelivered(backend, { claimBetween: true }),
  },
  {
    name: "deliveries: a redelivery while the first's work is still queued is kept out",
    run: (backend) => redelivered(backend, { claimBetween: false }),
  },
  {
    name: 'deliveries: the same externalId on another subscription, or none, is kept',
    async run(backend) {
      const [one, other] = [uniqueKey('sub'), uniqueKey('sub')];
      const externalId = uniqueKey('delivery');
      const keep = async (subscriptionId: string, delivery: NewDelivery) => (await backend.keepDelivery({ subscriptionId, delivery, work: [] })).kept;
      const kept = [newDelivery({ externalId }), newDelivery({ externalId }), newDelivery(), newDelivery()];
      assert.equal(await keep(one, kept[0]!), true);
      assert.equal(await keep(other, kept[1]!), true, 'another subscription');
      assert.equal(await keep(one, kept[2]!), true, 'no external id');
      assert.equal(await keep(one, kept[3]!), true, 'no external id, again');
      const listed = (await backend.deliveries({ limit: 100 })).map((d) => d.id);
      for (const delivery of kept) assert.ok(listed.includes(delivery.id), delivery.id);
    },
  },
  {
    name: 'deliveries: a delivery lists its runs',
    async run(backend) {
      const subscriptionId = uniqueKey('sub');
      const delivery = newDelivery();
      await backend.keepDelivery({ subscriptionId, delivery, work: [] });
      const running = await startDeliveryRun(backend, delivery.id);
      const completed = await startDeliveryRun(backend, delivery.id);
      const unnamed = await startDeliveryRun(backend, undefined);
      await backend.completeRun(completed);
      const [row] = await backend.deliveries({ subscriptionId, limit: 10 });
      const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
      assert.deepEqual(
        [...(row?.runs ?? [])].sort(byId),
        [
          { id: running, status: 'running' },
          { id: completed, status: 'completed' },
        ].sort(byId),
      );
      assert.equal(row?.events, undefined, 'a listing carries no events');
      assert.equal((await backend.runGet({ runId: running }))?.deliveryId, delivery.id);
      assert.equal((await backend.runGet({ runId: unnamed }))?.deliveryId, null);
    },
  },
  {
    name: 'deliveries: listing filters by subscription and since, most recent first, at most limit',
    async run(backend) {
      const [one, other] = [uniqueKey('sub'), uniqueKey('sub')];
      const at = (minutesAgo: number) => newDelivery({ receivedAt: PAST(minutesAgo) });
      const [oldest, middle, newest, elsewhere] = [at(30), at(20), at(10), at(5)];
      for (const [subscriptionId, delivery] of [[one, oldest], [one, middle], [one, newest], [other, elsewhere]] as const) {
        await backend.keepDelivery({ subscriptionId, delivery, work: [] });
      }
      const ids = async (input: { subscriptionId?: string; since?: string; limit: number }) => (await backend.deliveries(input)).map((d) => d.id);
      assert.deepEqual(await ids({ subscriptionId: one, limit: 10 }), [newest.id, middle.id, oldest.id]);
      assert.deepEqual(await ids({ subscriptionId: one, since: middle.receivedAt, limit: 10 }), [newest.id, middle.id]);
      assert.deepEqual(await ids({ subscriptionId: one, limit: 1 }), [newest.id]);
      const all = await ids({ limit: 100 });
      assert.deepEqual(
        all.filter((id) => [oldest.id, middle.id, newest.id, elsewhere.id].includes(id)),
        [elsewhere.id, newest.id, middle.id, oldest.id],
      );
    },
  },
  {
    name: 'deliveries: the sweep forgets settled old deliveries only',
    async run(backend) {
      const subscriptionId = uniqueKey('sub');
      const old = async (work: (id: string) => NewWorkRow[] = () => []) => {
        const delivery = newDelivery({ receivedAt: DAYS(30) });
        await backend.keepDelivery({ subscriptionId, delivery, work: work(delivery.id) });
        return delivery.id;
      };
      const settled = await old();
      await backend.completeRun(await startDeliveryRun(backend, settled));
      const running = await old();
      await startDeliveryRun(backend, running);
      const queued = await old((id) => [{ ...fireRow(id, 1), dueAt: FUTURE(60) }]);
      const fresh = newDelivery();
      await backend.keepDelivery({ subscriptionId, delivery: fresh, work: [] });
      assert.equal(await backend.sweepDeliveries({ before: DAYS(14), limit: 100 }), 1);
      assert.equal(await backend.delivery({ id: settled }), null, 'old, its run settled: forgotten');
      assert.ok(await backend.delivery({ id: running }), 'its run is still running');
      assert.ok(await backend.delivery({ id: queued }), 'a fire_event row still names it');
      assert.ok(await backend.delivery({ id: fresh.id }), 'not old enough');
    },
  },
];

// ── Reruns ──────────────────────────────────────────────────────────────────
// A failed run run again (`lf runs rerun`) is the same run's next attempt:
// one fenced write keeps the failed attempt beside the run and starts the
// next with the input it is given. Their own list over their own backend:
// the TypeScript `RunHostStore` has no run rows, since only lf's runs do.

export interface RerunContractBackend {
  startRun(input: { id: string; file: string; movement: string; startedAt: string; input: string }): Promise<void>;
  runGet(input: { runId: string }): Promise<RunRow | null>;
  runSettle(input: { runId: string; status: string; outcome: unknown; at: string }): Promise<void>;
  runRerun(input: { runId: string; input: string; at: string; fence: string }): Promise<number | null>;
  markFailed(input: { runId: string; message: string }): Promise<void>;
  claimLease(input: { runId: string; ttlMs: number }): Promise<{ token: string } | null>;
  releaseLease(input: { runId: string; token: string }): Promise<void>;
}

export interface RerunContractCase {
  name: string;
  run(backend: RerunContractBackend): Promise<void>;
}

const WROTE = { adapter: 'crm', recordType: 'Company', recordId: 'c-1', action: 'create', committed: true, values: {} };

/** A run started then settled `status` with `outcome`, a millisecond apart. */
async function settledRun(backend: RerunContractBackend, status: string, outcome: unknown): Promise<string> {
  const id = randomUUID();
  await backend.startRun({ id, file: 'f', movement: 'm', startedAt: PAST(10), input: '{"attempt":1}' });
  await backend.runSettle({ runId: id, status, outcome, at: PAST(9) });
  return id;
}

async function leased(backend: RerunContractBackend, runId: string): Promise<string> {
  const lease = await backend.claimLease({ runId, ttlMs: 60_000 });
  assert.ok(lease, 'the run is not held');
  return lease.token;
}

export const rerunContractCases: RerunContractCase[] = [
  {
    name: "reruns: a failed run's rerun is its next attempt, the failed one kept beside it",
    async run(backend) {
      const runId = await settledRun(backend, 'failed', { error: 'boom', writes: 1, writeRecords: [WROTE] });
      const before = await backend.runGet({ runId });
      assert.equal(before?.attempt ?? 1, 1);
      assert.deepEqual(before?.attempts ?? [], []);
      assert.deepEqual(JSON.parse(before?.outcome ?? 'null'), { error: 'boom', writes: 1, writeRecords: [WROTE] }, 'a failed outcome keeps its writes');
      const fence = await leased(backend, runId);
      const at = PAST(1);
      assert.equal(await backend.runRerun({ runId, input: '{"attempt":2}', at, fence }), 2);
      const row = await backend.runGet({ runId });
      assert.ok(row);
      assert.deepEqual([row.status, row.attempt, row.input, row.startedAt, row.finishedAt ?? null], ['running', 2, '{"attempt":2}', at, null]);
      // The new attempt has written nothing yet (a store may answer `{ writes: 0 }` for none).
      const fresh = JSON.parse(row.outcome ?? '{}') as { error?: unknown; writes?: number; writeRecords?: unknown };
      assert.deepEqual([fresh.error, fresh.writes ?? 0, fresh.writeRecords], [undefined, 0, undefined]);
      assert.equal(row.attempts?.length, 1);
      const [first] = row.attempts!;
      assert.deepEqual([first!.attempt, first!.status, first!.startedAt, first!.finishedAt], [1, 'failed', before!.startedAt, before!.finishedAt]);
      assert.deepEqual(first!.outcome, { error: 'boom', writes: 1, writeRecords: [WROTE] });

      await backend.runSettle({ runId, status: 'failed', outcome: { error: 'boom again', writes: 0, writeRecords: [] }, at: PAST(0.5) });
      assert.equal(await backend.runRerun({ runId, input: '{"attempt":3}', at: PAST(0.2), fence }), 3);
      const third = await backend.runGet({ runId });
      assert.deepEqual(third?.attempts?.map((a) => [a.attempt, a.status]), [[1, 'failed'], [2, 'failed']]);
      assert.equal(third?.attempt, 3);
      await backend.releaseLease({ runId, token: fence });
    },
  },
  {
    name: 'reruns: a run whose latest attempt did not fail is not rerun, and nothing is written',
    async run(backend) {
      const completed = await settledRun(backend, 'completed', { writes: 0, writeRecords: [] });
      const running = randomUUID();
      await backend.startRun({ id: running, file: 'f', movement: 'm', startedAt: PAST(1), input: '{}' });
      const parked = await settledRun(backend, 'parked', { writes: 0 });
      for (const runId of [completed, running, parked]) {
        const before = await backend.runGet({ runId });
        const fence = await leased(backend, runId);
        assert.equal(await backend.runRerun({ runId, input: '{"attempt":2}', at: PAST(0), fence }), null, before?.status);
        const after = await backend.runGet({ runId });
        assert.deepEqual([after?.status, after?.attempt ?? 1, after?.input, after?.attempts ?? []], [before?.status, 1, before?.input, []]);
        await backend.releaseLease({ runId, token: fence });
      }
    },
  },
  {
    name: 'reruns: a rerun is fenced by the run lease',
    async run(backend) {
      const runId = await settledRun(backend, 'failed', { error: 'boom' });
      await assert.rejects(backend.runRerun({ runId, input: '{}', at: PAST(0), fence: randomUUID() }), RunLeaseLost);
      const fence = await leased(backend, runId);
      await assert.rejects(backend.runRerun({ runId, input: '{}', at: PAST(0), fence: randomUUID() }), RunLeaseLost, 'another token');
      const row = await backend.runGet({ runId });
      assert.deepEqual([row?.status, row?.attempt ?? 1], ['failed', 1]);
      await backend.releaseLease({ runId, token: fence });
    },
  },
  {
    name: "reruns: a run failed by markFailed keeps the writes it settled with",
    async run(backend) {
      const runId = await settledRun(backend, 'parked', { writes: 1, writeRecords: [WROTE] });
      await backend.markFailed({ runId, message: 'cancelled by the operator' });
      const row = await backend.runGet({ runId });
      assert.equal(row?.status, 'failed');
      assert.deepEqual(JSON.parse(row?.outcome ?? 'null'), { error: 'cancelled by the operator', writes: 1, writeRecords: [WROTE] });
    },
  },
];

// The run host's backend in memory: every family a parked run needs (its
// leaves, joins, waits and the arrivals they read, lease, work queue and
// pinned library texts), for an embedder that runs movements that `await` or
// `sleep` in one process. Held to the same contract suite as the Postgres and
// SQLite backends (contract.ts), and to the waits cases every store runs
// (engine-contracts' conformance/store-waits.json). Durable only for the life
// of the process: a restart forgets every parked run, so a product that must
// keep them across restarts implements `RunHostStore` over its own database
// instead.
//
// Every value goes in and comes out as JSON, as a database would keep it: a
// caller never shares an object with the store. Each method runs to its end
// without yielding, so each is one write, as a database transaction is.

import { randomUUID } from 'node:crypto';

import type { ParkReason } from 'engine-contracts';

import { RunLeaseLost } from '../movement_engine/errors';
import {
  RESUME_TIMER_WORK_KIND,
  SETTLE_RACE_WORK_KIND,
  WAKE_AWAIT_WORK_KIND,
  settleRaceWorkKey,
  type ClaimedWork,
  type DeliveryRowStore,
  type DeliveryWait,
  type KeepDelivery,
  type KeptDelivery,
  type LeafRow,
  type ListedArrival,
  type NewArrival,
  type OwedRace,
  type ParkKind,
  type RunHostStore,
  type RunRowStore,
  type StrandedWait,
  type WaitWake,
} from './store';

interface Leaf {
  reason: ParkReason;
  status: 'parked' | 'resuming';
  wakeAt: string | null;
  state: string;
}

interface Join {
  pending: number;
  decremented: Set<string>;
  closer: string | undefined;
}

interface BranchExport {
  branchIndex: number;
  exports: string;
}

interface WorkRow {
  id: string;
  kind: string;
  key: string;
  payload: string;
  dueAt: number;
  teamId: string | undefined;
  claim: string | undefined;
  leasedUntil: number;
  /** Bumped by every enqueue: a claim remembers the one it saw, so a re-arm
   *  during the work is told from the work itself. */
  armed: number;
  armedAtClaim: number;
  /** Buried (`work.bury`): never claimed again. */
  dead: boolean;
}

interface LogRow {
  seq: number;
  teamId: string;
  adapterType: string;
  edge: string;
  key: string;
  identity: string | null;
  version: string | null;
  landing: string | null;
  gone: boolean;
  loggedAt: number;
}

/** An identity a log took, kept apart from its entry for the module's
 *  re-send window: a repeat of it before `keptUntil` is a sender's retry. */
interface IdentityRow {
  teamId: string;
  adapterType: string;
  edge: string;
  key: string;
  identity: string;
  version: string | null;
  keptUntil: number;
}

interface WaitRow {
  id: string;
  runId: string;
  teamId: string;
  adapterType: string;
  edge: string;
  /** Null for a wait opened on a record already gone. */
  key: string | null;
  since: number;
  /** Where the wait is parked; null while it is not. */
  address: string | null;
  /** When it was found parked on a deleted record (ms); null while it was not. */
  strandedAt: number | null;
  /** The `fire_event` row that queues its run, for a wait a delivery
   *  opened; null for one its run opened. */
  fireKey: string | null;
}

interface Note {
  waitId: string;
  identity: string;
  version: string | null;
  matched: boolean;
  /** The leaf the noting segment resumed, until its progress is kept. */
  leaf: string | null;
}

const stored = (value: unknown): string => JSON.stringify(value ?? null);
const read = (text: string): unknown => JSON.parse(text);

function byRun<T>(map: Map<string, Map<string, T>>, runId: string): Map<string, T> {
  let inner = map.get(runId);
  if (inner === undefined) {
    inner = new Map();
    map.set(runId, inner);
  }
  return inner;
}

/** A `RunHostStore` in this process's memory, with the run rows and the
 *  delivery write a listen-fire store keeps beside it (for the shared waits
 *  cases). `now` is its clock (due times, leases, the identities' re-send
 *  windows); default the wall clock. */
export function memoryRunHostStore(options: { now?: () => number } = {}): RunHostStore & RunRowStore & DeliveryRowStore {
  const now = options.now ?? Date.now;
  const leaves = new Map<string, Map<string, Leaf>>();
  const joins = new Map<string, Map<string, Join>>();
  const branchExports = new Map<string, Map<string, Map<string, BranchExport>>>();
  /** Each held lease, with the arrival mark it was claimed at. */
  const leases = new Map<string, { token: string; until: number; mark: number }>();
  const work = new Map<string, WorkRow>();
  const sources = new Map<string, string>();
  const runs = new Map<string, string>();
  let lastSeq = 0;
  let log: LogRow[] = [];
  let identities: IdentityRow[] = [];
  const waits = new Map<string, WaitRow>();
  /** Kept deliveries by subscription and the provider's id, to keep a
   *  duplicate out; and each subscription's pull cursor. */
  const deliveryIds = new Set<string>();
  const checkpoints = new Map<string, string>();
  let notes: Note[] = [];

  const leasedTo = (runId: string, fence: string): boolean => {
    const held = leases.get(runId);
    return held !== undefined && held.token === fence && held.until > now();
  };
  const refuseUnlessLeased = (runId: string, fence: string | undefined): void => {
    if (fence !== undefined && !leasedTo(runId, fence)) throw new RunLeaseLost(runId);
  };
  const exportsOf = (runId: string, frameAddress: string): Map<string, BranchExport> => byRun(byRun(branchExports, runId), frameAddress);

  // ── Steps of one write: none yields ──────────────────────────────────────

  const putLeaf = (runId: string, address: string, reason: ParkReason, wakeAt: string | null, state: unknown): void => {
    byRun(leaves, runId).set(address, { reason, status: 'parked', wakeAt, state: stored(state) });
  };
  const recordJoin = (runId: string, frameAddress: string, pending: number): void => {
    const frames = byRun(joins, runId);
    const frame = frames.get(frameAddress);
    if (frame === undefined) frames.set(frameAddress, { pending, decremented: new Set(), closer: undefined });
    else frame.pending = pending;
  };
  const enqueue = (input: { kind: string; key: string; payload: unknown; dueAt?: string; teamId?: string }): void => {
    const due = input.dueAt !== undefined ? Date.parse(input.dueAt) : now();
    const row = work.get(input.key);
    if (row === undefined) {
      work.set(input.key, { id: randomUUID(), kind: input.kind, key: input.key, payload: stored(input.payload), dueAt: due, teamId: input.teamId, claim: undefined, leasedUntil: 0, armed: 0, armedAtClaim: 0, dead: false });
      return;
    }
    const leased = row.claim !== undefined && row.leasedUntil > now();
    row.kind = input.kind;
    row.payload = stored(input.payload);
    row.dueAt = leased ? due : Math.min(row.dueAt, due);
    if (input.teamId !== undefined) row.teamId = input.teamId;
    row.armed += 1;
  };
  const waitsOfRun = (runId: string): Set<string> => new Set([...waits.values()].filter((w) => w.runId === runId).map((w) => w.id));
  /** The notes a segment that resumed the leaf made are kept: its progress is. */
  const keepLeafNotes = (runId: string, address: string): void => {
    const ofRun = waitsOfRun(runId);
    for (const note of notes) if (note.leaf === address && ofRun.has(note.waitId)) note.leaf = null;
  };
  /** Anything parked at `address` unparks the run's wait parked there before. */
  const unparkWaits = (runId: string, address: string): void => {
    for (const wait of waits.values()) if (wait.runId === runId && wait.address === address) wait.address = null;
  };
  const finishLeaf = (runId: string, address: string): void => {
    const run = leaves.get(runId);
    if (run?.get(address)?.status === 'resuming') run.delete(address);
    keepLeafNotes(runId, address);
  };
  const markParked = (runId: string): void => {
    const status = runs.get(runId);
    if (status === 'running' || status === 'parked') runs.set(runId, 'parked');
  };
  /** A park the store refuses, named before anything is written. */
  const refusedPark = (runId: string, park: ParkKind): Error | undefined => {
    if (park.kind !== 'wait' || waits.get(park.waitId)?.runId === runId) return undefined;
    return new Error(`run ${runId} has no wait ${park.waitId}`);
  };
  const commitPark = (runId: string, teamId: string, address: string, state: unknown, park: ParkKind): void => {
    putLeaf(runId, address, park.kind === 'wait' ? 'await' : park.kind, park.kind === 'timer' ? park.wakeAt : null, state);
    unparkWaits(runId, address);
    keepLeafNotes(runId, address);
    switch (park.kind) {
      case 'timer':
        // The leaf is the truth; the work row only says when to look.
        enqueue({ kind: RESUME_TIMER_WORK_KIND, key: `${RESUME_TIMER_WORK_KIND}:${runId}`, payload: { runId }, dueAt: park.wakeAt, teamId });
        return;
      case 'wait': {
        const wait = waits.get(park.waitId);
        if (wait === undefined) return;
        wait.address = address;
        // Parked on a record already gone (the newest arrival on it after
        // its mark is gone, or no key), it is stranded as it parks.
        if (wait.strandedAt === null && (wait.key === null || log.filter((row) => onWaitsRecord(wait, row)).at(-1)?.gone === true)) wait.strandedAt = now();
        return;
      }
      case 'limit':
        return;
      default: {
        const unreachable: never = park;
        throw new Error(`not a park: ${JSON.stringify(unreachable)}`);
      }
    }
  };
  const requireWait = (waitId: string): WaitRow => {
    const wait = waits.get(waitId);
    if (wait === undefined) throw new Error(`no wait ${waitId}`);
    return wait;
  };
  const onWaitsRecord = (wait: WaitRow, row: LogRow): boolean =>
    row.teamId === wait.teamId && row.adapterType === wait.adapterType && row.edge === wait.edge && row.key === wait.key && row.seq > wait.since;
  const waitArrivals = (waitId: string): { arrivals: ListedArrival[] } => {
    const wait = requireWait(waitId);
    const logged = log.filter((row) => onWaitsRecord(wait, row));
    const arrivals: ListedArrival[] = [];
    for (const row of logged) {
      if (row.gone) continue;
      // One without an identity is its own: `#` and its seq, never a bare
      // seq a module reports.
      const identity = row.identity ?? `#${row.seq}`;
      if (notes.some((n) => n.waitId === waitId && n.identity === identity && n.version === row.version)) continue;
      if (logged.some((b) => !b.gone && b.seq < row.seq && b.identity !== null && b.identity === row.identity && b.version === row.version)) continue;
      arrivals.push({ seq: row.seq, identity, version: row.version, landing: row.landing === null ? null : read(row.landing) });
    }
    return { arrivals };
  };
  /** Whether the wait's leaf is still parked where the wait is. */
  const parkedNow = (wait: WaitRow): boolean => wait.address !== null && leaves.get(wait.runId)?.has(wait.address) === true;
  const strandedOf = (wait: WaitRow & { strandedAt: number }): StrandedWait => ({
    waitId: wait.id,
    runId: wait.runId,
    adapterType: wait.adapterType,
    edge: wait.edge,
    key: wait.key,
    at: new Date(wait.strandedAt).toISOString(),
    parked: parkedNow(wait),
  });
  const dropOwedRace = (runId: string, frameAddress: string): void => {
    work.delete(settleRaceWorkKey(runId, frameAddress));
  };
  /** Oldest first: a row keeps its place when a second arm owes it again. */
  const owedOf = (runId: string): OwedRace[] => {
    const owed: OwedRace[] = [];
    for (const row of work.values()) {
      if (row.kind !== SETTLE_RACE_WORK_KIND) continue;
      const payload = read(row.payload);
      if (typeof payload !== 'object' || payload === null || Reflect.get(payload, 'runId') !== runId) continue;
      const frameAddress: unknown = Reflect.get(payload, 'frameAddress');
      if (typeof frameAddress !== 'string') throw new Error(`a ${SETTLE_RACE_WORK_KIND} row of run ${runId} that is not one: ${row.payload}`);
      owed.push({ frameAddress, state: Reflect.get(payload, 'state') ?? null });
    }
    return owed;
  };
  const queueWake = (teamId: string, wake: WaitWake): void => {
    enqueue({ kind: WAKE_AWAIT_WORK_KIND, key: `${WAKE_AWAIT_WORK_KIND}:${randomUUID()}`, payload: wake, teamId });
  };
  const logArrivals = (input: { teamId: string; adapterType: string; arrivals: readonly NewArrival[]; at: string; resendWindowMs: number }): { wakes: WaitWake[]; stranded: StrandedWait[] } => {
    const { teamId, adapterType, arrivals, at } = input;
    const loggedAt = Date.parse(at);
    const keptUntil = loggedAt + input.resendWindowMs;
    const wakes: WaitWake[] = [];
    const stranded: StrandedWait[] = [];
    for (const arrival of arrivals) {
      const { edge, key, identity, version } = arrival;
      const sameRecord = (row: { teamId: string; adapterType: string; edge: string; key: string | null }): boolean =>
        row.teamId === teamId && row.adapterType === adapterType && row.edge === edge && row.key === key;
      if (identity !== null) {
        // A sender's retry: its identity and version logged there within the
        // module's re-send window, even if the sweep forgot its entry since.
        if (identities.some((row) => sameRecord(row) && row.identity === identity && row.version === version && row.keptUntil > loggedAt)) continue;
        identities.push({ teamId, adapterType, edge, key, identity, version, keptUntil });
      }
      lastSeq += 1;
      log.push({ seq: lastSeq, teamId, adapterType, edge, key, identity, version, landing: arrival.landing === null ? null : stored(arrival.landing), gone: arrival.gone, loggedAt });
      // A deleted record answers no wait: the waits parked on it are
      // stranded, once, and keep waiting.
      if (arrival.gone) {
        for (const wait of waits.values()) {
          if (!sameRecord(wait) || wait.strandedAt !== null || !parkedNow(wait)) continue;
          wait.strandedAt = loggedAt;
          stranded.push(strandedOf({ ...wait, strandedAt: loggedAt }));
        }
        continue;
      }
      // The newest report on a record wins: one after a gone one says
      // the record is back (or never went), so its waits are not
      // stranded.
      for (const wait of waits.values()) {
        if (!sameRecord(wait) || wait.strandedAt === null) continue;
        wait.strandedAt = null;
        const unstranded = stranded.findIndex((w) => w.waitId === wait.id);
        if (unstranded !== -1) stranded.splice(unstranded, 1);
      }
      for (const wait of waits.values()) {
        if (!sameRecord(wait) || wait.address === null) continue;
        // A wait whose park has finished needs no wake: its leaf is gone.
        if (leaves.get(wait.runId)?.has(wait.address) !== true) continue;
        if (!wakes.some((w) => w.waitId === wait.id)) wakes.push({ runId: wait.runId, waitId: wait.id, address: wait.address });
      }
    }
    for (const wake of wakes) queueWake(teamId, wake);
    return { wakes, stranded };
  };
  /** The run's wait on this edge of this record: the one it has, or a new one. */
  const openWait = (input: { runId: string; teamId: string; adapterType: string; edge: string; key: string | null; since: number; fireKey: string | null }): string => {
    const { runId, teamId, adapterType, edge, key, since, fireKey } = input;
    for (const wait of waits.values()) {
      if (wait.runId === runId && wait.teamId === teamId && wait.adapterType === adapterType && wait.edge === edge && wait.key === key) return wait.id;
    }
    const id = randomUUID();
    waits.set(id, { id, runId, teamId, adapterType, edge, key, since, address: null, strandedAt: null, fireKey });
    return id;
  };
  /** A wait a delivery opens for a run it queues; its trigger's own arrival
   *  noted as judged, not matched, so it never answers its own run. */
  const openDeliveryWait = (teamId: string, adapterType: string, wait: DeliveryWait, since: number): void => {
    const waitId = openWait({ runId: wait.runId, teamId, adapterType, edge: wait.edge, key: wait.key, since, fireKey: wait.fireKey });
    const noted = wait.preNoted;
    if (noted !== undefined) notes.push({ waitId, identity: noted.identity, version: noted.version, matched: false, leaf: null });
  };
  /** A wait its run opened lives as long as its run's state; one a delivery
   *  opened, while its run exists or its `fire_event` row is queued. */
  const live = (wait: WaitRow): boolean => {
    if (wait.fireKey === null || runs.has(wait.runId)) return true;
    const fire = work.get(wait.fireKey);
    return fire !== undefined && !fire.dead;
  };
  /** The lowest mark an unexpired lease took, else the latest seq. */
  const floor = (): number => {
    const held = [...leases.values()].filter((lease) => lease.until > now()).map((lease) => lease.mark);
    return held.length > 0 ? Math.min(...held) : lastSeq;
  };
  const dropWaits = (ids: ReadonlySet<string>): void => {
    notes = notes.filter((n) => !ids.has(n.waitId));
    for (const id of ids) waits.delete(id);
  };

  return {
    parks: {
      async putLeaf({ runId, address, reason, wakeAt, state, fence }) {
        refuseUnlessLeased(runId, fence);
        putLeaf(runId, address, reason, wakeAt, state);
      },
      async commit({ runId, teamId, address, state, fence, park }) {
        refuseUnlessLeased(runId, fence);
        const refused = refusedPark(runId, park);
        if (refused !== undefined) throw refused;
        commitPark(runId, teamId, address, state, park);
        markParked(runId);
      },
      async commitSegment({ runId, teamId, fence, resumed, joins: held, parks, settle, owedRaces = [], settledRace }) {
        refuseUnlessLeased(runId, fence);
        for (const { park } of parks) {
          const refused = refusedPark(runId, park);
          if (refused !== undefined) throw refused;
        }
        for (const join of held) recordJoin(runId, join.frameAddress, join.pending);
        for (const park of parks) commitPark(runId, teamId, park.address, park.state, park.park);
        if (resumed !== null && !parks.some((park) => park.address === resumed)) finishLeaf(runId, resumed);
        if (parks.length > 0) markParked(runId);
        if (settle !== null && runs.has(runId)) runs.set(runId, settle.status);
        if (settledRace !== undefined && settledRace !== null) dropOwedRace(runId, settledRace);
        for (const race of owedRaces) {
          enqueue({ kind: SETTLE_RACE_WORK_KIND, key: settleRaceWorkKey(runId, race.frameAddress), payload: { runId, frameAddress: race.frameAddress, state: race.state }, teamId });
        }
        // Read in the write: an arrival logged before it is read here, and one
        // logged after it finds the wait parked.
        const wakes: WaitWake[] = [];
        for (const { address, park } of parks) {
          if (park.kind !== 'wait') continue;
          const unread = waitArrivals(park.waitId);
          if (unread.arrivals.length === 0) continue;
          const wake = { runId, waitId: park.waitId, address };
          queueWake(teamId, wake);
          wakes.push(wake);
        }
        return wakes;
      },
      async owedRaces({ runId }) {
        return owedOf(runId);
      },
      async claimLeaf({ runId, address, reason }) {
        const leaf = leaves.get(runId)?.get(address);
        if (leaf === undefined || leaf.status !== 'parked' || (reason !== undefined && leaf.reason !== reason)) return null;
        leaf.status = 'resuming';
        // What a segment that resumed it before noted and never kept: it died.
        const ofRun = waitsOfRun(runId);
        notes = notes.filter((n) => !(n.leaf === address && ofRun.has(n.waitId)));
        return { state: read(leaf.state), reason: leaf.reason };
      },
      async finishLeaf({ runId, address, fence }) {
        if (fence !== undefined && !leasedTo(runId, fence)) return;
        finishLeaf(runId, address);
      },
      async leaves({ runId, parkedOnly, reason, dueBy }) {
        const due = dueBy !== undefined ? Date.parse(dueBy) : undefined;
        const rows: LeafRow[] = [];
        for (const [address, leaf] of leaves.get(runId) ?? []) {
          if (parkedOnly === true && leaf.status !== 'parked') continue;
          if (reason !== undefined && leaf.reason !== reason) continue;
          if (due !== undefined && (leaf.wakeAt === null || Date.parse(leaf.wakeAt) > due)) continue;
          rows.push({ address, reason: leaf.reason, status: leaf.status, wakeAt: leaf.wakeAt });
        }
        return rows;
      },
      async deleteLeaves({ runId, addresses }) {
        const run = leaves.get(runId);
        for (const address of addresses) run?.delete(address);
      },
    },

    joins: {
      async recordJoin({ runId, frameAddress, pending, fence }) {
        refuseUnlessLeased(runId, fence);
        recordJoin(runId, frameAddress, pending);
      },
      async decrementJoin({ runId, frameAddress, branchAddress }) {
        const frame = joins.get(runId)?.get(frameAddress);
        if (frame === undefined) return { closed: false };
        if (frame.decremented.has(branchAddress)) return { closed: frame.closer === branchAddress };
        frame.decremented.add(branchAddress);
        if (frame.decremented.size < frame.pending) return { closed: false };
        frame.closer = branchAddress;
        return { closed: true };
      },
      async persistBranchExport({ runId, frameAddress, branchAddress, branchIndex, exports }) {
        exportsOf(runId, frameAddress).set(branchAddress, { branchIndex, exports: stored(exports) });
      },
      async collectBranchExports({ runId, frameAddress }) {
        return [...(branchExports.get(runId)?.get(frameAddress) ?? [])]
          .map(([branchAddress, branch]) => ({ branchAddress, branchIndex: branch.branchIndex, exports: read(branch.exports) }))
          .sort((a, b) => a.branchIndex - b.branchIndex);
      },
      async hasPendingJoins({ runId }) {
        return [...(joins.get(runId)?.values() ?? [])].some((frame) => frame.decremented.size < frame.pending);
      },
      async frames({ runId }) {
        return [...(joins.get(runId)?.keys() ?? [])];
      },
      async deleteFrames({ runId, frameAddresses }) {
        for (const frameAddress of frameAddresses) {
          joins.get(runId)?.delete(frameAddress);
          branchExports.get(runId)?.delete(frameAddress);
          // A withdrawn race is settled by nobody.
          dropOwedRace(runId, frameAddress);
        }
      },
    },

    waits: {
      async mark() {
        return lastSeq;
      },
      async log(input) {
        return logArrivals(input);
      },
      async open({ runId, teamId, adapterType, edge, key, since }) {
        return { waitId: openWait({ runId, teamId, adapterType, edge, key, since, fireKey: null }) };
      },
      async stranded(of) {
        const every = [...waits.values()]
          .flatMap((wait) => (wait.strandedAt === null ? [] : [strandedOf({ ...wait, strandedAt: wait.strandedAt })]))
          .sort((a, b) => (a.at === b.at ? (a.waitId < b.waitId ? -1 : 1) : a.at < b.at ? -1 : 1));
        if ('runId' in of) return every.filter((wait) => wait.runId === of.runId);
        const { after } = of;
        const afterAt = after === undefined ? '' : new Date(after.at).toISOString();
        const later = after === undefined ? every : every.filter((wait) => wait.at > afterAt || (wait.at === afterAt && wait.waitId > after.waitId));
        return later.slice(0, of.limit);
      },
      async arrivals({ waitId }) {
        return waitArrivals(waitId);
      },
      async note({ waitId, identity, version, matched, leaf, fence }) {
        const wait = requireWait(waitId);
        refuseUnlessLeased(wait.runId, fence);
        if (notes.some((n) => n.waitId === waitId && n.identity === identity && n.version === version)) return false;
        const last = notes.filter((n) => n.waitId === waitId && n.identity === identity).at(-1);
        notes.push({ waitId, identity, version, matched, leaf: leaf ?? null });
        return matched && last?.matched !== true;
      },
      async sweep({ limit, floor: held }) {
        const below = Math.min(floor(), held ?? Number.POSITIVE_INFINITY);
        const readByLiveWait = (row: LogRow): boolean => [...waits.values()].some((wait) => onWaitsRecord(wait, row) && live(wait));
        const doomed = new Set(log.filter((row) => row.seq <= below && !readByLiveWait(row)).slice(0, limit).map((row) => row.seq));
        log = log.filter((row) => !doomed.has(row.seq));
        const at = now();
        const lapsed = identities.filter((row) => row.keptUntil < at).slice(0, limit);
        identities = identities.filter((row) => !lapsed.includes(row));
        return { swept: doomed.size };
      },
    },

    leases: {
      async claim({ runId, ttlMs }) {
        const held = leases.get(runId);
        if (held !== undefined && held.until > now()) return null;
        const token = randomUUID();
        leases.set(runId, { token, until: now() + ttlMs, mark: lastSeq });
        // Whatever a holder left claimed is parked again for this one: no
        // live holder is resuming it.
        for (const leaf of leaves.get(runId)?.values() ?? []) leaf.status = 'parked';
        return { token };
      },
      async renew({ runId, token, ttlMs }) {
        const held = leases.get(runId);
        if (held === undefined || held.token !== token || held.until <= now()) return false;
        held.until = now() + ttlMs;
        return true;
      },
      async release({ runId, token }) {
        if (leases.get(runId)?.token === token) leases.delete(runId);
      },
      async dropRunState({ runId, fence }) {
        if (fence !== undefined && !leasedTo(runId, fence)) return false;
        leaves.delete(runId);
        joins.delete(runId);
        branchExports.delete(runId);
        dropWaits(waitsOfRun(runId));
        for (const race of owedOf(runId)) dropOwedRace(runId, race.frameAddress);
        return true;
      },
    },

    work: {
      async enqueue(input) {
        enqueue(input);
      },
      async enqueueIfAbsent({ kind, key, payload, dueAt, teamId }) {
        if (work.has(key)) return false;
        work.set(key, { id: randomUUID(), kind, key, payload: stored(payload), dueAt: dueAt !== undefined ? Date.parse(dueAt) : now(), teamId, claim: undefined, leasedUntil: 0, armed: 0, armedAtClaim: 0, dead: false });
        return true;
      },
      async claimDue({ limit, leaseMs, dueBy, kinds, teamId }) {
        const by = dueBy !== undefined ? Date.parse(dueBy) : now();
        const claimed: ClaimedWork[] = [];
        for (const row of [...work.values()].sort((a, b) => a.dueAt - b.dueAt)) {
          if (claimed.length >= limit) break;
          if (row.dead || row.dueAt > by || (row.claim !== undefined && row.leasedUntil > now())) continue;
          if (kinds !== undefined && !kinds.includes(row.kind)) continue;
          if (teamId !== undefined && row.teamId !== teamId) continue;
          row.claim = randomUUID();
          row.leasedUntil = now() + leaseMs;
          row.armedAtClaim = row.armed;
          claimed.push({ id: row.id, kind: row.kind, key: row.key, payload: read(row.payload), claim: row.claim });
        }
        return claimed;
      },
      async complete({ key, claim }) {
        const row = work.get(key);
        if (row === undefined || row.claim !== claim) return;
        if (row.armed !== row.armedAtClaim) {
          row.claim = undefined;
          row.leasedUntil = 0;
          return;
        }
        work.delete(key);
      },
      async release({ key, claim, dueAt }) {
        const row = work.get(key);
        if (row === undefined || row.claim !== claim) return;
        row.claim = undefined;
        row.leasedUntil = 0;
        if (row.armed === row.armedAtClaim) row.dueAt = dueAt !== undefined ? Date.parse(dueAt) : now();
      },
    },

    sources: {
      async put({ teamId, hash, source }) {
        const key = JSON.stringify([teamId, hash]);
        if (!sources.has(key)) sources.set(key, source);
      },
      async get({ teamId, hash }) {
        return sources.get(JSON.stringify([teamId, hash])) ?? null;
      },
    },

    async startRun({ runId }) {
      if (!runs.has(runId)) runs.set(runId, 'running');
    },
    async runStatus({ runId }) {
      return runs.get(runId) ?? null;
    },

    async keepDelivery(input: KeepDelivery): Promise<KeptDelivery> {
      const { subscriptionId, delivery, arrivals } = input;
      if (delivery.externalId !== undefined && delivery.externalId !== null) {
        const id = JSON.stringify([subscriptionId, delivery.externalId]);
        if (deliveryIds.has(id)) return { kept: false };
        deliveryIds.add(id);
      }
      if ('checkpoint' in input) checkpoints.set(subscriptionId, stored(input.checkpoint));
      const arrivalMark = lastSeq;
      let wakes: WaitWake[] | undefined;
      if (arrivals !== undefined) {
        for (const wait of input.waits ?? []) openDeliveryWait(arrivals.teamId, arrivals.adapterType, wait, arrivalMark);
        wakes = logArrivals(arrivals).wakes;
      }
      for (const row of input.work) {
        // Each run a delivery queues reads from the mark before its arrivals.
        const payload = row.kind === 'fire_event' && typeof row.payload === 'object' && row.payload !== null ? { ...row.payload, arrivalMark } : row.payload;
        enqueue({ kind: row.kind, key: row.key, payload, ...(row.dueAt != null ? { dueAt: row.dueAt } : {}), ...(row.teamId != null ? { teamId: row.teamId } : {}) });
      }
      return wakes === undefined ? { kept: true, arrivalMark } : { kept: true, arrivalMark, wakes };
    },
    async bury({ key, claim }) {
      const row = work.get(key);
      if (row === undefined || row.claim !== claim) return;
      row.dead = true;
      row.claim = undefined;
      row.leasedUntil = 0;
      // The waits it opened for runs that never started read for nobody.
      dropWaits(new Set([...waits.values()].filter((wait) => wait.fireKey === key && !runs.has(wait.runId)).map((wait) => wait.id)));
    },
  };
}

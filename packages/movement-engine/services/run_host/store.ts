// The run host's backend: the durable state a run leaves between its segments
// (parked leaves, the joins they hold, the waits its awaits read and the
// arrivals logged for them, the run lease, the work queue), as the families
// every backend serves. The hosted product serves
// them from Postgres and `listen-fire` from SQLite; the rules that read and write them
// (when a run is complete, how a wake reaches its park, how a race settles,
// how a cancel or a failure tears a run down) are the core's (rules.ts,
// drain.ts), written once over these families.
//
// Every method is plain data in and out. A backend is held to one meaning by
// the contract suite (contract.ts), run against each.

import type { CoreParkReason, ParkReason } from 'engine-contracts';

/** One parked leaf of a run, as the backend lists it. */
export interface LeafRow {
  address: string;
  /** One of the core's reasons, or one a unit owns: a unit's parked leaf
   *  still holds its run open. */
  reason: ParkReason;
  /** `parked`, or `resuming` while a resume holds its claim. */
  status: 'parked' | 'resuming';
  /** A timer's wake instant (ISO 8601); null for any other reason. */
  wakeAt: string | null;
}

export interface ParkStore {
  /**
   * Park a leaf: one row per (run, address), so a re-reached park rewrites its
   * own row, `parked` again. `rewritten` stamps the row as rewritten (how a
   * limit resume tells a flow that suspended again at once from the one it
   * stepped). Given `fence`, it lands only while the run's lease is that
   * token's, and throws `RunLeaseLost` otherwise.
   */
  putLeaf(input: {
    runId: string;
    address: string;
    reason: CoreParkReason;
    wakeAt: string | null;
    state?: unknown;
    rewritten?: boolean;
    fence?: string;
  }): Promise<void>;
  /**
   * Park a leaf and what wakes it, in one fenced write: the leaf (as
   * `putLeaf`, the kind its reason; a wait's reason is `await`); a timer's
   * run row armed at `wakeAt` (as `armTimerWake`); a wait's wait parked at
   * `address` (a wait the run does not have writes nothing, and fails),
   * stranded as it parks when its record is already gone (the newest
   * arrival logged on it after its `since` is gone, or no key;
   * `waits.stranded`). Any
   * kind unparks the run's wait parked at `address` before, and keeps the
   * run's wait notes that name `address` as their `leaf`. A wait's park never
   * interleaves with a `waits.log` on its record's edge: either the log sees
   * the park and answers it, or the park lands after the log, so a run that
   * reads its wait's arrivals after parking misses none. Throws
   * `RunLeaseLost`, writing nothing, when `fence` is not the run's lease.
   * `teamId` is the run's tenant: a timer's row is queued under it (a store
   * module serves one tenant, and takes none over the wire).
   */
  commit(input: { runId: string; teamId: string; address: string; state?: unknown; fence?: string; park: ParkKind; rewritten?: boolean }): Promise<void>;
  /**
   * One fenced write of what a step left its run to do (docs/contracts/store-slot.md,
   * `parks.commitSegment`): each join recorded, each park committed in order,
   * `resumed` finished (as `finishLeaf`) unless a park is at its address, the
   * run marked parked when anything parked, then the run settled by `settle`;
   * the `settle_race` row of `settledRace` deleted and each of `owedRaces`
   * queued (key `settle_race:<runId>:<frameAddress>`, team `teamId`); and a
   * `wake_await` row queued, and answered, for each wait a park parks whose
   * arrivals are unread (a deleted record wakes nothing). Throws `RunLeaseLost`,
   * writing nothing, when `fence` is not the run's lease; a park the store
   * refuses writes nothing either.
   *
   * listen-fire holds a segment's parks and joins back for this write. The
   * run host in this package writes each park as the engine makes it, and
   * ends each step with this write alone: the leaf it resumed finished, with
   * the races its arm won owed in the same write; or the race it settled
   * discharged. So a race is never owed only in a drain's memory.
   */
  commitSegment(input: {
    runId: string;
    teamId: string;
    fence?: string;
    resumed: string | null;
    joins: ReadonlyArray<{ frameAddress: string; pending: number }>;
    parks: ReadonlyArray<{ address: string; state?: unknown; park: ParkKind }>;
    settle: RunSettle | null;
    owedRaces?: readonly OwedRace[];
    settledRace?: string | null;
  }): Promise<WaitWake[]>;
  /** The races the run owes (its `settle_race` rows), oldest first. */
  owedRaces(input: { runId: string }): Promise<OwedRace[]>;
  /** Claim a parked leaf for its resume (`parked` → `resuming`). Null when it
   *  is not parked: another resume took it, or a race cancelled it. Claiming
   *  drops the wait notes that name the leaf as their `leaf`: the segment
   *  that made them died before its progress was kept. */
  claimLeaf(input: { runId: string; address: string; reason?: ParkReason }): Promise<{ state?: unknown; reason: ParkReason } | null>;
  /** The claimed leaf is done with: delete it unless its step parked it again
   *  (the row is `parked` again, and stays), keeping the wait notes that name
   *  it as their `leaf`. Given `fence`, only while the run's lease is still
   *  that token's. */
  finishLeaf(input: { runId: string; address: string; fence?: string }): Promise<void>;
  /** The run's leaves, by address. `parkedOnly` leaves out claimed ones;
   *  `dueBy` keeps only timers due by that instant. */
  leaves(input: { runId: string; parkedOnly?: boolean; reason?: ParkReason; dueBy?: string }): Promise<LeafRow[]>;
  /** Delete the named leaves, whatever their status. */
  deleteLeaves(input: { runId: string; addresses: readonly string[] }): Promise<void>;
}

export interface JoinStore {
  /** A join frame's count of parked children. A re-reached frame rewrites the
   *  count to the same value, never double-counting. Fenced as `putLeaf`. */
  recordJoin(input: { runId: string; frameAddress: string; pending: number; fence?: string }): Promise<void>;
  /** One branch finished: decrement exactly once per branch. True for the one
   *  branch that closes the frame, also on a retry of that branch. */
  decrementJoin(input: { runId: string; frameAddress: string; branchAddress: string; leafAddress: string }): Promise<{ closed: boolean }>;
  /** A completed branch's exports, written before its decrement. A rewrite
   *  keeps the branch's decrement claim. */
  persistBranchExport(input: { runId: string; frameAddress: string; branchAddress: string; branchIndex: number; exports: unknown }): Promise<void>;
  collectBranchExports(input: { runId: string; frameAddress: string }): Promise<Array<{ branchAddress: string; branchIndex: number; exports?: unknown }>>;
  /** Whether any join of the run still waits on a branch (a closed frame does not). */
  hasPendingJoins(input: { runId: string }): Promise<boolean>;
  /** Every join frame of the run, pending or closed. */
  frames(input: { runId: string }): Promise<string[]>;
  /** Delete the named frames and their branch exports. */
  deleteFrames(input: { runId: string; frameAddresses: readonly string[] }): Promise<void>;
}

/** What wakes a parked leaf: its wake time, a wait, or nothing (a limit
 *  pause, resumed by an operator). */
export type ParkKind = { kind: 'timer'; wakeAt: string } | { kind: 'wait'; waitId: string } | { kind: 'limit' };

/** One arrival as the log keeps it. `identity` and `version` as the edge
 *  declares them, null for none: an arrival without an identity is its own.
 *  `gone`: the record went, and nothing more arrives on its edges. */
export interface NewArrival {
  edge: string;
  /** The record whose edge it arrived on, as the module keys it. */
  key: string;
  identity: string | null;
  version: string | null;
  /** The arrived record as the module reported it (JSON), null for none. */
  landing: unknown;
  gone: boolean;
}

/** An arrival a wait has yet to note (`waits.arrivals`). */
export interface ListedArrival {
  seq: number;
  /** The reported one, or `#` and the seq when it reported none. */
  identity: string;
  version: string | null;
  landing: unknown;
}

/** A wait parked at `address` that a logged arrival answers. */
export interface WaitWake {
  runId: string;
  waitId: string;
  address: string;
}

/** A wait parked on a record whose newest report is that it went
 *  (`waits.stranded`, docs/contracts/stranded-waits.md): it never resolves
 *  unless the record reports again. */
export interface StrandedWait {
  waitId: string;
  runId: string;
  adapterType: string;
  edge: string;
  /** Null for a wait opened on a record already gone. */
  key: string | null;
  /** When the store found it parked on a deleted record (ISO 8601). */
  at: string;
  /** Whether its leaf is still parked: a race's other arm may have won. */
  parked: boolean;
}

/** Which stranded waits `waits.stranded` answers: one run's, or every
 *  run's a page at a time, after the last wait of the page before. */
export type StrandedOf = { runId: string } | { after?: { at: string; waitId: string }; limit: number };

/**
 * A run's waits on listenable edges and the log of arrivals they read
 * (docs/contracts/store-slot.md, `waits.*`; the cases every store is held to
 * are engine-contracts' conformance/store-waits.json).
 */
export interface WaitStore {
  /** The latest seq logged (0 for none): every arrival logged after this
   *  answer is above it. */
  mark(): Promise<number>;
  /**
   * Log each arrival at `at`, in order, under a seq above every seq before
   * it, and queue a `wake_await` row (payload a `WaitWake`, team `teamId`)
   * for each wait parked on their records, in one write: a crash leaves
   * both or neither. Answers those waits (one each) as `wakes`. A gone
   * arrival wakes none: it strands each wait parked on its record not
   * stranded already, at `at`. Any other arrival on a record clears its
   * waits' stranding (the newest report wins) and wakes the parked ones.
   * `stranded` is the waits the log left stranded. A repeat (an identity
   * and version its team, adapter, edge and record logged within the
   * module's re-send window `resendWindowMs` before `at`) is skipped and
   * answers nothing, even after the sweep forgot its entry: each identity
   * is kept apart from its entry until `at` plus the window. An arrival
   * without an identity is never a repeat.
   */
  log(input: { teamId: string; adapterType: string; arrivals: readonly NewArrival[]; at: string; resendWindowMs: number }): Promise<{ wakes: WaitWake[]; stranded: StrandedWait[] }>;
  /** The run waits on this edge of this record, reading what is logged after
   *  `since`. A run that already waits on it keeps that wait, and its `since`.
   *  A null `key`: the record was already gone, so nothing arrives on it and
   *  a park on it strands it; a run that already waits on this edge of a
   *  record already gone keeps that wait. */
  open(input: { runId: string; teamId: string; adapterType: string; edge: string; key: string | null; since: number }): Promise<{ waitId: string }>;
  /** What the wait has yet to note, in seq order, the first of each identity
   *  and version only (one without an identity reads as `#` and its seq). An
   *  unknown wait fails. */
  arrivals(input: { waitId: string }): Promise<{ arrivals: ListedArrival[] }>;
  /** The stranded waits `of` names, oldest stranded first (ties by wait id).
   *  A wait is stranded when it is parked on a record already gone: by a
   *  gone arrival logged while it is parked, or as a park parks it on a
   *  record whose newest arrival after its `since` is gone, or with no key.
   *  It stays stranded until an arrival other than a gone one is logged on
   *  its record (`stranded_at` cleared), or its run's rows go. */
  stranded(of: StrandedOf): Promise<StrandedWait[]>;
  /**
   * Note the wait judged an arrival, and whether its record matched: whether
   * it counts (it matched, and its identity did not match at its last noted
   * arrival). An arrival noted before answers false. `leaf` is the leaf the
   * noting segment resumed: the note is kept with that segment's progress
   * (`finishLeaf` of it, a `commit` at its address) and dropped by its next
   * `claimLeaf`. Throws `RunLeaseLost`, noting nothing, when `fence` is not
   * the run's lease.
   */
  note(input: { waitId: string; identity: string; version: string | null; matched: boolean; leaf?: string; fence?: string }): Promise<boolean>;
  /**
   * Forget at most `limit` arrivals, and the identities whose re-send window
   * has passed: how many arrivals went. An arrival goes when no live wait on
   * its record's edge reads from below it, and it is at or below the floor:
   * the lowest mark an unexpired run lease took when it was claimed, else the
   * latest seq. A wait is live while its run exists, or, one a delivery
   * opened (`keepDelivery`'s `waits`), while its `fire_event` row is queued.
   * `floor`: a mark the caller's own running steps hold in its process
   * rather than by a lease; nothing above it goes either.
   */
  sweep(input: { limit: number; floor?: number }): Promise<{ swept: number }>;
}

export interface RunLeaseStore {
  /** Take the run's lease if it is free or lapsed, returning every leaf left
   *  claimed (`resuming`) to `parked`, whether its holder lapsed or released
   *  the lease: no live holder is resuming it. The lease keeps the arrival
   *  mark it was claimed at (`waits.mark`), the floor the sweep keeps
   *  arrivals above while it holds: its step takes its marks after. Null
   *  while someone else holds it. */
  claim(input: { runId: string; ttlMs: number }): Promise<{ token: string } | null>;
  /** Extend a held lease. False once it is not this token's, or has lapsed. */
  renew(input: { runId: string; token: string; ttlMs: number }): Promise<boolean>;
  /** Give it back. A no-op when it is no longer this token's. */
  release(input: { runId: string; token: string }): Promise<void>;
  /**
   * Drop the run's live state: every leaf, every join with its exports,
   * every wait with its notes, and every race it owes.
   * Given `fence`, only while the run is still leased under it: false when it
   * is not, and nothing was dropped.
   */
  dropRunState(input: { runId: string; fence?: string }): Promise<boolean>;
}

/**
 * The library texts parked runs pin (park-state version 2's `libraries`),
 * each kept once per tenant by its content's hash, however many parks name
 * it. Never deleted: a row is small, and a park written long ago may still
 * name it.
 */
export interface SourceStore {
  /** Keep `source` under `hash`; a no-op when it is already kept. */
  put(input: { teamId: string; hash: string; source: string }): Promise<void>;
  /** The text kept under `hash`, or null. */
  get(input: { teamId: string; hash: string }): Promise<string | null>;
}

/** The work the run host queues: a run's timer row (one per run, due at its
 *  earliest timer), the wake of one wait an arrival answered, and a race an
 *  arm won and left its run to settle. */
export const RESUME_TIMER_WORK_KIND = 'resume_timer';
export const WAKE_AWAIT_WORK_KIND = 'wake_await';
export const SETTLE_RACE_WORK_KIND = 'settle_race';
export type RunHostWorkKind = typeof RESUME_TIMER_WORK_KIND | typeof WAKE_AWAIT_WORK_KIND | typeof SETTLE_RACE_WORK_KIND;
export const RUN_HOST_WORK_KINDS: readonly RunHostWorkKind[] = [RESUME_TIMER_WORK_KIND, WAKE_AWAIT_WORK_KIND, SETTLE_RACE_WORK_KIND];

/** The run host's kind a work row is of, or null for another's. */
export function runHostWorkKindOf(kind: string): RunHostWorkKind | null {
  return RUN_HOST_WORK_KINDS.find((known) => known === kind) ?? null;
}

/** The `settle_race` row of the race at `frameAddress`: one per race, so two
 *  arms that owe it keep one row. */
export function settleRaceWorkKey(runId: string, frameAddress: string): string {
  return `${SETTLE_RACE_WORK_KIND}:${runId}:${frameAddress}`;
}

/** Why a claimed row goes back unfinished (`WorkQueue.release`). */
export type WorkRelease = 'failed' | 'busy' | 'rescheduled';

/** A claimed work row: what to do, and the claim to finish it under. */
export interface ClaimedWork {
  id: string;
  kind: string;
  key: string;
  payload?: unknown;
  claim: string;
}

export interface WorkQueue {
  /** Upsert by key. Against an unleased row the earliest due time wins; against
   *  a leased row the new one does (a re-arm during the work). The payload is
   *  always the new one. */
  enqueue(input: { kind: string; key: string; payload: unknown; dueAt?: string; teamId?: string }): Promise<void>;
  /** Insert when no row has the key, in one write; a row there in any state
   *  (due, leased, buried) is left as it is. Whether it was queued: arming a
   *  listen's standing row from several workers queues it once, and never
   *  moves the due time of a row another worker holds. */
  enqueueIfAbsent(input: { kind: string; key: string; payload: unknown; dueAt?: string; teamId?: string }): Promise<boolean>;
  /** Lease up to `limit` rows due by `dueBy`, unleased or with a lapsed lease;
   *  only rows of `kinds` when it is given (a drain pool's), else every kind;
   *  and only rows queued under `teamId` when it is given, so another team's
   *  rows never count against the limit. A store that serves one tenant (a
   *  store module over the wire) keeps no row's team, and claims its own rows
   *  whatever `teamId` names: a caller that must step one team's rows only
   *  checks each claimed row's run as well. */
  claimDue(input: { limit: number; leaseMs: number; dueBy?: string; kinds?: readonly string[]; teamId?: string }): Promise<ClaimedWork[]>;
  /** Done: delete the row, unless it was re-armed since the claim (it stays,
   *  unleased, due at its new time). A stale claim changes nothing. */
  complete(work: ClaimedWork): Promise<void>;
  /** Unlease it for a retry, due at `dueAt` unless re-armed since the claim.
   *  `why` is the store slot's (`work.release`): `failed` (the default) counts
   *  the claim as one of the row's attempts, `busy` gives it back (its run was
   *  held elsewhere, or it was never stepped), `rescheduled` starts the
   *  attempts over. A store that keeps no attempts ignores it. */
  release(work: ClaimedWork & { dueAt?: string; why?: WorkRelease }): Promise<void>;
}

/** Every family a run host's backend serves. */
export interface RunHostStore {
  parks: ParkStore;
  joins: JoinStore;
  waits: WaitStore;
  leases: RunLeaseStore;
  work: WorkQueue;
  sources: SourceStore;
}

/** Where a write leaves its run (`runs.settle`, and `parks.commitSegment`'s
 *  `settle`): its status, what it came to, and when. */
export interface RunSettle {
  status: string;
  outcome: unknown;
  at: string;
}

/** A race a step's resumed arm won and left its run to settle, from the
 *  arm's `state` (`parks.owedRaces`). */
export interface OwedRace {
  frameAddress: string;
  state: unknown;
}

// ── A delivery's one write (`inbound.keepDelivery`) ─────────────────────────

/** Where a delivery came in: a provider's webhook, the older `/hooks/…` door,
 *  a module's own push (`emit`), `listen-fire run --webhook` or a replay
 *  (`cli`), or a poll of a listenable edge that fired a listen (`poll`). */
export const DELIVERY_SOURCES = ['webhook', 'hook', 'emit', 'cli', 'poll'] as const;
export type DeliverySource = (typeof DELIVERY_SOURCES)[number];

/** `inbound.keepDelivery`'s `delivery`. */
export interface NewDelivery {
  id: string;
  /** The provider's id for the delivery: a second one under it, at the same subscription, is kept out. */
  externalId?: string | null;
  receivedAt: string;
  source: DeliverySource;
  inline: boolean;
  replayOf?: string | null;
  events: unknown[];
}

/** A work row as `inbound.keepDelivery` queues it (`work.enqueue`'s input). */
export interface NewWorkRow {
  kind: string;
  key: string;
  payload: unknown;
  dueAt?: string | null;
  teamId?: string | null;
}

/** What a delivery says arrived, as `waits.log` takes it. */
export interface DeliveryArrivals {
  teamId: string;
  adapterType: string;
  arrivals: readonly NewArrival[];
  at: string;
  resendWindowMs: number;
}

/**
 * A wait a delivery opens for a run it queues, on the run's trigger: an
 * edge the run's function awaits off its parameter, on the record the
 * module's `awaitKeys` keys the trigger by. It reads from the mark before
 * the delivery's arrivals, so a reply that lands while the run sits in the
 * queue, or later in the same delivery, answers it. `fireKey` is the
 * `fire_event` row that queues the run: the wait is live while that row is
 * queued or the run exists, and goes when the row is buried before the run
 * started. `preNoted` is the trigger's own arrival, noted on the wait as
 * judged and not matched, so the trigger never answers its own run.
 */
export interface DeliveryWait {
  runId: string;
  edge: string;
  /** Null for a record already gone. */
  key: string | null;
  fireKey: string;
  preNoted?: { identity: string; version: string | null };
}

/** `inbound.keepDelivery`'s input: the door's one write. */
export interface KeepDelivery {
  subscriptionId: string;
  /** The pull cursor; absent, the saved one is left as it is. */
  checkpoint?: unknown;
  delivery: NewDelivery;
  work: readonly NewWorkRow[];
  /** Logged as `waits.log` logs them, its wakes queued in the write. */
  arrivals?: DeliveryArrivals;
  /** Opened before the arrivals are logged, from the mark before them; only
   *  with `arrivals` (whose team and adapter they are): sent without them,
   *  the store refuses the write. */
  waits?: readonly DeliveryWait[];
}

/** `inbound.keepDelivery`'s answer. `kept: false`, and nothing written, for
 *  a duplicate. `arrivalMark`: the latest seq before the delivery's
 *  arrivals, each `fire_event` row's `arrivalMark`. `wakes`: the waits its
 *  arrivals answered, when it logged any. */
export type KeptDelivery = { kept: false } | { kept: true; arrivalMark: number; wakes?: WaitWake[] };

/**
 * A delivery's one write and the burial of a row it queued, as the shared
 * waits cases reach them (listen-fire's stores, and the in-memory one).
 */
export interface DeliveryRowStore {
  keepDelivery(input: KeepDelivery): Promise<KeptDelivery>;
  /** Give up on a claimed row (`work.bury`): it stays, dead, and is never
   *  claimed again. Burying a `fire_event` row drops the waits a delivery
   *  opened for the runs it queued that never started. */
  bury(work: ClaimedWork & { reason: string }): Promise<void>;
  /** A row its caller queued a run lease out (so a drain takes it only if
   *  the caller died) and ran itself, done (`work.completeKey`): deleted,
   *  unless a live claim holds it, and with it the waits it opened for runs
   *  that never started. Whether it was deleted. */
  completeKey(input: { key: string }): Promise<boolean>;
}

/**
 * The run rows listen-fire's stores keep beside the families (`runs.start`,
 * `runs.get`): the shared waits cases (conformance/store-waits.json) park
 * against a started run and read its status after a commit. The run host in
 * this package keeps no run rows (its product does), so it calls neither.
 */
export interface RunRowStore {
  /** A run row to park against (`runs.start`). */
  startRun(input: { runId: string }): Promise<void>;
  /** The run's status (`runs.get`), or null for none. */
  runStatus(input: { runId: string }): Promise<string | null>;
}

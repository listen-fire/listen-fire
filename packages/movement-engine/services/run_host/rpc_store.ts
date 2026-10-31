// A run host backend a store module serves: every family of `RunHostStore`
// (store.ts) as the store slot's methods (docs/contracts/store-slot.md),
// carried as adapter protocol 2 calls over HTTP (a Unix socket on this box).
// It is how the contract suite (contract.ts), written once in TypeScript,
// holds a backend in another language to the same meaning —
// `listen-fire --contract-store <state.db>` (crates/lf) first.
//
// A method is `<family>.<method>` as `RunHostStore` names it, its params the
// method's one input object, its result the method's answer; the run records
// are `records.<method>` as `RunRecords` names them, and the run rows
// `runs.start` and `runs.get` (`RunRowStore`). The error code
// `run_lease_lost` (`data: { runId }`) is rethrown as the core's
// `RunLeaseLost`, so the rules over the store see the one refusal they handle.

import { z } from 'zod';
import { RUN_LEASE_LOST_CODE } from 'engine-contracts/slots';
import { RunLeaseLost } from '../movement_engine/errors';
import { SlotClient, SlotRefused, startModule, type SlotAddress } from 'module-runtime/module_wire/wire';
import type { RunRecords } from './rules';
import { DELIVERY_SOURCES, type DeliveryRowStore, type DeliverySource, type KeepDelivery, type KeptDelivery } from './store';
import type { ArrivalRunStore, ClaimedWork, NewArrival, ParkKind, RunHostStore, RunRowStore, WorkRelease } from './store';

const Nothing = z.null();
const Leaf = z.object({
  address: z.string(),
  reason: z.string(),
  status: z.enum(['parked', 'resuming']),
  wakeAt: z.string().nullable(),
});
const Claimed = z.object({ reason: z.string(), state: z.unknown().optional() }).nullable();
const Work = z.object({ id: z.string(), kind: z.string(), key: z.string(), payload: z.unknown().optional(), claim: z.string() });
const Wake = z.object({ runId: z.string(), waitId: z.string(), address: z.string() });
const Kept = z.union([
  z.object({ kept: z.literal(false) }),
  z.object({ kept: z.literal(true), arrivalMark: z.number(), wakes: z.array(Wake).optional() }),
]);
const Listed = z.object({ seq: z.number(), identity: z.string(), version: z.string().nullable(), landing: z.unknown() });
const Stranded = z.object({
  waitId: z.string(),
  runId: z.string(),
  adapterType: z.string(),
  edge: z.string(),
  key: z.string().nullable(),
  /** A store written before waits named their record answers none. */
  recordId: z.string().nullable().default(null),
  at: z.string(),
  parked: z.boolean(),
});

/** A park as the wire carries it: every member said. */
function parkOf(park: ParkKind): Record<string, unknown> {
  return { ...park };
}

/** An arrival as `waits.log` takes it: every member said, `null` for none. */
function arrivalOf(arrival: NewArrival): Record<string, unknown> {
  return { ...arrival, landing: arrival.landing ?? null };
}

// ── Delivery receipts (`inbound.*`) ─────────────────────────────────────────
// What a door keeps of one delivery: the events it produced, in the door's one
// write. Only listen-fire's doors call these, so they live on this client rather than
// on `RunHostStore`.

export { DELIVERY_SOURCES, type DeliverySource, type NewDelivery, type NewWorkRow } from './store';

export interface DeliveryRun {
  id: string;
  status: string;
}

/** A kept delivery; `events` only from `inbound.delivery`. */
export interface DeliveryRow {
  id: string;
  subscriptionId: string;
  externalId: string | null;
  receivedAt: string;
  source: DeliverySource;
  inline: boolean;
  replayOf: string | null;
  eventCount: number;
  runs: DeliveryRun[];
  events?: unknown[];
}

/** A run row as `runs.get` answers it. */
export interface RunRow {
  id: string;
  file: string;
  movement: string;
  status: string;
  startedAt: string;
  input: string;
  outcome: string | null;
  deliveryId: string | null;
  /** When it last settled completed or failed; a store that keeps none answers none. */
  finishedAt?: string | null;
  /** The latest attempt's number; a store that keeps no attempts answers none (1). */
  attempt?: number;
  /** The run's earlier attempts, oldest first. */
  attempts?: RunAttempt[];
}

/** One earlier attempt of a run, as `runs.rerun` kept it. */
export interface RunAttempt {
  attempt: number;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  /** The JSON object it settled with: `{ error, writes?, writeRecords? }` for a failed one. */
  outcome: unknown;
}

const Delivery: z.ZodType<DeliveryRow> = z.object({
  id: z.string(),
  subscriptionId: z.string(),
  externalId: z.string().nullable(),
  receivedAt: z.string(),
  source: z.enum(DELIVERY_SOURCES),
  inline: z.boolean(),
  replayOf: z.string().nullable(),
  eventCount: z.number(),
  runs: z.array(z.object({ id: z.string(), status: z.string() })),
  events: z.array(z.unknown()).optional(),
});
const Run: z.ZodType<RunRow> = z.object({
  id: z.string(),
  file: z.string(),
  movement: z.string(),
  status: z.string(),
  startedAt: z.string(),
  input: z.string(),
  outcome: z.string().nullable(),
  deliveryId: z.string().nullable(),
  finishedAt: z.string().nullable().optional(),
  attempt: z.number().optional(),
  attempts: z
    .array(z.object({ attempt: z.number(), status: z.string(), startedAt: z.string(), finishedAt: z.string().nullable(), outcome: z.unknown() }))
    .optional(),
});

/** The work claim the server reads: no more than it needs, whatever the caller spreads in. */
function claimOf(work: ClaimedWork & { dueAt?: string; why?: WorkRelease }): Record<string, unknown> {
  return {
    id: work.id,
    kind: work.kind,
    key: work.key,
    claim: work.claim,
    ...(work.dueAt !== undefined ? { dueAt: work.dueAt } : {}),
    ...(work.why !== undefined ? { why: work.why } : {}),
  };
}

export class RpcStoreBackend {
  readonly store: RunHostStore;
  /** The run rows listen-fire's stores keep beside the families. */
  readonly runRows: RunRowStore;
  /** The run records the server keeps beside its families. */
  readonly runs: RunRecords;
  /** A delivery's one write and a row's burial, as the shared waits cases reach them. */
  readonly deliveryRows: DeliveryRowStore;
  /** A run an arrival starts and its receipt, as one write (`events.startRun`). */
  readonly arrivalRuns: ArrivalRunStore;
  private readonly started: Promise<{ client: SlotClient; close(): Promise<void> }>;

  /** The store module `command` starts, or the one already at `address`. */
  constructor(command: string, args: readonly string[]);
  constructor(address: SlotAddress);
  constructor(target: string | SlotAddress, args: readonly string[] = []) {
    this.started =
      typeof target === 'string'
        ? startModule(target, args).then((module) => ({ client: new SlotClient(module.address), close: () => module.close() }))
        : Promise.resolve({ client: new SlotClient(target), close: async () => undefined });
    // A failed start is met by the first call; never an unhandled rejection.
    this.started.catch(() => undefined);
    this.store = this.families();
    this.runRows = this.runRowFamily();
    this.runs = this.runRecords();
    this.deliveryRows = {
      keepDelivery: (input) => this.keepDelivery(input),
      bury: (work) => this.buryWork(work),
      completeKey: (input) => this.completeKey(input),
      forgetDeliveryId: (input) => this.forgetDeliveryId(input),
    };
    this.arrivalRuns = {
      startArrivalRun: ({ runId, ...start }) => this.call('events.startRun', { ...start, id: runId }, z.boolean()),
    };
  }

  /** One call; its result read by `schema`. A fenced write refused because
   *  the run's lease is gone throws the core's `RunLeaseLost`. */
  async call<S extends z.ZodType>(method: string, params: object, schema: S): Promise<z.infer<S>> {
    const { client } = await this.started;
    try {
      return await client.read(method, params, schema);
    } catch (error) {
      if (error instanceof SlotRefused && error.code === RUN_LEASE_LOST_CODE) {
        const runId = error.data !== null && typeof error.data === 'object' ? Reflect.get(error.data, 'runId') : undefined;
        throw new RunLeaseLost(typeof runId === 'string' ? runId : '');
      }
      throw error;
    }
  }

  /** A run row the backend can park against (the contract's `newRun`);
   *  `deliveryId` names the delivery whose event started it, `teamId` the
   *  team it is kept under (absent: the store's own tenant). */
  async startRun(input: { id: string; file: string; movement: string; startedAt: string; input: string; deliveryId?: string; teamId?: string }): Promise<void> {
    await this.call('runs.start', { ...input, deliveryId: input.deliveryId ?? null }, Nothing);
  }

  /** A run's row, or null (`runs.get`). */
  runGet(input: { runId: string }): Promise<RunRow | null> {
    return this.call('runs.get', input, Run.nullable());
  }

  /** Where the run stands (`runs.settle`). */
  async runSettle(input: { runId: string; status: string; outcome: unknown; at: string }): Promise<void> {
    await this.call('runs.settle', input, Nothing);
  }

  /** The run's next attempt, under its lease (`runs.rerun`): its number, or
   *  null when the run's latest attempt did not fail. */
  async runRerun(input: { runId: string; input: string; at: string; fence: string }): Promise<number | null> {
    const answer = await this.call('runs.rerun', input, z.object({ attempt: z.number() }).nullable());
    return answer?.attempt ?? null;
  }

  /** The door's one write (`inbound.keepDelivery`): the receipt, the cursor
   *  (absent: left as it is), the work rows, and the arrivals with the waits
   *  the delivery opens for the runs it queues; `kept: false`, and nothing
   *  written, for a duplicate. */
  keepDelivery(input: KeepDelivery): Promise<KeptDelivery> {
    const { delivery, work, arrivals, waits } = input;
    const params = {
      subscriptionId: input.subscriptionId,
      ...('checkpoint' in input ? { checkpoint: input.checkpoint } : {}),
      delivery: { ...delivery, externalId: delivery.externalId ?? null, replayOf: delivery.replayOf ?? null },
      work: work.map((row) => ({ ...row, dueAt: row.dueAt ?? null, teamId: row.teamId ?? null })),
      ...(arrivals !== undefined ? { arrivals: { ...arrivals, arrivals: arrivals.arrivals.map(arrivalOf) } } : {}),
      ...(waits !== undefined && waits.length > 0 ? { waits } : {}),
    };
    return this.call('inbound.keepDelivery', params, Kept);
  }

  /** Give up on a claimed row (`work.bury`). */
  async buryWork(work: ClaimedWork & { reason: string }): Promise<void> {
    await this.call('work.bury', { id: work.id, claim: work.claim, reason: work.reason }, Nothing);
  }

  /** Done with a row its caller ran itself (`work.completeKey`). */
  completeKey(input: { key: string }): Promise<boolean> {
    return this.call('work.completeKey', input, z.boolean());
  }

  /** Clear a kept delivery's provider id, its receipt kept (`inbound.forgetDeliveryId`). */
  async forgetDeliveryId(input: { id: string }): Promise<void> {
    await this.call('inbound.forgetDeliveryId', input, Nothing);
  }

  /** Kept deliveries, most recent first, without their events. */
  deliveries(input: { subscriptionId?: string | null; since?: string | null; limit: number }): Promise<DeliveryRow[]> {
    return this.call('inbound.deliveries', { subscriptionId: input.subscriptionId ?? null, since: input.since ?? null, limit: input.limit }, z.array(Delivery));
  }

  /** One kept delivery with its events, or null. */
  delivery(input: { id: string }): Promise<DeliveryRow | null> {
    return this.call('inbound.delivery', input, Delivery.nullable());
  }

  /** Forget settled deliveries received before `before`: how many went. */
  sweepDeliveries(input: { before: string; limit: number }): Promise<number> {
    return this.call('inbound.sweepDeliveries', input, z.number());
  }

  /** A subscription's saved pull cursor (`inbound.checkpoint`). */
  checkpoint(input: { subscriptionId: string }): Promise<{ checkpoint?: unknown } | null> {
    return this.call('inbound.checkpoint', input, z.object({ checkpoint: z.unknown().optional() }).nullable());
  }

  /** An operator asks to cancel the run (the records contract's `requestCancel`). */
  async requestCancel(input: { runId: string; reason: string | null }): Promise<void> {
    await this.call('runs.requestCancel', input, Nothing);
  }

  /** The run's status as the server's run record holds it (`runStatus`). */
  runStatus(runId: string): Promise<string> {
    return this.call('runs.status', { runId }, z.string());
  }

  /** Mark the run completed (`completeRun`). */
  async completeRun(runId: string): Promise<void> {
    await this.call('runs.complete', { runId }, Nothing);
  }

  /** End the module this backend started. */
  async close(): Promise<void> {
    const started = await this.started.catch(() => undefined);
    await started?.close();
  }

  private runRowFamily(): RunRowStore {
    return {
      startRun: (input) => this.startRun({ id: input.runId, file: 'f', movement: 'm', startedAt: new Date().toISOString(), input: '{}' }),
      runStatus: async (input) => (await this.runGet(input))?.status ?? null,
    };
  }

  private runRecords(): RunRecords {
    const call = this.call.bind(this);
    return {
      cancelRequest: (input) => call('records.cancelRequest', input, z.object({ reason: z.string().nullable() }).nullable()),
      markFailed: async (input) => {
        await call('records.markFailed', input, Nothing);
      },
    };
  }

  private families(): RunHostStore {
    const call = this.call.bind(this);
    return {
      parks: {
        putLeaf: async (input) => {
          await call('parks.putLeaf', input, Nothing);
        },
        // listen-fire keeps no `rewritten` stamp: it has no limit resume to
        // read it. A store module serves one tenant: a timer's row is its.
        commit: async ({ runId, address, state, fence, park }) => {
          await call('parks.commit', { runId, address, state: state ?? null, fence: fence ?? null, park: parkOf(park) }, Nothing);
        },
        commitSegment: (input) =>
          call(
            'parks.commitSegment',
            {
              ...input,
              fence: input.fence ?? null,
              parks: input.parks.map((held) => ({ address: held.address, state: held.state ?? null, park: parkOf(held.park) })),
              owedRaces: input.owedRaces ?? [],
              settledRace: input.settledRace ?? null,
            },
            z.array(Wake),
          ),
        owedRaces: (input) => call('parks.owedRaces', input, z.array(z.object({ frameAddress: z.string(), state: z.unknown() }))),
        claimLeaf: (input) => call('parks.claimLeaf', input, Claimed),
        finishLeaf: async (input) => {
          await call('parks.finishLeaf', input, Nothing);
        },
        leaves: (input) => call('parks.leaves', input, z.array(Leaf)),
        deleteLeaves: async (input) => {
          await call('parks.deleteLeaves', input, Nothing);
        },
      },
      joins: {
        recordJoin: async (input) => {
          await call('joins.recordJoin', input, Nothing);
        },
        decrementJoin: (input) => call('joins.decrementJoin', input, z.object({ closed: z.boolean() })),
        persistBranchExport: async (input) => {
          await call('joins.persistBranchExport', input, Nothing);
        },
        collectBranchExports: (input) =>
          call('joins.collectBranchExports', input, z.array(z.object({ branchAddress: z.string(), branchIndex: z.number(), exports: z.unknown().optional() }))),
        hasPendingJoins: (input) => call('joins.hasPendingJoins', input, z.boolean()),
        frames: (input) => call('joins.frames', input, z.array(z.string())),
        deleteFrames: async (input) => {
          await call('joins.deleteFrames', input, Nothing);
        },
      },
      waits: {
        mark: () => call('waits.mark', {}, z.number()),
        log: (input) => call('waits.log', { ...input, arrivals: input.arrivals.map(arrivalOf) }, z.object({ wakes: z.array(Wake), stranded: z.array(Stranded) })),
        open: (input) => call('waits.open', input, z.object({ waitId: z.string() })),
        arrivals: (input) => call('waits.arrivals', input, z.object({ arrivals: z.array(Listed) })),
        stranded: (of) => call('waits.stranded', of, z.array(Stranded)),
        note: (input) => call('waits.note', input, z.boolean()),
        sweep: (input) => call('waits.sweep', input, z.object({ swept: z.number() })),
      },
      leases: {
        claim: (input) => call('leases.claim', input, z.object({ token: z.string() }).nullable()),
        renew: (input) => call('leases.renew', input, z.boolean()),
        release: async (input) => {
          await call('leases.release', input, Nothing);
        },
        dropRunState: (input) => call('leases.dropRunState', input, z.boolean()),
      },
      work: {
        enqueue: async (input) => {
          await call('work.enqueue', input, Nothing);
        },
        enqueueIfAbsent: (input) => call('work.enqueueIfAbsent', input, z.boolean()),
        // A store module serves one tenant: every row it claims is its own.
        claimDue: ({ limit, leaseMs, dueBy, kinds }) => call('work.claimDue', { limit, leaseMs, dueBy, kinds }, z.array(Work)),
        complete: async (work) => {
          await call('work.complete', claimOf(work), Nothing);
        },
        release: async (work) => {
          await call('work.release', claimOf(work), Nothing);
        },
      },
      sources: {
        put: async (input) => {
          await call('sources.put', input, Nothing);
        },
        get: (input) => call('sources.get', input, z.string().nullable()),
      },
    };
  }
}

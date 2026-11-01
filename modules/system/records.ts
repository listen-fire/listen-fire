// What `@lf/system` reads: the host's facts about its own runs and waits.
// A host hands them in (`systemModuleWith`); listen-fire's come over its
// records door (`recordsOverHostDoor`), the platform's from its own tables.
// The facts name no event kind: which are events, and what each says, is
// the poll's (poll.ts).

import { z } from 'zod';

import type { ModuleContext } from 'module-kit';

/** Where a page of runs left off: its last run (when it settled, and its id). */
export interface RunMark {
  at: string;
  runId: string;
}

/** Where a page of stranded waits left off: its last wait. */
export interface WaitMark {
  at: string;
  waitId: string;
}

/** Where a page of releases left off: its last release. */
export interface ReleaseMark {
  at: string;
  version: string;
}

/** Where a page of unjudged arrivals left off: its last one. */
export interface UnjudgedMark {
  at: string;
  listen: string;
  arrival: string;
  /** Absent in a cursor kept before replays were attempts of their own: 0. */
  attempt?: number;
}

/** The program a run belongs to; null for a run no program owns. */
export interface Automation {
  id: string;
  name: string;
}

/** A run that settled failed (or paused). */
export interface SettledRun {
  runId: string;
  automation: Automation | null;
  /** The listen whose arrival started it, by its pipeline: an event about it
   *  is never that listen's. Null for a run no listen started. */
  listen: string | null;
  /** A rehearsal (a dry run): its failure is not reported. */
  rehearsal: boolean;
  reason: string;
  /** When it failed (or paused), ISO 8601. */
  at: string;
  /** Where a person opens it, when the host has such a page. */
  url?: string;
}

/** A wait parked on a record that was deleted (docs/contracts/stranded-waits.md). */
export interface StrandedWait {
  waitId: string;
  runId: string;
  automation: Automation | null;
  listen: string | null;
  /** The module its record is in, and the edge it waits on. */
  adapter: string;
  edge: string;
  /** The deleted record's id; null when the host does not know it. */
  recordId: string | null;
  /** When the host found it stranded, ISO 8601. */
  at: string;
}

/** A listen that could not judge an arrival (its WHERE reads what the
 *  arrival's module could not read), kept once per listen, arrival and
 *  attempt. */
export interface UnjudgedArrival {
  /** The listen, by its pipeline: an event about it is never that listen's. */
  listen: string;
  /** The arrival, as the listen names it. */
  arrival: string;
  automation: Automation;
  /** The kept delivery it came in; null when the host kept none. */
  deliveryId: string | null;
  edge: string;
  recordId: string | null;
  reason: string;
  /** The run whose write caused the arrival, when one did: the event is
   *  about it, so a run the event fires continues its chain. */
  cause: string | null;
  /** When the host found it could not judge it, ISO 8601. */
  at: string;
  /** Which judging it was: 0 as it was delivered, one more for each replay
   *  of it through the listen (`listen-fire listens replay`). */
  attempt: number;
}

/** A release the host first ran under, and when. */
export interface Release {
  version: string;
  at: string;
}

/** The host's facts, each read a page at a time after a mark, oldest first. */
export interface SystemRecords {
  /** Runs failed after `after` and no later than `until`. */
  failedRuns(input: { after: RunMark; until: string; limit: number }): Promise<SettledRun[]>;
  /** Runs paused at their cost limit, likewise. */
  pausedRuns(input: { after: RunMark; until: string; limit: number }): Promise<SettledRun[]>;
  /** Waits stranded after `after`. */
  strandedWaits(input: { after: WaitMark; limit: number }): Promise<StrandedWait[]>;
  /** Releases first run after `after`. */
  releases(input: { after: ReleaseMark; limit: number }): Promise<Release[]>;
  /** Arrivals a listen could not judge, found after `after`. */
  unjudgedArrivals(input: { after: UnjudgedMark; limit: number }): Promise<UnjudgedArrival[]>;
  /** The web app's base URL an event's `Url` links into; null where the host has none. */
  webBaseUrl(): Promise<string | null>;
}

// ── Over listen-fire's records door ─────────────────────────────────────────

const automationOf = (file: string | null, movement: string | null): Automation | null =>
  file === null || movement === null ? null : { id: `${file}:${movement}`, name: movement };

const DoorRun = z.object({
  runId: z.string(),
  file: z.string(),
  movement: z.string(),
  listen: z.string().nullable(),
  rehearsal: z.boolean(),
  reason: z.string(),
  at: z.string(),
});

const DoorWait = z.object({
  waitId: z.string(),
  runId: z.string(),
  file: z.string().nullable(),
  movement: z.string().nullable(),
  listen: z.string().nullable(),
  adapterType: z.string(),
  edge: z.string(),
  recordId: z.string().nullable(),
  at: z.string(),
});

const DoorRelease = z.object({ version: z.string(), at: z.string() });

const DoorUnjudged = z.object({
  pipeline: z.string(),
  arrival: z.string(),
  file: z.string(),
  movement: z.string(),
  deliveryId: z.string().nullable(),
  edge: z.string(),
  recordId: z.string().nullable(),
  reason: z.string(),
  cause: z.string().nullable(),
  at: z.string(),
  // A host that keeps no attempts judges each arrival once.
  attempt: z.number().int().nonnegative().default(0),
});

/** listen-fire's facts, read at its records door (`ctx.records`). */
export function recordsOverHostDoor(ctx: Pick<ModuleContext, 'records'>): SystemRecords {
  const read = async <T>(method: string, params: Record<string, unknown>, rows: z.ZodType<T>): Promise<T[]> => {
    const answer = z.array(rows).safeParse(await ctx.records.read(method, params));
    if (!answer.success) throw new Error(`the host's records door answered ${method} with what is not its rows: ${answer.error.message}`);
    return answer.data;
  };
  const settled = (method: string) => async (input: { after: RunMark; until: string; limit: number }) =>
    (await read(method, input, DoorRun)).map((run) => ({
      runId: run.runId,
      automation: automationOf(run.file, run.movement),
      listen: run.listen,
      rehearsal: run.rehearsal,
      reason: run.reason,
      at: run.at,
    }));
  return {
    failedRuns: settled('records.failedRuns'),
    pausedRuns: settled('records.pausedRuns'),
    async strandedWaits(input) {
      return (await read('records.strandedWaits', input, DoorWait)).map((wait) => ({
        waitId: wait.waitId,
        runId: wait.runId,
        automation: automationOf(wait.file, wait.movement),
        listen: wait.listen,
        adapter: wait.adapterType,
        edge: wait.edge,
        recordId: wait.recordId,
        at: wait.at,
      }));
    },
    releases: (input) => read('records.releases', input, DoorRelease),
    async unjudgedArrivals(input) {
      const after = { at: input.after.at, pipeline: input.after.listen, arrival: input.after.arrival, attempt: input.after.attempt ?? 0 };
      return (await read('records.unjudgedArrivals', { after, limit: input.limit }, DoorUnjudged)).map((row) => ({
        listen: row.pipeline,
        arrival: row.arrival,
        automation: { id: `${row.file}:${row.movement}`, name: row.movement },
        deliveryId: row.deliveryId,
        edge: row.edge,
        recordId: row.recordId,
        reason: row.reason,
        cause: row.cause,
        at: row.at,
        attempt: row.attempt,
      }));
    },
    async webBaseUrl() {
      const answer = z.string().nullable().safeParse(await ctx.records.read('records.webBaseUrl'));
      if (!answer.success) throw new Error(`the host's records door answered records.webBaseUrl with what is not a URL or null`);
      return answer.data;
    },
  };
}

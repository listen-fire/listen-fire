// How a host watches one `listen to <traversal> fire f`: the checker writes
// it on its answer (`listens`, crates/movement-parser/src/listen_plan.rs), and
// both hosts read it instead of the listen's source.

import { z } from 'zod';

import type { Expression } from './expression/expression';

import { expressionSchema } from './expression/expression';

/** How the host honours a hop's filter: nothing to judge; judged on each
 *  arrival against the record it carries (the last hop always is); or by
 *  listing the hop's members and keeping those that match. */
export const hopJudgedSchema = z.enum(['none', 'arrival', 'resolved']);
export type HopJudged = z.infer<typeof hopJudgedSchema>;

export interface PlanHop {
  edge: string;
  /** The record type the hop leaves; empty for a root collection. */
  from: string;
  /** The record type it lands on. */
  to: string;
  alias?: string;
  /** The part of its WHERE the edge's module takes, joined by AND. */
  taken?: Expression;
  /** The part the host checks on what comes back. */
  checked?: Expression;
  /** The fields `taken` reads that hold a scalar only the module can
   *  evaluate (an owned one). Absent when it reads none. */
  owned?: string[];
  judged: HopJudged;
}

export interface ListenPlan {
  /** The function it fires. */
  movement: string;
  /** `listen as "…"`: the lane's name. */
  alias?: string;
  /** The connection the traversal starts from, by its name in the program. */
  connection: string;
  /** That connection's module. */
  adapter: string;
  /** Outermost first; the last is the listened edge. */
  hops: PlanHop[];
  /** The earlier hops' edges whose records an arrival on the last edge
   *  carries, outermost first. Absent when it carries none. */
  carries?: string[];
  /** The node the listen states its untyped landing is
   *  (`-[:Requests]-><Payment>`), by its name in the program: the host runs
   *  only what fits it. Absent when it states none. */
  landing?: string;
}

export const planHopSchema: z.ZodType<PlanHop> = z
  .object({
    edge: z.string(),
    from: z.string(),
    to: z.string(),
    alias: z.string().optional(),
    taken: expressionSchema.optional(),
    checked: expressionSchema.optional(),
    owned: z.array(z.string()).optional(),
    judged: hopJudgedSchema,
  })
  .strict();

export const listenPlanSchema: z.ZodType<ListenPlan> = z
  .object({
    movement: z.string(),
    alias: z.string().optional(),
    connection: z.string(),
    adapter: z.string(),
    hops: z.array(planHopSchema).min(1),
    carries: z.array(z.string()).optional(),
    landing: z.string().optional(),
  })
  .strict();

/** One arrival on a listen's last edge, as the judge reads it
 *  (crates/movement-engine/src/listen_judge.rs). */
export interface PlanArrival {
  /** The edge it arrived on. */
  edge: string;
  /** Its identity on that edge; absent on a root edge's arrival. */
  key?: string;
  /** The record that landed. */
  landing: ArrivedRecord;
  /** The records it carries from earlier hops, aligned to the plan's
   *  `carries` (the k-th hop on an edge name reads the k-th carried record
   *  of it); null for one it does not carry. */
  parents?: Array<ArrivedRecord | null>;
  /** Its module applied the plan's taken parts (a filtered poll or
   *  subscription). Absent or false, the judge evaluates them too. */
  takenApplied?: boolean;
}

/** A record an arrival carries, its landing or a parent: the record type its
 *  module says it is, as the catalog names it, and its fields. One edge name
 *  may hang off several record types (every object's `Changes`); the record
 *  type is what tells their arrivals apart. A record of another type than
 *  its hop lands on skips; one that states none leaves the arrival undecided. */
export interface ArrivedRecord {
  recordType?: string;
  fields: Record<string, unknown>;
  /** The fields its module could not read (a lookup the provider did not
   *  answer): a filter reading one is undecided, never read as absent. */
  unknown?: string[];
}

const arrivedRecordSchema: z.ZodType<ArrivedRecord> = z
  .object({ recordType: z.string().optional(), fields: z.record(z.string(), z.unknown()), unknown: z.array(z.string().min(1)).optional() })
  .strict();

export const planArrivalSchema: z.ZodType<PlanArrival> = z
  .object({
    edge: z.string(),
    key: z.string().optional(),
    landing: arrivedRecordSchema,
    parents: z.array(arrivedRecordSchema.nullable()).optional(),
    takenApplied: z.boolean().optional(),
  })
  .strict();

/** Whether an arrival fires a listen: it does; it fails the filter of hop
 *  `skips` (outermost is 0), or, with a `reason`, the record it carries for
 *  that hop is of another record type; or the judge cannot tell, and says
 *  why. An undecided arrival runs nothing, and the host logs the reason. */
export type Verdict = { fires: true } | { skips: number; reason?: string } | { undecided: string };

export const verdictSchema: z.ZodType<Verdict> = z.union([
  z.object({ fires: z.literal(true) }).strict(),
  z.object({ skips: z.number().int().nonnegative(), reason: z.string().optional() }).strict(),
  z.object({ undecided: z.string() }).strict(),
]);

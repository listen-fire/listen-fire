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
}

export const planHopSchema: z.ZodType<PlanHop> = z
  .object({
    edge: z.string(),
    from: z.string(),
    to: z.string(),
    alias: z.string().optional(),
    taken: expressionSchema.optional(),
    checked: expressionSchema.optional(),
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
  })
  .strict();

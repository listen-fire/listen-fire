// A program's standing listens, as its check answers them (one plan per
// `listen to <traversal> fire f`), and whether an arrival fires one. The judge
// is the engine's own (crates/movement-engine/src/listen_judge.rs), reached
// through the wasm, so this host and listen-fire's decide every arrival alike
// (engine-contracts/conformance/listen-arrivals.json).

import { listenPlanSchema, verdictSchema } from 'engine-contracts';
import { callJudgeArrival } from 'movement-lang';

import type { ListenPlan, PlanArrival, Verdict } from 'engine-contracts';

/** The plans a check answer carries (`listens`); none when it carries none. */
export function listenPlansOf(answer: unknown): ListenPlan[] {
  if (answer === null || typeof answer !== 'object' || !('listens' in answer) || answer.listens === undefined) return [];
  return listenPlanSchema.array().parse(answer.listens);
}

/** Whether `arrival` fires the listen `plan` describes, `nowMs` (epoch ms)
 *  the instant WITHIN measures from. An undecided verdict runs nothing; the
 *  host logs its reason. */
export function judgeArrival(plan: ListenPlan, arrival: PlanArrival, nowMs: number): Verdict {
  const reply = callJudgeArrival(JSON.stringify({ plan, arrival, nowMs }));
  if (!reply.ok) throw new Error(`the listen judge refused its input: ${JSON.stringify(reply.json)}`);
  return verdictSchema.parse(reply.json);
}

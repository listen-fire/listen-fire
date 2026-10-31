// A program's standing listens, as its check answers them (one plan per
// `listen to <traversal> fire f`), whether an arrival fires one, whether what
// landed fits the node a listen states it is, and the pipeline each is named
// by. The judge, the landing check and a plan's identity are the engine's
// own (crates/movement-engine/src/listen_judge.rs, listen_landing.rs,
// crates/movement-parser/src/listen_plan.rs), reached through the wasm, so
// this host and listen-fire decide every arrival alike
// (engine-contracts/conformance/listen-arrivals.json, listen-landings.json)
// and name every listen alike (conformance/listen-pipelines.json).

import { createHash } from 'node:crypto';

import { listenPlanSchema, verdictSchema } from 'engine-contracts';
import { callJudgeArrival, callLandingMisfits, callListenIdentity } from 'movement-lang';
import { z } from 'zod';

import type { Arrival, ListenPlan, PlanArrival, TriggerEvent, Verdict } from 'engine-contracts';
import type { Program } from 'movement-lang';

import { listenConstructionsOf } from '../movement/file_listeners';
import { listenHearsCredential } from './listen_config';

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

const landingMisfitsSchema = z.object({ node: z.string(), misfits: z.array(z.string()) }).strict();

/** What of `landing` (an arrival's record's fields) does not fit `node`,
 *  the node a listen states its landing is (`-[:Requests]-><Payment>`), as
 *  the single file `source` declares it: the node's name as the lines name
 *  it, and one line per misfit, none when it fits. An arrival that misfits
 *  runs nothing, as listen-fire has it. */
export function landingMisfits(input: { source: string; node: string; landing: unknown }): z.infer<typeof landingMisfitsSchema> {
  const reply = callLandingMisfits(JSON.stringify(input));
  if (!reply.ok) throw new Error(`the landing check refused its input: ${JSON.stringify(reply.json)}`);
  return landingMisfitsSchema.parse(reply.json);
}

/** What makes two listens one (`ListenPlan::identity`): the plan, its hops'
 *  aliases read as their places, without the lane's name. */
export function listenIdentity(plan: ListenPlan): string {
  const reply = callListenIdentity(JSON.stringify(plan));
  const identity: unknown = reply.ok && typeof reply.json === 'object' && reply.json !== null ? Reflect.get(reply.json, 'identity') : undefined;
  if (typeof identity !== 'string') throw new Error(`a plan's identity was refused: ${JSON.stringify(reply.json)}`);
  return identity;
}

/**
 * The pipeline a listen on a traversal is named by, its receipts and an
 * arrival's `notFor` with it: `listen:<file>:<movement>:<digest>`, the digest
 * the first 8 hex digits of the sha256 of its identity and of its
 * connection's construction (the credential and the other arguments), so one
 * whose connection is made otherwise is another listen. listen-fire names
 * the same listen the same (crates/lf/src/routing.rs `Listen::pipeline`).
 */
export function listenPipeline(input: { file: string; plan: ListenPlan; credentialName?: string; constructionArgs?: Readonly<Record<string, string>> }): string {
  // Sorted as Rust sorts its strings: by their UTF-8 bytes.
  const args = Object.entries(input.constructionArgs ?? {}).sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const construction = JSON.stringify({ args, credential: input.credentialName ?? null });
  const digest = createHash('sha256').update(`${listenIdentity(input.plan)}\n${construction}`).digest('hex').slice(0, 8);
  return `listen:${input.file}:${input.plan.movement}:${digest}`;
}

/** A saved listen on a traversal as a host routes it: its plan, its
 *  pipeline, and the credential its connection is made with (by the name
 *  the program imports it by). */
export interface PlannedListen {
  plan: ListenPlan;
  pipeline: string;
  credentialName?: string;
}

/** Each of `plans` (the check's of `program`, the file `file`) with its
 *  connection's construction read from the program. */
export function plannedListensOf(input: { file: string; program: Program; plans: readonly ListenPlan[] }): PlannedListen[] {
  const constructionOf = listenConstructionsOf(input.program);
  return input.plans.map((plan) => {
    const construction = constructionOf(plan.connection);
    // The checker plans no listen on a name that is no connection.
    if (construction === undefined) throw new Error(`${input.file}: the listen that fires ${plan.movement} is on \`${plan.connection}\`, which is no connection the file makes`);
    const { credentialName, constructionArgs } = construction;
    return {
      plan,
      pipeline: listenPipeline({ file: input.file, plan, ...(credentialName !== undefined ? { credentialName } : {}), ...(constructionArgs !== undefined ? { constructionArgs } : {}) }),
      ...(credentialName !== undefined ? { credentialName } : {}),
    };
  });
}

/**
 * Whether `arrival`, delivered by a module of `delivery.adapterType` for the
 * connection `delivery.credentialName` (absent: the module's install, which
 * serves every connection), fires `listen` at `nowMs`, as the judge finds its
 * filters. Null when the arrival is not this listen's to judge: it says the
 * record went; it is on another module or another edge than the listen's
 * last; it came for another connection (`listenHearsCredential`); or it is
 * marked for this listen's own sake (`notFor` its pipeline). An Undecided
 * verdict runs nothing, and the host says why.
 */
export function listenFires(listen: PlannedListen, arrival: Arrival, delivery: { adapterType: string; credentialName?: string }, nowMs: number): Verdict | null {
  const { plan } = listen;
  if ('gone' in arrival || plan.adapter !== delivery.adapterType || plan.hops[plan.hops.length - 1]?.edge !== arrival.edge) return null;
  if (!listenHearsCredential(listen.credentialName, delivery.credentialName) || arrival.notFor === listen.pipeline) return null;
  return judgeArrival(
    plan,
    {
      edge: arrival.edge,
      ...(arrival.key !== undefined ? { key: arrival.key } : {}),
      landing: arrival.landing.fields,
      ...(arrival.parents !== undefined ? { parents: arrival.parents.map((parent) => parent?.fields ?? null) } : {}),
      ...(arrival.takenApplied === true ? { takenApplied: true } : {}),
    },
    nowMs,
  );
}

/** The event a run fired by an arrival is handed: what landed on the
 *  listen's last edge, which its function's parameter binds, and what it
 *  carries (crates/lf/src/routing.rs `arrival_trigger_of`). */
export function arrivalTriggerOf(input: { pipelineInputId: string; adapterType: string; arrival: Exclude<Arrival, { gone: true }>; now: Date }): TriggerEvent {
  const { adapterType, arrival } = input;
  return {
    pipelineInputId: input.pipelineInputId,
    adapterType,
    triggerType: 'arrival',
    arrival: { adapterType, edge: arrival.edge, landing: arrival.landing, ...(arrival.parents !== undefined && arrival.parents.length > 0 ? { parents: arrival.parents } : {}) },
    occurredAt: input.now.toISOString(),
  };
}

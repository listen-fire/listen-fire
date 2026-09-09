// The GENERIC correlation map for the awaitable capability (asks-as-adapter §A
// duty 1) — the store that BOTH the ask adapter and the Slack adapter (and any
// future awaitable adapter) register their in-flight `await <head>-[:E]->` parks
// into. One `adapter_await` row per park maps an adapter's native identity
// (`adapterType` + `correlationKey` — the ask id for `ask`, `channel:thread_ts`
// for `slack`) to the engine park (`runId`, `address`).
//
// The whole point of ONE shared table: the terminal-seam correlation drop is
// adapter-AGNOSTIC by construction. Run death / race loss / an engine ERROR all
// reap `WHERE run_id = ?` across every adapter at once — no per-adapter fan-out,
// which is exactly the generalization the chunk-C fix-up flagged as owed once a
// second awaitable adapter (Slack) landed.
//
// Resolvability is NOT here: it is per-adapter and lives outside this map. The
// `ask` poll joins these rows to `ask.state`; `slack` is event-driven, looking
// up a thread's parks by `correlationKey` when an inbound reply arrives. This
// module only holds the map and the two adapter-agnostic reaps.

import { getAutomationsQb, getQb } from '../../../lib/kysely';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { TriggerRunId } from '../../../generated/kysely/automations/TriggerRun';

/** One resolvable await park — the adapter-agnostic leaf the resume driver steps
 *  forward (`resumeAwaitRun` re-enters here and re-checks the edge live). The
 *  driver needs only the run, the team, and the leaf address; WHICH adapter and
 *  what landed are re-derived at re-entry, so no adapter payload rides here. */
export interface ResolvableAwait {
  runId: TriggerRunId;
  teamId: TeamId;
  address: string;
}

/** Register (or re-register) a park's correlation. Idempotent on (run, address)
 *  — a re-parked await (a re-enter that stayed pending) rewrites the same row. */
export async function registerAwaitCorrelation(input: {
  adapterType: string;
  correlationKey: string;
  runId: TriggerRunId;
  teamId: TeamId;
  address: string;
}): Promise<void> {
  await getAutomationsQb(['adapter_await'])
    .insertInto('adapter_await')
    .values({
      adapter_type: input.adapterType,
      correlation_key: input.correlationKey,
      run_id: input.runId,
      team_id: input.teamId,
      address: input.address,
    })
    .onConflict((oc) =>
      oc.columns(['run_id', 'address']).doUpdateSet({
        adapter_type: input.adapterType,
        correlation_key: input.correlationKey,
        updated_at: new Date(),
      }),
    )
    .execute();
}

/** Drop ONE park's correlation (the cancellation-signal response, F7 — a race
 *  loser or a resolved leaf). Adapter-agnostic: keyed on the engine park alone. */
export async function dropAwaitCorrelation(input: {
  runId: TriggerRunId;
  address: string;
}): Promise<void> {
  await getAutomationsQb(['adapter_await'])
    .deleteFrom('adapter_await')
    .where('run_id', '=', input.runId)
    .where('address', '=', input.address)
    .execute();
}

/** Drop EVERY correlation of a run (run death / ERROR — the ONE signal to every
 *  in-flight await, P17/F7) across ALL adapters in one reap. This is the seam the
 *  chunk-C fix-up wanted adapter-agnostic: no per-adapter fan-out — one table,
 *  one delete. Touches no adapter record (a late answer still lands as data). */
export async function dropAwaitCorrelationsForRun(runId: TriggerRunId): Promise<void> {
  await getAutomationsQb(['adapter_await']).deleteFrom('adapter_await').where('run_id', '=', runId).execute();
}

/** Every park correlated to one adapter identity — the EVENT-DRIVEN resolution
 *  lookup (Slack: an inbound thread reply → the parks awaiting that thread).
 *  Team-scoped so a `channel:thread_ts` in one workspace never wakes another's
 *  parks. The driver re-enters each returned leaf and re-checks the edge live. */
export async function loadCorrelatedParks(input: {
  adapterType: string;
  teamId: TeamId;
  correlationKey: string;
}): Promise<ResolvableAwait[]> {
  const rows = await getAutomationsQb(['adapter_await'])
    .selectFrom('adapter_await')
    .where('adapter_type', '=', input.adapterType)
    .where('team_id', '=', input.teamId)
    .where('correlation_key', '=', input.correlationKey)
    .select(['run_id', 'team_id', 'address'])
    .execute();
  // `adapter_await.team_id` is an opaque tenant uuid (D3 dropped the FK, and
  // with it the brand); naming it as core's team id is the boundary conversion.
  return rows.map((r) => ({ runId: r.run_id, teamId: r.team_id as TeamId, address: r.address }));
}

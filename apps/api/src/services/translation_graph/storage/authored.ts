// Dispatch liveness for automations.
//
// Movements are the only invoker. A `automations.trigger` row is purely the
// dispatch index for a movement's `listen` statement — it carries no
// orchestration / object code; execution reads the canonical movement text
// (services/movement_engine/run.ts). So liveness is a movement-derivation
// gate: a trigger is "live" (eligible to dispatch on real events and to be
// test-run) iff it is movement-derived — `trigger.movement_id IS NOT NULL`.
//
// (The save gate that makes a movement's text *runnable* — checkProgram +
// the dry interpretability scan — lives in movement/provision.ts; a
// movement that fails it never reconciles its derived trigger rows, so a
// derived row only exists for a movement that saved live.)
//
// This is the single source of truth for liveness, shared by the home
// dashboard, the automation detail page, the dispatch gates, and the
// Test-run simulator. It replaces the older content-derived gate (an
// automation was live iff its orchestration referenced a translation graph
// with roots) — orchestration and translation graphs are gone.

/**
 * Of the given triggers, return the ids that are live: those that are
 * movement-derived (`movementId` set). Hand-authored / orphaned rows
 * (no movement) never dispatch.
 */
export function authoredTriggerIds(
  triggers: Array<{ id: string; movementId?: string | null }>,
): Set<string> {
  const live = new Set<string>();
  for (const trigger of triggers) {
    if (trigger.movementId != null) live.add(trigger.id);
  }
  return live;
}

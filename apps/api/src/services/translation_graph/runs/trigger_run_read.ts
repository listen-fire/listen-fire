// Read-side helpers for trigger_run. A trigger_run aggregates every
// orchestration step of one firing under `steps`; the runs UI renders a
// firing as one card whose body is the union of its steps' applied action
// plans. These helpers flatten the firing into the flat shape the existing
// runs view + linked-object enrichment already understand.

export interface TriggerRunStep {
  tgId: string;
  tgName?: string | null;
  sourceAdapterType: string | null;
  targetAdapterType: string | null;
  status: string;
  appliedActionPlans: unknown;
  diagnostics: Record<string, unknown>;
  errors: Array<Record<string, unknown>>;
}

/** Parse the `steps` jsonb of a trigger_run into typed step records. */
export function parseTriggerRunSteps(value: unknown): TriggerRunStep[] {
  if (!Array.isArray(value)) return [];
  return value as TriggerRunStep[];
}

/**
 * Flatten every step's `appliedActionPlans` into one array — the firing's
 * complete set of writes, in step order. This is what the runs UI renders as
 * the firing's action tree and what `enrichWithLinkedObjectData` annotates.
 */
export function flattenTriggerRunPlans(value: unknown): unknown[] {
  const steps = parseTriggerRunSteps(value);
  const out: unknown[] = [];
  for (const step of steps) {
    if (Array.isArray(step.appliedActionPlans)) out.push(...step.appliedActionPlans);
  }
  return out;
}

/** First non-null source adapter across the firing's steps (for display). */
export function firstSourceAdapter(steps: TriggerRunStep[]): string | null {
  for (const s of steps) if (s.sourceAdapterType) return s.sourceAdapterType;
  return null;
}

/** Last non-null target adapter across the firing's steps (for display). */
export function lastTargetAdapter(steps: TriggerRunStep[]): string | null {
  let found: string | null = null;
  for (const s of steps) if (s.targetAdapterType) found = s.targetAdapterType;
  return found;
}

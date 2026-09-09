// Loop guard — post-run usage recording for the per-team budgets.
//
// `evaluate()` counts movement RUNS before a run (the cheap, always-available
// signal). External writes and LLM tokens are only known AFTER a run, so they
// are recorded here by the dispatch layer once a firing reports its writes /
// token spend. They feed the same rolling team-budget windows, so a team that's
// blowing through external writes or tokens trips the pause on the NEXT
// evaluate — the budget is multi-dimensional even though the pre-run gate keys
// on run count.
//
// Fire-and-forget + fail-open: recording uses the same Redis store that already
// degrades to no-op on error, and callers should not await-block dispatch on it.
//
// usage budgets

import { guardKeys, incrementAndSum } from './store';
import { resolveThresholds } from './thresholds';

/** Record external writes a firing applied against the team's write budget. */
export async function recordExternalWrites(input: {
  teamId: string;
  count: number;
  nowMs?: number;
}): Promise<{ total: number; overBudget: boolean }> {
  if (input.count <= 0) return { total: 0, overBudget: false };
  const t = resolveThresholds();
  const { total } = await incrementAndSum({
    key: guardKeys.teamExternalWrites(input.teamId),
    windowSeconds: t.teamWindowSeconds,
    amount: input.count,
    nowMs: input.nowMs,
  });
  return { total, overBudget: total > t.teamExternalWritesPerWindow };
}

/** Record LLM tokens a firing spent against the team's token budget. */
export async function recordLlmTokens(input: {
  teamId: string;
  tokens: number;
  nowMs?: number;
}): Promise<{ total: number; overBudget: boolean }> {
  if (input.tokens <= 0) return { total: 0, overBudget: false };
  const t = resolveThresholds();
  const { total } = await incrementAndSum({
    key: guardKeys.teamLlmTokens(input.teamId),
    windowSeconds: t.teamWindowSeconds,
    amount: input.tokens,
    nowMs: input.nowMs,
  });
  return { total, overBudget: total > t.teamLlmTokensPerWindow };
}

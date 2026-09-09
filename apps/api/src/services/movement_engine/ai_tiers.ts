/**
 * Tiers → calls. The language lets an author say how much thinking a job is
 * worth — `"quick"`, `"careful"`, `"thorough"` — and nothing else. What that
 * BUYS is decided here, on the platform's side of the line: which model
 * answers, how hard it is asked to think, how long its answer may run.
 *
 * That split is the whole point. Provider names, reasoning-effort dialects and
 * token budgets are all things that change under us — and none of them are
 * things an author can be asked to reason about. Retuning any of them, or
 * moving to a different family entirely, is an edit to this file and to
 * nothing else; no saved program changes, and no author has to be told.
 *
 * The AI() and extraction contexts map INDEPENDENTLY. They are different jobs:
 * `AI()` is a judgement call on a small prompt, extraction is a transcription
 * job over a whole document, and its defaults are tuned from production
 * runaways. The same word means "cheap for this job" in both, which is not the
 * same settings in both.
 */

import { aiTier } from '#shared/expression/types';

/**
 * Reasoning depth for extraction, on its OWN calls rather than on the client
 * it shares with `AI()`. Extraction is a transcription job, not a reasoning
 * one: the fields are named in the prompt and the evidence is quoted from the
 * source. The adaptive-thinking models reason at effort `high` when nobody
 * says otherwise, which is where a production runaway's output tokens went.
 */
export const EXTRACTION_EFFORT = 'low' as const;

/**
 * The room a `thorough` answer gets — the same ceiling extraction tops out at
 * (`EXTRACTION_MAX_TOKENS`), flat rather than sized from the input: the point
 * of the tier is that the answer is allowed to be long even when the question
 * was short.
 */
const THOROUGH_OUTPUT_TOKENS = 32000;

/** What one call asks the platform for. An absent field is the client's own
 *  default: no `effort` means the model's own reasoning depth, no `maxTokens`
 *  means the ceiling sized from the input.
 *
 *  `'opus'` is opus-4-7 — reachable only through extraction's omitted-tier
 *  path (the density heuristic can still choose it independently of the tier
 *  ladder below). `'opus5'` is claude-opus-5, on `AI()`'s `thorough` row
 *  only: see plans/mvt-core-calculus-2026-08-31/10_bakeoff.md round 2 for why
 *  the two are not interchangeable — opus-4-7 with no effort named runs with
 *  NO thinking at all and can leak its scratchpad into the visible reply;
 *  opus-5 in the same silence thinks adaptively by default. */
export interface TierCallSettings {
  model: 'opus' | 'opus5' | 'sonnet' | 'haiku';
  effort?: 'low' | 'medium' | 'high' | 'xhigh';
  maxTokens?: number;
}

/**
 * An `AI(prompt[, tier])` call's settings.
 *
 * An omitted tier is the platform default, and it is deliberately the same as
 * `quick`: the fast model under the input-proportional ceiling, which is what
 * every deployed `AI()` without a tier already gets. `careful` and `thorough`
 * name no effort, so those models reason at their own default depth — an
 * author who asked for real thinking should not have it capped from here.
 *
 * A word that is not a tier cannot reach a saved program (the checker refuses
 * it), so it lands on the default rather than raising: an evaluator is the
 * wrong place to discover a spelling mistake.
 *
 * Ruled from two bake-off rounds:
 * plans/mvt-core-calculus-2026-08-31/10_bakeoff.md.
 */
export function aiExpressionSettings(tier: string | undefined): TierCallSettings {
  switch (aiTier(tier)) {
    case 'careful':
      return { model: 'sonnet' };
    case 'thorough':
      return { model: 'opus5', maxTokens: THOROUGH_OUTPUT_TOKENS };
    case 'quick':
    case undefined:
      return { model: 'haiku', effort: EXTRACTION_EFFORT };
  }
}

/**
 * An `extract ["tier"] from […]` call's settings — every call the extraction
 * makes, at every stage.
 *
 * An omitted tier is exactly today's extraction: the density heuristic's model
 * (`defaultModel`), shallow effort, and the input-proportional ceiling. So a
 * deployed extraction that names no tier calls the models identically to
 * before this existed. Naming one takes the model choice AWAY from the density
 * heuristic — an author who says how much the job is worth has said something
 * the heuristic was guessing at.
 *
 * `quick`/`careful`/`thorough` are one model (sonnet-5) at rising effort, not
 * three models: two bake-off rounds found no fixture — including two built
 * specifically to break the cheap arm — where a bigger model scored higher
 * than sonnet-5, at any effort. `thorough` keeps the flat 32k ceiling rather
 * than the proportional one, so the tier still buys room even on a short
 * question. Ruled from plans/mvt-core-calculus-2026-08-31/10_bakeoff.md.
 */
export function extractionSettings(
  tier: string | undefined,
  defaultModel: 'opus' | 'sonnet',
): TierCallSettings {
  switch (aiTier(tier)) {
    case 'quick':
      return { model: 'sonnet', effort: EXTRACTION_EFFORT };
    case 'careful':
      return { model: 'sonnet', effort: 'high' };
    case 'thorough':
      return { model: 'sonnet', effort: 'xhigh', maxTokens: THOROUGH_OUTPUT_TOKENS };
    case undefined:
      return { model: defaultModel, effort: EXTRACTION_EFFORT };
  }
}

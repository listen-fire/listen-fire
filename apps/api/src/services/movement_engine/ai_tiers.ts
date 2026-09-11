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
 * The room a call that REASONS gets — flat rather than sized from the input,
 * and twice what a shallow call may spend.
 *
 * The doubling is not generosity: on these models the thinking is paid for out
 * of the same ceiling as the answer, and from `high` up it is a large fraction
 * of everything the model writes. One stage of a morning recap answered in 22.5k
 * tokens with the thinking switched down to `low`; the same stage at `high` and
 * at `xhigh` each spent a whole 32k ceiling thinking and returned no answer at
 * all. The request is streamed, so a ceiling this high is safe against the HTTP
 * timeout.
 */
const REASONING_OUTPUT_TOKENS = 64000;

/**
 * The ceiling a depth needs, which is what actually decides it — not the tier's
 * name. `high` and `xhigh` are both deep enough to exhaust a shallow call's
 * ceiling before writing a character, so both carry this one.
 *
 * Silence below that is deliberate and is NOT the same number written out: it
 * leaves the client's own ceiling standing, which is the flat 32k by default
 * and the budget guard's input-sized one where that is switched on. A shallow
 * call's ceiling only ever has to fit its answer.
 */
function roomToThink(effort: TierCallSettings['effort']): { maxTokens?: number } {
  switch (effort) {
    case 'high':
    case 'xhigh':
      return { maxTokens: REASONING_OUTPUT_TOKENS };
    case 'low':
    case 'medium':
    case undefined:
      return {};
  }
}

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
    // No effort named, and opus-5 in that silence thinks adaptively and deeply
    // — a reasoning call by any other route, so it gets a reasoning call's room.
    case 'thorough':
      return { model: 'opus5', maxTokens: REASONING_OUTPUT_TOKENS };
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
 * than sonnet-5, at any effort. Ruled from
 * plans/mvt-core-calculus-2026-08-31/10_bakeoff.md.
 *
 * The room each row gets follows its DEPTH ({@link roomToThink}), not its name:
 * the thinking comes out of the same ceiling as the answer, so the two rows
 * that reason carry a ceiling that fits both. It also means the flat ceiling
 * arrives for the same reason the tier does, rather than as a second thing to
 * remember about the expensive one.
 */
export function extractionSettings(
  tier: string | undefined,
  defaultModel: 'opus' | 'sonnet',
): TierCallSettings {
  switch (aiTier(tier)) {
    case 'quick':
      return sonnetAt(EXTRACTION_EFFORT);
    case 'careful':
      return sonnetAt('high');
    case 'thorough':
      return sonnetAt('xhigh');
    case undefined:
      return { model: defaultModel, effort: EXTRACTION_EFFORT };
  }
}

/** One extraction row: sonnet-5 asked to think this hard, with the room that
 *  asking costs. */
function sonnetAt(effort: 'low' | 'medium' | 'high' | 'xhigh'): TierCallSettings {
  return { model: 'sonnet', effort, ...roomToThink(effort) };
}

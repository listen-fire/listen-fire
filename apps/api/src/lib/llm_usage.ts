import { AsyncLocalStorage } from 'node:async_hooks';

import { getQb } from './kysely';
import { logger } from '../services/logger';
import type { TeamId } from '../generated/kysely/core/Team';
import type { DealflowPipelineId } from '../generated/kysely/public/DealflowPipeline';
import type { AgentConversationId } from '../generated/kysely/public/AgentConversation';
import type { TriggerRunId } from '../generated/kysely/automations/TriggerRun';

// -- Context --

/**
 * The cancel gate the LLM chokepoint reads off the same AsyncLocalStorage
 * context (runs-and-cancel spec §cancel) — a structural type here (not an
 * import) so `llm_usage.ts` stays free of a dependency on the movement-engine
 * layer. The concrete gate lives in `services/movement_engine/cancel_gate.ts`.
 *
 * The read is async because it has to be: a cached last-known value could only
 * ever repeat what the interpreter's statement-boundary check already knew, and
 * the boundaries reading this sink are all INSIDE a statement, where that check
 * is not going to run until the statement is over.
 */
interface CancelSink {
  /** Re-read (debounced) and latch — throws `RunCancelledSignal` at the next
   *  in-statement boundary when true. */
  cancelled(): Promise<boolean>;
}

interface LlmUsageContextData {
  teamId: string;
  pipelineId?: string;
  conversationId?: string;
  /** The trigger_run this LLM call attributes to (movement firings) — threaded
   *  onto each `llm_usage` row for the per-run rollup (billing spec §2.3). */
  triggerRunId?: string;
  /** The run's cancel gate — every boundary inside a statement (LLM calls,
   *  plugin invocations) reads it here (runs-and-cancel spec §cancel).
   *  Absent ⇒ not a cancellable firing. */
  cancelGate?: CancelSink;
}

const asyncLocalStorage = new AsyncLocalStorage<LlmUsageContext>();

class LlmUsageContext {
  data: LlmUsageContextData;

  constructor(data: LlmUsageContextData) {
    this.data = data;
  }

  async runAsync<T>(fn: () => Promise<T>): Promise<T> {
    return asyncLocalStorage.run(this, fn);
  }
}

function currentLlmUsageContext(): LlmUsageContext | undefined {
  return asyncLocalStorage.getStore();
}

/**
 * The run a log line belongs to, as structured log fields — spread into any
 * `logger.*` call made underneath a movement firing.
 *
 * A plugin logs what it is doing (the URL it is fetching, the characters it
 * got back), but a log line with no run on it cannot answer the question
 * anyone actually asks of it — "what was THIS run waiting on for seven
 * minutes?". The firing already establishes this context around everything it
 * calls, so the correlation costs nothing to carry; it was simply never
 * carried. Outside a firing the bag is empty and the line is unchanged.
 */
function runFields(): { runId?: string } {
  const runId = currentLlmUsageContext()?.data.triggerRunId;
  return runId ? { runId } : {};
}

// -- Pricing --

// Prices in dollars per million tokens.
// cost_microdollars = tokens * priceDollarsPerMillion
// e.g. 1000 tokens of gpt-4.1 input at $2/M = 1000 * 2 = 2000 microdollars = $0.002
// Sources:
//   OpenAI: https://pricepertoken.com/pricing-page/provider/openai (Feb 2026)
//   Anthropic: https://platform.claude.com/docs/en/about-claude/pricing (Feb 2026)
//   Embeddings: https://platform.openai.com/docs/models/text-embedding-3-large
const MODEL_PRICING: Record<
  string,
  { input: number; output: number; cacheRead?: number; cacheCreation?: number }
> = {
  'gpt-4.1': { input: 2.0, output: 8.0 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4.1-nano': { input: 0.1, output: 0.4 }, // deprecated 2026-10-23
  'gpt-5': { input: 1.25, output: 10.0 },
  'gpt-5-mini': { input: 0.25, output: 2.0 },
  'gpt-5-nano': { input: 0.05, output: 0.4 },
  o3: { input: 2.0, output: 8.0 },
  'claude-haiku-4-5-20251001': { input: 0.8, output: 4.0, cacheRead: 0.08, cacheCreation: 1.0 },
  'claude-sonnet-4-5-20250929': { input: 3.0, output: 15.0, cacheRead: 0.3, cacheCreation: 3.75 },
  'claude-sonnet-4-6': { input: 3.0, output: 15.0, cacheRead: 0.3, cacheCreation: 3.75 },
  // Standard rates; introductory $2/$10 applies through 2026-08-31, then reverts to these.
  'claude-sonnet-5': { input: 3.0, output: 15.0, cacheRead: 0.3, cacheCreation: 3.75 },
  'claude-opus-4-20250514': { input: 15.0, output: 75.0, cacheRead: 1.5, cacheCreation: 18.75 },
  'claude-opus-4-7': { input: 5.0, output: 25.0, cacheRead: 0.5, cacheCreation: 6.25 },
  'claude-opus-4-8': { input: 5.0, output: 25.0, cacheRead: 0.5, cacheCreation: 6.25 },
  'claude-opus-5': { input: 5.0, output: 25.0, cacheRead: 0.5, cacheCreation: 6.25 },
  'mercury-2': { input: 0.25, output: 0.75 },
  'text-embedding-3-large': { input: 0.13, output: 0 },
  'text-embedding-3-small': { input: 0.02, output: 0 },
};

function calculateCostMicrodollars(options: {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}): number {
  const pricing = MODEL_PRICING[options.model];
  if (!pricing) return 0;

  const inputCost = options.inputTokens * pricing.input;
  const outputCost = options.outputTokens * pricing.output;
  const cacheReadCost = options.cacheReadTokens * (pricing.cacheRead ?? pricing.input);
  const cacheCreationCost = options.cacheCreationTokens * (pricing.cacheCreation ?? pricing.input);

  return Math.round(inputCost + outputCost + cacheReadCost + cacheCreationCost);
}

// -- Recording --

interface RecordUsageOptions {
  provider: 'openai' | 'anthropic';
  model: string;
  callType: 'chat' | 'structured' | 'tool_loop' | 'embedding' | 'responses';
  label?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  durationMs?: number;
}

async function recordLlmUsage(options: RecordUsageOptions): Promise<void> {
  const ctx = currentLlmUsageContext();
  const teamId = ctx?.data.teamId;

  if (!teamId) return;

  const costMicrodollars = calculateCostMicrodollars({
    model: options.model,
    inputTokens: options.inputTokens,
    outputTokens: options.outputTokens,
    cacheReadTokens: options.cacheReadTokens ?? 0,
    cacheCreationTokens: options.cacheCreationTokens ?? 0,
  });

  try {
    await getQb(['llm_usage'])
      .insertInto('llm_usage')
      .values({
        team_id: teamId as TeamId,
        provider: options.provider,
        model: options.model,
        call_type: options.callType,
        label: options.label ?? null,
        input_tokens: options.inputTokens,
        output_tokens: options.outputTokens,
        cache_read_tokens: options.cacheReadTokens ?? 0,
        cache_creation_tokens: options.cacheCreationTokens ?? 0,
        cost_microdollars: costMicrodollars,
        duration_ms: options.durationMs ?? null,
        pipeline_id: (ctx?.data.pipelineId ?? null) as DealflowPipelineId | null,
        conversation_id: (ctx?.data.conversationId ?? null) as AgentConversationId | null,
        trigger_run_id: (ctx?.data.triggerRunId ?? null) as TriggerRunId | null,
      })
      .execute();
  } catch (err) {
    logger.error('[llm_usage] Failed to record usage', { error: err });
  }
}

/** Which runs' usage lines to unlink: an explicit set, or every run of a team. */
type LlmUsageRunScope = { runIds: TriggerRunId[] } | { teamId: TeamId };

/**
 * Null the `trigger_run_id` of the scoped usage rows — by hand, exactly what
 * the ON DELETE SET NULL did before `llm_usage` (public) and `trigger_run`
 * (automations) ended up in different schemas with no constraint between them
 * (D3). The two paths that delete runs — the retention prune and
 * `dev:seed --reset` — call this alongside the delete, so the usage side is
 * released explicitly rather than rotting into orphans nobody notices.
 */
async function releaseLlmUsageRunReferences(scope: LlmUsageRunScope): Promise<void> {
  const qb = getQb(['llm_usage']);
  if ('runIds' in scope) {
    if (scope.runIds.length === 0) return;
    await qb
      .updateTable('llm_usage')
      .set({ trigger_run_id: null })
      .where('trigger_run_id', 'in', scope.runIds)
      .execute();
    return;
  }
  await qb
    .updateTable('llm_usage')
    .set({ trigger_run_id: null })
    .where('team_id', '=', scope.teamId)
    .execute();
}

export {
  LlmUsageContext,
  currentLlmUsageContext,
  recordLlmUsage,
  releaseLlmUsageRunReferences,
  runFields,
};
export type { RecordUsageOptions };

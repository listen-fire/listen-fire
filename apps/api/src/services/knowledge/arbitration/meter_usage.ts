// The composition root's other wiring job: knowledge spends model tokens, and
// in the composed Listen-Fire deployment those tokens are billable like any other.
//
// Knowledge publishes a sink interface and nothing more (D12) — it does not know
// `llm_usage`, wallets, or run cost meters exist, and a standalone knowledge
// registers no sink and meters nothing. This module is the only place that knows
// both sides, which is the same shape as the mutation subscriber: the two
// products meet here and nowhere else.

import { registerKnowledgeLlmUsageSink } from '../../../lib/knowledge/llm';
import { LlmUsageContext, recordLlmUsage } from '../../../lib/llm_usage';
import { runInBackground } from '../../../lib/utils/background';

export function meterKnowledgeLlmUsage(): void {
  registerKnowledgeLlmUsageSink({
    record(usage) {
      // The meter reads its team off an ambient context rather than an argument,
      // so the team knowledge names is supplied here rather than threaded
      // through the store. Fire-and-forget: a metering failure must never fail
      // the ruling that earned it.
      runInBackground(async () => {
        await new LlmUsageContext({ teamId: usage.teamId }).runAsync(async () => {
          await recordLlmUsage({
            provider: 'anthropic',
            model: usage.model,
            callType: 'structured',
            label: usage.purpose,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
          });
        });
      });
    },
  });
}

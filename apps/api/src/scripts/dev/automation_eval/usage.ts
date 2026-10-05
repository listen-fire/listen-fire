// Token usage and its dollar cost, per role in a trial (the builder, the
// simulated user, the judge), so a report can say where the money went.

import type Anthropic from '@anthropic-ai/sdk';

interface TokenUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** First-party list prices, $ per million tokens (claude-api skill, cached 2026-09-25). */
interface Price {
  input: number;
  output: number;
  cacheRead: number;
}

const PRICES: Record<string, Price> = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1 },
};

/** Cache writes (5-minute TTL) bill at 1.25× the input price. */
const CACHE_WRITE_MULTIPLIER = 1.25;

function emptyUsage(): TokenUsage {
  return { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

function addMessageUsage(into: TokenUsage, usage: Anthropic.Usage): void {
  into.calls += 1;
  into.inputTokens += usage.input_tokens;
  into.outputTokens += usage.output_tokens;
  into.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
  into.cacheWriteTokens += usage.cache_creation_input_tokens ?? 0;
}

/** Null when the model has no known price — the report says "unpriced" rather than $0. */
function costUsd(model: string, usage: TokenUsage): number | null {
  const price = PRICES[model];
  if (!price) return null;
  const perToken = (perMillion: number) => perMillion / 1_000_000;
  return (
    usage.inputTokens * perToken(price.input) +
    usage.cacheWriteTokens * perToken(price.input * CACHE_WRITE_MULTIPLIER) +
    usage.cacheReadTokens * perToken(price.cacheRead) +
    usage.outputTokens * perToken(price.output)
  );
}

export { PRICES, addMessageUsage, costUsd, emptyUsage };
export type { TokenUsage };

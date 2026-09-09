// Knowledge's own model call, and the sink it reports what it spent to.
//
// D12: a shared LLM helper is a coupling every product inherits, so each unit
// vendors its own small one instead. This is knowledge's — the ~120 lines it
// actually needs, reporting usage through an interface rather than reaching for
// automations' metering, its wallet, its cost meter or its cancel gate. The
// composition root is the only place that knows both sides and wires them
// together; a standalone knowledge simply has no sink and records nothing.
//
// Degradation is LOUD and it is the caller's to handle (D42): no key configured
// is `null` from `knowledgeLlmKey()`, not a throw at import and not a silent
// call that fails at the vendor. The arbitration worker reads that and lets its
// queue grow visibly rather than burning attempts on a call that cannot succeed.

import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

import { logger } from '../../services/logger';

/**
 * Knowledge's key, falling back to the composed deployment's. A self-hoster
 * sets `KNOWLEDGE_LLM_API_KEY` and nothing else; Listen-Fire's single process has one
 * key that both products use. Deliberately NOT `getEnvVar` with a dev default —
 * "no key" has to be expressible, because a store without one is a supported
 * deployment, not a misconfiguration.
 */
export function knowledgeLlmKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const key = env.KNOWLEDGE_LLM_API_KEY ?? env.ANTHROPIC_API_KEY;
  return key ? key : null;
}

export function isKnowledgeLlmConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return knowledgeLlmKey(env) !== null;
}

/** Overridable because the operator paying for the calls should get to choose. */
function knowledgeLlmModel(env: NodeJS.ProcessEnv = process.env): string {
  return env.KNOWLEDGE_LLM_MODEL ?? 'claude-opus-5';
}

/**
 * Where knowledge reports what a call cost. Structural, and optional: the unit
 * works without one, it just meters nothing.
 */
export interface KnowledgeLlmUsageSink {
  record(usage: {
    teamId: string;
    /** What the call was for — the sink's only handle on which surface spent this. */
    purpose: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
  }): void;
}

let usageSink: KnowledgeLlmUsageSink | null = null;

export function registerKnowledgeLlmUsageSink(sink: KnowledgeLlmUsageSink): void {
  usageSink = sink;
}

export class KnowledgeLlmUnavailable extends Error {
  constructor() {
    super(
      'No LLM key is configured for knowledge (set KNOWLEDGE_LLM_API_KEY or ANTHROPIC_API_KEY). ' +
        'Model-backed knowledge behaviour is disabled until one is.',
    );
    this.name = 'KnowledgeLlmUnavailable';
  }
}

const MAX_TOKENS = 8192;

/**
 * One model call returning a value of the caller's shape.
 *
 * The shape is enforced by a forced tool rather than by asking for JSON: the
 * vendor guarantees the arguments match the schema, so there is no parse to
 * salvage and no prose to strip. The tool is never executed — it exists only to
 * give the answer a type.
 */
export async function knowledgeLlmStructured<T extends z.ZodType>(input: {
  teamId: string;
  purpose: string;
  system: string;
  user: string;
  /** JSON Schema for the answer, and the validator it must satisfy. */
  schema: Record<string, unknown>;
  validator: T;
  env?: NodeJS.ProcessEnv;
}): Promise<z.infer<T>> {
  const env = input.env ?? process.env;
  const apiKey = knowledgeLlmKey(env);
  if (!apiKey) throw new KnowledgeLlmUnavailable();

  const model = knowledgeLlmModel(env);
  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model,
    max_tokens: MAX_TOKENS,
    system: input.system,
    messages: [{ role: 'user', content: input.user }],
    tools: [
      {
        name: 'answer',
        description: input.purpose,
        input_schema: input.schema as Anthropic.Tool['input_schema'],
      },
    ],
    tool_choice: { type: 'tool', name: 'answer' },
  });

  usageSink?.record({
    teamId: input.teamId,
    purpose: input.purpose,
    model,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  });

  const answer = response.content.find((block) => block.type === 'tool_use');
  if (!answer || answer.type !== 'tool_use') {
    // A forced tool that produced no tool block means the turn ended some other
    // way — refused, or truncated. Either is a failure the caller must see.
    logger.warn('[knowledge llm] forced tool produced no answer', {
      purpose: input.purpose,
      model,
      stopReason: response.stop_reason,
    });
    throw new Error(
      `Knowledge LLM call "${input.purpose}" returned no answer (stop_reason=${response.stop_reason}).`,
    );
  }

  return input.validator.parse(answer.input);
}

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

import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

import { clientFor, platformAnthropic } from '../anthropic/client';
import type { AnthropicCall } from '../anthropic/client';
import {
  isGoogleServiceAccountConfigured,
  missingGoogleServiceAccountVars,
} from '../google_cloud';
import { modelRoute } from '../model_route';
import { neverAsAny } from '../utils/types';
import { logger } from '../../services/logger';

/**
 * Knowledge's key, falling back to the composed deployment's. A self-hoster
 * sets `KNOWLEDGE_LLM_API_KEY` and nothing else; Listen-Fire's single process has one
 * key that both products use. Deliberately NOT `getEnvVar` with a dev default —
 * "no key" has to be expressible, because a store without one is a supported
 * deployment, not a misconfiguration.
 *
 * A key answers only for the direct route. Where the deployment routes its
 * model calls through Google Cloud there is no key at all, and the question
 * "can knowledge call a model" is {@link isKnowledgeLlmConfigured}'s.
 */
export function knowledgeLlmKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const key = env.KNOWLEDGE_LLM_API_KEY ?? env.ANTHROPIC_API_KEY;
  return key ? key : null;
}

export function isKnowledgeLlmConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const route = modelRoute(env);
  switch (route) {
    case 'direct':
      return knowledgeLlmKey(env) !== null;
    case 'google':
      return isGoogleServiceAccountConfigured(env);
    default:
      return neverAsAny(route);
  }
}

/**
 * Knowledge's own client, built the way this deployment's route says. Its key
 * override is the operator's choice of who pays for arbitration, so it survives
 * on the direct route — but a key on the Google route is a contradiction rather
 * than an override, and says so instead of being quietly ignored.
 */
function knowledgeLlmClient(env: NodeJS.ProcessEnv): AnthropicCall {
  const route = modelRoute(env);
  switch (route) {
    case 'direct': {
      const apiKey = knowledgeLlmKey(env);
      if (!apiKey) throw new KnowledgeLlmUnavailable();
      return clientFor(apiKey, env);
    }
    case 'google': {
      if (env.KNOWLEDGE_LLM_API_KEY) {
        throw new Error(
          'KNOWLEDGE_LLM_API_KEY is set while MODEL_ROUTE is google. Knowledge calls its model ' +
            'through Google Cloud on that route and no key is used — remove it, or set ' +
            'MODEL_ROUTE=direct.',
        );
      }
      if (!isGoogleServiceAccountConfigured(env)) {
        throw new KnowledgeLlmUnavailable(missingGoogleServiceAccountVars(env).join(', '));
      }
      return platformAnthropic(env);
    }
    default:
      return neverAsAny(route);
  }
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
  /** What the operator has to set, which differs by route: a key on the direct
   *  route, a Google service account where the calls go through Google Cloud. */
  constructor(setThis = 'KNOWLEDGE_LLM_API_KEY or ANTHROPIC_API_KEY') {
    super(
      `No LLM credentials are configured for knowledge (set ${setThis}). ` +
        'Model-backed knowledge behaviour is disabled until they are.',
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
  const { client, wireModel } = knowledgeLlmClient(env);
  const model = knowledgeLlmModel(env);

  const response = await client.messages.create({
    model: wireModel(model),
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

// Embeddings on OpenAI.

import { recordLlmUsage } from '../../llm_usage';
import { openAiClient } from '../providers/openai';
import type { Resolved } from '../map';
import type { EmbeddingRequest, EmbeddingResult } from './index';
import type { EmbeddingRange } from './range';

/**
 * The widths each OpenAI embedding model can produce. `dimensions` shortens
 * a text-embedding-3 vector to any width up to its native one; the native
 * width is the maximum. Source, checked 2026-09-24: "By default, the length of
 * the embedding vector is 1536 for text-embedding-3-small or 3072 for
 * text-embedding-3-large" (https://developers.openai.com/api/docs/guides/embeddings),
 * and the SDK's own `dimensions` doc: "Only supported in `text-embedding-3`
 * and later models" — which is why ada-002 is not listed.
 */
export const OPENAI_EMBEDDING_DIMENSIONS: Readonly<Record<string, EmbeddingRange>> = {
  'text-embedding-3-large': { min: 1, max: 3072 },
  'text-embedding-3-small': { min: 1, max: 1536 },
};

export async function openAiEmbed(
  resolved: Resolved,
  req: EmbeddingRequest,
  env: NodeJS.ProcessEnv,
): Promise<EmbeddingResult> {
  const { wireModel } = resolved;
  const native = OPENAI_EMBEDDING_DIMENSIONS[wireModel]?.max;
  const response = await openAiClient(env).embeddings.create({
    model: wireModel,
    input: req.input,
    // Omitted at the native width: naming it changes nothing but the request,
    // and the request without it is the one that has always worked.
    ...(req.dimensions === undefined || req.dimensions === native ? {} : { dimensions: req.dimensions }),
  });

  recordLlmUsage({
    resolved,
    callType: 'embedding',
    label: req.label,
    inputTokens: response.usage.total_tokens,
    outputTokens: 0,
  }).catch(() => {});

  return { embeddings: response.data.map((d) => d.embedding) };
}

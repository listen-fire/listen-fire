// Embeddings behind the model map: the caller names a registry model and a
// width, and the map decides which vendor computes the vectors.

import { neverAsAny } from '../../utils/types';
import { assertCallable, resolveModel } from '../map';
import type { Provider } from '../map';
import type { EmbeddingModelName } from '../registry';
import { geminiEmbed } from './gemini';
import { openAiEmbed } from './openai';

export interface EmbeddingRequest {
  input: string[];
  /** The width the vectors must have; the vendor's native width when absent. */
  dimensions?: number;
  label?: string;
}

export interface EmbeddingResult {
  embeddings: number[][];
}

export async function embed(
  name: EmbeddingModelName,
  req: EmbeddingRequest,
  env: NodeJS.ProcessEnv = process.env,
): Promise<EmbeddingResult> {
  if (req.input.length === 0) return { embeddings: [] };
  const resolved = resolveModel(name, env);
  assertCallable(resolved, env);
  const { provider, wireModel } = resolved;
  const result = await embedOn(provider, wireModel, req, env, name);
  if (result.embeddings.length !== req.input.length) {
    throw new Error(
      `${provider}/${wireModel} returned ${result.embeddings.length} embeddings for ${req.input.length} texts.`,
    );
  }
  // A vector of the wrong width is a row Postgres refuses, or worse, one it
  // accepts into the wrong index; either way it never leaves here.
  const wrong = result.embeddings.find((v) => req.dimensions !== undefined && v.length !== req.dimensions);
  if (wrong) {
    throw new Error(
      `${provider}/${wireModel} returned a ${wrong.length}-dimension vector where ${req.dimensions} were asked for.`,
    );
  }
  return result;
}

function embedOn(
  provider: Provider,
  wireModel: string,
  req: EmbeddingRequest,
  env: NodeJS.ProcessEnv,
  name: EmbeddingModelName,
): Promise<EmbeddingResult> {
  switch (provider) {
    case 'openai':
      return openAiEmbed(wireModel, req, env);
    case 'gemini':
      return geminiEmbed(wireModel, req, env);
    case 'anthropic':
    case 'vertex':
      // Boot validation refuses this map line; reaching it means the map was
      // never validated.
      throw new Error(`MODEL_MAP sends "${name}" to ${provider}, which does not serve embeddings.`);
    default:
      return neverAsAny(provider);
  }
}

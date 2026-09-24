// What width of vector each wire model can produce, read by boot validation.
// Its own module because the map imports it, and the embedding entry point
// imports the map.

import { neverAsAny } from '../../utils/types';
import type { Provider } from '../map';
import { GEMINI_EMBEDDING_MODELS } from './gemini';
import { OPENAI_EMBEDDING_DIMENSIONS } from './openai';

/** The widths a wire model can produce, inclusive. */
export interface EmbeddingRange {
  min: number;
  max: number;
}

/**
 * What `wireModel` on `provider` can produce, or nothing when its provider
 * file does not list it: a wire model nobody wrote down cannot promise the
 * width a column needs, so boot validation refuses it rather than guessing.
 */
export function embeddingRange(provider: Provider, wireModel: string): EmbeddingRange | undefined {
  switch (provider) {
    case 'openai':
      return OPENAI_EMBEDDING_DIMENSIONS[wireModel];
    case 'gemini':
      return GEMINI_EMBEDDING_MODELS[wireModel];
    case 'anthropic':
    case 'vertex':
      return undefined;
    default:
      return neverAsAny(provider);
  }
}

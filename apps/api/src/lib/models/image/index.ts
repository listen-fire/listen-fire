// Image generation behind the model map: the caller names a registry model and
// DALL·E 3's knobs, and the map decides which vendor draws it.

import { neverAsAny } from '../../utils/types';
import { assertCallable, resolveModel } from '../map';
import type { ImageModelName } from '../registry';
import { geminiGenerateImage } from './gemini';
import { openAiGenerateImage } from './openai';

/** DALL·E 3's request shape, the interface every image provider answers. */
export interface ImageRequest {
  prompt: string;
  /** `1024x1024`, `1792x1024` or `1024x1792`. */
  size?: string;
  /** `standard` or `hd`. */
  quality?: string;
  /** `vivid` or `natural`. */
  style?: string;
  label?: string;
}

export interface GeneratedImage {
  bytes: Buffer;
  mimeType: string;
}

export async function generateImage(
  name: ImageModelName,
  req: ImageRequest,
  env: NodeJS.ProcessEnv = process.env,
): Promise<GeneratedImage> {
  const resolved = resolveModel(name, env);
  assertCallable(resolved, env);
  const { provider, wireModel } = resolved;
  switch (provider) {
    case 'openai':
      return openAiGenerateImage(wireModel, req, env);
    case 'gemini':
      return geminiGenerateImage(wireModel, req, env);
    case 'anthropic':
    case 'vertex':
      // Boot validation refuses this map line; reaching it means the map was
      // never validated.
      throw new Error(`MODEL_MAP sends "${name}" to ${provider}, which does not generate images.`);
    default:
      return neverAsAny(provider);
  }
}

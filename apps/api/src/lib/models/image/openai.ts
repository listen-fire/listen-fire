// Image generation on OpenAI's images endpoint.

import { z } from 'zod';

import { logger } from '../../../services/logger';
import { openAiClient } from '../providers/openai';
import type { GeneratedImage, ImageRequest } from './index';

// The values DALL·E 3 takes. Parsed rather than asserted: the request's
// strings come from a model's tool call, and one the endpoint does not know
// should fail here naming the field, not as a 400 naming nothing we wrote.
const DalleOptions = z.object({
  size: z.enum(['1024x1024', '1792x1024', '1024x1792']).default('1024x1024'),
  quality: z.enum(['standard', 'hd']).default('standard'),
  style: z.enum(['vivid', 'natural']).default('vivid'),
});

export async function openAiGenerateImage(
  wireModel: string,
  req: ImageRequest,
  env: NodeJS.ProcessEnv,
): Promise<GeneratedImage> {
  const options = DalleOptions.safeParse({ size: req.size, quality: req.quality, style: req.style });
  if (!options.success) {
    throw new Error(`An image request OpenAI cannot take: ${options.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  logger.info(`OpenAI image submitted ${req.label ? `(${req.label})` : ''}`, { model: wireModel });
  const response = await openAiClient(env).images.generate({
    model: wireModel,
    prompt: req.prompt,
    n: 1,
    ...options.data,
    response_format: 'b64_json',
  });
  const b64 = response.data?.[0]?.b64_json;
  if (!b64) throw new Error(`${wireModel} returned no image data.`);
  return { bytes: Buffer.from(b64, 'base64'), mimeType: 'image/png' };
}

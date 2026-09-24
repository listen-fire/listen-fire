// Image generation on Gemini: a `generateContent` call to an image model, asked
// for an image back, whose reply carries the picture as an inline part.

import { googleServiceAccount } from '../../google_cloud';
import { logger } from '../../../services/logger';
import { geminiClient } from '../providers/gemini';
import type { GeneratedImage, ImageRequest } from './index';

/** DALL·E's sizes as Gemini's aspect ratio and resolution tier. */
function geminiImageConfig(size?: string): { aspectRatio: string; imageSize: string } {
  if (size === '1792x1024') return { aspectRatio: '16:9', imageSize: '2K' };
  if (size === '1024x1792') return { aspectRatio: '9:16', imageSize: '2K' };
  return { aspectRatio: '1:1', imageSize: '1K' };
}

export async function geminiGenerateImage(
  wireModel: string,
  req: ImageRequest,
  env: NodeJS.ProcessEnv,
): Promise<GeneratedImage> {
  // `quality` and `style` have no Gemini parameter and are not sent: they are
  // DALL·E's names for what the prompt itself describes to Gemini, and this
  // is how image generation on Google has always behaved here.
  logger.info(`Gemini image submitted ${req.label ? `(${req.label})` : ''}`, { model: wireModel });
  // In the project's own region rather than the model region: image
  // generation has always run there, and the global endpoint is not where
  // every image model is served.
  const client = geminiClient(env, { location: googleServiceAccount(env).projectLocation });
  const response = await client.models.generateContent({
    model: wireModel,
    contents: [{ role: 'user', parts: [{ text: req.prompt }] }],
    config: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: geminiImageConfig(req.size) },
  });
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  const image = parts.find((part) => part.inlineData?.mimeType?.startsWith('image/'))?.inlineData;
  if (!image?.data || !image.mimeType) throw new Error(`${wireModel} returned no image data.`);
  return { bytes: Buffer.from(image.data, 'base64'), mimeType: image.mimeType };
}

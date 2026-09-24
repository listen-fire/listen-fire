// Claude on Google Cloud, passed through: the Vertex SDK serves the same
// messages surface as Anthropic's own, minus endpoints the seam never asks for.

import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';

import { googleAuth, googleServiceAccount } from '../../google_cloud';
import type { ChatProvider } from '../chat';

let client: AnthropicVertex | undefined;

/** Claude's endpoint on Google. The global one is Anthropic's recommendation
 *  and the only one without a regional price premium — deliberately NOT
 *  `GOOGLE_PROJECT_LOCATION`, which is a real region that OCR and image
 *  generation need. */
function modelRegion(env: NodeJS.ProcessEnv): string {
  return env.GOOGLE_MODEL_REGION || 'global';
}

export function vertexChatProvider(env: NodeJS.ProcessEnv = process.env): ChatProvider {
  return (client ??= new AnthropicVertex({
    projectId: googleServiceAccount(env).projectId,
    region: modelRegion(env),
    googleAuth: googleAuth(env),
  }));
}

// Who transcribes a voice note, as a decision rather than as a line in the
// composition root.
//
// It follows the model route and nothing else: a deployment on Google has no
// OpenAI account for Whisper to belong to, and one on the direct route has no
// reason to change. Splitting the choice out (as outbound email does) is what
// lets both outcomes be asserted without importing every service in the process.

import { modelRoute } from '../../lib/model_route';
import { neverAsAny } from '../../lib/utils/types';
import { GoogleTranscriptionAdapter } from './google';
import type { TranscriptionAdapter } from './interface';
import { OpenAiTranscriptionAdapter } from './openai';

export function chooseTranscriptionAdapter(
  env: NodeJS.ProcessEnv = process.env,
): TranscriptionAdapter {
  const route = modelRoute(env);
  switch (route) {
    case 'direct':
      return new OpenAiTranscriptionAdapter();
    case 'google':
      return new GoogleTranscriptionAdapter();
    default:
      return neverAsAny(route);
  }
}

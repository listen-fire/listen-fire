// Who transcribes a voice note, as a decision rather than as a line in the
// composition root.
//
// It follows the OpenAI route and nothing else — Whisper is an OpenAI model, so
// it belongs to that vendor's route rather than to Claude's: a deployment whose
// OpenAI-shaped calls go to Google has no OpenAI account for Whisper to belong
// to, and one on the direct route has no reason to change. Splitting the choice
// out (as outbound email does) is what
// lets both outcomes be asserted without importing every service in the process.

import { openAiRoute } from '../../lib/model_route';
import { neverAsAny } from '../../lib/utils/types';
import { GoogleTranscriptionAdapter } from './google';
import type { TranscriptionAdapter } from './interface';
import { OpenAiTranscriptionAdapter } from './openai';

export function chooseTranscriptionAdapter(
  env: NodeJS.ProcessEnv = process.env,
): TranscriptionAdapter {
  const route = openAiRoute(env);
  switch (route) {
    case 'direct':
      return new OpenAiTranscriptionAdapter();
    case 'google':
      return new GoogleTranscriptionAdapter();
    default:
      return neverAsAny(route);
  }
}

// Who transcribes a voice note, as a decision rather than as a line in the
// composition root.
//
// It follows the model map's answer for Whisper and nothing else: a deployment
// that sends `whisper-1` to Gemini has no OpenAI account for Whisper to belong
// to, and one that leaves it at home has no reason to change. Splitting the
// choice out (as outbound email does) is what lets both outcomes be asserted
// without importing every service in the process.

import { resolveModel } from '../../lib/models/map';
import { neverAsAny } from '../../lib/utils/types';
import { GoogleTranscriptionAdapter } from './google';
import type { TranscriptionAdapter } from './interface';
import { OpenAiTranscriptionAdapter } from './openai';

export function chooseTranscriptionAdapter(
  env: NodeJS.ProcessEnv = process.env,
): TranscriptionAdapter {
  const { provider } = resolveModel('whisper-1', env);
  switch (provider) {
    case 'openai':
      return new OpenAiTranscriptionAdapter();
    case 'gemini':
      return new GoogleTranscriptionAdapter();
    case 'anthropic':
    case 'vertex':
      throw new Error(`MODEL_MAP sends whisper-1 to ${provider}, which does not transcribe audio.`);
    default:
      return neverAsAny(provider);
  }
}

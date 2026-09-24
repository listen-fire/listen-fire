import { toFile } from 'openai';
import { backOff } from 'exponential-backoff';

import { Queue } from '../utils/queue';
import { logger } from '../../services/logger';
import { SECOND } from '../../constants';
import { platformOpenAI } from './client';

const rateLimitQueue = new Queue<any>({ concurrency: 8 });

const RETRY_LIMIT = 4;
const INITIAL_DELAY = 1 * SECOND;
const TIME_MULTIPLE = 4;
const RATE_LIMIT_DELAY = 30 * SECOND;
async function enqueueQuery<T>(fn: () => Promise<T>, signal?: AbortSignal) {
  return rateLimitQueue.enqueue(async () => {
    return backOff(fn, {
      jitter: 'none',
      numOfAttempts: RETRY_LIMIT,
      startingDelay: INITIAL_DELAY,
      timeMultiple: TIME_MULTIPLE, // 0s, 1s, 4s, 16s, 64s
      retry: async (e, attempt) => {
        if (signal?.aborted) return false;
        if (e instanceof Error && e.message.includes('429')) {
          // rate limit
          // extra delay to lower the odds of hitting the rate limit again
          logger.info(`Hit rate limit, waiting an additional ${RATE_LIMIT_DELAY / SECOND} seconds`);
          await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_DELAY));
        } else if (e instanceof Error && e.message.includes('401')) {
          // invalid api key
          return false;
        }

        if (attempt < RETRY_LIMIT) {
          logger.info(
            `Retrying OpenAI query in ${
              (INITIAL_DELAY / SECOND) * TIME_MULTIPLE ** (attempt - 1)
            } seconds`,
            {
              error: e,
            },
          );
        }
        return true;
      },
    });
  });
}

const TRANSCRIPTION_MODEL = 'whisper-1';

interface TranscribeOutput {
  text: string;
  /** Source audio length in seconds, as reported by the verbose_json response. */
  duration: number;
}

async function openAiTranscribe(
  audio: Buffer,
  options: { name: string; label?: string },
): Promise<TranscribeOutput> {
  const { client, wireModel } = platformOpenAI(TRANSCRIPTION_MODEL);
  try {
    return await enqueueQuery(async () => {
      logger.info(
        `OpenAI transcription submitted ${options.label ? `(${options.label})` : ''}`,
        { model: wireModel, name: options.name, bytes: audio.length },
      );
      const file = await toFile(audio, options.name);
      const transcription = await client.audio.transcriptions.create({
        file,
        model: wireModel,
        // verbose_json carries `duration` — the honest per-minute metering unit.
        response_format: 'verbose_json',
      });
      return { text: transcription.text ?? '', duration: transcription.duration ?? 0 };
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes('401')) {
      throw new Error('Invalid OpenAI API key');
    }
    throw err;
  }
}

export { openAiTranscribe };

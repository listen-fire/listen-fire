import OpenAI, { toFile } from 'openai';
import { backOff } from 'exponential-backoff';

import { Queue } from '../utils/queue';
import { logger } from '../../services/logger';
import { SECOND } from '../../constants';
import { RequestOptions } from 'openai/internal/request-options';
import { recordLlmUsage } from '../llm_usage';
import { modelRoute } from '../model_route';
import { assertSchemaIsNotRecursive, platformOpenAI } from './client';

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

type ChatCreateParams = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
type Messages = ChatCreateParams['messages'];
type Options = Omit<ChatCreateParams, 'messages'>;

const defaultOptions: Options = {
  model: 'gpt-4.1',
  temperature: 0,
  n: 1,
};

// gpt-5 and o-series reasoning models reject any temperature other than the
// default (1). The rule belongs to those OPENAI models, so it keys on the name
// actually being sent — a Gemini answering for `gpt-5-nano` on the Google route
// accepts temperature perfectly well, and stripping it because the name the
// caller reached for looked o-series would quietly throw away the determinism
// every one of those callers asked for.
function modelSupportsTemperature(wireModel: string) {
  return !/^(gpt-5|o\d)/.test(wireModel);
}

function stripUnsupportedParams<T extends { model: string; temperature?: number | null }>(
  opts: T,
): T {
  if (!modelSupportsTemperature(opts.model) && opts.temperature !== undefined) {
    const { temperature: _temperature, ...rest } = opts;
    return rest as T;
  }
  return opts;
}

async function openAiChat(messages: Messages, options?: Partial<Options>, label?: string) {
  const { client, wireModel, provider } = platformOpenAI();
  const merged = options ? { ...defaultOptions, ...options } : defaultOptions;
  // The wire name is also the billed name: on Google this really is a different
  // model at a different price, so the ledger follows the request rather than
  // the caller's wish.
  const sendOptions = stripUnsupportedParams({ ...merged, model: wireModel(merged.model) });
  try {
    const text = await enqueueQuery(async () => {
      logger.info(`OpenAI chat submitted ${label ? `(${label})` : ''}`, sendOptions);

      const startMs = Date.now();
      const completion = await client.chat.completions.create({
        messages,
        ...sendOptions,
      });
      const durationMs = Date.now() - startMs;

      recordLlmUsage({
        provider,
        model: sendOptions.model,
        callType: 'chat',
        label: label ?? undefined,
        inputTokens: completion.usage?.prompt_tokens ?? 0,
        outputTokens: completion.usage?.completion_tokens ?? 0,
        durationMs,
      }).catch(() => {});

      return completion.choices[0]?.message?.content ?? '';
    });

    return text;
  } catch (err) {
    if (err instanceof Error && err.message.includes('401')) {
      throw new Error('Invalid OpenAI API key');
    }
    throw err;
  }
}

async function openAiChatStructured(
  messages: Messages,
  options?: Partial<Options>,
  label?: string,
) {
  const { client, wireModel, provider } = platformOpenAI();
  const merged = options ? { model: 'o3', ...options } : { model: 'o3' };
  const sendOptions = stripUnsupportedParams({ ...merged, model: wireModel(merged.model) });

  if (provider === 'google') {
    const responseFormat = sendOptions.response_format;
    if (responseFormat?.type === 'json_schema') {
      assertSchemaIsNotRecursive(
        responseFormat.json_schema.schema,
        responseFormat.json_schema.name,
      );
    }
  }

  try {
    const text = await enqueueQuery(async () => {
      logger.info(`OpenAI chat submitted ${label ? `(${label})` : ''}`, sendOptions);

      const startMs = Date.now();
      const completion = await client.chat.completions.parse({
        messages,
        ...sendOptions,
      });
      const durationMs = Date.now() - startMs;

      recordLlmUsage({
        provider,
        model: sendOptions.model,
        callType: 'structured',
        label: label ?? undefined,
        inputTokens: completion.usage?.prompt_tokens ?? 0,
        outputTokens: completion.usage?.completion_tokens ?? 0,
        durationMs,
      }).catch(() => {});

      return (
        completion.choices[0]?.message?.parsed ?? completion.choices[0]?.message?.content ?? ''
      );
    });

    return text;
  } catch (err) {
    if (err instanceof Error && err.message.includes('401')) {
      throw new Error('Invalid OpenAI API key');
    }
    throw err;
  }
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
  try {
    return await enqueueQuery(async () => {
      logger.info(
        `OpenAI transcription submitted ${options.label ? `(${options.label})` : ''}`,
        { model: TRANSCRIPTION_MODEL, name: options.name, bytes: audio.length },
      );
      const file = await toFile(audio, options.name);
      const transcription = await platformOpenAI().client.audio.transcriptions.create({
        file,
        model: TRANSCRIPTION_MODEL,
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

async function openAIResponses(
  body: OpenAI.Responses.ResponseCreateParamsNonStreaming,
  tools: Record<string, (args: any) => Promise<any>> = {},
  options?: RequestOptions & { label?: string; signal?: AbortSignal },
) {
  // Google's endpoint serves chat completions and nothing else — there is no
  // Responses API behind it to fall back to, and no sensible translation from a
  // stateful `previous_response_id` loop into a stateless one. Boot validation
  // already refuses this combination; this is the second wall, for a caller that
  // reached the tool loop some other way.
  if (modelRoute() === 'google') {
    throw new Error(
      "MODEL_ROUTE is google, and Google serves no OpenAI Responses API. The knowledge agents' " +
        'Claude path does work on this route — set KNOWLEDGE_AGENT_PROVIDER=anthropic.',
    );
  }

  const { client } = platformOpenAI();
  try {
    let currentParams: any = {
      model: 'gpt-5',
      ...body,
    };

    for (let turn = 0; ; turn++) {
      if (options?.signal?.aborted) throw new Error('Aborted');

      const startMs = Date.now();
      const response = await enqueueQuery(async () => {
        return client.responses.create(currentParams, options);
      }, options?.signal);
      const durationMs = Date.now() - startMs;

      const responseUsage = (response as any).usage;
      if (responseUsage) {
        recordLlmUsage({
          provider: 'openai',
          model: currentParams.model ?? 'gpt-5',
          callType: 'responses',
          label: options?.label,
          inputTokens: responseUsage.input_tokens ?? 0,
          outputTokens: responseUsage.output_tokens ?? 0,
          durationMs,
        }).catch(() => {});
      }

      console.log(response);

      const toolCalls = [];
      let finalContent = null;

      if (response.output) {
        for (const output of response.output) {
          if (output.type === 'message') {
            finalContent = output.content;
          } else if (output.type === 'tool_call' || output.type === 'function_call') {
            toolCalls.push(output);
          }
        }
      }

      if (toolCalls.length > 0) {
        const toolOutputs = await Promise.all(
          toolCalls.map(async (tc: any) => {
            if (options?.signal?.aborted) return { type: 'function_call_output', call_id: tc.call_id ?? tc.id, output: '"Aborted"' };
            const name = tc.function?.name ?? tc.name;
            const argsString = tc.function?.arguments ?? tc.arguments;
            const callId = tc.call_id ?? tc.id;

            const tool = tools[name];
            let result;
            if (tool) {
              try {
                const args = JSON.parse(argsString);
                result = await tool(args);
              } catch (e: any) {
                // Re-throw control-flow signals (e.g. handoff/hand-back) — they must propagate
                if (e?.isHandoff || e?.isHandBack) throw e;
                result = { error: String(e) };
              }
            } else {
              result = { error: `Tool ${name} not found` };
            }

            return {
              type: 'function_call_output',
              call_id: callId,
              output: JSON.stringify(result),
            };
          }),
        );

        if (options?.signal?.aborted) throw new Error('Aborted');

        // Prepare next call with tool outputs as input and link via previous_response_id
        currentParams = {
          model: 'gpt-5',
          ...body, // Keep original instructions/tools/etc
          input: toolOutputs,
          previous_response_id: response.id,
        };
      } else if (finalContent !== null) {
        return finalContent;
      } else {
        // Logic for no message and no tools (e.g., incomplete or just done)
        // If "done", usually we have a message?
        // If not, break to avoid infinite loop.
        break;
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('401')) {
      throw new Error('Invalid OpenAI API key');
    }
    throw err;
  }
}

export { openAiChat, openAiChatStructured, openAIResponses, openAiTranscribe };

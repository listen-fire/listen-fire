// Jev (Typesafe AI): a non-generative judge. A request carries a `state` and
// typed questions; Jev answers each with a probability rather than text to
// parse. The wire shapes, the retry policy and the request model are the
// platform's client's (lf-platform apps/api/src/lib/jev/client.ts); the
// request goes through the host's fetch, so the host sees and limits it.

import { z } from 'zod';

export const DEFAULT_JEV_BASE_URL = 'https://api.typesafe.ai/v1';
const REQUEST_MODEL = 'jev-latest';

/**
 * Jev's listed price: $0.042 per million input tokens, output free (the
 * Jev evaluation of 2026-09-17, from Jev's own docs). The platform's price
 * table has no Jev line yet, so this is the one figure in either repository.
 */
export const JEV_PRICE_PER_MILLION_INPUT_TOKENS = 0.042;

/**
 * Jev accepts about 31.7k input tokens and refuses about 39k. A request is
 * measured before it is sent at one token per three bytes of its JSON, which
 * overcounts English (about four), so a request this lets through is under
 * Jev's ceiling.
 */
export const JEV_MAX_INPUT_TOKENS = 30_000;
const BYTES_PER_TOKEN_ESTIMATE = 3;

const ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 1000;

const noulAnswerSchema = z.object({ type: z.literal('noul'), noul: z.number() });
const choiceAnswerSchema = z.object({
  type: z.literal('choice'),
  choice: z.string(),
  confidence: z.number(),
  probabilities: z.record(z.string(), z.number()),
});
const answerSchema = z.discriminatedUnion('type', [choiceAnswerSchema, noulAnswerSchema]);
const responseSchema = z.object({
  model: z.string(),
  answers: z.record(z.string(), answerSchema),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).optional(),
});

export type JevQuestion =
  | { type: 'noul'; instructions: string }
  /** Each criterion's value describes its option to Jev. */
  | { type: 'choice'; instructions: string; criteria: Record<string, string | null> };

export type JevAnswer = z.infer<typeof answerSchema>;

export interface JevReply {
  answers: Record<string, JevAnswer>;
  costMicrodollars: number;
}

export interface JevEndpoint {
  apiKey: string;
  baseUrl: string;
}

/** The credential's fields as an endpoint, refusing by name when there is no key. */
export function endpointOf(fields: Readonly<Record<string, string | undefined>>): JevEndpoint {
  const apiKey = fields.apiKey?.trim();
  if (apiKey === undefined || apiKey === '') {
    throw new Error('@lf/jev has no API key: add a credential with `lf credential add --module @lf/jev <name>`');
  }
  const baseUrl = fields.baseUrl?.trim();
  return { apiKey, baseUrl: (baseUrl === undefined || baseUrl === '' ? DEFAULT_JEV_BASE_URL : baseUrl).replace(/\/+$/, '') };
}

/** The request's size in tokens, estimated high (see `JEV_MAX_INPUT_TOKENS`). */
export function estimatedTokens(body: string): number {
  return Math.ceil(Buffer.byteLength(body, 'utf8') / BYTES_PER_TOKEN_ESTIMATE);
}

/** Microdollars for a call that read `inputTokens`, never zero: every call counts against the cap. */
export function costOf(inputTokens: number): number {
  return Math.max(1, Math.ceil(inputTokens * JEV_PRICE_PER_MILLION_INPUT_TOKENS));
}

function retryable(status: number): boolean {
  return status === 429 || status === 529;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/**
 * Ask Jev `questions` over `state`. A rate limit or an overload (429, 529) is
 * retried with a growing, jittered delay, three tries in all; anything else
 * Jev refuses fails at once, since asking again would be refused again.
 */
export async function askJev(
  input: { state: unknown; questions: Record<string, JevQuestion>; caller: string },
  options: { endpoint: JevEndpoint; fetch: typeof fetch; retryDelayMs?: number },
): Promise<JevReply> {
  const body = JSON.stringify({ model: REQUEST_MODEL, state: input.state, questions: input.questions });
  const tokens = estimatedTokens(body);
  if (tokens > JEV_MAX_INPUT_TOKENS) {
    throw new Error(
      `${input.caller}: the subject and question come to about ${tokens} tokens, over the ${JEV_MAX_INPUT_TOKENS} Jev reads. ` +
        'Pass less: the fields that matter, or one piece of a long text (Text.chunks).',
    );
  }
  const delay = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  for (let attempt = 1; ; attempt++) {
    const response = await options.fetch(`${options.endpoint.baseUrl}/systemone`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${options.endpoint.apiKey}`, 'Content-Type': 'application/json' },
      body,
    });
    if (response.ok) return replyOf(await response.json(), tokens);
    const text = await response.text().catch(() => '');
    if (response.status === 401 || response.status === 403) {
      throw new Error(`Jev refused the API key (${response.status}): check the apiKey of the @lf/jev credential. ${text}`.trim());
    }
    if (!retryable(response.status)) throw new Error(`Jev refused the request (${response.status}): ${text}`);
    if (attempt === ATTEMPTS) throw new Error(`Jev is overloaded or rate-limiting (${response.status}) after ${ATTEMPTS} tries: ${text}`);
    await sleep(Math.random() * delay * 2 ** (attempt - 1));
  }
}

function replyOf(raw: unknown, estimated: number): JevReply {
  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Jev answered something this module does not read: ${parsed.error.message}`);
  // Jev's own count when it gives one; the estimate otherwise, so an
  // unreported call is not counted as free.
  const inputTokens = parsed.data.usage?.input_tokens ?? estimated;
  return { answers: parsed.data.answers, costMicrodollars: costOf(inputTokens) };
}

// Gemini's OWN request shape, for the things Google's OpenAI-shaped endpoint
// cannot carry.
//
// Audio is the one that forced this. The compatibility layer does accept an
// `input_audio` part, and its docs say "Using Gemini, all valid MIME types are
// supported" — but the OpenAI SDK types that part's `format` as `'wav' | 'mp3'`,
// so every real voice note (Opus in Ogg, AAC in MP4, WebM) would have to reach
// the wire through a type assertion that says the opposite of what the type
// says. `generateContent` takes the MIME type as a MIME type.

import { z } from 'zod';

import { googleBearerTokens, googleModelUrl } from './google_cloud';
import { logger } from '../services/logger';
import { recordLlmUsage } from './llm_usage';

/**
 * The Gemini that answers an audio question. GA since 2026-09-02, served on the
 * global endpoint, and it takes all eleven audio MIME types
 * (https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-8-flash).
 * Deliberately not the Pro: transcription is a long input and a long output with
 * no reasoning in between, which is what the Flash tier is for.
 */
export const GEMINI_TRANSCRIPTION_MODEL = 'gemini-3.8-flash';

/**
 * How many bytes of audio may travel INSIDE the request.
 *
 * Google publishes no inline ceiling for audio specifically. What it does
 * publish, on the same model page, is 7 MB per inline file (stated for images)
 * and 15 MB for audio it fetches from an HTTP URL — so 7 MB is the smaller of
 * the two documented inline figures and the one we hold ourselves to rather than
 * discovering the real number as a failed transcription. Base64 inflates the
 * body by a third, which this is the raw-bytes side of.
 *
 * For scale: a ten-minute Opus voice note is well under 1 MB. A file that trips
 * this is a recording, not a message, and the honest answer is to say so.
 */
export const GEMINI_INLINE_AUDIO_MAX_BYTES = 7 * 1024 * 1024;

/**
 * As much of a `generateContent` reply as we read. PARSED rather than asserted:
 * this is a boundary, and a shape we assert is a shape we have stopped checking.
 *
 * What is optional here is genuinely optional — a safety-blocked candidate
 * carries no parts, and `usageMetadata` is absent on some error-shaped 200s.
 * Missing text is a real outcome the caller reports, not a parse failure.
 */
const GeneratedContent = z.object({
  candidates: z
    .array(
      z.object({
        content: z.object({ parts: z.array(z.object({ text: z.string().optional() })) }).optional(),
      }),
    )
    .min(1),
  usageMetadata: z
    .object({
      promptTokenCount: z.number().optional(),
      candidatesTokenCount: z.number().optional(),
    })
    .optional(),
});

function readGeneratedText(body: unknown): {
  text: string;
  inputTokens: number;
  outputTokens: number;
} {
  const parsed = GeneratedContent.safeParse(body);
  if (!parsed.success) {
    throw new Error(
      `Gemini answered in a shape we do not recognise: ${parsed.error.message.slice(0, 300)}`,
    );
  }
  const parts = parsed.data.candidates[0].content?.parts ?? [];
  return {
    text: parts.map((part) => part.text ?? '').join(''),
    inputTokens: parsed.data.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: parsed.data.usageMetadata?.candidatesTokenCount ?? 0,
  };
}

/**
 * A verbatim transcript of one audio file, through Gemini's own endpoint.
 *
 * The prompt asks for the words and nothing else on purpose: a model told to
 * "transcribe" will otherwise happily add a summary, a speaker guess or an
 * apology, and every one of those becomes text the extraction downstream treats
 * as something the speaker said.
 */
export async function geminiTranscribe(
  audio: Buffer,
  options: { mimeType: string; label?: string; env?: NodeJS.ProcessEnv },
): Promise<{ text: string }> {
  const env = options.env ?? process.env;
  if (audio.length > GEMINI_INLINE_AUDIO_MAX_BYTES) {
    throw new Error(
      `The audio is ${audio.length} bytes, over the ${GEMINI_INLINE_AUDIO_MAX_BYTES}-byte limit ` +
        'for audio sent inside a Gemini request.',
    );
  }

  const url = googleModelUrl({ model: GEMINI_TRANSCRIPTION_MODEL, method: 'generateContent', env });
  const token = await googleBearerTokens(env)();

  logger.info(`Gemini transcription submitted ${options.label ? `(${options.label})` : ''}`, {
    model: GEMINI_TRANSCRIPTION_MODEL,
    mimeType: options.mimeType,
    bytes: audio.length,
  });

  const startMs = Date.now();
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType: options.mimeType, data: audio.toString('base64') } },
            {
              text:
                'Transcribe this audio verbatim. Output only the spoken words, as plain text. ' +
                'Do not add speaker labels, timestamps, commentary, or any note about the audio ' +
                'itself. If nothing is said, output nothing.',
            },
          ],
        },
      ],
      generationConfig: { temperature: 0 },
    }),
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`Gemini transcription error ${response.status}: ${detail}`);
  }

  const { text, inputTokens, outputTokens } = readGeneratedText(await response.json());

  recordLlmUsage({
    provider: 'google',
    model: GEMINI_TRANSCRIPTION_MODEL,
    callType: 'chat',
    label: options.label,
    inputTokens,
    outputTokens,
    durationMs: Date.now() - startMs,
  }).catch(() => {});

  return { text };
}

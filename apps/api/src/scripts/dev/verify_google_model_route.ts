/**
 * Live proof that this deployment can run on Google Cloud alone.
 *
 * Every surface the api has a model for is exercised ONCE, through the real
 * wrappers rather than a hand-built request — the thing being proved is that
 * the code paths the product uses work on this route, not that Google answers
 * an HTTP call. Each surface prints one PASS or FAIL line and none of them can
 * stop another: a Google project with some models switched on and others not is
 * the expected state, and the useful output is which ones.
 *
 *   MODEL_ROUTE=google npx ts-node --project tsconfig.dev.json --transpile-only \
 *     -r dotenv/config -r tsconfig-paths/register \
 *     src/scripts/dev/verify_google_model_route.ts [path/to/audio]
 *
 * It spends real money on Google's bill: a handful of small Claude turns, two
 * Gemini turns, one hosted search with a page read, one embedding, one
 * transcription and one image. Run it once, read the output, stop.
 */
import './_profile_loader';

import path from 'node:path';
import fs from 'node:fs';

import { z } from 'zod';

import {
  anthropicChat,
  anthropicChatStructured,
  anthropicWebChat,
  meterAnthropicUsage,
} from '../../lib/anthropic';
import type { PageFetchResult } from '../../lib/anthropic';
import { ScraperService } from '../../services/scraper';
import { modelRoute } from '../../lib/model_route';
// Side-effect import: it is what registers the adapters, and on this route it is
// also what CHOOSES the transcription one — so the surface below proves the
// switch, not just the call.
import '../../services';
import { services } from '../../adapters/registry';
import { openAiChat, openAiChatStructured } from '../../lib/openai';
import { embedTexts } from '../../services/embedding';
import { generateImage } from '../../lib/file_generation';

/** The voice note the fake Slack channel serves — a few seconds of real speech
 *  in the container a voice note actually arrives in. */
const BUNDLED_AUDIO = path.resolve(
  __dirname,
  '../../../../fake-channels/assets/voice-sample.ogg',
);

type Outcome = { surface: string; detail: string };

const results: Array<{ ok: boolean } & Outcome> = [];

/** Run one surface. A surface that throws is a finding, not the end of the run:
 *  "this model is not switched on in the project" is exactly what this script
 *  exists to discover, and it has to discover all of them in one pass. */
async function surface(name: string, run: () => Promise<string>): Promise<void> {
  const startedMs = Date.now();
  try {
    const detail = await run();
    results.push({ ok: true, surface: name, detail: `${detail} [${Date.now() - startedMs}ms]` });
    console.log(`PASS  ${name} — ${detail} [${Date.now() - startedMs}ms]`);
  } catch (error) {
    const detail = describeError(error);
    results.push({ ok: false, surface: name, detail });
    console.log(`FAIL  ${name} — ${detail}`);
  }
}

/** The status and the message, trimmed — a Google refusal carries both, and the
 *  status is the half that says whether it is a model that is off or a call
 *  that is wrong. Never the request body: prompts and credentials live there. */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const status = (error as { status?: unknown }).status;
  const head = typeof status === 'number' ? `${status}: ` : '';
  return `${head}${error.message.replace(/\s+/g, ' ').slice(0, 400)}`;
}

function preview(text: string, chars = 90): string {
  return JSON.stringify(text.replace(/\s+/g, ' ').slice(0, chars));
}

async function fetchPage(url: string): Promise<PageFetchResult> {
  try {
    const text = await ScraperService.getWebsite(url, { provider: 'brightdata' });
    return text.trim() ? { text } : { error: 'the page had no readable text' };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function main() {
  const route = modelRoute();
  if (route !== 'google') {
    console.error(
      `This proof only means anything on the google route — MODEL_ROUTE is "${process.env.MODEL_ROUTE ?? 'unset'}". ` +
        'Run it with MODEL_ROUTE=google and no vendor keys in the environment.',
    );
    process.exit(1);
  }

  for (const name of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENAI_API_KEY_FALLBACK_OR_DEV']) {
    if (process.env[name]) {
      console.error(
        `${name} is set. The whole point of this run is that no vendor key is reachable — ` +
          `start it with \`env -u ${name} …\`.`,
      );
      process.exit(1);
    }
  }

  const audioPath = process.argv[2] ?? (fs.existsSync(BUNDLED_AUDIO) ? BUNDLED_AUDIO : undefined);

  console.log(`route: google · project: ${process.env.GOOGLE_PROJECT_ID ?? '(unset)'} · region: ${process.env.GOOGLE_MODEL_REGION ?? 'global'}\n`);

  // (a) Claude, plain.
  await surface('claude chat', async () => {
    const text = await anthropicChat({
      system: 'Answer in one short sentence.',
      userMessage: 'Name the largest moon of Saturn.',
      model: 'claude-sonnet-5',
      effort: 'low',
      maxTokens: 256,
      label: 'verify_google_model_route:chat',
    });
    if (!text.trim()) throw new Error('the model returned no text');
    return preview(text);
  });

  // (b) Prompt caching. The same long system prompt twice: the second turn must
  //     read from cache, which is the only observable proof the breakpoint
  //     survived the trip through Google.
  await surface('claude prompt caching', async () => {
    // Comfortably over the 1024-token minimum a cache breakpoint needs.
    const system = `You are a careful assistant.\n${'Cacheable context line that exists only to pass the cache minimum. '.repeat(400)}`;
    const ask = (userMessage: string) =>
      anthropicChat({
        system,
        userMessage,
        model: 'claude-sonnet-5',
        effort: 'low',
        maxTokens: 64,
        label: 'verify_google_model_route:cache',
      });

    const first = await meterAnthropicUsage(() => ask('Reply with the single word: one.'));
    const second = await meterAnthropicUsage(() => ask('Reply with the single word: two.'));
    const detail =
      `write ${first.usage.cacheCreationTokens}/read ${first.usage.cacheReadTokens} then ` +
      `write ${second.usage.cacheCreationTokens}/read ${second.usage.cacheReadTokens}`;
    if (second.usage.cacheReadTokens === 0) {
      throw new Error(`the second turn read nothing from cache — ${detail}`);
    }
    return detail;
  });

  // (c) Extended thinking at the deepest setting this repo ever asks for.
  await surface('claude thinking (xhigh)', async () => {
    const { value, usage } = await meterAnthropicUsage(() =>
      anthropicChat({
        system: 'Think it through, then give only the final number.',
        userMessage:
          'A barrel holds 31 litres. You pour out two fifths, then add back 4 litres. How many litres are in it?',
        model: 'claude-sonnet-5',
        effort: 'xhigh',
        maxTokens: 4096,
        label: 'verify_google_model_route:thinking',
      }),
    );
    if (!value.trim()) throw new Error('the model spent its ceiling thinking and returned no text');
    return `${preview(value, 60)} · out ${usage.outputTokens} tokens`;
  });

  // (d) Forced tool use — how every structured extraction in this repo is made.
  await surface('claude structured output', async () => {
    const parsed = await anthropicChatStructured({
      system: 'Extract the facts the user states, and nothing else.',
      userMessage: 'Ada Lovelace was born in London in 1815.',
      schema: z.object({
        name: z.string(),
        city: z.string(),
        year: z.number(),
      }),
      toolName: 'record_person',
      toolDescription: 'Record the person the message describes.',
      model: 'claude-sonnet-5',
      maxTokens: 1024,
      label: 'verify_google_model_route:structured',
    });
    if (parsed.year !== 1815) throw new Error(`expected 1815, got ${JSON.stringify(parsed)}`);
    return JSON.stringify(parsed);
  });

  // (e) The research step's default engine on this route: Google serves only the
  //     basic hosted search and no hosted fetch, so the page must come back
  //     through our own reader inside the same conversation.
  await surface('claude web chat (hosted search + own page reader)', async () => {
    if (!process.env.BRIGHT_DATA_ACCESS_TOKEN) {
      throw new Error('BRIGHT_DATA_ACCESS_TOKEN is not set — the own page reader has no fetcher');
    }
    const reply = await anthropicWebChat({
      system:
        'Answer one factual question using web search and the page reader. Search for the site, ' +
        'then READ a page — do not answer from search snippets alone.',
      userMessage: 'What is the tagline on the homepage of Bright Data?',
      model: 'claude-sonnet-5',
      effort: 'low',
      maxSearches: 2,
      maxFetches: 2,
      // On this route there is no hosted fetcher, so the loop defaults to ours —
      // and ours needs its handler passed in, or the request is a wiring mistake
      // rather than a page that failed to load.
      fetchPage,
      label: 'verify_google_model_route:web',
    });
    const searches = reply.events.filter((e) => e.kind === 'search').length;
    const fetches = reply.events.filter((e) => e.kind === 'fetch').length;
    if (searches === 0) throw new Error('no search ran');
    return `reader ${reply.pageReader} · ${searches} searches, ${fetches} pages · ${preview(reply.text, 60)}`;
  });

  // (f) A model whose name carries a date. Google spells it with an `@`, and the
  //     naming table is the only thing standing between us and a 404.
  await surface('claude dated model name (haiku)', async () => {
    const text = await anthropicChat({
      system: 'Answer with one word.',
      userMessage: 'What colour is a ripe banana?',
      model: 'claude-haiku-4-5-20251001',
      maxTokens: 64,
      label: 'verify_google_model_route:dated',
    });
    if (!text.trim()) throw new Error('the model returned no text');
    return `claude-haiku-4-5-20251001 → ${preview(text, 40)}`;
  });

  await geminiSurfaces();
  await embeddingSurface();
  await transcriptionSurface(audioPath);
  await imageSurface();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n── ${results.length - failed.length}/${results.length} surfaces passed ──`);
  for (const r of failed) console.log(`  FAILED ${r.surface}: ${r.detail}`);
}

/** (g) and (h): the OpenAI-shaped surface, answered by Gemini. Both go through
 *  the real wrapper, so what is proved is that the naming table, the parameter
 *  stripping and the token refresh all hold on a live call. */
async function geminiSurfaces(): Promise<void> {
  await surface('gemini chat (openAiChat)', async () => {
    const text = await openAiChat(
      [{ role: 'user', content: 'Name the largest moon of Jupiter. One word.' }],
      { model: 'gpt-4.1' },
      'verify_google_model_route:gemini-chat',
    );
    if (!text.trim()) throw new Error('the model returned no text');
    return `gpt-4.1 → ${preview(text, 40)}`;
  });

  await surface('gemini structured output (.parse)', async () => {
    const output = await openAiChatStructured(
      [
        { role: 'system', content: 'Extract the facts the user states, as JSON.' },
        { role: 'user', content: 'Grace Hopper was born in New York in 1906.' },
      ],
      {
        model: 'o3',
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'person',
            schema: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                city: { type: 'string' },
                year: { type: 'number' },
              },
              required: ['name', 'city', 'year'],
              additionalProperties: false,
            },
          },
        },
      },
      'verify_google_model_route:gemini-structured',
    );
    const text = typeof output === 'string' ? output : JSON.stringify(output);
    if (!text.includes('1906')) throw new Error(`expected 1906 in ${preview(text, 120)}`);
    return `o3 → ${preview(text, 80)}`;
  });
}

/** (i): one embedding per destination column, because the width is the
 *  column's and a vector of the wrong length is a write that fails later. */
async function embeddingSurface(): Promise<void> {
  for (const destination of ['raw_text', 'extraction_fact'] as const) {
    await surface(`embedding → ${destination}`, async () => {
      const [vector] = await embedTexts({
        texts: ['A short sentence to embed.'],
        destination,
        label: 'verify_google_model_route:embedding',
      });
      if (!vector?.length) throw new Error('no vector came back');
      const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
      return `${vector.length} dimensions, |v| = ${magnitude.toFixed(4)}`;
    });
  }
}

/** (j): a real voice note through the adapter the route chose. */
async function transcriptionSurface(audioPath: string | undefined): Promise<void> {
  if (!audioPath) {
    console.log('SKIP  transcription — no audio file given and none bundled. Pass a path as argv[1].');
    return;
  }
  await surface(`transcription (${path.basename(audioPath)})`, async () => {
    const audio = fs.readFileSync(audioPath);
    const result = await services.transcription.transcribe(audio, {
      name: path.basename(audioPath),
    });
    if (!result) throw new Error('the adapter returned no transcript');
    return `${services.transcription.constructor.name} · ${audio.length} bytes → ${preview(result.text, 80)}`;
  });
}

/** (k): image generation, which was already Gemini-first — what this proves is
 *  that the DALL-E fallback behind it is unreachable on this route. */
async function imageSurface(): Promise<void> {
  await surface('image generation', async () => {
    const file = await generateImage({
      prompt: 'A single red maple leaf on a plain white background, flat illustration.',
      title: 'verify google model route',
    });
    return `${file.filename} (${file.mimeType})`;
  });
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

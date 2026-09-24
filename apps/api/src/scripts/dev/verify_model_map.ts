/**
 * Does a model call reach the provider MODEL_MAP names, and come back as
 * something the wrapper can use? One call per leg, through the same wrapper
 * functions the product calls, and a pass table at the end.
 *
 * Legs are a named list: a capability that moves behind the map adds its leg
 * (and, if it needs one, a model on {@link Target}) rather than a new script.
 *
 * Empty map, against Anthropic itself (needs ANTHROPIC_API_KEY):
 *
 *   cd apps/api && pnpm dev:verify-model-map
 *
 * Everything on the fake OpenAI. The fake lives in `apps/fake-channels` at
 * `/openai/v1`; the agent dev loop (`pnpm dev:loop:agent`) serves it on port
 * 6056 (`dev/loop.sh`: HARNESS_BASE 6055 + 1, recorded as FAKE_CHANNELS_URL in
 * `.dev-loop/profiles/agent.json`). `--fake-openai` points OPENAI_BASE_URL at
 * the running profile's fake, and supplies a placeholder OPENAI_API_KEY when
 * none is set (the fake takes any bearer), so with the loop up this is the
 * whole command:
 *
 *   cd apps/api && MODEL_MAP='{"claude-sonnet-5":"openai/gpt-5"}' \
 *     pnpm dev:verify-model-map --fake-openai
 *
 * Without the loop, start the fake alone and name it:
 *
 *   FAKE_CHANNELS_PORT=6056 pnpm --filter fake-channels start
 *   cd apps/api && MODEL_MAP='{"claude-sonnet-5":"openai/gpt-5"}' OPENAI_API_KEY=fake \
 *     OPENAI_BASE_URL=http://localhost:6056/openai/v1 pnpm dev:verify-model-map
 *
 * Like every dev CLI it reads `apps/api/.env`. A checkout without one (a fresh
 * worktree) also needs NODE_ENV=development and placeholder DATABASE_URL and
 * DATABASE_URL_READONLY: the wrapper's imports demand them, though with no
 * team in context the usage ledger never writes.
 *
 * `--model <registry name>` picks the chat model (default claude-sonnet-5);
 * the map line has to name that model for the call to leave Anthropic.
 */
import './_profile_loader';

import { z } from 'zod';

import { anthropicChat, anthropicChatStructured, anthropicToolLoop } from '../../lib/anthropic';
import { assertModelMapConfigured, resolveModel } from '../../lib/models/map';
import { parseChatModelName } from '../../lib/models/registry';
import type { ChatModelName } from '../../lib/models/registry';

/** The model each capability's legs call. */
interface Target {
  chat: ChatModelName;
}

interface Leg {
  name: string;
  /** Which of the target's models this leg calls, for the route column. */
  model: (target: Target) => ChatModelName;
  /** Resolves with a one-line detail on a pass; throws on a fail. */
  run: (target: Target) => Promise<string>;
}

const LABEL = 'verify_model_map';

const legs: Leg[] = [
  {
    name: 'chat',
    model: (t) => t.chat,
    run: async ({ chat }) => {
      const text = await anthropicChat({
        system: 'You are a terse assistant.',
        userMessage: 'Reply with one short friendly sentence.',
        model: chat,
        maxTokens: 512,
        label: LABEL,
      });
      if (!text.trim()) throw new Error('empty reply');
      return JSON.stringify(text.slice(0, 60));
    },
  },
  {
    name: 'chat, structured',
    model: (t) => t.chat,
    run: async ({ chat }) => {
      const city = await anthropicChatStructured({
        system: 'You answer with the tool, never in prose.',
        userMessage: 'Name one European capital and its population in millions.',
        schema: z.object({ city: z.string(), populationMillions: z.number() }),
        toolName: 'record_city',
        toolDescription: 'Record a city and its population in millions.',
        model: chat,
        maxTokens: 512,
        label: LABEL,
      });
      return JSON.stringify(city);
    },
  },
  {
    name: 'chat, tool loop',
    model: (t) => t.chat,
    run: async ({ chat }) => {
      const asked: string[] = [];
      const blocks = await anthropicToolLoop(
        {
          model: chat,
          max_output_tokens: 1024,
          maxTurns: 3,
          system: 'Use the weather tool to answer, then reply in one sentence.',
          userMessage: 'What is the weather in Paris?',
          tools: [
            {
              type: 'function',
              name: 'lookup_weather',
              description: 'Current weather for a city.',
              parameters: {
                type: 'object',
                properties: { city: { type: 'string' } },
                required: ['city'],
              },
            },
          ],
          label: LABEL,
        },
        {
          lookup_weather: async (args: unknown) => {
            asked.push(z.object({ city: z.string() }).parse(args).city);
            return { tempC: 21, sky: 'clear' };
          },
        },
      );
      if (asked.length === 0) throw new Error('the model never called the tool');
      const text = blocks
        .map((b) => b.text ?? '')
        .join('')
        .trim();
      if (!text) throw new Error('no text after the tool result');
      return `tool called for ${asked.join(', ')}; then ${JSON.stringify(text.slice(0, 40))}`;
    },
  },
];

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  return value === undefined || value.startsWith('--') ? undefined : value;
}

interface Row {
  leg: string;
  route: string;
  outcome: 'PASS' | 'FAIL';
  ms: number;
  detail: string;
}

function printTable(rows: Row[]): void {
  const headers = ['leg', 'route', 'outcome', 'ms', 'detail'] as const;
  const cells = rows.map((r) => [r.leg, r.route, r.outcome, String(r.ms), r.detail]);
  const widths = headers.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
  const line = (values: readonly string[]) => values.map((v, i) => v.padEnd(widths[i])).join('  ');
  console.log(line(headers));
  console.log(line(widths.map((w) => '-'.repeat(w))));
  for (const c of cells) console.log(line(c));
}

async function main(): Promise<void> {
  if (process.argv.includes('--fake-openai') && !process.env.OPENAI_BASE_URL) {
    const fake = process.env.FAKE_CHANNELS_URL;
    if (!fake) {
      throw new Error('--fake-openai needs a running dev loop (no FAKE_CHANNELS_URL); set OPENAI_BASE_URL instead.');
    }
    process.env.OPENAI_BASE_URL = `${fake}/openai/v1`;
    process.env.OPENAI_API_KEY ??= 'fake';
  }

  const target: Target = { chat: parseChatModelName(flag('model') ?? 'claude-sonnet-5', '--model') };

  // The same refusals the server makes at boot, so a bad map fails here with
  // the server's own words rather than as a confusing first-leg error.
  assertModelMapConfigured();
  console.log(`MODEL_MAP        ${process.env.MODEL_MAP || '(empty)'}`);
  console.log(`OPENAI_BASE_URL  ${process.env.OPENAI_BASE_URL || '(OpenAI itself)'}\n`);

  const rows: Row[] = [];
  for (const leg of legs) {
    const { provider, wireModel } = resolveModel(leg.model(target));
    const started = Date.now();
    try {
      const detail = await leg.run(target);
      rows.push({ leg: leg.name, route: `${provider}/${wireModel}`, outcome: 'PASS', ms: Date.now() - started, detail });
    } catch (error) {
      rows.push({
        leg: leg.name,
        route: `${provider}/${wireModel}`,
        outcome: 'FAIL',
        ms: Date.now() - started,
        detail: (error instanceof Error ? error.message : String(error)).split('\n')[0].slice(0, 160),
      });
    }
  }

  printTable(rows);
  // Exit explicitly: the wrapper's queue and the usage ledger's pool would
  // otherwise hold the process open after the last leg.
  process.exit(rows.every((r) => r.outcome === 'PASS') ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

// Which Claude client a call gets, and what the model is called once it is
// addressed to Google.
//
// Deliberately its own file rather than part of the wrapper next door: the
// knowledge unit builds its own Claude calls and must not inherit automations'
// wallet, cost meter or cancel gate to do it (D12). Everything here imports the
// environment, the vendor SDKs and nothing else.

import Anthropic from '@anthropic-ai/sdk';
import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';

import { googleAuth, googleServiceAccount } from '../google_cloud';
import { anthropicRoute } from '../model_route';
import { getEnvVar } from '../utils/environment';
import { neverAsAny } from '../utils/types';

/**
 * What the two platform clients have in common, as this codebase uses them.
 *
 * `AnthropicVertex` is a `BaseAnthropic` whose messages resource is the ordinary
 * one minus the Batch API, so the honest shared type is the messages surface
 * both actually serve. Naming it structurally rather than reaching for the base
 * class keeps a caller from wandering onto an endpoint one of them lacks.
 */
export type PlatformAnthropic = { messages: Pick<Anthropic['messages'], 'create' | 'stream'> };

/**
 * A client and the naming that belongs to it, handed out together.
 *
 * The two cannot be chosen separately without a way for them to disagree: a
 * team's own key goes to Anthropic directly even where this deployment routes
 * everything else through Google, and Google's spelling of a model is a 404 at
 * Anthropic's own door. Whatever picks the client therefore also answers what
 * the model is called on its wire.
 */
export interface AnthropicCall {
  client: PlatformAnthropic;
  /** What `model` is called on THIS client's wire. */
  wireModel(model: string): string;
}

/**
 * Google's own spelling for every Claude model this repo names. The current
 * generation carries its name over unchanged; anything whose name carries a
 * date moves that date behind an `@`.
 *
 * Verified 2026-09-17 against
 * https://platform.claude.com/docs/en/build-with-claude/claude-on-vertex-ai
 */
const GOOGLE_MODEL_NAMES: Record<string, string> = {
  'claude-fable-5-1': 'claude-fable-5-1',
  'claude-fable-5': 'claude-fable-5',
  'claude-opus-5': 'claude-opus-5',
  'claude-opus-4-8': 'claude-opus-4-8',
  'claude-opus-4-7': 'claude-opus-4-7',
  'claude-opus-4-6': 'claude-opus-4-6',
  'claude-sonnet-5': 'claude-sonnet-5',
  'claude-sonnet-4-6': 'claude-sonnet-4-6',
  'claude-sonnet-4-5': 'claude-sonnet-4-5@20250929',
  'claude-sonnet-4-5-20250929': 'claude-sonnet-4-5@20250929',
  'claude-sonnet-4-20250514': 'claude-sonnet-4@20250514',
  'claude-3-7-sonnet-20250219': 'claude-3-7-sonnet@20250219',
  'claude-opus-4-5-20251101': 'claude-opus-4-5@20251101',
  'claude-opus-4-1-20250805': 'claude-opus-4-1@20250805',
  'claude-opus-4-20250514': 'claude-opus-4@20250514',
  'claude-haiku-4-5': 'claude-haiku-4-5@20251001',
  'claude-haiku-4-5-20251001': 'claude-haiku-4-5@20251001',
  'claude-3-5-haiku-20241022': 'claude-3-5-haiku@20241022',
};

/** Anthropic's own door knows its own names. */
function anthropicWireModel(model: string): string {
  return model;
}

/**
 * The name to put on the wire, applied where the request is built and nowhere
 * else: usage records, prices and recording hashes all keep the caller's own
 * name, so a route switch never moves a price or invalidates a fixture.
 *
 * A model with no known Google spelling raises here rather than travelling to
 * Google and coming back a 404 — a wrong model id and an unavailable one are
 * indistinguishable once the request has left.
 */
function googleWireModel(model: string): string {
  const googleName = GOOGLE_MODEL_NAMES[model];
  if (!googleName) {
    throw new Error(
      `Claude model "${model}" has no known name on Google Cloud, and this deployment's ` +
        'Anthropic route is google. Send a model Google serves, or set ' +
        'ANTHROPIC_MODEL_ROUTE=direct.',
    );
  }
  return googleName;
}

// Read at first USE, not at module load. `getEnvVar` throws in production when
// the key is unset, so an eager read made merely IMPORTING this module enough
// to stop the process booting — including for a deployment that runs entirely
// on per-team keys (BYOT) or uses no LLM at all. Memoized per route: still one
// read and one client, just on first call rather than on import.
let directClient: Anthropic | undefined;
let googleClient: AnthropicVertex | undefined;

/** Claude's endpoint on Google. The global one is Anthropic's recommendation
 *  and the only one without a regional price premium — deliberately NOT
 *  `GOOGLE_PROJECT_LOCATION`, which is a real region that OCR and image
 *  generation need. */
function googleModelRegion(env: NodeJS.ProcessEnv): string {
  return env.GOOGLE_MODEL_REGION || 'global';
}

/** The client for a call that has no team key of its own, with its naming. */
export function platformAnthropic(env: NodeJS.ProcessEnv = process.env): AnthropicCall {
  const route = anthropicRoute(env);
  switch (route) {
    case 'direct':
      return {
        client: (directClient ??= new Anthropic({
          // `getEnvVar` reads `process.env` and carries the dev default and the
          // production error; an explicitly passed environment answers first, so
          // a caller that threads one (knowledge does) is not silently overruled.
          apiKey:
            env.ANTHROPIC_API_KEY ??
            getEnvVar('ANTHROPIC_API_KEY', {
              devDefault: 'test',
              because:
                'it is the platform key for any Anthropic call that does not carry a team key',
            }),
        })),
        wireModel: anthropicWireModel,
      };
    case 'google':
      return {
        client: (googleClient ??= new AnthropicVertex({
          projectId: googleServiceAccount(env).projectId,
          region: googleModelRegion(env),
          googleAuth: googleAuth(env),
        })),
        wireModel: googleWireModel,
      };
    default:
      return neverAsAny(route);
  }
}

/**
 * The Anthropic client for a call: the team's own key (BYOT — pricing-v2 §B.2)
 * when supplied, else the platform client for this route. A team key is per-team
 * data rather than deployment configuration, so it stays a direct Anthropic call
 * on either route — and takes Anthropic's own model names with it, which is why
 * the naming comes back attached rather than being asked of the route. A
 * per-call client is cheap and keeps the request server-side (no endpoint
 * override — prompts never leave our backend). The key is NEVER part of any
 * recording hash.
 */
export function clientFor(
  byotApiKey?: string,
  env: NodeJS.ProcessEnv = process.env,
): AnthropicCall {
  return byotApiKey
    ? { client: new Anthropic({ apiKey: byotApiKey }), wireModel: anthropicWireModel }
    : platformAnthropic(env);
}

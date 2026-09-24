// Where this deployment's model calls go, asked once per vendor.
//
// `direct` is a vendor's own API, authenticated by its own key, and it is what a
// deployment that sets nothing gets. `google` sends that vendor's calls through
// one Google Cloud project, authenticated by one service account — no key for
// that vendor exists there at all, which is why carrying one is a configuration
// error rather than a harmless leftover: a half-configured route would send some
// calls one way and some the other, and nothing would say so.
//
// The two vendors move separately because Google grants their quota separately:
// a deployment can be serving Gemini through Google's OpenAI-shaped endpoint
// while Claude is still on Anthropic's own key, waiting for Claude to be turned
// on in the Google project. `MODEL_ROUTE` remains the default for both, so a
// deployment that has only ever set that keeps meaning exactly what it meant.

import { isGoogleServiceAccountConfigured, missingGoogleServiceAccountVars } from './google_cloud';
import { neverAsAny } from './utils/types';

export type ModelRoute = 'direct' | 'google';

/** The two model vendors whose calls this deployment routes. */
export type ModelVendor = 'anthropic' | 'openai';

export type RouteVariable = 'MODEL_ROUTE' | 'ANTHROPIC_MODEL_ROUTE' | 'OPENAI_MODEL_ROUTE';

/** A vendor's route and the variable that decided it, carried together so a
 *  message can name the setting the operator actually made rather than the one
 *  it might have been. */
export interface RouteChoice {
  route: ModelRoute;
  decidedBy: RouteVariable;
}

function parseRoute(value: string | undefined, variable: RouteVariable): ModelRoute | undefined {
  switch (value) {
    case undefined:
    case '':
      return undefined;
    case 'direct':
      return 'direct';
    case 'google':
      return 'google';
    default:
      throw new Error(
        `The ${variable} environment variable must be "direct" or "google" — got "${value}".`,
      );
  }
}

function overrideVariable(vendor: ModelVendor): RouteVariable {
  switch (vendor) {
    case 'anthropic':
      return 'ANTHROPIC_MODEL_ROUTE';
    case 'openai':
      return 'OPENAI_MODEL_ROUTE';
    default:
      return neverAsAny(vendor);
  }
}

/** Read live rather than memoized: the route is deployment configuration, and
 *  a memo would make the first caller decide it for the whole process. */
export function routeChoice(
  vendor: ModelVendor,
  env: NodeJS.ProcessEnv = process.env,
): RouteChoice {
  // The shared default is parsed even when the override answers, so a garbage
  // value in it is refused rather than shadowed into silence by an override.
  const shared = parseRoute(env.MODEL_ROUTE, 'MODEL_ROUTE') ?? 'direct';
  const variable = overrideVariable(vendor);
  const override = parseRoute(env[variable], variable);
  return override === undefined
    ? { route: shared, decidedBy: 'MODEL_ROUTE' }
    : { route: override, decidedBy: variable };
}

/** Where Claude calls go. */
export function anthropicRoute(env: NodeJS.ProcessEnv = process.env): ModelRoute {
  return routeChoice('anthropic', env).route;
}

/** Where OpenAI-shaped calls go — chat, transcription, embeddings, images. */
export function openAiRoute(env: NodeJS.ProcessEnv = process.env): ModelRoute {
  return routeChoice('openai', env).route;
}

/**
 * Refuse a half-configured route at boot rather than at the first model call.
 * A key that cannot be used is not inert — it is the sign that the deployment
 * believes it is on the other route.
 */
export function assertModelRouteConfigured(env: NodeJS.ProcessEnv = process.env): void {
  assertAnthropicRouteConfigured(env);
  assertOpenAiRouteConfigured(env);
}

function assertGoogleServiceAccount(env: NodeJS.ProcessEnv, decidedBy: RouteVariable): void {
  if (isGoogleServiceAccountConfigured(env)) return;
  throw new Error(
    `${decidedBy} is google, but its Google service account is not configured — set ${missingGoogleServiceAccountVars(env).join(', ')}.`,
  );
}

function assertAnthropicRouteConfigured(env: NodeJS.ProcessEnv): void {
  const { route, decidedBy } = routeChoice('anthropic', env);
  switch (route) {
    case 'direct':
      return;
    case 'google': {
      for (const name of ['ANTHROPIC_API_KEY', 'KNOWLEDGE_LLM_API_KEY'] as const) {
        if (env[name]) {
          throw new Error(
            `${decidedBy} is google, so every Claude call goes through Google Cloud and no ` +
              `Anthropic key is used — but ${name} is set. Remove it, or set ${decidedBy}=direct.`,
          );
        }
      }
      assertGoogleServiceAccount(env, decidedBy);
      return;
    }
    default:
      return neverAsAny(route);
  }
}

function assertOpenAiRouteConfigured(env: NodeJS.ProcessEnv): void {
  const { route, decidedBy } = routeChoice('openai', env);
  switch (route) {
    case 'direct':
      return;
    case 'google': {
      for (const name of ['OPENAI_API_KEY', 'OPENAI_API_KEY_FALLBACK_OR_DEV'] as const) {
        if (env[name]) {
          throw new Error(
            `${decidedBy} is google, so every OpenAI-shaped call goes to Google's endpoint and ` +
              `no OpenAI key is used — but ${name} is set. Remove it, or set ${decidedBy}=direct.`,
          );
        }
      }
      // Google's OpenAI-shaped endpoint serves chat completions and nothing
      // else, so the knowledge agents' OpenAI dialect (the Responses API) has no
      // door to knock on there. Asked for POSITIVELY rather than checked for the
      // value `openai`, because three of the four agents (system, movement,
      // ontology) fall back to `openai` when the variable is UNSET — only the
      // unified agent defaults to anthropic. An unset variable is therefore the
      // broken configuration, not the safe one.
      if (env.KNOWLEDGE_AGENT_PROVIDER !== 'anthropic') {
        throw new Error(
          `${decidedBy} is google, but Google serves no Responses API — the knowledge agents ` +
            'must run on Claude. Set KNOWLEDGE_AGENT_PROVIDER=anthropic, or set ' +
            `${decidedBy}=direct. (Unset is not enough: the system, movement and ontology ` +
            'agents default to openai.)',
        );
      }
      assertGoogleServiceAccount(env, decidedBy);
      return;
    }
    default:
      return neverAsAny(route);
  }
}

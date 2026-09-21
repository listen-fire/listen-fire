// Where this deployment's model calls go.
//
// `direct` is the vendors' own APIs, authenticated by their own keys, and it is
// what a deployment that sets nothing gets. `google` sends every model call
// through one Google Cloud project, authenticated by one service account — no
// vendor key exists there at all, which is why carrying one is a configuration
// error rather than a harmless leftover: a half-configured route would send
// some calls one way and some the other, and nothing would say so.

import { isGoogleServiceAccountConfigured, missingGoogleServiceAccountVars } from './google_cloud';
import { neverAsAny } from './utils/types';

export type ModelRoute = 'direct' | 'google';

/** Read live rather than memoized: the route is deployment configuration, and
 *  a memo would make the first caller decide it for the whole process. */
export function modelRoute(env: NodeJS.ProcessEnv = process.env): ModelRoute {
  const value = env.MODEL_ROUTE;
  switch (value) {
    case undefined:
    case '':
    case 'direct':
      return 'direct';
    case 'google':
      return 'google';
    default:
      throw new Error(
        `The MODEL_ROUTE environment variable must be "direct" or "google" — got "${value}".`,
      );
  }
}

/**
 * Refuse a half-configured route at boot rather than at the first model call.
 * A key that cannot be used is not inert — it is the sign that the deployment
 * believes it is on the other route.
 */
export function assertModelRouteConfigured(env: NodeJS.ProcessEnv = process.env): void {
  const route = modelRoute(env);
  switch (route) {
    case 'direct':
      return;
    case 'google': {
      if (env.ANTHROPIC_API_KEY) {
        throw new Error(
          'MODEL_ROUTE is google, so every Claude call goes through Google Cloud and no Anthropic ' +
            'key is used — but ANTHROPIC_API_KEY is set. Remove it, or set MODEL_ROUTE=direct.',
        );
      }
      if (env.KNOWLEDGE_LLM_API_KEY) {
        throw new Error(
          'MODEL_ROUTE is google, so knowledge calls its model through Google Cloud too and no ' +
            'key is used — but KNOWLEDGE_LLM_API_KEY is set. Remove it, or set MODEL_ROUTE=direct.',
        );
      }
      for (const name of ['OPENAI_API_KEY', 'OPENAI_API_KEY_FALLBACK_OR_DEV'] as const) {
        if (env[name]) {
          throw new Error(
            `MODEL_ROUTE is google, so every OpenAI-shaped call goes to Google's endpoint and no ` +
              `OpenAI key is used — but ${name} is set. Remove it, or set MODEL_ROUTE=direct.`,
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
          'MODEL_ROUTE is google, but Google serves no Responses API — the knowledge agents must ' +
            'run on Claude. Set KNOWLEDGE_AGENT_PROVIDER=anthropic, or set MODEL_ROUTE=direct. ' +
            '(Unset is not enough: the system, movement and ontology agents default to openai.)',
        );
      }
      const missing = missingGoogleServiceAccountVars(env);
      if (!isGoogleServiceAccountConfigured(env)) {
        throw new Error(
          `MODEL_ROUTE is google, but its Google service account is not configured — set ${missing.join(', ')}.`,
        );
      }
      return;
    }
    default:
      return neverAsAny(route);
  }
}

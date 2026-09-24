// Which OpenAI-shaped client a call gets when the model map sends it to OpenAI
// or to Gemini.
//
// Deliberately its own file rather than part of the wrapper next door:
// everything here imports the environment, the vendor SDK and nothing else, so
// the client choice can be asserted without dragging the queue and the
// recording context in with them.
//
// The Gemini branch here is Google's OpenAI-shaped endpoint, kept until the
// native Gemini provider replaces it; which branch a call takes is the model
// map's answer for the caller's registry name.

import OpenAI from 'openai';

import { isProd } from '../../constants';
import { googleBearerTokens, googleModelRegion, googleServiceAccount } from '../google_cloud';
import { resolveModel } from '../models/map';
import type { ModelName } from '../models/registry';
import { getEnvVar } from '../utils/environment';
import { neverAsAny } from '../utils/types';

/**
 * A client and the name to put on its wire, handed out together: the map
 * decides both, and `dall-e-3` is a 404 at Google's door just as
 * `google/gemini-3.8-flash` is at OpenAI's.
 */
export interface OpenAiCall {
  client: OpenAI;
  /** What the model is called on THIS client's wire. */
  wireModel: string;
  /** Who served the call, for the usage ledger. */
  provider: 'openai' | 'google';
}

/**
 * Google's OpenAI-shaped endpoint. The `openapi` endpoint id is what Google
 * calls the Gemini-serving one; a real endpoint id there would address a
 * self-deployed Model Garden container instead.
 * https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/migrate/openai/auth-and-credentials
 */
function googleOpenAiBaseUrl(env: NodeJS.ProcessEnv): string {
  const { projectId } = googleServiceAccount(env);
  const region = googleModelRegion(env);
  // The global endpoint drops the region from the HOST but keeps it in the path.
  const host =
    region === 'global' ? 'aiplatform.googleapis.com' : `${region}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${projectId}/locations/${region}/endpoints/openapi`;
}

// Read at first USE, not at module load, and memoized per door: `getEnvVar`
// throws in production on an unset key, so an eager read made merely IMPORTING
// this module enough to stop a deployment booting that never makes an
// OpenAI-shaped call.
let directClient: OpenAI | undefined;
let googleClient: OpenAI | undefined;

/** The organisation the key belongs to, when this deployment has declared one.
 *  Optional: a self-hoster's key belongs to whatever organisation OpenAI has on
 *  file for it, and the SDK sends the key's own default organisation when none
 *  is named here — so an unset value is correct, not a hole to fall back from.
 *  Google has no such concept, and sending one there would be an OpenAI
 *  account id travelling to a vendor that has never heard of it. */
function directOrganization(env: NodeJS.ProcessEnv): string | undefined {
  return env.OPENAI_ORGANIZATION || undefined;
}

/** OpenAI's own API, for every name the map sends to openai or leaves at home. */
export function directOpenAI(env: NodeJS.ProcessEnv = process.env): OpenAI {
  const organization = directOrganization(env);
  return (directClient ??= new OpenAI({
    apiKey: isProd
      ? getEnvVar('OPENAI_API_KEY', { devDefault: 'test', because: 'OpenAI calls need a key' })
      : getEnvVar('OPENAI_API_KEY_FALLBACK_OR_DEV', { devDefault: 'test' }),
    ...(organization ? { organization } : {}),
  }));
}

/** The client for an OpenAI-shaped call to `model`, wherever the map sends it. */
export function platformOpenAI(model: ModelName, env: NodeJS.ProcessEnv = process.env): OpenAiCall {
  const { provider, wireModel } = resolveModel(model, env);
  switch (provider) {
    case 'openai':
      return { client: directOpenAI(env), wireModel, provider: 'openai' };
    case 'gemini':
      return {
        client: (googleClient ??= new OpenAI({
          baseURL: googleOpenAiBaseUrl(env),
          // There is no key here. A Google access token goes where the key
          // would, and it expires inside the hour — so this is a FUNCTION,
          // which the SDK calls before every request. The token source holds
          // one `GoogleAuth`, whose own cache means asking per request costs a
          // property read until the token is actually near expiry.
          apiKey: googleBearerTokens(env),
        })),
        // The `google/` prefix is Google's, not ours —
        // https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/start/openai
        wireModel: `google/${wireModel}`,
        provider: 'google',
      };
    case 'anthropic':
    case 'vertex':
      throw new Error(
        `MODEL_MAP sends "${model}" to ${provider}, but this call speaks the OpenAI dialect, ` +
          'which only openai and gemini serve. Map it to one of those.',
      );
    default:
      return neverAsAny(provider);
  }
}

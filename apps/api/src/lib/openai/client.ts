// Which OpenAI-shaped client a call gets, and what Google will actually listen
// to when the model map sends an OpenAI-shaped call to Gemini.
//
// Deliberately its own file rather than part of the wrapper next door:
// everything here imports the environment, the vendor SDK and nothing else, so
// the supported-parameter list can be asserted without dragging the queue, the
// meter and the recording context in with them.
//
// The Gemini branch here is Google's OpenAI-shaped endpoint, kept until the
// native Gemini provider replaces it; which branch a call takes is the model
// map's answer for the caller's registry name.

import OpenAI from 'openai';
import { z } from 'zod';

import { isProd } from '../../constants';
import { googleBearerTokens, googleModelRegion, googleServiceAccount } from '../google_cloud';
import { resolveModel } from '../models/map';
import type { ModelName } from '../models/registry';
import { getEnvVar } from '../utils/environment';
import { neverAsAny } from '../utils/types';

/**
 * A client and the name to put on its wire, handed out together: the map
 * decides both, and `gpt-4.1` is a 404 at Google's door just as
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
 * The request parameters Google's OpenAI-shaped endpoint DOCUMENTS as supported
 * for Google models. Everything else it silently ignores rather than rejecting —
 * "If you pass any unsupported parameter, it is ignored" — which is why this list
 * exists at all: a request that quietly loses half its options looks exactly like
 * one that worked. The test beside this file is what checks our requests against
 * it; nothing at runtime reads it, because a parameter we send is a decision made
 * when the code was written, not when it runs.
 *
 * Verified 2026-09-17 against the "Supported parameters" table at
 * https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/migrate/openai/overview
 */
export const GOOGLE_SUPPORTED_CHAT_PARAMS: ReadonlySet<string> = new Set([
  'messages',
  'model',
  'detail',
  'max_completion_tokens',
  'modalities',
  'max_tokens',
  'n',
  'frequency_penalty',
  'presence_penalty',
  'reasoning_effort',
  'response_format',
  'seed',
  'stop',
  'stream',
  'temperature',
  'top_p',
  'tools',
  'tool_choice',
  'web_search_options',
  'function_call',
  'functions',
  // The escape hatches for Gemini-only options. Documented on the same page.
  'extra_body',
  'extra_content',
]);

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

/** OpenAI's own API, for the calls that have no other door (the Responses
 *  API) as well as for every name the map leaves at home. */
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

/**
 * Refuse a JSON schema Google cannot honour: "Fully recursive schemas are not
 * supported" on its `json_schema` response format, and an unsupported schema is
 * ignored rather than rejected — so the alternative to raising here is a reply
 * shaped by nothing at all.
 *
 * Detection is a cycle walk over the `$defs` graph the schema generator emits. A
 * plain `$ref` is not enough on its own: zod names a merely REUSED subschema the
 * same way, and refusing those would refuse schemas Google is happy with.
 */
export function assertSchemaIsNotRecursive(schema: unknown, name: string): void {
  const withDefs = z.object({ $defs: z.record(z.string(), z.unknown()) }).safeParse(schema);
  if (!withDefs.success) return;

  /** Every `#/$defs/X` this subtree points at, at any depth. */
  const refsWithin = (node: unknown, found: Set<string>): Set<string> => {
    if (Array.isArray(node)) {
      for (const item of node) refsWithin(item, found);
      return found;
    }
    if (typeof node !== 'object' || node === null) return found;
    for (const [key, value] of Object.entries(node)) {
      const target = key === '$ref' && typeof value === 'string' ? /^#\/\$defs\/(.+)$/.exec(value) : null;
      if (target) found.add(target[1]);
      else refsWithin(value, found);
    }
    return found;
  };

  const edges = new Map<string, Set<string>>();
  for (const [defName, defSchema] of Object.entries(withDefs.data.$defs)) {
    edges.set(defName, refsWithin(defSchema, new Set()));
  }

  const visiting = new Set<string>();
  const settled = new Set<string>();
  const reachesItself = (from: string): boolean => {
    if (visiting.has(from)) return true;
    if (settled.has(from)) return false;
    visiting.add(from);
    for (const next of edges.get(from) ?? []) {
      if (reachesItself(next)) return true;
    }
    visiting.delete(from);
    settled.add(from);
    return false;
  };

  // Only the definitions can take part in a cycle — the root is not a `$defs`
  // entry, so nothing can point back at it — but the cycle is only REACHED if
  // something the request actually sends points into it.
  for (const root of edges.keys()) {
    if (reachesItself(root)) {
      throw new Error(
        `The JSON schema for "${name}" is recursive, and MODEL_MAP sends this call to gemini — ` +
          "Google's OpenAI-shaped endpoint does not support fully recursive schemas and would " +
          'ignore it rather than refuse it. Flatten the schema, or map the model to openai.',
      );
    }
  }
}

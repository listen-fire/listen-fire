// Which OpenAI-shaped client a call gets, what the model is called once it is
// addressed to Google, and what Google will actually listen to.
//
// Deliberately its own file rather than part of the wrapper next door, mirroring
// `lib/anthropic/client.ts`: everything here imports the environment, the vendor
// SDK and nothing else, so the naming table and the supported-parameter list can
// be asserted without dragging the queue, the meter and the recording context in
// with them.

import OpenAI from 'openai';
import { z } from 'zod';

import { isProd } from '../../constants';
import { googleBearerTokens, googleModelRegion, googleServiceAccount } from '../google_cloud';
import { modelRoute } from '../model_route';
import { getEnvVar } from '../utils/environment';
import { neverAsAny } from '../utils/types';

/**
 * A client and the naming that belongs to it, handed out together.
 *
 * The two cannot be chosen separately without a way for them to disagree:
 * `gpt-4.1` is a 404 at Google's door and `google/gemini-3.8-flash` is a 404 at
 * OpenAI's. Whatever picks the client therefore also answers what the model is
 * called on its wire — and who to bill it to, because on Google the model really
 * is a different model at a different price.
 */
export interface OpenAiCall {
  client: OpenAI;
  /** What `model` is called on THIS client's wire. */
  wireModel(model: string): string;
  /** Who served the call, for the usage ledger. */
  provider: 'openai' | 'google';
}

/**
 * Google's OpenAI-shaped endpoint serves Gemini and only Gemini, so every
 * OpenAI model this repo names has to become a Gemini one. Two tiers, because
 * that is all the distinction our callers actually draw: the models we reach for
 * when the answer needs reasoning, and the ones we reach for when it needs to be
 * quick and cheap.
 *
 * Verified 2026-09-17 against
 * https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-1-pro
 * and .../models/gemini/3-8-flash.
 *
 * `gemini-3.1-pro-preview` is Google's flagship reasoning model and is PUBLIC
 * PREVIEW — there is no generally available Pro in the 3.x line at all, so
 * "prefer GA" has nothing to prefer. It is also served on the global endpoint
 * ONLY, which is the default here but not the only thing `GOOGLE_MODEL_REGION`
 * can say. `gemini-3.8-flash` is GA (2026-09-02) on global, us and eu.
 */
const GEMINI_REASONING = 'gemini-3.1-pro-preview';
const GEMINI_FAST = 'gemini-3.8-flash';

/**
 * Every OpenAI chat model name this repo sends, and the Gemini model that
 * answers for it. Grepped from the call sites rather than from the SDK's model
 * union: the ones with no caller are here because they are one edit away from
 * having one, and an unmapped name is a thrown error rather than a guess.
 *
 * The `google/` prefix is Google's, not ours —
 * https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/start/openai
 */
const GEMINI_FOR_OPENAI_MODEL: Record<string, string> = {
  o3: `google/${GEMINI_REASONING}`,
  'gpt-5': `google/${GEMINI_REASONING}`,
  'gpt-4.1': `google/${GEMINI_FAST}`,
  'gpt-4.1-mini': `google/${GEMINI_FAST}`,
  'gpt-4.1-nano': `google/${GEMINI_FAST}`,
  'gpt-5-mini': `google/${GEMINI_FAST}`,
  'gpt-5-nano': `google/${GEMINI_FAST}`,
};

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

/** OpenAI's own door knows its own names. */
function openAiWireModel(model: string): string {
  return model;
}

/**
 * The name to put on the wire, applied where the request is built and nowhere
 * else — except that here, unlike Claude, the usage ledger follows it too: a
 * Gemini answering for `gpt-4.1` is a different model at a different price, and
 * a ledger row that said `gpt-4.1` would be charging OpenAI's rate for a call
 * OpenAI never saw. The record/replay hash keeps the caller's own name, so a
 * route switch does not invalidate a fixture.
 */
function geminiWireModel(model: string): string {
  const geminiName = GEMINI_FOR_OPENAI_MODEL[model];
  if (!geminiName) {
    throw new Error(
      `OpenAI model "${model}" has no Gemini equivalent, and MODEL_ROUTE is google. ` +
        'Send a model this deployment maps, or set MODEL_ROUTE=direct.',
    );
  }
  return geminiName;
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

// Read at first USE, not at module load, and memoized per route — same reasoning
// as the Claude factory next door: `getEnvVar` throws in production on an unset
// key, so an eager read made merely IMPORTING this module enough to stop a
// deployment booting that never makes an OpenAI-shaped call.
let directClient: OpenAI | undefined;
let googleClient: OpenAI | undefined;

/** The organisation each key belongs to. Google has no such concept, and sending
 *  one there would be an OpenAI account id travelling to a vendor that has never
 *  heard of it. */
const ORGANIZATION_FALLBACK_OR_DEV = 'org-8dLfRZxrZST5fjBfvwxP0fU5';
const ORGANIZATION = isProd ? 'org-8BBSblaUkeNcT0htEr4sOoed' : ORGANIZATION_FALLBACK_OR_DEV;

/** The client for an OpenAI-shaped call on this deployment's route. */
export function platformOpenAI(env: NodeJS.ProcessEnv = process.env): OpenAiCall {
  const route = modelRoute(env);
  switch (route) {
    case 'direct':
      return {
        client: (directClient ??= new OpenAI({
          apiKey: isProd
            ? getEnvVar('OPENAI_API_KEY', { devDefault: 'test', because: 'OpenAI calls need a key' })
            : getEnvVar('OPENAI_API_KEY_FALLBACK_OR_DEV', { devDefault: 'test' }),
          organization: ORGANIZATION,
        })),
        wireModel: openAiWireModel,
        provider: 'openai',
      };
    case 'google':
      return {
        client: (googleClient ??= new OpenAI({
          baseURL: googleOpenAiBaseUrl(env),
          // There is no key on this route. A Google access token goes where the
          // key would, and it expires inside the hour — so this is a FUNCTION,
          // which the SDK calls before every request. The token source holds one
          // `GoogleAuth`, whose own cache means asking per request costs a
          // property read until the token is actually near expiry.
          apiKey: googleBearerTokens(env),
        })),
        wireModel: geminiWireModel,
        provider: 'google',
      };
    default:
      return neverAsAny(route);
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
        `The JSON schema for "${name}" is recursive, and MODEL_ROUTE is google — Google's ` +
          'OpenAI-shaped endpoint does not support fully recursive schemas and would ignore it ' +
          'rather than refuse it. Flatten the schema, or set MODEL_ROUTE=direct.',
      );
    }
  }
}

// Which vendor answers each model name on this deployment, and what it calls it.
//
// `MODEL_MAP` is a JSON object from a registry name to `provider/wire-model`,
// for example `{"claude-sonnet-5": "vertex/claude-sonnet-5"}`. A name the map
// is silent about goes to its home vendor under its own name, so an empty or
// unset map is exactly the deployment that existed before maps did.
//
// The map is a boundary: it is parsed, never trusted, and a value that almost
// matches (`Gemini/…`, a trailing space) is refused with its key named rather
// than quietly failing to match anything.

import { z } from 'zod';

import { isGoogleServiceAccountConfigured, missingGoogleServiceAccountVars } from '../google_cloud';
import { neverAsAny } from '../utils/types';
import { embeddingDestinations } from './embedding/destinations';
import { embeddingRange } from './embedding/range';
import { isModelName, modelNames, models } from './registry';
import type { Capability, ModelName } from './registry';

export const providers = ['anthropic', 'vertex', 'openai', 'gemini'] as const;
export type Provider = (typeof providers)[number];

export interface Resolved {
  preferred: ModelName;
  provider: Provider;
  wireModel: string;
}

type MapEntry = { provider: Provider; wireModel: string };
export type ModelMap = ReadonlyMap<ModelName, MapEntry>;

function isProvider(s: string): s is Provider {
  return providers.some((p) => p === s);
}

/** Lowercase provider, one slash, a wire model with no whitespace. Anything
 *  else is refused rather than trimmed: an operator who typed `Gemini/` meant
 *  something, and guessing what is how a map line silently stops applying. */
const MAP_VALUE = /^([a-z]+)\/(\S+)$/;

export function parseModelMap(raw: string | undefined): ModelMap {
  if (raw === undefined || raw.trim() === '') return new Map();

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `MODEL_MAP is not valid JSON (${error instanceof Error ? error.message : String(error)}). ` +
        'It must be an object like {"claude-sonnet-5": "vertex/claude-sonnet-5"}.',
    );
  }

  const shape = z.record(z.string(), z.string()).safeParse(json);
  if (!shape.success) {
    throw new Error(
      'MODEL_MAP must be a JSON object whose values are strings, like ' +
        '{"claude-sonnet-5": "vertex/claude-sonnet-5"}.',
    );
  }

  const map = new Map<ModelName, MapEntry>();
  for (const [key, value] of Object.entries(shape.data)) {
    if (!isModelName(key)) {
      throw new Error(
        `MODEL_MAP key "${key}" is not a model name this code uses. Known names: ${modelNames.join(', ')}.`,
      );
    }
    const match = MAP_VALUE.exec(value);
    const provider = match?.[1];
    const wireModel = match?.[2];
    if (!provider || !wireModel || !isProvider(provider)) {
      throw new Error(
        `MODEL_MAP["${key}"] is "${value}". Write it as provider/wire-model, where provider is ` +
          `one of ${providers.join(', ')} (lowercase) and the wire model has no spaces.`,
      );
    }
    map.set(key, { provider, wireModel });
  }
  return map;
}

// Parsed once per distinct value rather than once per process: the value is
// fixed in production, and keying on it keeps a test that sets its own map from
// reading the previous test's.
let memo: { raw: string | undefined; map: ModelMap } | undefined;

function modelMap(env: NodeJS.ProcessEnv): ModelMap {
  const raw = env.MODEL_MAP;
  if (memo === undefined || memo.raw !== raw) memo = { raw, map: parseModelMap(raw) };
  return memo.map;
}

export function resolveModel(name: ModelName, env: NodeJS.ProcessEnv = process.env): Resolved {
  const entry = modelMap(env).get(name);
  return entry
    ? { preferred: name, provider: entry.provider, wireModel: entry.wireModel }
    : { preferred: name, provider: models[name].home, wireModel: name };
}

export function providerServes(provider: Provider, capability: Capability): boolean {
  switch (provider) {
    case 'anthropic':
    case 'vertex':
      return capability === 'chat';
    case 'openai':
    case 'gemini':
      return true;
    default:
      return neverAsAny(provider);
  }
}

/** What an operator sets so `provider` can be called at all. */
function credentialsFor(provider: Provider, env: NodeJS.ProcessEnv): string {
  switch (provider) {
    case 'anthropic':
      return 'ANTHROPIC_API_KEY';
    case 'openai':
      return 'OPENAI_API_KEY';
    case 'vertex':
    case 'gemini': {
      const missing = missingGoogleServiceAccountVars(env);
      return missing.length > 0 ? missing.join(', ') : 'the Google service account';
    }
    default:
      return neverAsAny(provider);
  }
}

export function providerCredentialsPresent(
  provider: Provider,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  switch (provider) {
    case 'anthropic':
      return Boolean(env.ANTHROPIC_API_KEY);
    case 'openai':
      return Boolean(env.OPENAI_API_KEY || env.OPENAI_API_KEY_FALLBACK_OR_DEV);
    case 'vertex':
    case 'gemini':
      return isGoogleServiceAccountConfigured(env);
    default:
      return neverAsAny(provider);
  }
}

/**
 * Refuse a map that cannot work, at boot rather than at the first call.
 *
 * Deliberately NOT refused: a home vendor's key that nothing uses, and an
 * unmapped name whose home vendor has no key — a deployment that never
 * generates an image need not map image generation. That second case raises
 * at the call instead ({@link assertCallable}).
 */
export function assertModelMapConfigured(env: NodeJS.ProcessEnv = process.env): void {
  for (const [name, { provider, wireModel }] of modelMap(env)) {
    const { capability } = models[name];
    if (!providerServes(provider, capability)) {
      const servers = providers.filter((p) => providerServes(p, capability));
      throw new Error(
        `MODEL_MAP["${name}"] is "${provider}/${wireModel}", but ${provider} does not serve ` +
          `${capability}. Map it to one of: ${servers.join(', ')}.`,
      );
    }
    if (!providerCredentialsPresent(provider, env)) {
      throw new Error(
        `MODEL_MAP["${name}"] sends it to ${provider}, but ${provider} has no credentials here — ` +
          `set ${credentialsFor(provider, env)}.`,
      );
    }
    if (capability === 'embedding') assertEmbeddingWidths(name, provider, wireModel);
  }
}

/**
 * A map line that sends an embedding model to a wire model that cannot produce
 * the width of a column that model fills. Refused rather than resized: a
 * vector of the wrong width is a row Postgres refuses, and a truncated one is
 * a different vector, not a smaller copy of the right one.
 */
function assertEmbeddingWidths(name: ModelName, provider: Provider, wireModel: string): void {
  const range = embeddingRange(provider, wireModel);
  if (!range) {
    throw new Error(
      `MODEL_MAP["${name}"] is "${provider}/${wireModel}", an embedding model the ${provider} ` +
        'provider does not list, so nothing here knows what width of vector it produces. ' +
        'Map it to a listed embedding model, or add this one to its provider file with the widths it supports.',
    );
  }
  for (const { column, model, dimensions } of Object.values(embeddingDestinations)) {
    if (model !== name) continue;
    if (dimensions < range.min || dimensions > range.max) {
      throw new Error(
        `MODEL_MAP["${name}"] is "${provider}/${wireModel}", which produces vectors of ` +
          `${range.min} to ${range.max} dimensions, but ${name} fills ${column}, which stores ` +
          `${dimensions}. Map it to a model that can produce ${dimensions}.`,
      );
    }
  }
}

/**
 * The call-time half of boot validation: a name that resolved through the map's
 * silence to a home vendor with no credentials. Production only, mirroring the
 * development defaults the vendor clients fall back to.
 */
export function assertCallable(resolved: Resolved, env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== 'production') return;
  if (providerCredentialsPresent(resolved.provider, env)) return;
  if (modelMap(env).has(resolved.preferred)) {
    throw new Error(
      `MODEL_MAP["${resolved.preferred}"] sends it to ${resolved.provider}, but ${resolved.provider} ` +
        `has no credentials here — set ${credentialsFor(resolved.provider, env)}.`,
    );
  }
  throw new Error(
    `"${resolved.preferred}" is not in MODEL_MAP, so it goes to its home vendor ` +
      `${resolved.provider}, which has no credentials here. Set ` +
      `${credentialsFor(resolved.provider, env)}, or add a line to MODEL_MAP such as ` +
      `"${resolved.preferred}": "<provider>/<wire model>".`,
  );
}

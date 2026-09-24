// Every model name the code may ask for, closed and enumerable.
//
// A name here is a PREFERENCE, not an address: the model map (`map.ts`) decides
// which vendor answers it on this deployment and what that vendor calls it. A
// name the map says nothing about goes to its home vendor under its own name,
// which is why an empty map reproduces a deployment that never heard of maps.
//
// Dated names stay dated where that is what callers send today: the registry
// name is also the wire name on the home vendor, so undating one would change
// what reaches Anthropic's API for every deployment at once.

export type Capability = 'chat' | 'transcription' | 'embedding' | 'image';

/** Where a name goes when the map is silent about it. */
export type HomeVendor = 'anthropic' | 'openai';

export interface RegistryEntry {
  capability: Capability;
  home: HomeVendor;
}

export const models = {
  'claude-fable-5-1': { capability: 'chat', home: 'anthropic' },
  'claude-opus-5': { capability: 'chat', home: 'anthropic' },
  'claude-opus-4-8': { capability: 'chat', home: 'anthropic' },
  'claude-opus-4-7': { capability: 'chat', home: 'anthropic' },
  'claude-opus-4-6': { capability: 'chat', home: 'anthropic' },
  'claude-sonnet-5': { capability: 'chat', home: 'anthropic' },
  'claude-haiku-4-5': { capability: 'chat', home: 'anthropic' },
  'claude-haiku-4-5-20251001': { capability: 'chat', home: 'anthropic' },
  'gpt-5': { capability: 'chat', home: 'openai' },
  'gpt-5-mini': { capability: 'chat', home: 'openai' },
  'gpt-5-nano': { capability: 'chat', home: 'openai' },
  'gpt-4.1': { capability: 'chat', home: 'openai' },
  'gpt-4.1-mini': { capability: 'chat', home: 'openai' },
  'gpt-4.1-nano': { capability: 'chat', home: 'openai' },
  'gpt-4o': { capability: 'chat', home: 'openai' },
  o3: { capability: 'chat', home: 'openai' },
  'whisper-1': { capability: 'transcription', home: 'openai' },
  'text-embedding-3-large': { capability: 'embedding', home: 'openai' },
  'text-embedding-3-small': { capability: 'embedding', home: 'openai' },
  'dall-e-3': { capability: 'image', home: 'openai' },
} as const satisfies Record<string, RegistryEntry>;

export type ModelName = keyof typeof models;

export function isModelName(s: string): s is ModelName {
  return Object.prototype.hasOwnProperty.call(models, s);
}

export const modelNames: readonly ModelName[] = Object.keys(models).filter(isModelName);

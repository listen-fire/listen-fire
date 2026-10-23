// Anthropic's own API on a key the caller holds, passed through: the seam IS
// this SDK's shape.

import { createHash } from 'node:crypto';

import Anthropic from '@anthropic-ai/sdk';
import { budgetAfter, limiterSlot, vendorBudget, type Caller } from 'movement-engine/public/limiter';

import type { ChatProvider } from './chat';

export interface AnthropicKey {
  apiKey: string;
  /** Another endpoint speaking the same Messages API (a proxy, a test fake). */
  baseUrl?: string;
}

// One per key rather than one per process: a unit that pays with its own key
// (knowledge's `KNOWLEDGE_LLM_API_KEY`) must not share the platform's client.
const keyedClients = new Map<string, ChatProvider>();

/** What the limiter knows a key by: a hash, so neither the key nor any prefix
 *  of it reaches a throttle key or a shared limiter's store. */
export function credentialId(apiKey: string): string {
  return `sha256:${createHash('sha256').update(apiKey).digest('hex').slice(0, 16)}`;
}

/** Who a model request is made as: the API key it calls on (Anthropic's
 *  limits are per key), so a 429 on one key leaves the others open. A provider
 *  with no key of its own is one caller, module-wide. */
export function modelsCallerFor(credential: string | undefined): Caller {
  return { module: '@lf/anthropic', team: '', ...(credential !== undefined ? { credential } : {}) };
}

/** Every response the key's client receives reports the key's remaining
 *  budget; a spent one closes the key before the 429 would. A failed
 *  response is the handler's (it reads the 429's own Retry-After). */
function fetchReportingBudget(credential: string): typeof fetch {
  return async (input, init) => {
    const response = await fetch(input, init);
    if (response.ok) await budgetAfter(limiterSlot(), modelsCallerFor(credential), vendorBudget(response.headers));
    return response;
  };
}

export function anthropicKeyedChatProvider({ apiKey, baseUrl }: AnthropicKey): ChatProvider {
  const cacheKey = `${baseUrl ?? ''}\n${apiKey}`;
  let keyed = keyedClients.get(cacheKey);
  if (!keyed) {
    // No SDK retries: a 429 must reach the module's handler at once, which
    // releases the permit and throttles the key for everyone sharing the
    // limiter. The SDK would sleep on it (twice) inside the held permit.
    // The client's own backoff retries the other transient failures.
    const credential = credentialId(apiKey);
    const sdk = new Anthropic({ apiKey, maxRetries: 0, fetch: fetchReportingBudget(credential), ...(baseUrl !== undefined ? { baseURL: baseUrl } : {}) });
    keyed = { credential, messages: sdk.messages };
    keyedClients.set(cacheKey, keyed);
  }
  return keyed;
}

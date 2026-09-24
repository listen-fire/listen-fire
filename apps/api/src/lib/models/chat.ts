// The seam every chat call crosses: a provider object in Anthropic's own
// request and response types, plus the name to put on its wire.
//
// Typed structurally rather than as either SDK's class, so a translator that is
// not an Anthropic client at all can stand behind it, and so a caller cannot
// wander onto an endpoint (batches, files) that only one vendor has.

import type Anthropic from '@anthropic-ai/sdk';

import { neverAsAny } from '../utils/types';
import { assertCallable, resolveModel } from './map';
import type { Provider, Resolved } from './map';
import { anthropicChatProvider } from './providers/anthropic';
import { geminiChatProvider } from './providers/gemini';
import { vertexChatProvider } from './providers/vertex';
import { models } from './registry';
import type { ModelName } from './registry';

export type ChatProvider = {
  messages: {
    create(
      params: Anthropic.MessageCreateParamsNonStreaming,
      options?: Anthropic.RequestOptions,
    ): Promise<Anthropic.Message>;
    stream(
      params: Anthropic.MessageCreateParamsNonStreaming,
      options?: Anthropic.RequestOptions,
    ): { finalMessage(): Promise<Anthropic.Message> };
  };
};

export interface ChatCall {
  client: ChatProvider;
  wireModel: string;
  resolved: Resolved;
}

function chatProviderFor(provider: Provider, env: NodeJS.ProcessEnv): ChatProvider {
  switch (provider) {
    case 'anthropic':
      return anthropicChatProvider(env);
    case 'vertex':
      return vertexChatProvider(env);
    case 'openai':
      throw new Error(`Provider "${provider}" is not available yet`);
    case 'gemini':
      return geminiChatProvider(env);
    default:
      return neverAsAny(provider);
  }
}

export function chatCallFor(name: ModelName, env: NodeJS.ProcessEnv = process.env): ChatCall {
  const { capability } = models[name];
  if (capability !== 'chat') {
    throw new Error(`"${name}" is a ${capability} model, and was asked for a chat reply.`);
  }
  const resolved = resolveModel(name, env);
  assertCallable(resolved, env);
  return { client: chatProviderFor(resolved.provider, env), wireModel: resolved.wireModel, resolved };
}

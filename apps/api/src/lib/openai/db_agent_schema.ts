import { z } from 'zod';

// Shared schema for agent tool-loop output (works with both OpenAI and Anthropic)
const OutputItemSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
  content: z.string().optional(),
  annotations: z.array(z.unknown()).optional(),
  logprobs: z.array(z.unknown()).optional(),
});

export const AgentResponseSchema = z.preprocess(
  (val) => {
    if (Array.isArray(val)) return val;
    if (typeof val === 'string') return [{ type: 'text', text: val }];
    if (val == null) return [];
    return [];
  },
  z.array(OutputItemSchema),
);

/** @deprecated Use AgentResponseSchema */
export const OpenAIResponseSchema = AgentResponseSchema;

export type AgentRawResponse = z.infer<typeof AgentResponseSchema>;

/** @deprecated Use AgentRawResponse */
export type DbAgentRawResponse = AgentRawResponse;

// Simplified response type for TRPC/frontend
export const DbAgentResponseSchema = z.object({
  text: z.string(),
});

export type DbAgentResponse = z.infer<typeof DbAgentResponseSchema>;

import { z } from 'zod';

// Common schema for webhook node configurations
export const webhookFieldSchema = z.object({
  key: z.string().min(1), // The key in the JSON object (e.g., "name", "company.website")
  prompt: z.string().optional(), // Prompt for AI-generated value (for field nodes)
});

export type WebhookFieldConfig = z.infer<typeof webhookFieldSchema>;

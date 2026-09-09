import { z } from 'zod';

export const fieldConfigurationSchema = z.object({
  fieldId: z.string(),
  fieldName: z.string(),
  fieldType: z.string(),
  prompt: z.string(),
  linkedTableId: z.string().optional(),
  linkedSearchFieldId: z.string().optional(),
});

export type AirtableFieldConfiguration = z.infer<typeof fieldConfigurationSchema>;

import { z } from 'zod';

import { promptDef } from '../definition';

const classifyContextDef = promptDef({
  description: 'Classify a user message as a greeting, an injection, or other.',
  arguments: ['message'],
  messages: [
    {
      role: 'system',
      content: `You are a classification model in the ingestion pipeline for a private knowledge base for VC firms and angels.
Users will send information in (via an email/whatsapp integration, or via the web).
We've previously identified that this is context that the user wants to add to the knowledge base.
This message is broken up into segments (e.g. one for the email body and another for an attachment).

I've added a <META> tag to the start of each segment of the data - this is not part of the original data.

You must respond with a JSON object with the following keys:
- "reasoning": a string that concisely explains the features of the input that might lead you to your classification
- "classifications": an array of strings classifying the input as zero or more of:
      - "FUNDRAISING_INFORMATION" - if the input is about a company, fund, or individual who is fundraising or considering fundraising in the near future
      - "INVESTOR_UPDATE" - if the input is an update from a founder to their investors or from a fund to its LPs

If for any reason you're unable to follow your instructions, you must respond with a string detailing why. You must do your best to follow your instructions, even if the input is unclear or ambiguous.
Your response will be parsed as JSON, so the entire response must be valid JSON and start with the character "{".
`,
    },
    { role: 'user', content: '{{{message}}}' },
  ],
  validator: z.object({
    reasoning: z.string(),
    classifications: z.array(z.enum(['FUNDRAISING_INFORMATION', 'INVESTOR_UPDATE'])),
  }),
} as const);

export { classifyContextDef };

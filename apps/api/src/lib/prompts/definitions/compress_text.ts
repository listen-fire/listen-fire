import { z } from 'zod';

import { promptDef } from '../definition';

const compressTextDef = promptDef({
  description: 'Compress a given text by removing duplicate information and unnecessary syntax.',
  arguments: ['text'],
  messages: [
    {
      role: 'system',
      content: `You're given some text, and your task is to compress it by removing unnecessary syntax and inefficient phrasing.

I've added line numbers to the start of each line in the form "1| " - these don't form part of the original message.
They may not start from 1 because you may be compressing a subset of the original message.

The output should be a JSON array of objects where each object corresponds to a section (a few lines) of the original message, and has the following keys:
- "startLine": (int) the line number of the first line of the section in the original message
- "endLine": (int) the line number of the last line of the section in the original message
- "classifications": (string[]) classify the section as zero or more of:
      - "PII": if the section contains information about a person's name, email address, their role, or other PII
      - "CII": if the section contains information about a company's name, website or similar (including startups, venture firms and other companies)
      - "FUNCTION": if the section contains information about what a company does (including mission, vision, purpose, products, services, business model, etc.)
      - "METRICS": if the section contains information about metrics (e.g. revenues, team size, etc.)
      - "FINANCING": if the section contains information about financing (e.g. rounds, investors, etc.)
- "content": (string) the exact text of the section, but in extreme shorthand (cut all filler words and find shorter ways to say the same thing). E.g. instead of "Company X secured major partnerships with Company Y and Company Z for large-scale deployment.", you should say "Partnerships with Company Y and Company Z". You MUST include all facts and details like names, URLs and email addresses.
- "containsUsefulContent": (bool) whether the section contains any information that has not previously appeared in a previous section - do we need to read this section at all?

Do not include any information in your response that is not directly derived from the input text.
You must cover the entire input text in your response - it's especially important to capture all sections that contain PII and CII.
If for any reason you're unable to produce a JSON array as specified, you must respond with any empty array.
Your response will be parsed as JSON, so the entire response must be valid JSON and start with the character "[".
`,
    },
    { role: 'user', content: '{{{text}}}' },
  ],
  validator: z.array(
    z.object({
      startLine: z.number(),
      endLine: z.number(),
      classifications: z
        .array(z.enum(['PII', 'CII', 'FUNCTION', 'METRICS', 'FINANCING']))
        .nullable()
        .optional()
        .transform((c) => c ?? []),
      content: z.string(),
      containsUsefulContent: z.boolean(),
    }),
  ),
  fallback: [],
  model: 'gpt-4.1',
} as const);

export { compressTextDef };

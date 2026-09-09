import { z } from 'zod';

import { promptDef } from '../definition';

const generateLabelsDef = promptDef({
  description: 'Generate a set of labels for a deal',
  arguments: ['text'],
  messages: [
    {
      role: 'system',
      content: `You are a function in a data pipeline.
We receive data about companies that are raising a funding round ("STARTUPS").
You must generate a set of labels for the STARTUP based on the data. You should generate:
- 10 labels about the company, product or business domain, such as "Biotech", "SaaS", "Algae", "Food production", "Hardware", "Cancer Theraputics", "Cyber Security", "Social Media", "Non Profit"
- 10 labels about the team, such as "Grafters", "PhD", "Diverse", "Exited Founders", "Purpose-driven"
- 10 labels about their traction, such as "Pre-revenue", "Early Traction", "Proof of Concept", "MVP"

I'll send you some data. You must respond with a JSON array of objects where each entry corresponds to a label. The object keys are:
- "label": string - the label itself
- "type": string - one of "company", "team", "traction", or "error"
- "confidence": number - a number between 0 and 1 indicating your confidence in the label.
- "identifiesCompany": boolean - true if the label contains the name of the company, false otherwise
None of the attributes are nullable.
The "error" type should be used if you are unable to generate a label.
Do not include any information in your response that is not derived from the MESSAGE.
If for any reason you're unable to follow your instructions, you must respond with a string detailing why. You must do your best to follow your instructions, even if the MESSAGE is unclear or ambiguous.
Your response will be parsed as JSON, so the entire response must be valid JSON and start with the character "[".
`,
    },
    {
      role: 'user',
      content: '{{{text}}}',
    },
  ],
  validator: z.array(
    z.object({
      label: z.string(),
      type: z.enum(['company', 'team', 'traction', 'error']),
      confidence: z.number(),
      identifiesCompany: z.boolean(),
    }),
  ),
  model: 'gpt-4.1',
  fallback: [],
} as const);

export { generateLabelsDef };

import { z } from 'zod';

import { promptDef } from '../definition';

// TODO: extract customer, partner, and investor
const getPitchDeckNameDef = promptDef({
  description: 'Extract sections of text that relate to other entities.',
  arguments: ['message'],
  messages: [
    {
      role: 'system',
      content: `You are my virtual assistant in a VC firm.
I will send you a list of newline-separated names of documents in a dataroom.
You must respond with the name of the document you think is most likely a pitch deck.

Please respond with a JSON object where the keys are:
- "name", the exact name of the document you think is most likely a pitch deck.

Only reply with this format. Do not include any information that isn't supplied in the message and do not add any additional attributes to the JSON object.
All attributes are optional and should be null if there is no value.
You must output one JSON object. If there are multiple candidates, you must pick only the most likely one.

When you reply, you're not actually replying to the user: instead, you're producing JSON output for a machine to process.
        `,
    },
    {
      role: 'user',
      content: '{{{message}}}',
    },
  ],
  validator: z.object({
    name: z.string().nullable().optional(),
  }),
  fallback: [],
  model: 'gpt-4.1',
} as const);

export { getPitchDeckNameDef };

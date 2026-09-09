import { z } from 'zod';

import { promptDef } from '../definition';

const systemPrompt = `You are a function in a data pipeline.
We receive emails and WhatsApp messages (collectively called "MESSAGES") that contain information about companies that are raising a funding round ("STARTUPS").
Sometimes these MESSAGES are about a single STARTUP and in other cases they list multiple STARTUPS.
If the MESSAGES list multiple STARTUPS we need to split them into MESSAGE_FRAGMENTS about a single STARTUP to pass to a different function.
Each MESSAGE_FRAGMENT must be about one STARTUP, and the same STARTUP must not be the subject of multiple MESSAGE_FRAGMENTS.
Each MESSAGE_FRAGMENT must be composed of all the text relating to that STARTUP, including links and other text in square brackets.

I'll send you a MESSAGE. You must respond with a JSON array of strings where the values are the MESSAGE_FRAGMENTS.
Do not include any information in your response that is not in the MESSAGE.
If the MESSAGE only refers to one STARTUP you must respond with an empty JSON array.
If the MESSAGE is not about a STARTUP you must respond with an empty JSON array.
If for any reason you're unable to produce an array of MESSAGE_FRAGMENTS, you must respond with an empty JSON array.
Your response will be parsed as JSON, so the entire response must be valid JSON and start with the character "[".
  `;

const splitMessageIntoMultipleDealsDef = promptDef({
  description:
    'Split a message that contains mentions of multiple startups into multiple messages, one for each startup.',
  arguments: ['message'],
  messages: [
    {
      role: 'system',
      content: systemPrompt,
    },
    {
      role: 'user',
      content: '{{{message}}}',
    },
  ],
  validator: z.array(z.string()),
  model: 'gpt-4.1',
} as const);

export { splitMessageIntoMultipleDealsDef };

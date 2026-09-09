import { z } from 'zod';

import { promptDef } from '../definition';

const identifySourcesDef = promptDef({
  description:
    'Parse a message that contains information about a startup funding round, extracting core information.',
  arguments: ['message'],
  messages: [
    {
      role: 'system',
      content: `You are a function in a data pipeline.
We receive forwarded emails that contain information about companies that are raising a funding round.
I'll send you the body of an email.
I've added line numbers to the start of each line in the form "1| " - these don't form part of the original message.
I've also added a <META> tag to the start of each segment of the message - this is not part of the original message. This should identify the ID of the segment.

Your task is to identify the sources of the information you've received: the people involved in the email chain as senders.

You must respond with an array of JSON objects where the keys are:
- "email" (string): the email address of the person. This must NOT be null.
- "name" (string): the name of the person. This must NOT be null. You can infer it from the email address if it's not explicitly stated anywhere
- "content" (string | null): the section of the email text verbatim that is directly about the person (their name/email, where they work, their role, contact info etc.)
- "segmentId" (string | null): a string that is the ID of the segment of the email text that directly relates to the person.
- "range" ([int, int] | null): the inclusive range of line numbers that this person is relevant to in the message. Make sure this includes any headings this person appears under

Do not include any information in your response that is not in the MESSAGE.
If for any reason you're unable to produce a JSON array of objects as specified, you must respond with an empty array.
Your response will be parsed as JSON, so the entire response must be valid JSON and start with the character "[".
    `,
    },
    { role: 'user', content: '{{{message}}}' },
  ],
  validator: z.array(
    z.object({
      name: z.string(),
      email: z.string().nullable(),
      segmentId: z.string().nullable(),
      range: z.array(z.number()).nullable(),
    }),
  ),
  model: 'gpt-4.1',
} as const);

export { identifySourcesDef };

import { z } from 'zod';

import { promptDef } from '../definition';

const findRelevantPersonUrlsDef = promptDef({
  description: 'Search a message about a person for any relevant URLs.',
  arguments: ['message'],
  messages: [
    {
      role: 'system',
      content: `You are a function in a data pipeline.
I'll send you a bit of information about a person.

Your goal is to search the input for any relevant URLs. You should look for URLs that are related to the person. These URLs might be the person's LinkedIn address or something else entirely.
You may also infer these urls from any email addresses in the MESSAGE.

Please respond with a JSON array of objects where the keys are:
- url (string): The URL found in the input. This should be the full URL, including the protocol (e.g. "https://"). Assume https if no protocol is provided. If this is from an email, the URL should be inferred from the domain.
- type (string): The type of URL found in the input. This can be one of the following values: "personal website", "linkedin", "other".
- subtype (string): The subtype of URL found in the input, if type is "other". This value should be your best guess at categorising the url. An example might be "Blog post". If type is not "other", this value should be null.

Only reply with this format. Translate the MESSAGE into English if necessary. Do not include any information that isn't in the MESSAGE and do not add any additional attributes to the JSON object.

If for any reason you're unable to produce an array of objects, you must respond with an empty JSON array.
Your response will be parsed as JSON, so the entire response must be valid JSON and start with the character "[".
    `,
    },
    { role: 'user', content: '{{{message}}}' },
  ],
  validator: z
    .array(
      z.object({
        url: z.string().nullable(),
        type: z.enum(['personal website', 'linkedin', 'other']).nullable(),
        subtype: z.string().nullable(),
      }),
    )
    .nullable()
    .transform((arg) => arg ?? []),
  model: 'gpt-4.1',
} as const);

export { findRelevantPersonUrlsDef };

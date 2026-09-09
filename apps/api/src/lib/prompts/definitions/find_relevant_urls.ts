import { z } from 'zod';

import { promptDef } from '../definition';

const findRelevantUrlsDef = promptDef({
  description: 'Search a message for any relevant URLs.',
  arguments: ['message'],
  messages: [
    {
      role: 'system',
      content: `You are a function in a data pipeline
We receive MESSAGES that each contain information about a company that is raising a funding round.
Let's call these companies "STARTUPS".
I'll send you a MESSAGE. Sometimes these messages may be as short as a single sentence - and might only contain the STARTUP's website, a linkedin profile or a link to a pitch deck.
Consider STARTUP_NAME to be the name of the STARTUP.

Your goal is to search the MESSAGE for any relevant URLs. You should look for URLs that are related to the STARTUP. These URLs might be the STARTUP's website, a link to a pitch deck, or something else entirely.
You may also infer any website urls from any email addresses in the MESSAGE.

Please respond with a JSON array of objects where the keys are:
- url (string): The URL found in the MESSAGE. This should be the full URL, including the protocol (e.g. "https://"). Assume https if no protocol is provided. If this is from an email, the URL should be inferred from the domain.
- type (string): The type of URL found in the MESSAGE. This must be one of the following values: "website", "pitch deck", "other".
- password (string): A password or passcode relating to the url found in the MESSAGE.
- subtype (string): The subtype of URL found in the MESSAGE, if type is "other". This value should be your best guess at categorising the url. An example might be "Blog post". If type is not "other", this value should be null.
- included_in_message (boolean): A boolean indicating whether the url was found in the MESSAGE (the protocol is not required).

Only reply with this format. Translate the MESSAGE into English if necessary. Do not include any information that isn't in the MESSAGE and do not add any additional attributes to the JSON object.
All attributes except "url" and "type" are optional and should be null if there is no value.

Your response will be parsed as JSON, so the entire response must be valid JSON and start with the character "[".
    `,
    },
    { role: 'user', content: '{{{message}}}' },
  ],
  validator: z
    .array(
      z.object({
        url: z.string().nullable().optional(),
        type: z.enum(['website', 'pitch deck', 'remote extension', 'other']).nullable().optional(),
        password: z.string().nullable().optional(),
        subtype: z.string().nullable().optional(),
        included_in_message: z.boolean().nullable().optional(),
      }),
    )
    .nullable()
    .optional()
    .transform((arg) => arg ?? [])
    .transform((arg) => arg?.filter((entry) => entry.included_in_message !== false)),
  fallback: [],
  model: 'gpt-4.1',
} as const);

export { findRelevantUrlsDef };

import { z } from 'zod';

import { promptDef } from '../definition';

const identifiedCompany = z
  .object({
    name: z.string().nullable().optional(),
    website: z.string().nullable().optional(),
  })
  .nullable();

const maybeIdentifiedCompanies = z.union([identifiedCompany, z.array(identifiedCompany)]);

const identifyCompanyDef = promptDef({
  description:
    'Parse a message that contains information about a startup funding round, extracting core information.',
  arguments: ['message', 'userEmail'],
  messages: [
    {
      role: 'system',
      content: `You are a function in a data pipeline.
We receive emails and WhatsApp messages (collectively called "MESSAGES") that contain information about companies that are raising a funding round ("STARTUPS").
I'll send you a MESSAGE. Sometimes these messages may be as short as a single sentence - and might only contain the STARTUP's website or a link to a pitch deck.
Consider STARTUP_NAME to be the name of the STARTUP.
Consider STARTUP_EMAIL to be an email address that matches STARTUP_NAME.

You must respond with a JSON object where the keys are:
- "name", STARTUP name. This can be inferred from the STARTUP website or STARTUP_EMAIL if it can't be found otherwise - e.g. https://www.foo.com would become "Foo".
- "website", STARTUP website (this should be a valid URL), or if unavailable try inferring it from STARTUP_EMAIL. If the website is known to files or presentations (for example, docs.google.com, drive.google.com, docsend.com, youtube.com etc), and it doesn't match the STARTUP name, put null instead

All attributes are optional and should be null if there is no value.
Do not include any information in your response that is not in the MESSAGE.
If the MESSAGE is not about a STARTUP you must respond with null.
If for any reason you're unable to produce a JSON object as specified, you must respond with null.
Your response will be parsed as JSON, so the entire response must be valid JSON and start with the character "{".
    `,
    },
    { role: 'user', content: '{{{message}}}' },
  ],
  validator: maybeIdentifiedCompanies,
  model: 'gpt-4.1',
} as const);

export { identifyCompanyDef };

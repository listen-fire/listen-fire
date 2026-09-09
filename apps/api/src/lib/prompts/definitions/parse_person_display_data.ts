import { z } from 'zod';

import { promptDef } from '../definition';

const parsePersonDisplayDef = promptDef({
  description:
    'Parse a message that contains information about a startup funding round, extracting core information.',
  arguments: ['message', 'companyName', 'personName'],
  messages: [
    {
      role: 'system',
      content: `You are a function in a data pipeline.
We receive MESSAGES that each contain information about a company that is raising a funding round.
Let's call these companies "STARTUPS".
I'll send you some information about a person ({{{personName}}}) related to a STARTUP.
Consider STARTUP_NAME to be the name of the STARTUP, which in this case is {{{companyName}}}.

You must respond with a JSON object where the keys are:
- "fullname", the name of the person
- "role", an abbreviation or full role name, e.g. CEO, CTO. If they are a founder or co-founder, include that (e.g. "CTO & Co-Founder")
- "description", a summary description of the person. Include work experience and education, keep it concise and neutral. Don't include any information about the STARTUP in the description.
- "email", the email address of the person, if found in the MESSAGE
- "isSenior", a boolean indicating if the person is a senior executive or holds a founding role at the STARTUP
- "roleType", one of "team member" (if their main job is at the STARTUP) or "other" (for advisors, consultants, and investors). Advisors may be listed under a separate section.

Only reply with this format: one JSON object related to {{{personName}}}. Translate the MESSAGE into English if necessary. Do not include any information that isn't in the MESSAGE and do not add any additional attributes to the JSON object.
All attributes are optional and should be null if there is no value.

When you reply, you're not actually replying to the user: instead, you're producing JSON output for a machine to process.
    `,
    },
    { role: 'user', content: '{{{message}}}' },
  ],
  validator: z
    .object({
      fullname: z.string().nullable().optional(),
      role: z.string().nullable().optional(),
      description: z.string().nullable().optional(),
      description_short: z.string().nullable().optional(), // filled in after by a different prompt
      email: z.string().nullable().optional(),
      isSenior: z.boolean().nullable().optional(),
      roleType: z.enum(['team member', 'other']).nullable().optional(),
    })
    .nullable(),
  fallback: null,
  model: 'gpt-4.1',
} as const);

export { parsePersonDisplayDef };

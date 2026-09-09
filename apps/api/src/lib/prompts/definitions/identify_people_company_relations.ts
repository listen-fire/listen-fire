import { z } from 'zod';

import { promptDef } from '../definition';

// TODO: extract customer, partner, and investor
const identifyPeopleCompanyRelationsDef = promptDef({
  description: 'Extract sections of text that relate people to companies.',
  arguments: ['message', 'personName', 'companyName', 'date'],
  messages: [
    {
      role: 'system',
      content: `You are a function in a data pipeline.
We receive data (the INPUT) that contains information about people (e.g. employees, investors, advisors, etc.).
We already have information about the PERSON ({{{personName}}}) that is the subject of the INPUT - we are now looking for related companies instead.
This includes previous workplaces, companies they've invested in and other companies that are mentioned in the INPUT.

I'll send you some data.
I've added line numbers to the start of each line in the form "1| " - these don't form part of the original data.
I've also added a <META> tag to the start of each segment of the data - this is not part of the original data. This should identify the ID of the segment.
Today's date is {{{date}}} (you can use this to assess the relevance of the segments based on the date in their META section).

You must respond with a JSON array of objects where each entry corresponds to a company that is related to the PERSON. The object keys are:
- "name": a string that is the name of the company
- "segmentId", a string that is the ID of the segment of the INPUT text that directly relates to the company.
- "range", [int, int], the inclusive range of line numbers that this company is relevant to in the message. Make sure this includes any headings this company appears under (e.g. "Investments" or "Previous workplaces")
- "email": a string that is the email address of the company if found, otherwise null
- "linkedIn": a string that is the LinkedIn profile URL of the company if found, otherwise null
- "description", a concise, 1 sentence description of the person if there's enough information, otherwise null
- "relationship": an object detailing how the PERSON is related to this company. The object keys are:
  - "roleType", one of "team_member" (if it's a person whose main job is at the STARTUP. MUST NOT be a contractor/consultant/advisor/investor), or "other" (for advisors, consultants, investors, and other companies). Note that advisors may be listed under a separate section
  - "isFounder", a boolean that is true if the person is a team_member AND they are either a founder or a C-Suite executive or equivalent. This should be false otherwise. 
  - "subtype": a string that is a more specific description of how the COMPANY is related to this person. This should at most be a few words, and should be null if there's not enough information.

Do not include any information in your response that is not in the INPUT.
If for any reason you're unable to follow your instructions, you must respond with a string detailing why. You must do your best to follow your instructions, even if the MESSAGE is unclear or ambiguous.
Your response will be parsed as JSON, so the entire response must be valid JSON and start with the character "[".
        `,
    },
    {
      role: 'user',
      content: '{{{message}}}',
    },
  ],
  validator: z.array(
    z.object({
      name: z.string(),
      content: z.string(),
      email: z.string().nullable(),
      linkedIn: z.string().nullable(),
      description: z.string().nullable(),
      relationship: z.object({
        roleType: z.enum(['team_member', 'other']).catch('other'),
        isFounder: z.boolean().nullable().catch(false),
        subtype: z.string().nullable().catch(null),
      }),
    }),
  ),
  fallback: [],
  model: 'gpt-4.1',
} as const);

export { identifyPeopleCompanyRelationsDef };

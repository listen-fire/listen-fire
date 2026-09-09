import { z } from 'zod';

import { promptDef } from '../definition';

// TODO: extract customer, partner, and investor
const identifyCompanyPeopleRelationsDef = promptDef({
  description: 'Extract sections of text that relate companies to people.',
  arguments: ['message', 'companyName', 'date'],
  messages: [
    {
      role: 'system',
      content: `You are a function in a data pipeline.
We receive data (the INPUT) that contains information about companies (often startups or venture funds).
We already have information about the COMPANY ({{{companyName}}}) that is the subject of the INPUT - we are now looking for related people instead.
This includes investors, advisors, and team members that are mentioned in the INPUT.

I'll send you some data.
I've added line numbers to the start of each line in the form "1| " - these don't form part of the original data.
I've also added a <META> tag to the start of each segment of the data - this is not part of the original data. This should identify the ID of the segment.
Today's date is {{{date}}} (you can use this to assess the relevance of the segments based on the date in their META section).

You must respond with a JSON array of objects where each entry corresponds to a person that is related to the COMPANY. The object keys are:
- "name": (string), the name of the person
- "segmentId", (string), the ID of the segment of the INPUT text that directly relates to the person. This must be the UUID ID of segment from the INPUT - make sure it's the right value and the right length.
- "range", ([int, int]), the inclusive range of line numbers that this person is relevant to in the message. Make sure this includes any headings this person appears under (e.g. "Advisors" or "Investors")
- "email": (string | null), the email address of the person if found
- "linkedIn": (string | null), the LinkedIn profile URL of the person if found
- "description" (string | null), a concise, 1 sentence description of the person if there's enough information
- "relationship": (object), how the COMPANY is related to this person. The object keys are:
  - "roleType": (enum), one of "team_member" (if it's a person whose main job is at the STARTUP. MUST NOT be a contractor/consultant/advisor/investor), or "other" (for advisors, consultants, investors, and other companies). Note that advisors may be listed under a separate section
  - "isFounder": (boolean), true if the person is a team_member AND they are either a founder or a C-Suite executive or equivalent. This should be false otherwise. 
  - "subtype": (string | null), a more specific description of how the COMPANY is related to this person. This should at most be a few words.

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
  validator: z
    .array(
      z.object({
        name: z.string().nullable(),
        segmentId: z.string(),
        range: z.array(z.number()),
        email: z.string().nullable(),
        linkedIn: z.string().nullable(),
        description: z.string().nullable(),
        relationship: z.object({
          roleType: z.enum(['team_member', 'other']).catch('other'),
          isFounder: z.boolean().nullable().catch(false),
          subtype: z.string().nullable().catch(null),
        }),
      }),
    )
    .transform((data) => data.filter((d): d is typeof d & { name: string } => d.name !== null)),
  fallback: [],
  model: 'gpt-4.1',
} as const);

export { identifyCompanyPeopleRelationsDef };

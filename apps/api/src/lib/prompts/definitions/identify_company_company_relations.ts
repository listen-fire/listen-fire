import { z } from 'zod';

import { promptDef } from '../definition';

// TODO: extract customer, partner, and investor
const identifyCompanyCompanyRelationsDef = promptDef({
  description: 'Extract sections of text that relate to other companies.',
  arguments: ['message', 'companyName', 'date'],
  messages: [
    {
      role: 'system',
      content: `You are a function in a data pipeline.
We receive data (the INPUT) that contains information about companies (often startups or venture funds).
We already have information about the COMPANY ({{{companyName}}}) that is the subject of the INPUT - we are now looking for related companies instead.
This includes competitors and other companies that are mentioned in the INPUT.

I'll send you some data.
I've added line numbers to the start of each line in the form "1| " - these don't form part of the original data.
I've also added a <META> tag to the start of each segment of the data - this is not part of the original data. This should identify the ID of the segment.
Today's date is {{{date}}} (you can use this to assess the relevance of the segments based on the date in their META section).

You must respond with a JSON array of objects where each entry corresponds to a company that is related to the COMPANY. The object keys are:
- "name": a string that is the name of the company
- "segmentId", a string that is the ID of the segment of the INPUT text that directly relates to the company.
- "range", [int, int], the inclusive range of line numbers that this company is relevant to in the message. Make sure this includes any headings this company appears under (e.g. "Competitors")
- "website": a string that is the URL of the company's website if found, otherwise null
- "description", a concise, 1 sentence description of the company if there's enough information, otherwise null
- "isSubjectCompany": a boolean that is true if this is the COMPANY itself, and false otherwise
- "relationship": an object detailing how the COMPANY is related to this related company. The object keys are:
  - "roleType", one of "competitor" (if it's a company that's being compared to the COMPANY), or "other" (for other companies or venture funds)
  - "subtype": a string that is a more specific description of how the COMPANY is related to this company. This should at most be a few words, and should be null if there's not enough information.

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
      segmentId: z.string(),
      range: z.array(z.number()),
      website: z.string().nullable(),
      description: z.string().nullable(),
      isSubjectCompany: z.boolean(),
      relationship: z.object({
        roleType: z.enum(['competitor', 'other']).catch('other'),
        subtype: z.string().nullable().catch(null),
      }),
    }),
  ),
  fallback: [],
  model: 'gpt-4.1',
} as const);

export { identifyCompanyCompanyRelationsDef };

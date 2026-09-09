import { z } from 'zod';

import { promptDef } from '../definition';

// TODO: extract customer, partner, and investor
const identifyCompanyRelatedEntitiesDef = promptDef({
  description: 'Extract sections of text that relate to other entities.',
  arguments: ['message', 'companyName', 'teamMembers'],
  messages: [
    {
      role: 'system',
      content: `You are a function in a data pipeline.
We receive emails and WhatsApp messages (collectively called "MESSAGES") that contain information about companies that are raising a funding round ("STARTUPS").
We already have information about the STARTUP ({{{companyName}}}) - we are now looking for related entities (companies and people) instead.
This includes team members, advisors, investors, competitors, and other companies that are mentioned in the MESSAGE. We are especially looking for the team members, so look extra hard for those.
You are not looking for the STARTUP itself - DO NOT include it.

We've already identified some team members: {{{teamMembers}}}. We consider these to be already found.

I'll send you a MESSAGE. 
I've added line numbers to the start of each line in the form "1| " - these don't form part of the original message.
I've also added a <META> tag to the start of each segment of the message - this is not part of the original message. This should identify the ID of the segment.

You must respond with a JSON array of objects where each entry corresponds to a company or person. The object keys are:
- "name": a string that is the name of the company or person
- "roleType", one of
    - "team_member" (if it's a person whose main job is at the STARTUP. MUST NOT be a contractor/consultant/advisor/investor),
    - "competitor" (if it's a company that's being compared to the STARTUP)
    - or "other" (for advisors, consultants, investors, and other companies). Advisors may be listed under a separate section
- "subtype": a string that is a more specific type of the company or person (for example, their title or role in the STARTUP, or advisor/investor/consultant)
- "segmentId", a string that is the ID of the segment of the MESSAGE text that directly relates to the company or person.
- "range", [int, int] or null, the inclusive range of line numbers that this entity is relevant to in the message. Make sure this includes any headings this entity appears under (e.g. "Advisors", "Investors", or "Competitors")
- "alreadyFound": a boolean that is true if we've already found the team member and listed them above, and false otherwise

All attributes except "roleType", "segmentId" and "range" are optional and should be null if there is no value.
Do not include any information in your response that is not in the MESSAGE.
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
      roleType: z.enum(['team_member', 'competitor', 'other']).catch(() => 'other' as const),
      subtype: z.string().nullable().optional(),
      name: z.string().nullable().optional(),
      segmentId: z.string(),
      range: z.array(z.number()),
      alreadyFound: z.boolean().nullable().optional(),
    }),
  ),
  fallback: [],
  model: 'gpt-4.1',
} as const);

export { identifyCompanyRelatedEntitiesDef };

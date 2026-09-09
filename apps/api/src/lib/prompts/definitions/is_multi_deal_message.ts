import { z } from 'zod';

import { promptDef } from '../definition';

const isMultiDealMessageDef = promptDef({
  description:
    'Parse a message that contains information about a startup funding round, extracting core information.',
  arguments: ['message', 'userEmail'],
  messages: [
    {
      role: 'system',
      content: `You are a classifier in a data pipeline. You receive messages about investment opportunities.

Sometimes these messages are about a single opportunity - for example, when a founder sends a brief about their company to an investor.
Other times these messages are about multiple opportunities - for example, when an investor sends another investor a list of fundraising companies.

These opportunities may be current or future - these include:
- detailed company briefs
- linkedin profiles of founders or potential founders
- websites
- a reference to a pitch deck attached elsewhere
- funds looking for LPs

Intent matters:
<example>
John Doe (a founder of Doe ltd.) is sending an email to Jane Smith about Acme Corp, which is looking for funding.
Even though John Doe's email signature contains Doe ltd.'s website and John's linkedin url, you ignore them because the message is about Acme Corp.
This case should be considered a single opportunity.
</example>
<example>
All we have is some text:
- Acme Corp website
- a linkedin profile of Jane Doe
This case should be considered a multi-opportunity message.
</example>
<example>
We have some text:
Acme Corp - {John Doe's LinkedIn profile} and {Jane Smith's LinkedIn profile}
This case should be considered a single opportunity, because from the context it appears that John Doe and Jane Smith are both founders of Acme Corp.
</example>
<example>
John Doe (an investor with Doe VC) is sending an email to Jane Smith (who runs a fund-of-funds) to raise money for Doe VC.
John mentions Doe VC's top investments to contextualise his firm - you ignore them because the message is about Doe VC.
</example>
<example>
A long email chain that mentions Acme Corp earlier in the chain, talks about Beta Corp as a potential investment opportunity in the latest message, and mentions Gamma Corp as a potential application of Beta Corp's technology.
This case should be considered a single opportunity, because the recent conversation is all to do with evaluating Beta Corp as an investment opportunity.
</example>

You must respond with a JSON object with the following keys:
- thought: string, your evaluation of the message
- classification: "SINGLE" | "MULTI", the classification of the message

Your response will be parsed as JSON, so the entire response must be valid JSON and start with the character "{".
    `,
    },
    { role: 'user', content: '{{{message}}}' },
  ],
  validator: z.object({
    thought: z.string().nullish(),
    classification: z.enum(['SINGLE', 'MULTI']).catch(() => 'SINGLE' as const),
  }),
  fallback: {
    thought: null,
    classification: 'SINGLE',
  },
  model: 'gpt-4.1',
} as const);

export { isMultiDealMessageDef };

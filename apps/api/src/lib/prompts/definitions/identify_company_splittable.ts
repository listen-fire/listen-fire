import { z } from 'zod';

import { promptDef } from '../definition';

const identifiedCompany = z.object({
  name: z
    .string()
    .nullish()
    .describe(
      'The name of the opportunity. This could be a company, a person, or a fund. If it can\'t be found otherwise you can infer it from a related url or email - e.g. https://www.foo.com would become "Foo"',
    ),
  website: z
    .string()
    .nullish()
    .describe(
      "The website of the opportunity (this should be a valid URL). If unavailable you can infer it from a related email - for example john@foo.com would become https://foo.com. If the website is a known host of files or presentations (for example, docs.google.com, drive.google.com, docsend.com, youtube.com etc), and it doesn't match the name of the opportunity, put null instead",
    ),
  segmentId: z
    .string()
    .nullish()
    .describe('The <ID> from the <META> tag of the <SEGMENT> that this opportunity was found in.'),
  range: z
    .tuple([z.int(), z.int()])
    .nullish()
    .describe('The inclusive range of line numbers that are about this opportunity.'),
});

const identifiedCompanies = z.array(identifiedCompany);

const identifyCompanySplittableDef = promptDef({
  description:
    'Parse a message that contains information about a startup funding round, extracting core information.',
  arguments: ['message', 'userEmail'],
  messages: [
    {
      role: 'system',
      content: `You are a function in a data pipeline. You receive messages about investment opportunities.

These messages are each about multiple opportunities - for example, when an investor sends another investor a list of fundraising companies.

These opportunities may be current or future - these include:
- detailed company briefs
- linkedin profiles of founders or potential founders
- websites
- a reference to a pitch deck attached elsewhere
- funds looking for LPs

Intent matters:
<example>
John Doe (a founder of Doe ltd.) is sending an email to Jane Smith about Acme Corp and Beta Corp, who are looking for funding.
Even though John Doe's email signature contains Doe ltd.'s website and John's linkedin url, you ignore them because the message is about Acme Corp and Beta Corp.
</example>
<example>
Acme Corp - {John Doe's LinkedIn profile} and {Jane Smith's LinkedIn profile}
This case should be considered a single opportunity, because from the context it appears that John Doe and Jane Smith are both founders of Acme Corp.
</example>
<example>
A newline-separated list of company websites and linkedin profiles, with no further context, should be considered as separate opportunities.
</example>

The user will send you a message.
The message has been modified to add line numbers to the start of each line in the form "1| " - these don't form part of the original message.
A <META> tag has been added to the start of each segment of the message - this is not part of the original message. This should identify the ID of the segment.

You must respond with an array of JSON objects where the keys are:
- "name": string or null, the name of the opportunity. This could be a company, a person, or a fund. If it can't be found otherwise you can infer it from a related url or email - e.g. https://www.foo.com would become "Foo".
- "website": string or null, the website of the opportunity (this should be a valid URL). If unavailable you can infer it from a related email - for example john@foo.com would become https://foo.com. If the website is a known host of files or presentations (for example, docs.google.com, drive.google.com, docsend.com, youtube.com etc), and it doesn't match the name of the opportunity, put null instead
- "segmentId", string or null, the ID of the segment of the message that this STARTUP is relevant to. If this is the only primary subject in the message, this should be null.
- "range", [int, int] or null, the inclusive range of line numbers that this STARTUP is relevant to in the message. If this is the only primary subject in the message, this should be null.
- "text": string or null, the full text of the message, ommiting all mentions of other opportunities.

All attributes are optional and should be null if there is no value.
Do not include any information in your response that is not in the MESSAGE.

Your response will be parsed as JSON, so the entire response must be valid JSON and start with the character "[".
    `,
    },
    { role: 'user', content: '{{{message}}}' },
  ],
  validator: identifiedCompanies,
  model: 'gpt-4.1',
} as const);

export { identifyCompanySplittableDef };

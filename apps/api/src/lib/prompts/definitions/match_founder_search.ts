import { z } from 'zod';

import { promptDef } from '../definition';

// We need to use something smarter than a simple string match here
// For example, if the company is "Foo" and the person is "John Smith",
// we'd want to accept "Johnny S, Foo Inc." as a match
const matchFounderSearchDef = promptDef({
  description: 'Find the founder(s) of a company from the output of a Google search.',
  arguments: ['company', 'company_description', 'items'],
  messages: [
    {
      role: 'system',
      content: `Your function is to find the founder(s) of a company from the output of a Google search.
The input is the company name and description of the company.
I will also give you the Google search results, which will be in the form of a numbered list.
You must respond with an JSON array of objects where each element corresponds to a search result, and has keys:
  - "number": the number of the search result
  - "name": the name of the person in the search result
  - "is_match": a boolean indicating whether the result matches the person. Sometimes they might not list their company on their profile - in that case, you should still match them if the name and description match. A completely different name should result in false.
The results are sorted by Google's relevance, so the earlier the result, the more likely the match.

When you reply, you're not actually replying to the user: instead, you're producing JSON output for a machine to process.
Your response must start with an opening square bracket, and end with a closing square bracket.
      `,
    },
    {
      role: 'user',
      content: `
      company: {{{company}}}
      description: {{{company_description}}}

      Search results:
      {{{items}}}
      `,
    },
  ],
  fallback: [],
  model: 'gpt-4.1',
  validator: z.array(
    z.object({
      number: z.number(),
      name: z.string(),
      is_match: z.boolean(),
    }),
  ),
} as const);

export { matchFounderSearchDef };

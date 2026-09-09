import { promptDef } from '../definition';

const generateTeaserSummaryDef = promptDef({
  description: 'Generate a teaser summary of a startup funding round.',
  arguments: ['summary'],
  messages: [
    {
      role: 'system',
      content: `
You have previously generated a summary for a STARTUP.

I'll send you back the summary you generated.
Please write a concise and anonymised tag line about what the company does.
It should be a single sentence no more than 15 words long.
You MUST NOT include any information that could be used to identify the company or any people involved.
Disclosing that private information could seriously compromise their privacy and damage our reputation - so you MUST omit all names of companies and people.

Good example:
"Using AI to accelerate the development of new batteries."

Bad examples:
"The company uses AI to accelerate the development of new batteries."
"BatteryCo: Using AI to accelerate the development of new batteries."

Only include details that are present in the summary you generated.
Your response will be shown directly as part of a larger response, so a blank response is much better than "I don't know".
`,
    },
    { role: 'user', content: '{{{summary}}}' },
  ],
} as const);

export { generateTeaserSummaryDef };

import { promptDef } from '../definition';

const processWebsiteDef = promptDef({
  description: 'Remove unwanted content from a website.',
  arguments: ['websiteContent'],
  messages: [
    {
      role: 'system',
      content: `
Here's the content of a landing page of a company in Markdown. 
Please created a detailed summary of the content.
Exclude any funding information or any other personal information.
Focus on what the company does.
`,
    },
    { role: 'user', content: '{{{websiteContent}}}' },
  ],
} as const);

export { processWebsiteDef };

import { promptDef } from '../definition';

const combineDealSummariesDef = promptDef({
  description: 'Combine multiple summaries of a startup funding round into a single summary.',
  arguments: ['summary1', 'summary2'],
  messages: [
    {
      role: 'system',
      content: `
You have previously generated some summaries for a STARTUP.
Your instructions in each case were:
BEGIN INSTRUCTIONS
Your task is to generate a summary in English.

Each paragraph should be no more than 3 sentences, and should be written in telegraphic style, as if you're taking concise notes.
Remove subject and auxiliary verbs where possible.
Don't number the paragraphs.

Paragraph 1 should be a summary of what the STARTUP does. If there's insufficient information about what the STARTUP does, skip this paragraph.
Paragraph 2 should be a summary of their progress to date. If there's insufficient information about their progress to date, skip this paragraph.
Paragraph 3 should be a summary of the funding round. If there's insufficient information about the funding round, skip this paragraph.

If there is anything else of note, please also state it concisely.

Everything stated in the summary MUST exist in the MESSAGE. Use parts of the MESSAGE verbatim if possible.
END INSTRUCTIONS

I'll send you back the summaries you generated in consecutive messages.
Please combine them into a single summary following the original instructions.
`,
    },
    { role: 'user', content: '{{{summary1}}}' },
    { role: 'user', content: '{{{{summary2}}}' },
  ],
} as const);

export { combineDealSummariesDef };

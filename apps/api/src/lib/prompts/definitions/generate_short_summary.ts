import { promptDef } from '../definition';

const generateShortSummaryDef = promptDef({
  description: 'Generate a short summary of a startup funding round.',
  arguments: ['summary'],
  messages: [
    {
      role: 'system',
      content: `
You have previously generated a summary for a STARTUP.
Your instructions was:
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

I'll send you back the summary you generated.
Please write a very concise set of bullet points (no more than a sentence each):
- What does the STARTUP do?
- What is their progress or traction so far?
- What is the experience of the team?
- Details of the funding round

Be very minimal: we want only the most important information and for it to be easily digestible as a glance.
Feel free to cut out information that you feel might compromise the "punchiness" of the summary.
You're allowed to mention the experience of the team, but don't just list people.
These should be extremely short-form notes. Maximum 4 bullet points.

An example of a good summary:
"
Parsing and virtualising study code from clinical trials to build out the largest medical code repository.
- founded by Tomas Sabat, who was on the founding team of TypeDB, and Henning Kuich, who did a PhD in Systems Biology and joined Bayer's IT team to build out the first blueprint for patient data in the cloud, and a patient research database.
- $1M pre-seed round, no more room left for angels
"

If you don't know the answer to any of these questions, skip that bullet point.
Only include details that are present in the summary you generated.
Your response will be shown directly as part of a larger response, so a blank response is much better than "I don't know".
`,
    },
    { role: 'user', content: '{{{summary}}}' },
  ],
} as const);

export { generateShortSummaryDef };

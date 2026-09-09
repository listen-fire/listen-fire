import { z } from 'zod';

import { promptDef } from '../definition';

const generatePersonSummaryDef = promptDef({
  description:
    'Parse a message that contains information about a startup funding round, extracting core information.',
  arguments: ['message', 'companyName', 'personName'],
  messages: [
    {
      role: 'system',
      content: `# Instructions

You are a function in a data pipeline.
We receive MESSAGES that each contain information about a company that is raising a funding round.
Let's call these companies "STARTUPS".
I'll send you some information about a person ({{{personName}}}) related to a STARTUP.
Consider STARTUP_NAME to be the name of the STARTUP, which in this case is {{{companyName}}}.

Summaries should be written in English.
Each summary should be no more than 2 sentences, and should be written in telegraphic style, as if you're taking concise notes. Prefer full stops to semicolons.
Everything stated in a summary MUST exist in the MESSAGE.

You MUST AVOID jargon, buzzwords, and corporate speak (even if the MESSAGE uses it). Phrases like "deep industry knowledge", "high tech", "professionals", "extensive" and "revolutionising" will disappoint the user.
The more concise the summary, the better. The purpose of these summaries is to get the critical information across in as few words as possible.
If you can't find enough important details, put null.

# Fields

## summary

A concise summary of the person and why they're well suited to succeed with this startup.
The aim is for the reader to get the critical signal on this person as quickly as possible.
Don't offer an opinion: just state the facts.
Don't mention what they do at {{{companyName}}}: we're showing this separately. If they've recently founded a stealth startup where the name isn't mentioned, it's probably {{{companyName}}}, so don't mention that.

Negative example: "John Smith is a senior engineering operations leader with experience in innovative automotive startups and has developed a Modular Build Platform."

Positive example: "A technical leader with experience in automotive startups. Developed a Modular Build Platform."
This is good because it doesn't mention John by name (that's shown elsewhere), is concise, doesn't use jargon ("innovative"), and covers core experience that tells the reader their strengths.

It's often not necessary to include their name in the summary - anything indicating why they are likely to succeed is much more important.
Try aggregating their experience and skills to save the reader time, but keep it plain - I'd rather hear "Background in organic chemistry" than "Extensive background in organic chemistry".

Important details include:
- if they've founded before and if there was an exit
- if they have a lot of experience in a particular domain
- if they've previously worked somewhere extremely high-signal (e.g. "Ex-Deepmind").

# Format

Please respond with a JSON object where the keys are:
- "summary"
- "summaryWasBad" - true if the summary was bad according to the rules and examples above, false otherwise

Only reply with this format. Translate the MESSAGE into English if necessary. Do not include any information that isn't in the MESSAGE and do not add any additional attributes to the JSON object.
All attributes are optional and should be null if there is no value or there's .
You must output one JSON object. If multiple STARTUPs are listed, you should only output the one corresponding to {{{companyName}}}.

When you reply, you're not actually replying to the user: instead, you're producing JSON output for a machine to process.
    `,
    },
    { role: 'user', content: '{{{message}}}' },
  ],
  validator: z
    .object({
      summary: z.string().nullable().optional(),
      summaryWasBad: z.boolean().nullable().optional(),
    })
    .nullable(),
  fallback: {
    summary: null,
  },
  model: 'gpt-4.1',
} as const);

export { generatePersonSummaryDef };

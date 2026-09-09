import { z } from 'zod';

import { promptDef } from '../definition';

const MatchEntityResponse = z.object({
  matches: z.array(
    z.object({
      entityId: z.string(),
      confidenceLevel: z.number(),
      isPortfolio: z.boolean(),
      reasoning: z.string(),
      match: z.enum(['YES', 'NO', 'MAYBE']),
    }),
  ),
});
const matchEntitiesDef = promptDef({
  description: 'Extract metrics from an investor update.',
  arguments: ['query', 'entities'],
  messages: [
    {
      role: 'user',
      content: `
      You are an expert entity resolution specialist with deep knowledge of business names, corporate structures, and industry terminology. Your task is to determine which of the candidate entities match the query entity.

## Context
You need to identify when two entities refer to the same company, even with variations in naming, legal structure, or presentation.

Some key insights for this task:
- Companies may have slight variations in spelling or legal suffixes (LLC, Inc, GmbH)
- Name similarities alone can be misleading - industry context is critical
- Companies in different industries (e.g., "Health" vs "Tech") are likely different entities
- Similar domains in URLs provide strong evidence of a match
- Matching social media accounts provide very strong evidence
- Consider acronyms and normalized forms (e.g., "International Business Machines" vs "IBM")

## Query Entity
{{{query}}}

## Candidate Entities
[
{{{entities}}}
]

## Task
For each candidate entity, determine if it represents the same company as the query entity.
For each match, provide:
1. Match Type: "Yes" (same entity), "No" (different entity), or "Maybe" (uncertain)
2. Confidence: 1-5 scale where 5 is highest confidence
3. Brief reasoning explaining your decision

`,
    },
    { role: 'user', content: '{{{content}}}' },
  ],
  response: MatchEntityResponse,
} as const);

export { matchEntitiesDef, MatchEntityResponse };

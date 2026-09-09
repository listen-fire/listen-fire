import { z } from 'zod';

import { promptDef } from '../definition';

const classificationSchema = z.object({
  extractionGraphId: z.string(),
});

const classifyMessageTypeDef = promptDef({
  description: 'Classify a message to determine which extraction graph to use',
  arguments: ['candidates', 'content'],
  model: 'claude-haiku-4-5-20251001',
  messages: [
    {
      role: 'system',
      content: `You are a message classification system for a knowledge extraction pipeline.
Given a message and a list of extraction graph options, determine which extraction graph best matches the message content.
Each extraction graph is designed for a specific type of message and extracts different information.

Return a JSON object with "extractionGraphId" set to the ID of the best matching extraction graph.
If the message doesn't clearly match any graph, pick the closest one.`,
    },
    {
      role: 'user',
      content: `## Extraction Graphs

{{{candidates}}}

## Message Content

{{{content}}}`,
    },
  ],
  response: classificationSchema,
  validator: classificationSchema,
} as const);

export { classifyMessageTypeDef };

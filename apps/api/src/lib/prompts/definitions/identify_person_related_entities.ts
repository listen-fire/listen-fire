import { z } from 'zod';

import { promptDef } from '../definition';

const identifyPersonRelatedEntitiesDef = promptDef({
  description: 'Extract sections of text that relate to other entities.',
  arguments: ['message', 'companyName', 'personName'],
  messages: [
    {
      role: 'system',
      content: `You are a function in a data pipeline.
We receive emails and WhatsApp messages (collectively called "MESSAGES") that contain information about companies that are raising a funding round ("STARTUPS").
We already have information about the STARTUP ({{{companyName}}}) and a PERSON ({{{personName}}}) related to that company - we are now looking for entities (companies and people) relating to the PERSON instead.
This includes previous workplaces and other companies related to the PERSON that are mentioned in the MESSAGE.
DO NOT include the STARTUP itself. Do not include the PERSON.

I'll send you a MESSAGE. You must respond with a JSON array of objects where the values correspond to the MESSAGE_FRAGMENTS. The object keys are:
- "name": a string that is the name of the entity
- "roleType", one of
    - "previous_workplace" (if it's a company that the person worked at previously, or currently works at in addition to the STARTUP),
    - or "other" (for anything else)
- "subtype": a string that is a more specific type of the entity
- "segmentId", a string that is the ID of the segment of the MESSAGE text that directly relates to the entity.
- "range", [int, int], the inclusive range of line numbers that this entity is relevant to in the message. Make sure this includes any headings this entity appears under

All attributes except "type" and "content" are optional and should be null if there is no value.
Do not include any information in your response that is not in the MESSAGE.
If the MESSAGE doesn't include any entities other than the STARTUP or PERSON you must respond with an empty JSON array.
If the MESSAGE is not about a STARTUP or PERSON you must respond with an empty JSON array.
If for any reason you're unable to produce an array of objects, you must respond with an empty JSON array.
Your response will be parsed as JSON, so the entire response must be valid JSON and start with the character "[".
        `,
    },
    {
      role: 'user',
      content: '{{{message}}}',
    },
  ],
  validator: z.array(
    z.object({
      roleType: z.enum(['previous_workplace', 'other']).nullable().optional(),
      subtype: z.string().nullable().optional(),
      name: z.string().nullable().optional(),
      segmentId: z.string(),
      range: z.array(z.number()),
    }),
  ),
  model: 'gpt-4.1',
} as const);

export { identifyPersonRelatedEntitiesDef };

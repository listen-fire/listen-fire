import { z } from 'zod';

import { promptDef } from '../definition';

const identifiedEntity = z
  .object({
    name: z.string().nullable().optional(),
    nameInferred: z.string().nullable().optional(),
    nameFallback: z.string().nullable().optional(),
    email_addresses: z.array(z.string()).nullable().optional(),
    website: z.string().nullable().optional(),
    website_matches_name: z.boolean().nullable().optional(),
    type: z.enum(['company', 'founder', 'investor', 'fund', 'other']).nullable().optional(),
  })
  .nullable()
  .transform((value) => {
    if (value === null) {
      return null;
    }

    const isPerson = ['founder', 'investor'].includes(value.type ?? '');

    return {
      name:
        value.name && isPerson
          ? `${value.name}'s Startup`
          : value.name ?? value.nameInferred ?? value.nameFallback ?? null,
      website: value.website_matches_name && !isPerson ? value.website ?? null : null,
    };
  });

// TODO: ignore the user's organisation? Risks issues where we want to legitimately link a startup to the user's organisation - it just causes problems for external integrations
// We may be able to trust the metadata that the user's message is formatted with
const identifyEntityFromRequestDef = promptDef({
  description:
    'Parse a message that contains information about an entity, extracting core information.',
  arguments: ['message', 'userEmail'],
  messages: [
    {
      role: 'system',
      content: `You are a function in a data pipeline.

You will be sent a request from a user about an entity (like startups, founders, investors, funds, etc).

This request has one particular entity as the subject. It is typically the most actionable thing in the text: the entity that the user is asking about.

This entity will NOT be the organisation that the pipeline user belongs to, so disqualify any organisation that matches the domain of the pipeline user's email ({{{userEmail}}}).

You must respond with a JSON object where the keys are:
- "name" (string | null), name of the entity.
- "email_addresses" (string[]), an array of email addresses that are associated with the entity
- "website" (string | null), the entity's website. You should format this as a valid URL. If not specified in the INPUT, you should infer it from one of the email addresses associated with the entity. For example, if the company is "Foo", and someone who works there has the email address "joe@getfoo.com", you should conclude that the company's website is "https://getfoo.com"
- "nameInferred" (string | null), if you've found the name, this should be null. Otherwise, infer the name from any websites or email addresses e.g. https://www.foo.com would become "Foo"
- "nameFallback" (string | null), if you've found or inferred the name, this should be null. Otherwise, this should be a concise description of the entity (max 5 words).
- "website_matches_name" (boolean | null), a boolean indicating whether the website is similar enough to the name of the entity so we can infer if the website is the real website of the entity.
- "type", one of the following options that best describes the entity:
    - "company",
    - "founder",
    - "investor",
    - "fund",
    - "other"
- "email" (string | null), if the entity is a person, the email address of the person
- "linkedin" (string | null), if the entity is a person, the LinkedIn profile URL of the person

Do not include any information in your response that is not in the INPUT (unless you've been explicitly instructed to infer it in this system prompt).

Your response will be parsed as JSON, so the entire response must be valid JSON and start with the character "{".

Good description:
"Using AI to accelerate the development of new batteries."

Bad description:
"The company uses AI to accelerate the development of new batteries."
"BatteryCo: Using AI to accelerate the development of new batteries."
    `,
    },
    { role: 'user', content: '{{{message}}}' },
  ],
  fallback: null,
  validator: identifiedEntity,
  model: 'gpt-4.1',
} as const);

export { identifyEntityFromRequestDef };

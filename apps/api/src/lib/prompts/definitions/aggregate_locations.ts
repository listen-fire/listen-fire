import { z } from 'zod';

import { promptDef } from '../definition';

const aggregateLocationsDef = promptDef({
  description: 'Aggregate a list of locations into a single list.',
  arguments: ['locations'],
  messages: [
    {
      role: 'system',
      content: 'Your job is to product a small list of locations as a JSON array.',
    },
    {
      role: 'user',
      content: `Condense the following list of locations into a small list.
You must convert cities to countries.
You must generalise to a geopolitical region if there are several entries for that region. If there is only one entry for that region, retain the country.

Locations:
{{{locations}}}

You must output a JSON array (type string[]) of locations and nothing else. If there are no locations or there's any other reason you can't fulfil this request, output an empty array.
`,
    },
  ],
  validator: z.array(z.string()),
  fallback: [],
} as const);

export { aggregateLocationsDef };

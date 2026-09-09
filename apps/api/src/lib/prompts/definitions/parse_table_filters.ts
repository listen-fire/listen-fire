import { z } from 'zod';

import { promptDef } from '../definition';

const filterSchema: z.ZodType<FilterItem> = z.object({
  columnId: z.string(),
  operator: z.enum([
    'eq',
    'neq',
    'gt',
    'gte',
    'lt',
    'lte',
    'contains',
    'not_contains',
    'starts_with',
    'ends_with',
    'is_empty',
    'is_not_empty',
    'in',
  ]),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  values: z.array(z.string()).optional(),
  negated: z.boolean().optional(),
  group: z
    .object({
      conjunction: z.enum(['and', 'or']),
      filters: z.lazy(() => z.array(filterSchema)),
    })
    .optional(),
});

export type FilterItem = {
  columnId: string;
  operator: string;
  value?: string | number | boolean | null;
  values?: string[];
  negated?: boolean;
  group?: { conjunction: 'and' | 'or'; filters: FilterItem[] };
};

const parseTableFiltersDef = promptDef({
  description: 'Parse a natural language query into structured table filters.',
  arguments: ['query', 'columns'],
  messages: [
    {
      role: 'system',
      content: `You convert natural language queries into structured table filters.

You'll receive the available columns with their types, and a user query. Return an array of filter objects.

Each filter has:
- "columnId": the column ID to filter on
- "operator": one of: eq, neq, gt, gte, lt, lte, contains, not_contains, starts_with, ends_with, is_empty, is_not_empty, in
- "value": the filter value (string, number, or boolean). For dates use ISO format (YYYY-MM-DD).
- "values": array of strings (only for "in" operator)
- "negated": set to true to negate the filter (e.g. "not contains X")

For OR conditions, wrap the alternatives in a group object:
- "columnId": "" (empty — this is a group wrapper)
- "operator": "eq" (ignored — placeholder)
- "group": { "conjunction": "or", "filters": [ ...filters ] }

Top-level filters are combined with AND by default. Use a group with conjunction "or" when the user says "or", "either...or", or similar.

Examples:
- "status is Active or Pending" → [{ columnId: "", operator: "eq", group: { conjunction: "or", filters: [{ columnId: "status_id", operator: "eq", value: "Active" }, { columnId: "status_id", operator: "eq", value: "Pending" }] } }]
- "revenue > 1M and (stage is Series A or Series B)" → [{ columnId: "revenue_id", operator: "gt", value: 1000000 }, { columnId: "", operator: "eq", group: { conjunction: "or", filters: [{ columnId: "stage_id", operator: "eq", value: "Series A" }, { columnId: "stage_id", operator: "eq", value: "Series B" }] } }]
- "not in San Francisco" → [{ columnId: "location_id", operator: "eq", value: "San Francisco", negated: true }]

Operator guidelines by type:
- text: prefer "contains" for partial matches, "eq" for exact
- number: use comparison operators (eq, gt, lt, gte, lte)
- date: use "gt" for "after", "lt" for "before", "eq" for exact date. For relative dates like "last 30 days", compute the date relative to today.
- boolean: use "eq" with true/false
- enum columns (listed with their values): use "eq" for single value, "in" for multiple. IMPORTANT: pay close attention to the available enum values — match user intent to the closest enum value even if the wording differs (e.g. "passed on" → "Pass", "turned down" → "Rejected", "hot deals" → "Active").

CRITICAL: You MUST always produce at least one filter. Think creatively about which columns best match the user's intent:
- Map synonyms and natural language to the closest available columns and enum values
- If the user refers to a concept that maps to an enum column, check the enum values carefully for the closest match
- Use "contains" on text columns for fuzzy keyword matching when appropriate
- Only as a last resort if truly no column can be mapped, return an empty array

Today's date is ${new Date().toISOString().slice(0, 10)}.

Respond with a JSON array of filter objects.
Your response will be parsed as JSON, so the entire response must be valid JSON and start with "[".`,
    },
    {
      role: 'user',
      content: `Columns:\n{{{columns}}}\n\nQuery: {{{query}}}`,
    },
  ],
  validator: z.array(filterSchema),
  fallback: [],
  model: 'gpt-4.1',
  temperature: 0,
} as const);

export { parseTableFiltersDef };

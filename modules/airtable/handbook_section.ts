// Airtable's conceptual authoring documentation — what an author should know
// about Airtable before listening to it. Assembled into the automation
// handbook as the `system:airtable` chapter, and bound by the same contract as
// every hand-written chapter (consumer-neutral prose, no internal vocabulary).
//
// The one thing worth teaching here is that a listen walks to the table it
// hears by name, and keeps walking there: a table renamed into the filter is
// heard from then on.

import type { AdapterManifest } from 'movement-engine/public/adapter';

type HandbookSection = NonNullable<AdapterManifest['handbookSection']>;

export const AIRTABLE_HANDBOOK_SECTION: HandbookSection = {
  title: 'Airtable — listening to a table by name',
  content: `## Airtable — listening to a table by name

A listen on Airtable walks from the connection to a base, from the base to one of its tables, and ends on that table's \`Changes\`. Each hop is narrowed by its name, so the listen says which table it means the way a person would.

### listening-to-a-table

\`\`\`
listen to at-[b:Bases WHERE b.Name == "Finance"]->-[t:Tables WHERE t.Name == "Expenses"]->-[c:Changes WHERE c.Kind == "created"]-> fire review
\`\`\`

A change says what happened to a row: \`Kind\` is \`created\`, \`updated\` or \`deleted\`. An update names the field it touched in \`Field\`, with what it held before in \`Old\` and what it holds now in \`New\`; an update of two fields is two changes. \`c-[:Record]->\` is the row as the change left it, every field by name.

### when-a-field-becomes-a-value

\`\`\`
listen to hiring-[t:Tables WHERE t.Name == "Candidates"]->-[c:Changes WHERE c.Field == "Stage" AND c.New == "Interview"]-> fire schedule
\`\`\`

A connection started at its base (\`connect airtable using … { base: "Hiring" }\`) begins at that base's tables, so its listens start at \`Tables\`.

### a-renamed-table

The bases and tables a listen names are looked up again whenever Airtable reports that a base's tables changed: a table renamed to "Expenses" is heard from that moment, and the one renamed away from it no longer is. Changes a table had before it matched are never replayed. \`listen-fire listens\` shows which tables a listen hears now and when they were last looked up.

### webhooks-per-base

Each base a listen reaches costs two Airtable webhooks, however many of its tables the listen hears: one for its rows, one for its tables' names. Airtable lets one connected app make only two webhooks on a base, so a second connection to the same base (another credential, or one started at the base beside one that walks to it) is refused by Airtable when it registers its own.
`,
};

// Affinity's conceptual authoring documentation — what an author should know
// about Affinity BEFORE instantiating it. Assembled into the automation
// handbook as the `system:affinity` chapter, and bound by the same contract as
// every hand-written chapter (consumer-neutral prose, no internal vocabulary).
//
// The one thing worth teaching here is that a list is a TYPE: naming the list
// on the write decides what the row can carry, and the handle the write hands
// back stands on that list — which is what makes its relationships reachable.

import type { HandbookSection } from '../../../../lib/handbook_section';

export const AFFINITY_HANDBOOK_SECTION: HandbookSection = {
  title: 'Affinity — lists, and the people attached to a row',
  content: `## Affinity — lists, and the people attached to a row

Adding a company to a list is a write along that company's \`List Entries\` edge, with the list named in the body. Naming it is what decides everything else: a list's own fields — a stage, a score, whoever looks after it — belong to that list and to no other, so the list you name is the surface the rest of the write is checked against.

### adding-a-record-to-a-list

\`\`\`
entry = write company-[:\`List Entries\`]-> {
  listName: "Priority Accounts"
  \`Stage Order\` ?: "New"
  Status ?: "Open"
}
\`\`\`

\`listName\` is the list's own name, written as a fixed value rather than computed. Fields are spelled the way that list shows them, with no list name in front.

A company sits on a list once, so the row is identified by the pair — the company, and the list. Running this again updates the row already there: \`?:\` fills only what is still empty, and a value that has not changed is not written at all.

### attaching-people-to-a-row

A list field holding people is a relationship, so it is asserted rather than set. \`link\` points it at somebody who already exists:

\`\`\`
d-[o:owners]-> {
  link entry -[:Owners]-> { Name: o.name }
}
\`\`\`

\`entry\` is the handle the write above handed back, and it stands on the list it named — so that list's own relationships (\`Owners\`, \`Scouted By\`) are reachable from it, and nothing else's are.

The body is match criteria only: nobody is created, and nothing about the person found is changed. Somebody who cannot be found is skipped quietly, so walking a list of names attaches the ones that resolve. \`unlink\` takes one back off; severing what was never there does nothing.

### Common mistakes

- **Writing one block per name.** A name is a value like any other — walk the names you have and \`link\` inside the walk.
- **Computing the list name.** The list decides which fields exist, so it has to be known while the program is being written, not while it runs.`,
};

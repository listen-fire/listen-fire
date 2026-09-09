import type { Chapter } from '../types';

export const identity: Chapter = {
  id: 'identity',
  title: 'Identity and de-duplication',
  content: `## Identity and de-duplication

When information arrives — an email mentions "Acme", a meeting note
mentions "Acme Corp" — the system has to decide: is this the Acme we
already track, or something new? Identity rules are how you teach it the
answer. A type without identity rules accumulates duplicates; a type
with rules that are too loose merges things that should stay apart.

### How a rule is built

An identity rule is a list of conditions that must ALL hold for two
entries to count as the same thing. A type can carry several rules; if
ANY one rule matches in full, the entries are merged.

The conditions you can combine:

- **an exact field match** — \`Email\` means "same email address". Best
  when the field is a genuine unique handle: email, ticker, registration
  number, URL.
- **an approximate field match** — \`FUZZY(Name)\` means "the names are
  close enough" — "Acme" and "Acme Corp." match; "Acme" and "Apex" do
  not. Use this for human-written names, which never arrive twice the
  same way.
- **a shared connection** — \`-[:Company]->\` means "linked to the same
  company". This scopes identity by context: two deals called "Series A"
  are the same deal only if they belong to the same company.
- **a recency window** — \`WITHIN(first_seen, "6 months")\` means "the
  existing entry first appeared within the last 6 months". Use it when
  repeats should update a *recent* entry but an old entry should stay
  historical — a new entry is created instead of reviving it.

### Patterns that cover most types

| Situation | Rule |
|---|---|
| Things identified by name | \`FUZZY(Name)\` |
| Things with a unique handle | \`Email\` (or \`Ticker\`, \`URL\`, …) |
| Same name only means same thing in context | \`FUZZY(Name) AND -[:Company]->\` |
| Repeats update recent entries, old ones stay historical | \`FUZZY(Name) AND WITHIN(first_seen, "1 year")\` |
| Several independent ways to identify | two rules: \`Name\`, \`Ticker\` — either match suffices |

### A worked example

A fund tracks Companies and the funding Rounds they raise:

- **Company**: one rule, \`FUZZY(Name)\` — company names arrive in many
  spellings, and there is no risk of two different portfolio companies
  sharing a near-identical name at this scale.
- **Round**: one rule, \`FUZZY(Name) AND -[:Company]->\` — every company
  has a "Seed" round, so the name alone identifies nothing. The shared
  company connection is what makes the name meaningful.
- **Person**: two rules, \`Email\` and \`FUZZY(Name) AND -[:Organisation]->\`
  — an email match settles it outright; failing that, a close name at
  the same organisation is the same person.

### Common mistakes

- **No rules at all.** Every mention creates a fresh entry and the model
  silts up with duplicates. Set identity rules as soon as a type exists.
- **Exact match on human-written names.** "Acme Corp" vs "Acme Corp."
  becomes two companies. Names want approximate matching.
- **Identity on an ambiguous field alone.** "Series A" matches every
  Series A everywhere. If a name only means something in context, AND it
  with the connection that provides the context.
- **Merging across time when history matters.** If "Q3 Review" should be
  a fresh entry each year, add a recency window rather than letting this
  year's review overwrite last year's.`,
};

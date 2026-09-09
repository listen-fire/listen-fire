import type { Chapter } from '../types';

export const changing: Chapter = {
  id: 'changing',
  title: 'Changing data in conversation',
  content: `## Changing data in conversation

The same conversation that answers questions can change the data:
create entries, update fields, connect things, merge duplicates, and
delete. Everything you state is validated against your knowledge model
— field names, allowed values, which relationships are permitted
between which types — so a change either lands cleanly or you're told
exactly why not.

### Stating facts

A plain statement is an instruction. "Meridian's website is
meridian.io" finds the Meridian entry and updates the field. "Sarah
Lin joined Meridian as CFO" creates Sarah if she isn't known, and
records the connection with her role — you don't have to spell out
which entries and fields are involved.

Two behaviours worth knowing:

- **missing things are created with what you gave.** A relationship
  statement about someone new doesn't stall asking for their email and
  title; the entry is created with the name, and details can arrive
  later;
- **clear instructions execute directly.** The assistant acts and then
  reports what it did. Only genuinely ambiguous instructions come back
  as options to choose between.

### Updating and clearing

"Set the stage to Closed", "clear the fee on the Meridian engagement",
"mark these three as dormant" — updates name the entity and the field.
For fields with a fixed list of allowed values, the value must be one
of the list; the assistant will tell you the valid options if not.

### Merging duplicates

When two entries turn out to be the same real thing — "Acme" and "Acme
Corp" — ask to merge them. One entry survives and absorbs everything
from the other: its field values, its connections, and the history of
where each fact came from. Merging is the cleanup tool for duplicates
that slipped past the model's identity rules (and a hint: if the same
duplicate keeps appearing, the type's identity rules need tightening —
see the knowledge-model handbook).

### Bulk changes

Changes can be batched in one instruction: "add these five people…",
"mark every engagement with no activity since January as dormant". For
a bulk change driven by a condition, it's worth asking for the list
first — "which engagements have no activity since January?" — checking
it, then saying "mark all of those dormant".

### Deleting

Deleting an entry removes it with its field values and its connections.
It is the right tool for things that should never have existed (test
entries, misfiled extractions). For two entries describing the same
real thing, merge instead — deleting one discards the half of the
history it carried.

### Common mistakes

- **Spelling out mechanics instead of stating the fact.** "Create a
  person entry, then a connection of type member-of…" — just say
  "Sarah works at Meridian".
- **Deleting duplicates instead of merging.** A delete throws away the
  facts and history the duplicate held; a merge keeps both halves.
- **Bulk-changing on an unchecked condition.** Look at the list before
  sweeping a change across it.
- **Withholding a fact until you have all the details.** Record the
  connection with a name alone; enrich it when the details arrive.`,
};

import type { Chapter } from '../types';

export const editing: Chapter = {
  id: 'editing',
  title: 'Evolving a live model',
  content: `## Evolving a live model

A knowledge model is never finished — new kinds of information show up,
a field turns out to be a relationship, a type splits in two. This
chapter covers how to make changes safely once real data is flowing
through the model.

### Where edits happen

The model is edited in conversation with the assistant (and in the
model editor). Describe the change in your own terms — "I want to track
board seats", "split Contact into Person and Organisation" — and review
the plan it proposes before it builds. A good plan names every piece:
the entity types to add, the fields on each, the relationships with
their two names, and the identity rules.

### The order of construction

Pieces reference each other by name, so build in dependency order:

1. **entity types** first;
2. **fields** on those types;
3. **relationships** between them;
4. **identity rules** last — they refer to fields and relationships by
   name, so everything they mention must already exist.

The same order applies to any extension: adding "track which partner
leads each deal" means a relationship first, then the identity rule
that uses it.

### Deletes cascade

Deleting reaches further than the thing you name:

- deleting an **entity type** removes all its fields, every relationship
  touching it, and its role in extraction;
- deleting a **relationship** removes the fields on that relationship.

Before deleting, ask what hangs off the thing — and prefer renaming or
repurposing a type over delete-and-recreate, which orphans the existing
entries.

### Changes and existing data

Structural edits apply to the structure; they do not rewrite history by
themselves:

- a **new field** starts empty on existing entries and fills as new
  information arrives or as you backfill;
- a **new fixed-value list** on an existing field constrains future
  values; existing out-of-list values need cleaning up;
- **new identity rules** govern future arrivals — existing duplicates
  are cleaned up by merging them (see the querying handbook), not
  retroactively.

### A worked change

"We started co-investing, so a Round can involve several investors and
we care who led."

1. No new entity types — Investor and Round exist.
2. Add a relationship Investor *Participates In* / Round's
   *Participants*.
3. Put **Amount** and **Lead?** on the relationship — they are facts
   about each investor's part in the round, not about either entity.
4. Identity rules don't change; but note Round's existing rule (name +
   same company) keeps working precisely because it never depended on
   who invested.

### Common mistakes

- **Building before agreeing the plan.** A misunderstood model is
  expensive to unwind once data flows through it. Review the proposed
  shape first.
- **Delete-and-recreate to rename.** Recreating a type severs existing
  entries. Rename in place.
- **Forgetting identity rules after an extension.** A new type without
  identity rules duplicates from day one — set them in the same edit.
- **Encoding a one-off need structurally.** A question you'll ask once
  is a query, not a field. Add structure for information you'll record
  repeatedly.`,
};

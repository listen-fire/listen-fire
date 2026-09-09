import type { Chapter } from '../types';

export const grounding: Chapter = {
  id: 'grounding',
  title: 'Where answers come from',
  content: `## Where answers come from

Every fact in the knowledge model carries its provenance — how it got
there and what it was based on. Knowing the three sources, and how to
ask about them, is what lets you decide how much weight an answer
deserves.

### The three sources

- **Extraction.** Most data arrives by being read out of inbound
  material — forwarded emails, meeting notes, documents. Each extracted
  fact stays linked to the message it came from, so "where did this
  come from?" has a concrete answer: the original text.
- **Manual edits.** Facts stated in conversation or edited directly.
  These carry who made the change and when.
- **Lookups.** Facts brought in from connected systems or retrieval.

A single entry usually mixes sources — a company created by extraction
from an email, its website corrected by hand a week later. When sources
disagree, the field's conflict rule (defined in the knowledge model)
decides which value stands; the losing value is not erased from the
history.

### Tracing a fact

Ask directly: "where did Meridian's valuation come from?" The answer
points at the source — typically the original message, which you can
read to judge the claim in context. This is the habit that matters
before acting on a surprising number: read the sentence it was
extracted from.

### The fact archive

Alongside the structured model, raw extracted statements are kept in a
fact archive — simple subject–predicate–object claims pulled from
historical documents, including things your model has no structure for.
When a question can't be answered from the structured model, the
archive is searched as a fallback, and the assistant will say so.

Treat archive results as leads, not records: they are less precise than
structured data, haven't passed through identity rules or conflict
resolution, and may be stale. If an archive fact matters, promote it —
state it in conversation so it becomes a structured, attributed entry.
And if the same *kind* of fact keeps surfacing only in the archive,
that's a signal the knowledge model is missing a field or relationship
for it.

### Common mistakes

- **Acting on an extracted number without reading its source.** One
  sentence of context ("hoping to raise at...") can change what a
  figure means.
- **Treating archive results as equal to model data.** The assistant
  flags which is which; keep the distinction when you pass the answer
  on.
- **Leaving recurring archive facts unmodelled.** The archive is a
  safety net, not a home — recurring information deserves structure.`,
};

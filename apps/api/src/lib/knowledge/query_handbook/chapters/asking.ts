import type { Chapter } from '../types';

export const asking: Chapter = {
  id: 'asking',
  title: 'Asking questions',
  content: `## Asking questions

You query the knowledge model by asking the assistant questions in
plain language. Behind each question, the assistant reads your model —
the entity types, fields, and relationships your team has defined —
plans which of them hold the answer, and searches the actual entries.
You never need to know how the data is stored; you do get better
answers by knowing how to aim a question.

### Use your model's own words

The assistant resolves questions against the names in *your* model. If
your team tracks "Engagements" with a "Stage" field, ask "which
engagements are in delivery?" — not "what projects are in progress?".
The closer your phrasing sits to the model's vocabulary, the less the
assistant has to guess. (If you don't know what's in the model, ask —
"what kinds of things do we track?" is a fine first question.)

### Start broad, then drill down

Conversation carries context, so treat questions as a sequence rather
than one perfectly-specified request:

1. "Which companies have we spoken to this quarter?" — a broad sweep;
2. "Of those, which have no follow-up scheduled?" — narrows the same
   result set;
3. "Show me everything we have on Meridian" — drills into one entity:
   its fields, its relationships, and the messages it came from.

Follow-ups apply to what's on the table; you don't need to restate the
question from scratch each time.

### Questions about connections

The model's relationships are queryable directly — often the most
valuable questions are about the links rather than the things:

- "Who do we know at Meridian?" — follows person-to-company connections;
- "Which deals is Sarah leading?" — follows a filtered relationship;
- "Which investors appear in more than one round?" — counts across
  connections.

For a layered question like that last one, complex answers come back
more reliably if you let the assistant take it in steps — ask for the
investors per round first, then the overlap — than if you compress
everything into one sentence.

### When the answer looks wrong

Two usual causes, and both are checkable in conversation:

- **the data is missing or sparse** — not every entry has every field
  filled; "show me everything on X" reveals what's actually recorded;
- **duplicates are splitting the picture** — if "Acme" shows fewer
  deals than you expect, ask whether there's more than one Acme entry.
  Merging duplicates is covered in the changing-data chapter.

### Common mistakes

- **Asking in foreign vocabulary.** Words from your old tool ("leads",
  "tickets") that don't match your model's type names make the
  assistant guess at a mapping.
- **One giant compound question.** "Which companies that we met in Q3
  via a warm intro have raised since at a higher valuation" answers
  better as three steps than one.
- **Treating the first answer as final.** Answers reflect recorded
  data. If something seems off, drill into one entity and look at what
  is actually there before distrusting the model.`,
};

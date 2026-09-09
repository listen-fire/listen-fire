import type { Chapter } from '../types';

export const shape: Chapter = {
  id: 'shape',
  title: 'The shape of a knowledge model',
  content: `## The shape of a knowledge model

Your knowledge model is the structure behind everything Listen-Fire tracks for
you: what kinds of things exist, what you record about each, and how they
connect. Every answer the assistant gives, every record extracted from an
inbound message, and every sync to another tool is framed by this model —
so its shape is worth designing deliberately.

A model is built from three kinds of pieces.

### Entity types

An entity type is a kind of thing you track — Company, Person, Project,
Meeting Note. Each individual thing (this company, that person) is an
entry of its type. An entity type carries:

- a **name** — singular, title case ("Company", not "companies");
- a **description** — one or two sentences saying what counts as one of
  these. The description matters more than it looks: it is what the
  system reads when deciding whether something mentioned in a message is
  one of these.

Prefer a handful of well-chosen types over many overlapping ones. If two
candidate types would hold mostly the same fields and connect to mostly
the same things, they are probably one type with a category field.

### Fields

A field is a piece of information recorded on an entity (or on a
relationship — see the relationships chapter). Each field has:

- a **value kind** — text, number, date, true/false, or structured data;
- optionally a **fixed list of allowed values** — for categorical fields
  like status, stage, or role. When a field has a fixed list, only those
  values are accepted, which keeps reporting clean ("how many deals per
  stage" only works if Stage can't drift into free text);
- a **matching role** — whether the field helps identify the entity
  (covered fully in the identity chapter);
- a **conflict rule** — what happens when two sources disagree: keep the
  most recent value, or weigh the candidates and keep the best one.

Most entity types want a Name field plus three to eight others. If a
type accumulates fifteen fields, ask whether some belong on a related
entity instead.

### Relationships

A relationship connects two entity types in a direction: Deal → Company,
Person → Organisation. Relationships are how the graph earns its keep —
"which investors are in this round" is a question about relationships,
not fields. They are rich enough to get their own chapter.

### A worked shape

A small consulting firm tracking client work:

- **Client** — Name, Industry, Status (Active / Dormant / Prospect)
- **Engagement** — Name, Start Date, Fee, Stage (Scoping / Delivery / Closed)
- **Person** — Name, Email, Role
- Engagement **for** Client; Person **works at** Client; Person
  **involved in** Engagement (with a relationship field: their role on
  that engagement)

Notice what is *not* a field: the client an engagement belongs to is a
relationship, not a "Client Name" text field on Engagement. Whenever a
field would hold the name of another thing you track, model it as a
relationship instead — text copies go stale and can't be traversed.

### Common mistakes

- **A text field holding another entity's name.** Use a relationship.
- **Free-text status fields.** Give categorical fields a fixed list of
  values, or counts and filters will splinter across spellings.
- **One mega-type.** "Note" with twenty optional fields usually wants to
  be two or three types with a clear purpose each.
- **Vague descriptions.** "Company — a company" gives the extraction
  system nothing to work with. Say what counts and what doesn't: "An
  external organisation we might invest in — not service providers or
  co-investors."`,
};

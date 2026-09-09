import type { Chapter } from '../types';

export const relationships: Chapter = {
  id: 'relationships',
  title: 'Designing relationships',
  content: `## Designing relationships

Relationships connect entity types, and most of the questions a
knowledge model exists to answer — who works where, which deals belong
to which company, who attended which meeting — are questions about
relationships. Getting their direction, names, and fields right is most
of model design.

### Direction and the two names

Every relationship runs in a direction, from a source type to a target
type, and reads naturally from both ends. So each relationship carries
two display names:

- the **outbound name** — how it reads from the source: Deal *"For"*
  Company; Person *"Member Of"* Organisation;
- the **inbound name** — how it reads from the target: a Company's
  *"Deals"*; an Organisation's *"Members"*.

Write both, and make them different — the outbound name describes the
connection ("Led By", "Member Of"), the inbound name is usually the
plural collection seen from the other side ("Leads", "Members"). Test
each by reading it aloud in a sentence: "this Deal — For — Acme",
"Acme's — Deals".

### Fields on relationships

Some information belongs to the *connection*, not to either entity. A
person's role at an organisation is not a fact about the person (they
may hold different roles at different organisations) nor about the
organisation — it is a fact about the link between them. Put it on the
relationship:

- Person —Member Of→ Organisation, with **Role** on the relationship
- Investor —Participates In→ Round, with **Amount** and **Lead?** on the
  relationship

The test: if the entity could have the connection twice with different
values, the value belongs on the relationship.

### Required connections

A relationship can be marked **required**: an entry of the source type
isn't valid without it. Use this when the entity is meaningless on its
own — a Funding Round that belongs to no company is noise, so its
company connection is required. Most relationships should *not* be
required: information arrives incomplete, and a person whose employer
you don't yet know is still worth keeping.

### One meaning, several targets

Sometimes the same idea points at different types: a Meeting Note
*mentions* both People and Companies. Model that as two relationships
that share a **group** — the group tells the system (and readers) they
are one semantic relationship fanned out across target types, so they
can be displayed and queried together.

### Role filters

When one entity type plays distinct roles, a relationship can carry a
**filter** on a field — "this connection only applies to People whose
Role is Lead Partner". This keeps one Person type doing several jobs
instead of splitting into Lead Partner, Associate, and Advisor types
that are 90% identical.

### Common mistakes

- **Identical outbound and inbound names.** "Company — Company" reads as
  nothing from either end. Name each direction for its own reader.
- **Relationship facts stored on the entity.** A "Role" field on Person
  silently asserts the person has one role everywhere. If it varies per
  connection, it lives on the relationship.
- **Splitting types instead of filtering roles.** Three near-identical
  person types are harder to keep consistent than one Person with a Role
  field and filtered relationships.
- **Marking everything required.** Required connections reject partial
  information. Reserve them for entities that are genuinely meaningless
  without their parent.`,
};

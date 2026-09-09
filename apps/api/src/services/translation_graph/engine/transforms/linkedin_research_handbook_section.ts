// The handbook chapter `linkedin_research` declares on its manifest —
// assembled into the automation book as `plugin:linkedin_research`.
//
// Kept in its own module so the prose imports nothing: the plugin's own
// module pulls in the search, fetch and model chain, and the handbook must not.

import type { HandbookSection } from '../../../../lib/handbook_section';

export const LINKEDIN_RESEARCH_HANDBOOK_SECTION: HandbookSection = {
  title: 'LinkedIn activity — what a person is up to',
  content: `## LinkedIn activity — what a person is up to

\`linkedin_research\` takes a person's LinkedIn address and works out what they are currently doing — the role and organisation their profile shows, plus recent public activity found on the web — then writes it up in a paragraph you can read.

It is a stage: it runs inside an extract's \`through [ … ]\` and nowhere else. The address is the one thing it needs, so put it behind the stage that produced one.

### the-shape

\`\`\`
extract from [msg.\`Text\`] {
  node person: "each person named in this message" {
    name:     "the person's name"
    linkedin: "their LinkedIn address, if the message has one"
  } through [linkedin_research(url: linkedin)] {
    currently:      "what they are working on now"
    why_it_matters: "what this changes for us"
  }
}
\`\`\`

The first stage names the people and reads an address off the message. The stage runs ONCE PER PERSON, researching that person's own address, and what it finds is seen only by that person's own second stage. Two people in one message get two answers, and the fields after the stage are drawn from the right one.

### what-it-attaches

- \`activity_summary\` — the write-up: current role and organisation, what they appear to be doing or building now, recent activity with dates where those are known, and a plain hedge where the public record ends. Each claim carries a bracketed number pointing at the address it rests on.
- \`activity_confidence\` — \`high\`, \`medium\` or \`low\`. Read this before trusting the summary. \`high\` means the profile and two independent recent sources agree; \`medium\` means the profile plus one recent source, or several sources with nothing dated inside about a year; \`low\` means the profile alone, or sources that fit but say little.
- \`current_role\` and \`current_organisation\` — as the research read them, empty when unknown.
- \`activity_sources\` — one address per line, numbered to match the summary's citations.

### when-there-is-nothing-to-find

A result counts as this person's only when it is consistent with their own profile — the organisation, the field, or the location. A namesake's news is left out rather than folded in, so a common name with a sparse profile produces a low-confidence answer instead of somebody else's story.

When nothing survives that test the stage attaches no fields at all and the stage after it still runs. Absent fields are the honest reading: no public signal.

A record whose \`linkedin\` field came back empty is skipped for that record alone — no research, no error, and the rest of the extraction carries on.

### Common mistakes

- **Putting the stage at the top of the extract.** No address exists there yet, and the stage would run once for the whole message rather than once per person.
- **Expecting it to find a person from a name.** It starts from an address and never searches for one. Turning a name into an address is what \`linkedin_enrichment\` does: put that stage first and this one behind it.`,
  engineClaims: [
    {
      construct: 'a per-person research stage naming the person’s own address',
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials
import { linkedin_research } from plugins

inbox = email()
crm   = attio(credentials: acme)

function \`Intake\`(m: <inbox-[:Email]->>) {
  people = extract from [m.\`Body\`] {
    node person: "each person named in this message" {
      name:     "the person's name"
      linkedin: "their LinkedIn address, if the message has one"
    } through [linkedin_research(url: linkedin)] {
      currently: "what they are working on now"
    }
  }
  people-[p:person]-> {
    write crm-[:People]-> {
      unique by (\`Name\`)
      Name: p.name
    }
  }
}
`,
    },
  ],
};

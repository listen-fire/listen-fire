// The handbook chapter `linkedin_enrichment` declares on its manifest —
// assembled into the automation book as `plugin:linkedin_enrichment`.
//
// Kept in its own module so the prose imports nothing: the plugin's own
// module pulls in the search and model chain, and the handbook must not.

import type { HandbookSection } from '../../../../lib/handbook_section';

export const LINKEDIN_ENRICHMENT_HANDBOOK_SECTION: HandbookSection = {
  title: 'LinkedIn lookup — a person’s profile',
  content: `## LinkedIn lookup — a person’s profile

\`linkedin_enrichment\` takes a person a stage has already described, finds their LinkedIn profile — searching the web for it, or reading the address the person already carries — and attaches two fields to that person: \`linkedin_url\` and \`linkedin_profile\`, the text of the page.

It is a stage: it runs inside an extract's \`through [ … ]\` and nowhere else. It takes no arguments — the person it works on is the record the stage sits behind.

### where-to-put-it

\`\`\`
extract from [msg.\`Text\`] {
  node person: "each person named in this message" {
    name: "the person's name"
    role: "their job title, if the message says"
  } through [linkedin_enrichment] {
    seniority: "how senior they are, from the profile"
  }
}
\`\`\`

Behind a record's stage the lookup runs ONCE PER PERSON, and what it finds is seen only by that person's own stage. That is the placement it is built for: it needs a name to search on, and a name only exists once a stage has extracted one.

A record nested inside another one also gets the enclosing record's fields, so a person extracted under a company is searched for as that person at that company.

\`\`\`
node company: "each company named" {
  name: "the company's name"
  node person: "each person at this company" {
    name: "the person's name"
  } through [linkedin_enrichment] {
    seniority: "how senior they are, from the profile"
  }
}
\`\`\`

At the top of an extract the lookup has no person yet, so it finds nothing. Put it behind the stage that names one.

### what-it-attaches

- \`linkedin_url\` — the profile address it found.
- \`linkedin_profile\` — the text of that page, for a later stage to read.

Both are empty when nothing matches confidently, and the stage after it still runs. A person whose profile address the message already carried is not searched for twice: the lookup reads that address and attaches the page. It does nothing at all only when the profile text is already there.

### Common mistakes

- **Putting the lookup at the top of an extract.** There is no person there yet.
- **Expecting the profile to arrive as a field you can write.** What the lookup attaches reaches the stage behind it as context. Declare a field there for anything you want to keep.`,
  engineClaims: [
    {
      construct: 'a per-person enrichment stage behind the stage that names them',
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials
import { linkedin_enrichment } from plugins

inbox = email()
crm   = attio(credentials: acme)

function \`Intake\`(m: <inbox-[:Email]->>) {
  people = extract from [m.\`Body\`] {
    node person: "each person named in this message" {
      name: "the person's name"
    } through [linkedin_enrichment] {
      seniority: "how senior they are, from the profile"
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

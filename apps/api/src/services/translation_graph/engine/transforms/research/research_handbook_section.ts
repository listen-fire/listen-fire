// The handbook chapter `research` declares on its manifest — assembled into
// the automation book as `plugin:research`.
//
// Its own module so the prose imports nothing: the plugin pulls in the search
// index, the scraper chain and the model wrapper, and the handbook must not.

import type { HandbookSection } from '../../../../../lib/handbook_section';

export const RESEARCH_HANDBOOK_SECTION: HandbookSection = {
  title: 'Research — what is this person or company, and what do they do?',
  content: `## Research — what is this person or company, and what do they do?

\`research\` takes whatever a record carries — a name, a line of text, a web address, a profile address — looks the subject up on the web, and answers what you want to know about it. It is a stage: it runs inside an extract's \`through [ … ]\` and nowhere else.

Reach for it when a message names people or companies and you want to know more about them than the message said.

### the-shape

\`\`\`
extract from [msg.\`Text\`] {
  node company: "each company named in this message" {
    name:        "the company's name"
    description: "what the message says about it"
    website:     "the company's web address, if the message gives one"
    linkedin:    "the company's LinkedIn address, if the message gives one"
  } through [
    research(
      name:      name,
      context:   description,
      questions: "what it does, which sector it is in, where it is based",
      website:   website,
      linkedin:  linkedin
    )
  ] {
    website:  "the company's web address — the one the research resolved, verbatim, otherwise keep the value already here"
    summary:  "what the company does, in a sentence"
    sector:   "the sector, in a word or two"
    location: "where the company is based"
  }
}
\`\`\`

The stage runs once per company. Re-declaring \`website\` in the stage behind it is how a resolved address becomes the record's own.

### what-you-want-to-know

\`questions\` is what you want to find out, in your own words. The answer is sized to it: say what a company does and which sector it is in, and a few paragraphs come back; say nothing and you get a general account of the subject. Say what the stage behind this one needs, and the fields there have something to read.

### the-addresses

Pass every address the record carries. Each one is read for what it is: a web address is the subject's own words, a profile address settles who the subject is, and any other link is evidence alongside them. A record that carries an address is still researched — the address is where the research starts, not a reason to stop.

### what-makes-it-work-without-an-address

\`context\` is the line the message wrote: what the subject does, where it is, who is behind it. That is what tells this subject apart from every other one trading under the same word. A record that carries no address and whose message said nothing beyond a name comes back with nothing, deliberately: a name alone returns the world, and a wrong answer is worse than none — it colours every field extracted after it and lands in whatever the automation writes.

Give it a real sentence and it answers; give it a bare name and it declines. Both are correct, and the run record says which one happened.

### what-lands

Six fields: the answer, how confident the reading is, the addresses it cites, the web address and the profile address it resolved or confirmed, and the content itself — the passages it rests on, under their sources. Read the answer for a field \`questions\` covered; read the content for one it did not.

A record it declined carries none of them, and the fields after the stage are extracted from what the record already had.

### Common mistakes

- **Putting the stage at the top of the extract.** Nothing has produced a name yet, and the stage would run once for the whole message rather than once per record.
- **Leaving \`questions\` out when the stage behind it wants something specific.** The answer is written to the question; with no question it is written to the subject in general, and a narrow field behind it has nothing to read.
- **Not re-declaring \`website\` in the stage behind it.** The address is resolved but never becomes the record's, so nothing downstream can read it.`,
  engineClaims: [
    {
      construct: 'a research stage that reads a record and writes what it found to a connected system',
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials
import { research } from plugins

inbox = email()
crm   = attio(credentials: acme)

function \`Intake\`(m: <inbox-[:Email]->>) {
  mentions = extract from [m.\`Body\`] {
    node company: "each company named in this message" {
      name:        "the company's name"
      description: "what the message says about it"
      website:     "the company's web address, if the message gives one"
      linkedin:    "the company's LinkedIn address, if the message gives one"
    } through [
      research(
        name:      name,
        context:   description,
        questions: "what it does and which sector it is in",
        website:   website,
        linkedin:  linkedin
      )
    ] {
      website: "the company's web address — the one the research resolved, verbatim, otherwise keep the value already here"
      summary: "what the company does, in a sentence"
    }
  }
  mentions-[c:company]-> {
    write crm-[:Companies]-> {
      unique by (\`Name\`)
      Name:        c.name
      Domains:     c.website
      Description: c.summary
    }
  }
}
`,
    },
  ],
};

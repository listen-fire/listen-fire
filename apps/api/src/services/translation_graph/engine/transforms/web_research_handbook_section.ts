// The handbook chapter `web-research` declares on its manifest — assembled
// into the automation book as `plugin:web_research`.
//
// Its own module so the prose imports nothing: the plugin pulls in the search
// index and the scraper chain, and the handbook must not.

import type { HandbookSection } from '../../../../lib/handbook_section';

export const WEB_RESEARCH_HANDBOOK_SECTION: HandbookSection = {
  title: 'Find the website — the record that arrived with no link',
  content: `## Find the website — the record that arrived with no link

\`web_research\` works out a company's own website from its name and what the message said about it, checks the site really is that company, and loads it. It is a stage: it runs inside an extract's \`through [ … ]\` and nowhere else.

Reach for it when a message names companies and only some of them come with a link.

### the-shape

\`\`\`
extract from [msg.\`Text\`] {
  node company: "each company named in this message" {
    name:        "the company's name"
    description: "what the message says about it"
    website:     "the company's web address, if the message gives one"
    linkedin:    "the company's LinkedIn address, if the message gives one"
  } through [
    fetch_url(url: website, email: @user_email),
    web_research(name: name, context: description, website: website, linkedin: linkedin)
  ] {
    website:  "the company's web address — the one the research resolved, verbatim, otherwise keep the value already here"
    summary:  "what the company does, in a sentence"
    location: "where the company is based"
  }
}
\`\`\`

Both stages run once per company. A company that came with an address is loaded by \`fetch_url\`; one that came with nothing but a name is researched by this, and the stage after them reads whichever page arrived. Re-declaring \`website\` in that stage is how the resolved address becomes the record's own.

### passing-the-links

Pass the record's \`website\` and \`linkedin\` and the research stands down for any record that has one — no search, no page, nothing spent. Leave them out and it researches every record, including the ones another stage already covered.

### the-context-is-what-makes-it-work

\`context\` is the line the message wrote about the company: what it does, where it is, who is behind it. That is what tells this company apart from every other business trading under the same word, and the research will not search without it. A record whose message said nothing beyond a name comes back with nothing, deliberately: a name alone returns the world, and the wrong website is worse than none — it colours every field extracted after it and lands in whatever the run writes.

Give it a real sentence and it resolves; give it a bare name and it declines. Both are correct answers, and the run record says which one happened.

### what-lands

A record it resolved carries the address it found, plus the page, which the stage behind it reads like any other fetched page. A record it declined carries nothing at all, and the fields after the stage are extracted from what the record already had.

### Common mistakes

- **Putting the stage at the top of the extract.** Nothing has produced a name yet, and the stage would run once for the whole message rather than once per record.
- **Leaving \`context\` out.** Without it every record declines, and the stage costs nothing because it does nothing.
- **Not re-declaring \`website\` in the stage behind it.** The address is resolved but never becomes the record's, so nothing downstream can read it.`,
  engineClaims: [
    {
      construct: 'a fallback research stage beside a targeted fetch in one pipeline',
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials
import { fetch_url, web_research } from plugins

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
      fetch_url(url: website, email: @user_email),
      web_research(name: name, context: description, website: website, linkedin: linkedin)
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

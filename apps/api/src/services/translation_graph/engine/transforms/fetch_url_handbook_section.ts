// The handbook chapter `fetch-url` declares on its manifest — assembled into
// the automation book as `plugin:fetch_url`.
//
// Its own module so the prose imports nothing: the plugin pulls in the
// scraper chain, and the handbook must not.

import type { HandbookSection } from '../../../../lib/handbook_section';

export const FETCH_URL_HANDBOOK_SECTION: HandbookSection = {
  title: 'Fetch a page — the link a record carries',
  content: `## Fetch a page — the link a record carries

\`fetch_url\` loads the one link you give it and hands its content to the extraction as text. It is a stage: it runs inside an extract's \`through [ … ]\` and nowhere else.

Point it at a field an earlier stage produced and each record loads its own page.

### the-shape

\`\`\`
extract from [msg.\`Text\`] {
  node company: "each company named in this message" {
    name:    "the company's name"
    website: "the company's web address"
  } through [fetch_url(url: website)] {
    summary:  "what the company does, in a sentence"
    location: "where the company is based"
  }
}
\`\`\`

The first stage names the companies and reads a web address off the message. The stage runs ONCE PER COMPANY, loading that company's address, and what it loads is seen only by that company's own second stage. Two companies in one message get two pages, and the fields after the stage are drawn from the right one.

An argument may only read fields the stages BEFORE it produced. Reading a field the same stage declares is refused.

### when-the-field-is-empty

A record whose \`website\` came back empty loads nothing. The stage is skipped for that record alone: no page, no error, and the fields after it are extracted from what the record already has. A message naming three companies of which one has no address still produces three records — two enriched, one not.

That is the rule for any required argument: nothing to work on means no run, for that record only.

A LinkedIn address is read the way the LinkedIn lookup reads one: a person's profile comes back as their profile, and any other LinkedIn address — a company page, a post — comes back empty rather than as the page LinkedIn shows a stranger.

### gated-links

A shared document often arrives with its own way in written beside it: "here's the deck — docsend.com/view/abc, password SUMMER24". The way in is part of the message, so extract it like any other field and feed it to the stage.

\`\`\`
extract from [msg.\`Body\`] {
  node opportunity: "each opportunity this message is about" {
    company:       "the company's name"
    deck_url:      "the link to the deck, if the message has one"
    deck_password: "the passcode for that link, if the message gives one"
  } through [fetch_url(url: deck_url, email: @user_email, password: deck_password)] {
    raise:    "how much they are raising"
    traction: "what the deck says about traction"
  }
}
\`\`\`

\`email\` and \`password\` are typed into a link that demands them before it will show its content. A link with no gate ignores both, and without them a gated link comes back empty rather than being guessed at.

Access that arrives INSIDE the content — a passcode someone wrote in a message — is data, and belongs in these arguments. The keys and tokens that let the workspace reach a connected system are a different thing entirely: those are held by the connection and never written in source.

### scan-or-load

\`fetch_url\` loads one link, named. \`vc_url_retrieval\` reads a whole piece of text, works out which of the links in it are worth loading, and loads all of them. Reach for this one when a record carries the address; reach for the other when the message does.

### Common mistakes

- **Putting the stage at the top of the extract.** Nothing has produced a link yet, and the stage would run once for the whole message rather than once per record.
- **Expecting two pages from one call.** It loads one. Two links in a record's own text is what scanning is for.
- **Reading the fetched page in the same stage that names the link.** The page reaches the stage AFTER the retrieval, not the one before it.`,
  engineClaims: [
    {
      construct: 'a per-record retrieval stage naming the record’s own link',
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials
import { fetch_url } from plugins

inbox = email()
crm   = attio(credentials: acme)

function \`Intake\`(m: <inbox-[:Email]->>) {
  mentions = extract from [m.\`Body\`] {
    node company: "each company named in this message" {
      name:    "the company's name"
      website: "the company's web address"
    } through [fetch_url(url: website)] {
      summary: "what the company does, in a sentence"
    }
  }
  mentions-[c:company]-> {
    write crm-[:Companies]-> {
      unique by (\`Name\`)
      Name:        c.name
      Description: c.summary
    }
  }
}
`,
    },
    {
      construct: 'a gated link whose way in was extracted from the same message',
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials
import { fetch_url } from plugins

inbox = email()
crm   = attio(credentials: acme)

function \`Intake\`(m: <inbox-[:Email]->>) {
  found = extract from [m.\`Body\`] {
    node opportunity: "each opportunity this message is about" {
      company:       "the company's name"
      deck_url:      "the link to the deck, if the message has one"
      deck_password: "the passcode for that link, if the message gives one"
    } through [fetch_url(url: deck_url, email: @user_email, password: deck_password)] {
      raise: "how much they are raising"
    }
  }
  found-[o:opportunity]-> {
    write crm-[:Companies]-> {
      unique by (\`Name\`)
      Name:        o.company
      Description: o.raise
    }
  }
}
`,
    },
  ],
};

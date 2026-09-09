import type { Chapter } from '../types';

// the
// dealflow extraction playbook: ported scoping wording as authoring advice,
// surfaced through the existing handbook/library shelf (no runtime touch).
export const useCases: Chapter = {
  id: 'use-cases',
  title: 'Use-case playbooks — battle-tested scoping wording',
  content: `## Use-case playbooks

Copy the descriptions below when your brief matches one of these situations. A description is the only thing that scopes an extraction, and this wording is what survived contact with real messages — lift it as written, and trim only what your brief rules out.

Nothing here matches your brief? Then there is nothing extra to know: the extraction chapter's rules are the whole story.

### dealflow-extraction

A pitch, a forwarded intro, or a deck arrives, and you want the company being pitched and the people behind it. The same message name-drops competitors, quotes customers, and links to a file host — every clause below is there to keep one of those out.

#### the company

\`\`\`
node company: "Each company that is the primary subject of this message — the company being pitched or introduced for investment. Only extract organisations the message is ABOUT, not ones mentioned in passing as context, comparisons, competitors, or background. If several companies are being pitched, extract each one separately. Infer the company name from a website domain or an email address when it is not stated outright (joe@acme.com implies the company 'Acme' with website acme.com). Well-known file-hosting domains (docs.google.com, docsend.com, drive.google.com, pitch.com) are NOT company websites — never treat them as the company's site." {
  name:    "the company's name"
  website: "the company's official website (not a file-hosting link)"
}
\`\`\`

- *"not ones mentioned in passing"* is what stops "we're the Stripe for X" importing Stripe. It is the single most common over-extraction.
- *"extract each one separately"* makes a two-startup forward yield two companies rather than one blended record.
- The file-hosting sentence is the clause people trim for brevity and then regret: without it, a DocSend link becomes the company's website.

#### the team

\`\`\`
node founder: "Each senior member of this company's team named in the message: founders, co-founders, and C-suite (CEO, CTO, COO, CFO). Do NOT extract 'Head of X', 'X Lead', 'Senior X', or VP-level roles unless that person is also a founder. Do NOT extract advisors, consultants, or investors as team members. A person whose email is on the company's own domain is likely a team member rather than an external contact." {
  name: "the person's full name"
  role: "the person's title (CEO, CTO, Co-founder, …)"
}
\`\`\`

Declare it *inside* \`company\`. Without the seniority carve-out you import every "Head of Growth" the message names.

#### the sender

Only when the brief wants whoever sent it, which on a forward is not whoever wrote the pitch:

\`\`\`
node introducer: "The person who sent or forwarded this message to us — the introducer or referrer, found in the message header, signature, or 'From' line. If the message is a forward, this is the person who forwarded it, NOT the original author of the pitch."
\`\`\`

Read the message's \`From\` for this, not its \`To\` — on a forward, \`To\` is just the address it landed at.

#### both deck channels

The substance of a dealflow message is in the deck, and a deck arrives two ways. Read **both**:

\`\`\`
extract from [msg.\`Body\`, msg-[:Attachments]->.\`File\`] through [vc_url_retrieval(email: @user_email)] {
  …
}
\`\`\`

The source list carries the body *and* the attached files (a PDF, a slide deck, a voice note whose spoken words are transcribed). \`vc_url_retrieval\` covers the other channel — it finds the deck *links* in the body, works out which are decks, and feeds their content in. Extract from the body alone and the deck never reaches the model.

The \`email\` argument gets past an *enter your email to view* gate. \`@user_email\` — the team member responsible for the run, resolved through forwarders — is right almost always; reach for \`@actor_email\`, the raw sender of the triggering message, only when the gated link was shared with that sender rather than with the team.

Everything after the extraction is the ordinary shape: a tree extracted, each person written along their company's own edge, names matched with \`FUZZY\`. The extraction and patterns chapters carry it.`,
  engineClaims: [
    {
      construct: 'dealflow extraction (attachments as a source + URL-retrieval enrichment → linked fuzzy writes)',
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { vc_url_retrieval } from plugins
import { acme } from credentials

inbox = email()
crm   = attio(credentials: acme)

function \`Log Dealflow\`(msg: <inbox-[:Email]->>) {
  extracted = extract from [msg.\`Body\`, msg-[:Attachments]->.\`File\`] through [vc_url_retrieval(email: @user_email)] {
    node company: "each company this message is about — the one being pitched for investment, not competitors or customers named in passing" {
      name:    "the company's name"
      website: "the company's official website"

      node founder: "each founder or C-suite leader of this company named in the message" {
        name: "the person's full name"
        role: "the person's title"
      }
    }
  }

  extracted-[c:company]-> {
    company = write crm-[:Companies]-> {
      unique by (FUZZY \`Name\`)
      Name:    c.name
      Domains: c.website
    }
    c-[f:founder]-> {
      write company-[:Team]-> {
        unique by (FUZZY \`Name\`)
        Name:          f.name
        \`Job Title\`: f.role
      }
    }
  }
}
`,
    },
  ],
};

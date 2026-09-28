// The handbook chapter `vc_url_retrieval` declares on its manifest —
// assembled into the automation book as `plugin:vc_url_retrieval`.
//
// Kept in its own module (the knowledge-graph adapter's section sets the
// precedent) so the prose imports nothing: the plugin's own module pulls in
// the scraper and model chain, and the handbook must not.

import type { HandbookSection } from '../../../../lib/handbook_section';

export const VC_URL_RETRIEVAL_HANDBOOK_SECTION: HandbookSection = {
  title: 'URL retrieval — the links a message carries',
  content: `## URL retrieval — the links a message carries

\`vc_url_retrieval\` reads a piece of text, finds every link in it, works out what each one is, and loads the ones worth loading. Run it as a stage inside an extract's \`through [ … ]\`, or call it on its own for a list of what it loaded.

Inside a stage it takes the text it scans from the extraction itself, so a bare \`through [vc_url_retrieval]\` is the whole call. The page text reaches the extraction, and every document it downloads lands on the extracted records' \`_resources\`.

### where-to-put-it

\`\`\`
extract from [msg.\`Text\`] through [vc_url_retrieval] {
  node company: "each company named in this message" {
    name:    "the company's name"
    summary: "what the company does, from anything the pages say"
  }
}
\`\`\`

At the top of an extract the stage runs ONCE, over the whole source text, and the pages it loads are shared by every record the extract produces. That is where it belongs: the links are in the message, not in any one record, so the message is what it should read.

A slide deck link, a shared folder, a write-up someone linked to — all of them reach the extraction this way, and any record may draw on any of them.

### the-downloaded-files

\`\`\`
mentions-[c:company]-> {
  record = write crm-[:Companies]-> { unique by (\`Name\`) Name: c.name }
  c-[r:_resources WHERE type == "FILE"]-> {
    write record-[:Files]-> { File: r.\`file\` }
  }
}
\`\`\`

A slide deck behind a link arrives on \`_resources\` as a \`"FILE"\`, next to the files listed in \`from [ … ]\`. It has the same fields they have, plus \`url\`, the link it came from, so the same block attaches either kind to a record. A link that was a page rather than a document adds its text and no file.

### called-on-its-own

\`\`\`
pages = vc_url_retrieval(text: m.\`Body\`)
deck  = FIRST(pages)
\`\`\`

The call returns a list with one record per link it loaded, in the order it found them. Each has \`name\`, \`url\`, \`file\` and \`text\`. \`file\` is there only when the link was a document, and \`text\` only when something could be read. No link worth loading gives an empty list. Read one record with \`FIRST\`, or every one at once with \`pages.text\`.

### scan-or-load

\`vc_url_retrieval\` decides for itself which links are worth loading. \`fetch_url\` loads exactly the one link you name, so a stage behind a record's fields loads that record's own page.

Reach for this one when the links live in the message. Reach for \`fetch_url\` when the link is a field a record already carries — a company's web address, a document link extracted alongside it.

Putting this one behind a record's stage is almost never right: it runs once per record and each record then loads every link in the whole message.

### gated-links

\`\`\`
through [vc_url_retrieval(email: @user_email)]
\`\`\`

\`email\` is typed into a link that demands one before it will show its content. A passcode written next to a link in the text is picked up from the text itself. Without an address, a gated link is skipped rather than guessed at.

### Common mistakes

- **Extracting from the body alone when the content is behind a link.** Nothing reads the linked page unless the stage is there to load it.
- **Putting it behind a record's stage to get a page per record.** It scans the whole message wherever it sits. Name the link with \`fetch_url\` instead.`,
  engineClaims: [
    {
      construct: 'a scanning retrieval stage at the top of an extract',
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials
import { vc_url_retrieval } from plugins

inbox = email()
crm   = attio(credentials: acme)

function \`Intake\`(m: <inbox-[:Email]->>) {
  mentions = extract from [m.\`Body\`] through [vc_url_retrieval(email: @user_email)] {
    node company: "each company named in this message" {
      name:    "the company's name"
      summary: "what the company does, from anything the pages say"
    }
  }
  mentions-[c:company]-> {
    record = write crm-[:Companies]-> {
      unique by (\`Name\`)
      Name:        c.name
      Description: c.summary
    }
    c-[r:_resources WHERE type == "FILE"]-> {
      write record-[:Files]-> { File: r.\`file\` }
    }
  }
}
`,
    },
  ],
};

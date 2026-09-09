import type { Chapter } from '../types';

export const patterns: Chapter = {
  id: 'patterns',
  title: 'Common patterns',
  content: `## Common patterns

Reach for the shape that matches the brief. Each is an idiom, not a whole file — the surrounding imports, constructions, and \`listen\` line are the anatomy chapter's job, and every type and field name here is illustrative.

### inbound-intake

Something arrives, a record is created or updated, the team is told.

\`\`\`
person = write crm-[:People]-> {
  unique by (\`Email\`)
  Email: msg.\`From\`
  Name:  COALESCE(AI("the sender's name, cleaned — no email address, no 'via', no company suffix: \${msg.\`From\`}"), msg.\`From\`)
}

chat-[ch:Channels WHERE \`Name\` == "intake"]-> {
  write ch-[:Messages]-> { Message: "New sender: \${msg.\`From\`} (\${person.externalId})" }
}
\`\`\`

Key the identity on something actually carried in the message, so a second arrival updates rather than duplicates. The \`AI()\` touch is a micro-judgement — tidying a display name; pulling an entity *out of* the prose would be an \`extract\` job — and it is wrapped in \`COALESCE\` because \`Name\` is required and a judgement can come back with nothing.

### multi-target

Several systems hearing one event is several writes in one body; a later write quotes an earlier handle.

\`\`\`
record = write crm-[:Companies]-> { … }

chat-[ch:Channels WHERE \`Name\` == "ops"]-> {
  write ch-[:Messages]-> { Message: "Logged to the CRM: \${record.externalId}" }
}
\`\`\`

For writes that genuinely don't depend on each other, \`parallel\` runs them at once:

\`\`\`
await parallel([
  () => { write crm-[:Companies]-> { unique by (FUZZY \`Name\`), Name: msg.\`Subject\` } },
  () => { write sheet-[:Rows]->    { unique by (\`Company\`),    Company: msg.\`Subject\` } },
])
\`\`\`

Each arm is a **function** — \`() => { … }\` written where it stands, or the name of one declared elsewhere — and \`await\` is what waits, here until every arm has finished. An arm reads anything bound before the \`parallel\` and never another arm's bindings. Work that has to come back out is \`return\`ed: the value is a receipt with one slot per arm in the order written, and \`AT(r, 0)\` reads the first arm's slot. Arms that only act need no binding at all, as here.

### compose-a-report

Many small things into one readable artifact: a block returns a line each, \`JOIN\` assembles them, \`FILE\` turns the text into a file for a file-typed field.

\`\`\`
lines = msg-[f:Attachments]-> {
  return "- \${f.\`Name\`}"
}

digest = "Attachments on \${msg.\`Subject\`}:
\${JOIN(lines, "\\n")}"

write record-[:Files]-> { File: FILE(digest, "pdf") }
\`\`\`

\`FILE\` renders the string exactly as composed, so the layout you write is the layout in the file. Anything a block can iterate — extracted entities included — can feed one.

### scheduled-digest

A schedule fires, a query gathers, a message goes out. The tick carries nothing you need — the query is the input.

\`\`\`
function \`Weekly Digest\`(t: <timer-[:Tick]->>) {
  lines = crm-[c:Companies WHERE \`Created At\` WITHIN 7d ORDER BY \`Created At\` DESC LIMIT 20]-> {
    return "- \${c.\`Name\`}"
  }

  chat-[ch:Channels WHERE \`Name\` == "ops"]-> {
    write ch-[:Messages]-> { Message: "New this week:\\n\${JOIN(lines, "\\n")}" }
  }
}

listen as "Weekly digest" to timer { schedule: "0 9 * * 1" } fire \`Weekly Digest\`
\`\`\`

### sections-from-a-type

A report whose sections come from a **type** rather than from a list written beside it: group the findings by the value, walk the type's members in the order they were declared, and look each group up.

\`\`\`
type Thesis = <"Consumer" | "Infra" | "Health">

function \`Thesis Recap\`(go: <runs-[:Invocation]->>) {
  found = extract from [go.\`Text\`] {
    node finding: "each company mentioned" {
      headline: <text> "one line about it"
      thesis:   <Thesis> "which thesis it fits"
    }
  }

  rows     = found-[f:finding]-> { return { thesis: COALESCE(f.thesis, "Consumer"), line: COALESCE(f.headline, "") } }
  by       = GROUPBY(rows, (r) => { return COALESCE(AT(r, "thesis"), "Consumer") })
  theses   = MEMBERS(<Thesis>)
  sections = MAP(theses, (th) => { return "\${th}: \${COUNT(COALESCE(AT(by, th), []))} found" })

  chat-[ch:Channels WHERE \`Name\` == "ops"]-> {
    write ch-[:Messages]-> { Message: JOIN(sections, "\\n") }
  }
}
\`\`\`

- Adding a thesis is one edit — the declaration — and the report grows a section on its own, in the place the declaration puts it. A thesis nothing matched is an ordinary missing lookup, so it still gets its line.
- The rows are **dicts** rather than records because that is what a value collection holds: \`GROUPBY\`, \`MAP\` and the rest iterate values, while records keep the traversal-headed block.
- Every extracted field may not have been found, so each one is defaulted on the way into the row.

### extract-and-connect

Records pulled out of a message and written **with their relationships intact**: the people are declared inside the company, so each one lands attached to the right one.

\`\`\`
extracted = extract from [msg.\`Body\`] through [vc_url_retrieval] {
  node company: "…" {
    name:    "the company's name"
    website: "the company's official website"

    node person: "each person at this company named in the message" {
      name: "the person's full name"
    } through [linkedin_enrichment] {
      name:      "the person's full name"
      job_title: "the person's job title, from their public profile"
    }
  }
}

extracted-[c:company]-> {
  company = write crm-[:Companies]-> {
    unique by (FUZZY \`Name\`)
    Name:    c.name
    Domains: c.website
  }

  c-[p:person]-> {
    write company-[:Team]-> {
      unique by (FUZZY \`Name\`)
      Name:        p.name
      \`Job Title\`: p.job_title
    }
  }
}
\`\`\`

Two things here you cannot derive:

- **Where a plugin sits decides when it runs.** \`through\` on the top-level \`from\` works over the whole body *before* extraction — it fetches the pages the message links to, so \`website\` comes from the page rather than a guess. \`through\` between a node's stages runs *after* that node is extracted, enriching what was just pulled out. The trap: a per-node plugin works out who to look up from the fields the earlier stage produced, so the first stage must extract an identifying field. Without one it quietly finds nothing.
- **Which side declares the edge decides the shape of the write.** Where the parent declares it — as here — a linked write off the parent's handle is the one idiomatic form. Where only the child declares a reference back, write the child at the root and connect it with \`link\`. Read your catalog: that is the system's choice, not yours.

### human-reviewed-intake

"Let me paste something in, but let me check it before it's saved."

\`\`\`
found = extract from [go.\`Text\`, go-[:Files]->.\`File\`] {
  node company: "each company named in the supplied text or files" { … }
}

q = write asks-[:Check]-> {
  Prompt: "Save these companies and people?"
  Detail: "Review the extracted records before they're written."
}

answer = await FIRST(q-[:Response]->)
if answer.Answer {
  found-[c:company]-> { … }
}
\`\`\`

Two things make it this shape rather than a thinner one:

- **The raw input flows in.** What the person pasted and each file they dropped go into the source list undigested — not read, tidied, and re-typed somewhere else first.
- **The review happens inside.** The person approves the automation's *own* extracted values, not a rendering of them made somewhere else. The tempting alternative — read the pasted text outside, pull the records out yourself, show a tidied-up version, then run a write-only automation — throws the real input away and reviews the wrong thing.
`,
  engineClaims: [
    {
      construct: 'sections from a type (GROUPBY over dict rows, MEMBERS in declared order, AT per member)',
      status: 'runs',
      probe: `
import { manual, slack } from adapters
import { team_workspace } from credentials

runs = manual()
chat = slack(credentials: team_workspace)

type Thesis = <"Consumer" | "Infra" | "Health">

function \`Thesis Recap\`(go: <runs-[:Invocation]->>) {
  found = extract from [go.\`Text\`] {
    node finding: "each company mentioned" {
      headline: <text> "one line about it"
      thesis:   <Thesis> "which thesis it fits"
    }
  }

  rows     = found-[f:finding]-> { return { thesis: COALESCE(f.thesis, "Consumer"), line: COALESCE(f.headline, "") } }
  by       = GROUPBY(rows, (r) => { return COALESCE(AT(r, "thesis"), "Consumer") })
  theses   = MEMBERS(<Thesis>)
  sections = MAP(theses, (th) => { return "\${th}: \${COUNT(COALESCE(AT(by, th), []))} found" })

  chat-[ch:Channels WHERE \`Name\` == "ops"]-> {
    write ch-[:Messages]-> { Message: JOIN(sections, "\\n") }
  }
}

listen to runs {} fire \`Thesis Recap\`
`,
    },
    {
      construct: 'the compose-a-report shape (returned block lines → JOIN → FILE artifact)',
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials

inbox = email()
crm   = attio(credentials: acme)

function \`Attachment Report\`(m: <inbox-[:Email]->>) {
  lines = m-[f:Attachments]-> {
    return "- \${f.\`Name\`}"
  }
  digest = "Attachments on \${m.\`Subject\`}: \${JOIN(lines, ", ")}"

  record = write crm-[:Companies]-> {
    unique by (FUZZY \`Name\`)
    Name: m.\`Subject\`
  }
  write record-[:Files]-> {
    File: FILE(digest, "pdf")
  }
}
`,
    },
    {
      construct: 'the parallel combinator over closure arms (independent writes, concurrent, no binding)',
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials

inbox = email()
crm   = attio(credentials: acme)

function \`Intake\`(m: <inbox-[:Email]->>) {
  await parallel([
    () => {
      write crm-[:Companies]-> {
        unique by (FUZZY \`Name\`)
        Name: m.\`Subject\`
      }
    },
    () => {
      write crm-[:People]-> {
        unique by (\`Email\`)
        Name:  m.\`From\`
        Email: m.\`From\`
      }
    },
  ])
}
`,
    },
    {
      construct: 'extract-and-connect (extract a tree, whole-body + per-node plugins → linked writes → fuzzy identity)',
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { vc_url_retrieval, linkedin_enrichment } from plugins
import { acme } from credentials

inbox = email()
crm   = attio(credentials: acme)

function \`Extract And Connect\`(m: <inbox-[:Email]->>) {
  extracted = extract from [m.\`Body\`] through [vc_url_retrieval] {
    node company: "each company mentioned" {
      name:    "the company's name"
      website: "the company's official website"

      node person: "each person at this company mentioned" {
        name: "the person's full name"
      } through [linkedin_enrichment] {
        name:      "the person's full name"
        job_title: "the person's job title, from their public profile"
      }
    }
  }

  extracted-[c:company]-> {
    company = write crm-[:Companies]-> {
      unique by (FUZZY \`Name\`)
      Name:    c.name
      Domains: c.website
    }
    c-[p:person]-> {
      write company-[:Team]-> {
        unique by (FUZZY \`Name\`)
        Name:        p.name
        \`Job Title\`: p.job_title
      }
    }
  }
}
`,
    },
    {
      construct: 'human-reviewed-intake (manual text/files → extract → write a Check question, await its Response, gate the linked writes on the approval)',
      status: 'runs',
      probe: `
import { manual, attio, ask } from adapters
import { acme } from credentials

runs = manual()
crm  = attio(credentials: acme)
asks = ask()

function \`Review And Import\`(go: <runs-[:Invocation]->>) {
  found = extract from [go.\`Text\`, go-[:Files]->.\`File\`] {
    node company: "each company named in the supplied text or files" {
      name:    "the company's name"
      website: "the company's official website, if given"

      node person: "each person at this company named in the input" {
        name:  "the person's full name"
        email: "the person's email address, if given"
      }
    }
  }

  q = write asks-[:Check]-> {
    Prompt: "Save these companies and people?"
    Detail: "Review the extracted records before they're written."
  }

  answer = await FIRST(q-[:Response]->)
  if answer.Answer {
    found-[c:company]-> {
      company = write crm-[:Companies]-> {
        unique by (FUZZY \`Name\`)
        Name:    c.name
        Domains: c.website
      }

      c-[p:person]-> {
        write company-[:Team]-> {
          unique by (FUZZY \`Name\`)
          Name:  p.name
          Email: p.email
        }
      }
    }
  }
}

listen to runs {} fire \`Review And Import\`
`,
    },
    {
      construct: 'scheduled-digest (a cron tick fires; a bounded query composes lines; one message goes out)',
      status: 'runs',
      probe: `
import { cron, attio, slack } from adapters
import { acme, team_workspace } from credentials

timer = cron()
crm   = attio(credentials: acme)
chat  = slack(credentials: team_workspace)

function \`Weekly Digest\`(t: <timer-[:Tick]->>) {
  lines = crm-[c:Companies WHERE \`Created At\` WITHIN 7d ORDER BY \`Created At\` DESC LIMIT 20]-> {
    return "- \${c.\`Name\`}"
  }

  chat-[ch:Channels WHERE \`Name\` == "ops"]-> {
    write ch-[:Messages]-> {
      Message: "New this week:\\n\${JOIN(lines, "\\n")}"
    }
  }
}

listen as "Weekly digest" to timer { schedule: "0 9 * * 1" } fire \`Weekly Digest\`
`,
    },
  ],
};

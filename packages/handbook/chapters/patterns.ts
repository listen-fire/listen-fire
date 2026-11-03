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
  unique by (Email)
  Email: msg.From
  Name:  coalesce(ai("the sender's name, cleaned — no email address, no 'via', no company suffix: \${msg.From}"), msg.From)
}

intake = only(chat-[ch:Channels WHERE ch.Name == "intake"]->)
if (intake == null) { fail("no #intake channel") }
write intake-[:Messages]-> { Message: "New sender: \${msg.From} (\${person.externalId})" }
\`\`\`

Key the identity on something actually carried in the message, so a second arrival updates rather than duplicates. The \`ai()\` touch is a micro-judgement — tidying a display name; pulling an entity *out of* the prose would be an \`extract\` job — and it is wrapped in \`coalesce\` because \`Name\` is required and a judgement can come back with nothing.

### multi-target

Several systems hearing one event is several writes in one body; a later write quotes an earlier handle.

\`\`\`
record = write crm-[:Companies]-> { … }

ops = only(chat-[ch:Channels WHERE ch.Name == "ops"]->)
if (ops == null) { fail("no #ops channel") }
write ops-[:Messages]-> { Message: "Logged to the CRM: \${record.externalId}" }
\`\`\`

For writes that genuinely don't depend on each other, pass them to \`all\` as functions, and they run at once:

\`\`\`
all(
  () => { write crm-[:Companies]-> { unique by (FUZZY Name), Name: msg.Subject } },
  () => { write sheet-[:Rows]->    { unique by (Company),    Company: msg.Subject } },
)
\`\`\`

Each one is a **function** — \`() => { … }\` written where it stands, or the name of one declared elsewhere — and every one runs at once (\`all(f, g, { concurrency: 1 })\` runs one at a time). \`all\` finishes when every function has; one that waits parks the run, so there is no \`await\`. A function reads anything bound before \`all\` and never another's bindings. Work that has to come back out is \`return\`ed: the answer has one slot per function in the order written, and \`r[0]\` reads what the first returned. Functions that only act need no binding at all, as here.

### compose-a-report

Many small things into one readable artifact: a block returns a line each, \`Text.join\` assembles them, \`pdf.render\` turns the text into a PDF file for a file-typed field.

\`\`\`
lines = msg-[f:Attachments]-> {
  return "- \${f.Name}"
}

digest = "Attachments on \${msg.Subject}:
\${Text.join(lines, "\\n")}"

write record-[:Files]-> { File: pdf.render(digest) }
\`\`\`

\`pdf.render\` draws the string exactly as composed, so the layout you write is the layout in the file. Anything a block can iterate — extracted entities included — can feed one.

### scheduled-digest

A schedule fires, a query gathers, a message goes out. The tick carries nothing you need — the query is the input.

\`\`\`
function \`Weekly Digest\`(t: <cron-[:Ticks]->>) {
  lines = crm-[c:Companies WHERE c.\`Created At\` WITHIN 7d ORDER BY c.\`Created At\` DESC LIMIT 20]-> {
    return "- \${c.Name}"
  }

  ops = only(chat-[ch:Channels WHERE ch.Name == "ops"]->)
  if (ops == null) { fail("no #ops channel") }
  write ops-[:Messages]-> { Message: "New this week:\\n\${Text.join(lines, "\\n")}" }
}

listen as "Weekly digest" to cron-[k:Ticks WHERE k.Schedule == "0 9 * * 1"]-> fire \`Weekly Digest\`
\`\`\`

### sections-from-a-type

A report whose sections come from a **type** rather than from a list written beside it: group the findings by the value, walk the type's members in the order they were declared, and look each group up.

\`\`\`
type Thesis = <"Consumer" | "Infra" | "Health">

node Finding: "each company mentioned" {
  headline: <text> "one line about it"
  thesis:   <Thesis> "which thesis it fits"
}

function \`Thesis Recap\`(go: <manual-[:Invocation]->>) {
  found    = extract([go.Text], Finding)
  rows     = map(found, (f) => { return { thesis: coalesce(f.thesis, "Consumer"), line: f.headline } })
  by       = List.groupBy(rows, (r) => r.thesis)
  sections = map(members(<Thesis>), (th) => "\${th}: \${count(coalesce(by[th], []))} found")

  ops = only(chat-[ch:Channels WHERE ch.Name == "ops"]->)
  if (ops == null) { fail("no #ops channel") }
  write ops-[:Messages]-> { Message: Text.join(sections, "\\n") }
}
\`\`\`

- Adding a thesis is one edit — the declaration — and the report grows a section on its own, in the place the declaration puts it. A thesis nothing matched is an ordinary missing lookup, so it still gets its line.
- A thesis the model could not settle on is defaulted on the way into the row. The headline needs no default — a text field it did not find is \`""\`.

### group-and-count

A line per distinct value with its count (group by a key, count per group, distinct values): group with \`List.groupBy\`, then list the dict's keys in order.

\`\`\`
authors = gh-[r:Repositories WHERE r.Name == "api"]->-[i:Issues WHERE i.State == "open"]-> { return i.Author }
by      = List.groupBy(authors, (a) => a)
lines   = map(sort(Dict.keys(by)), (a) => "\${a}: \${count(by[a])}")
\`\`\`

- \`Dict.keys(by)\` is each author once, in no order, as a walk answers its records. The \`sort\` is what puts the lines in order for \`Text.join\`; \`first\`, \`Text.join\` and \`reduce\` are refused on it unsorted.
- \`by[a]\` may be absent, as any lookup by a computed key is; \`count\` of nothing is \`0\`. \`Dict.entries(by)\` hands each key with its group instead: \`map(sort(Dict.entries(by), (e) => e.key), (e) => "\${e.key}: \${count(e.value)}")\`.
- A key that may be missing takes a fallback, or the checker refuses it (the run would fail on it): \`List.groupBy(open, (t) => coalesce(t.Assignee, "Unassigned"))\`.
- The distinct values alone are \`List.distinct(authors)\`, kept in the order they first appear.
- When the keys are a type's values, *sections-from-a-type* walks them instead, so a key nothing matched still gets its line.

Grouping deeper than one level (people, then each person's repositories, then the issues in each) files each record under one record per key in the run's own graph, then walks the keys:

\`\`\`
node Board {
  node people {
    name: <text>
    node repos {
      name: <text>
      node issues { title: <text> }
    }
  }
}

board = graph<Board> {}
gh-[r:Repositories]->-[i:Issues WHERE i.State == "open"]-> {
  p = write board-[:people]-> { unique by (name), name: i.Author }
  q = write p-[:repos]-> { unique by (name), name: r.Name }
  write q-[:issues]-> { title: i.Title }
}
lines = board-[p:people ORDER BY p.name]->-[q:repos ORDER BY q.name]-> { return "\${p.name} in \${q.name}: \${count(q-[:issues]->)}" }
\`\`\`

- \`unique by (name)\` makes one record per name under its parent. A second issue by the same author in the same repository lands on the records the first one made, and is filed under them.
- The keys are records, so they are walked, ordered and counted like any others: \`count(board-[:people]->)\` is the distinct authors, \`count(board-[:people]->-[:repos]->-[:issues]->)\` every issue.
- The graph is the run's own: nothing reaches a system, and \`listen-fire run\` lists each filing as a write into the run's own graph.

### extract-and-connect

Records pulled out of a message and written **with their relationships intact**: the people are declared inside the company, so each one lands attached to the right one.

\`\`\`
import { vcUrlRetrieval } from plugins

node Company: "each company this message is about" {
  name:    <text> "the company's name"
  website: <text> "the company's official website"
  node person: "each person at this company named in the message" {
    name:      <text> "the person's full name"
    job_title: <text | null> "the person's job title, if given"
  }
}

pages     = vcUrlRetrieval(msg.Body)
content   = [msg.Body, ...map(pages, (p) => coalesce(p.text, ""))]
companies = extract(content, Company, { tier: "careful" })

map(companies, (c) => {
  company = write crm-[:Companies]-> { unique by (FUZZY Name), Name: c.name, Domains: c.website }
  c-[p:person]-> {
    write company-[:Team]-> { unique by (FUZZY Name), Name: p.name, \`Job Title\` ?: p.job_title }
  }
})
\`\`\`

Two things here you cannot derive:

- **Linked pages go into the content.** \`vcUrlRetrieval\` loads the pages and documents the message links to, so \`website\` comes from the page rather than a guess. Per-record enrichment — a lookup per company found — is a plugin call inside the \`map\` and a second extraction (extraction, *enrichment*).
- **Which side declares the edge decides the shape of the write.** Where the parent declares it — as here — a linked write off the parent's handle is the one idiomatic form. Where only the child declares a reference back, write the child at the root and connect it with \`link\`. Read your catalog: that is the system's choice, not yours.

### declare-once

The same record extracted in several places, written the same way each time — declare it once, with its words, and reuse it:

\`\`\`
node Entry: "each company named in this text" {
  Name:        <text> "the company's name"
  Description: <text> "what the company does, in one sentence"
  node person: "each person at the company" { Name: <text> "their full name" }
}

function \`Intake\`(go: <manual-[:Invocation]->>) {
  found = extract([go.Text], Entry, { tier: "careful" })
  map(found, (e: <Entry>) => {
    company = write crm-[:Companies]-> { unique by (FUZZY Name), ?...e }
    e-[p:person]-> { write company-[:Team]-> { unique by (FUZZY Name), ?...p } }
  })
}
\`\`\`

- The declaration is the one place the record's fields and words live; every extraction that names it reads it the same way.
- A step that needs one field more extends the declaration rather than copying it: \`node <name> extends Entry { … }\` (anatomy chapter, *declared-structures*).
- \`?...e\` writes each field set-if-empty, so the declaration's field names are the target's. It carries only fields — \`person\` is its own write — and a field the target lacks is flagged by name.
- Identity needs no line of its own: \`unique by (FUZZY Name)\` matches on the \`Name\` the spread writes.
- The same spread takes a parameter typed on a declaration (\`d: <Entry>\`) or a graph you built — any record whose fields the automation spells out. A record read from a system is written field by field.

### human-reviewed-intake

"Let me paste something in, but let me check it before it's saved."

\`\`\`
found = extract([go.Text, ...go-[:Files]->.File], Company)

q = write asks-[:Check]-> {
  Prompt: "Save these companies and people?"
  Detail: "Review the extracted records before they're written."
}

r = race(
  () => {
    answer = await q-[:Response]->
    return answer.Answer
  },
  () => { await sleep(1d) },
)
if (r[0] == true) {
  map(found, (c) => { … })
}
\`\`\`

Two things make it this shape rather than a thinner one:

- **The raw input flows in.** What the person pasted and each file they dropped go into the source list undigested — not read, tidied, and re-typed somewhere else first.
- **The review happens inside.** The person approves the automation's *own* extracted values, not a rendering of them made somewhere else. The tempting alternative — read the pasted text outside, pull the records out yourself, show a tidied-up version, then run a write-only automation — throws the real input away and reviews the wrong thing.
`,
  engineClaims: [
    {
      construct: 'declare-once (a described node declaration as the extract shape, `?...e` spread writes)',
      status: 'runs',
      probe: `
crm  = connect \`@lf/attio\` using acme

rules = "a company counts only if it is named as the subject"

node Entry: "each company named in this text" {
  Name:        <text> "the company's name. \${rules}"
  Description: <text> "what the company does, in one sentence"
  node person: "each person at the company" { Name: <text> "their full name" }
}

function \`Intake\`(go: <manual-[:Invocation]->>) {
  found = extract([go.Text], Entry, { tier: "careful" })
  map(found, (e: <Entry>) => {
    company = write crm-[:Companies]-> { unique by (FUZZY Name), ?...e }
    e-[p:person]-> { write company-[:Team]-> { unique by (FUZZY Name), ?...p } }
  })
}

listen to manual-[:Invocations]-> fire \`Intake\`
`,
    },
    {
      construct: 'sections from a type (List.groupBy over dict rows, members in declared order, an index per member)',
      status: 'runs',
      probe: `
chat = connect \`@lf/slack\` using team_workspace

type Thesis = <"Consumer" | "Infra" | "Health">

node Finding: "each company mentioned" {
  headline: <text> "one line about it"
  thesis:   <Thesis> "which thesis it fits"
}

function \`Thesis Recap\`(go: <manual-[:Invocation]->>) {
  found    = extract([go.Text], Finding)
  rows     = map(found, (f) => { return { thesis: coalesce(f.thesis, "Consumer"), line: f.headline } })
  by       = List.groupBy(rows, (r) => r.thesis)
  sections = map(members(<Thesis>), (th) => "\${th}: \${count(coalesce(by[th], []))} found")

  ops = only(chat-[ch:Channels WHERE ch.Name == "ops"]->)
  if (ops == null) { fail("no #ops channel") }
  write ops-[:Messages]-> { Message: Text.join(sections, "\\n") }
}

listen to manual-[:Invocations]-> fire \`Thesis Recap\`
`,
    },
    {
      construct: 'group-and-count (List.groupBy, then the dict\'s keys sorted, each looked up and counted)',
      status: 'runs',
      probe: `
gh   = connect \`@lf/github\` using my_github
chat = connect \`@lf/slack\` using team_workspace

function \`Open Issues By Author\`(t: <cron-[:Ticks]->>) {
  authors = gh-[r:Repositories WHERE r.Name == "api"]->-[i:Issues WHERE i.State == "open"]-> { return i.Author }
  by      = List.groupBy(authors, (a) => a)
  lines   = map(sort(Dict.keys(by)), (a) => "\${a}: \${count(by[a])}")

  ops = only(chat-[ch:Channels WHERE ch.Name == "ops"]->)
  if (ops == null) { fail("no #ops channel") }
  write ops-[:Messages]-> {
    Message: "\${count(authors)} open by \${count(List.distinct(authors))} authors:\\n\${Text.join(lines, "\\n")}"
  }
}

listen as "Open issues by author" to cron-[k:Ticks WHERE k.Schedule == "0 9 * * 1"]-> fire \`Open Issues By Author\`
`,
    },
    {
      construct: 'group-and-count, deeper than one level (records filed under one record per key, per parent, in the run\'s own graph by unique by; the keys walked in order and each counted)',
      status: 'runs',
      probe: `
gh   = connect \`@lf/github\` using my_github
chat = connect \`@lf/slack\` using team_workspace

node Board {
  node people {
    name: <text>
    node repos {
      name: <text>
      node issues { title: <text> }
    }
  }
}

function \`Open Issues By Author And Repo\`(t: <cron-[:Ticks]->>) {
  board = graph<Board> {}
  gh-[r:Repositories]->-[i:Issues WHERE i.State == "open"]-> {
    p = write board-[:people]-> { unique by (name), name: i.Author }
    q = write p-[:repos]-> { unique by (name), name: r.Name }
    write q-[:issues]-> { title: i.Title }
  }
  lines = board-[p:people ORDER BY p.name]->-[q:repos ORDER BY q.name]-> { return "\${p.name} in \${q.name}: \${count(q-[:issues]->)}" }

  ops = only(chat-[ch:Channels WHERE ch.Name == "ops"]->)
  if (ops == null) { fail("no #ops channel") }
  write ops-[:Messages]-> {
    Message: "\${count(board-[:people]->-[:repos]->-[:issues]->)} open:\\n\${Text.join(lines, "\\n")}"
  }
}

listen as "Open issues by author and repo" to cron-[k:Ticks WHERE k.Schedule == "0 9 * * 1"]-> fire \`Open Issues By Author And Repo\`
`,
    },
    {
      construct: 'the compose-a-report shape (returned block lines → Text.join → pdf.render artifact)',
      status: 'runs',
      probe: `
import { \`@lf/pdf\` as pdf } from plugins
inbox = connect \`@lf/email\`
crm   = connect \`@lf/attio\` using acme

function \`Attachment Report\`(m: <inbox-[:Emails]->>) {
  lines = m-[f:Attachments]-> {
    return "- \${f.Name}"
  }
  digest = "Attachments on \${m.Subject}: \${Text.join(lines, ", ")}"

  record = write crm-[:Companies]-> {
    unique by (FUZZY Name)
    Name: m.Subject
  }
  write record-[:Files]-> {
    File: pdf.render(digest)
  }
}
`,
    },
    {
      construct: 'all over closures, run at once (independent writes, concurrent, no binding)',
      status: 'runs',
      probe: `
inbox = connect \`@lf/email\`
crm   = connect \`@lf/attio\` using acme

function \`Intake\`(m: <inbox-[:Emails]->>) {
  all(
    () => {
      write crm-[:Companies]-> {
        unique by (FUZZY Name)
        Name: m.Subject
      }
    },
    () => {
      write crm-[:People]-> {
        unique by (Email)
        Name:  m.From
        Email: m.From
      }
    },
  )
}
`,
    },
    {
      construct: 'extract-and-connect (linked pages loaded by a plain plugin call into the content, a tree extracted, linked writes along the nested node, fuzzy identity)',
      status: 'runs',
      probe: `
import { vcUrlRetrieval } from plugins
inbox = connect \`@lf/email\`
crm   = connect \`@lf/attio\` using acme

node Company: "each company this message is about" {
  name:    <text> "the company's name"
  website: <text> "the company's official website"
  node person: "each person at this company named in the message" {
    name:      <text> "the person's full name"
    job_title: <text | null> "the person's job title, if given"
  }
}

function \`Extract And Connect\`(msg: <inbox-[:Emails]->>) {
  pages     = vcUrlRetrieval(msg.Body)
  content   = [msg.Body, ...map(pages, (p) => coalesce(p.text, ""))]
  companies = extract(content, Company, { tier: "careful" })

  map(companies, (c) => {
    company = write crm-[:Companies]-> { unique by (FUZZY Name), Name: c.name, Domains: c.website }
    c-[p:person]-> {
      write company-[:Team]-> { unique by (FUZZY Name), Name: p.name, \`Job Title\` ?: p.job_title }
    }
  })
}
`,
    },
    {
      construct: 'human-reviewed-intake (manual text/files → extract → write a Check question, race its Response against a sleep, gate the linked writes on the approval)',
      status: 'runs',
      probe: `
crm  = connect \`@lf/attio\` using acme
asks = connect \`@lf/ask\`

node Company: "each company named in the supplied text or files" {
  name:    <text> "the company's name"
  website: <text> "the company's official website, if given"
  node person: "each person at this company named in the input" {
    name:  <text> "the person's full name"
    email: <text> "the person's email address, if given"
  }
}

function \`Review And Import\`(go: <manual-[:Invocation]->>) {
  found = extract([go.Text, ...go-[:Files]->.File], Company)

  q = write asks-[:Check]-> {
    Prompt: "Save these companies and people?"
    Detail: "Review the extracted records before they're written."
  }

  r = race(
    () => {
      answer = await q-[:Response]->
      return answer.Answer
    },
    () => { await sleep(1d) },
  )
  if (r[0] == true) {
    map(found, (c) => {
      company = write crm-[:Companies]-> {
        unique by (FUZZY Name)
        Name:    c.name
        Domains: c.website
      }

      c-[p:person]-> {
        write company-[:Team]-> {
          unique by (FUZZY Name)
          Name:  p.name
          Email: p.email
        }
      }
    })
  }
}

listen to manual-[:Invocations]-> fire \`Review And Import\`
`,
    },
    {
      construct: 'scheduled-digest (a cron tick fires; a bounded query composes lines; one message goes out)',
      status: 'runs',
      probe: `
crm   = connect \`@lf/attio\` using acme
chat  = connect \`@lf/slack\` using team_workspace

function \`Weekly Digest\`(t: <cron-[:Ticks]->>) {
  lines = crm-[c:Companies WHERE c.\`Created At\` WITHIN 7d ORDER BY c.\`Created At\` DESC LIMIT 20]-> {
    return "- \${c.Name}"
  }

  ops = only(chat-[ch:Channels WHERE ch.Name == "ops"]->)
  if (ops == null) { fail("no #ops channel") }
  write ops-[:Messages]-> {
    Message: "New this week:\\n\${Text.join(lines, "\\n")}"
  }
}

listen as "Weekly digest" to cron-[k:Ticks WHERE k.Schedule == "0 9 * * 1"]-> fire \`Weekly Digest\`
`,
    },
  ],
};

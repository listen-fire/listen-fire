import type { Chapter } from '../types';

export const traversal: Chapter = {
  id: 'traversal',
  title: 'Traversal blocks — doing something per related position',
  content: `## Traversal blocks — doing something per related position

Do something per related position by following a path with a block: **any position-valued path followed by a block runs the block once per position the path yields.** Two attachments → the block runs twice; none → it doesn't run at all. That is the language's only repetition — there is no loop construct.

### blocks

\`\`\`
msg-[a:Attachments]-> {
  write drive-[:file]-> {
    Name: a.\`Name\`
    Data: a.\`Data\`
  }
}
\`\`\`

- The head is a traversal: \`-[:edge]->\` relative to the enclosing position, or rooted at any in-scope name (\`deals-[c:Companies]->\`, chaining hops as usual).
- The bracket-alias (\`a\`, \`c\`) names *this iteration's* position inside the block. Aliases are lexically scoped to their block.
- A \`WHERE\` filter on the hop narrows which positions the block sees: \`msg-[f:attachments WHERE \`Content Type\` == "application/pdf"]-> { … }\`.
- Blocks nest: a block over companies can contain a block over each company's rounds. With nesting, write the inner record as a **linked write** from the enclosing handle so the structure lands connected (see the writes chapter).

A handle is already a position — "continue from the company I just wrote" needs no construct: expressions rooted at the handle read its own fields directly, and traversing further *edges* onward from it walks just like any other position (\`co-[n:Notes]-> { … }\`, \`"\${co-[:Notes]->.Content}"\`).

### query-a-graph

A constructed instance can root a traversal directly. The first hop names a collection, and the bracket takes the full query surface: \`WHERE\` to filter, \`ORDER BY\` to sort by a field of the hop target, \`LIMIT\` to take the top N.

\`\`\`
# The ten most recent Customer companies in the CRM, one block run each:
crm-[c:Companies WHERE \`Categories\` == "Customer" ORDER BY \`Created At\` DESC LIMIT 10]-> {
  …
}

# The same surface works in expressions and conditions:
Message: "Top company: \${crm-[c:Companies ORDER BY \`Team Size\` DESC LIMIT 1]->.\`Name\`}"
if EXISTS(crm-[c:Companies WHERE \`Domains\` CONTAINS m.sender_domain]->) { … }

# Sort by something one hop along — the bracket's alias names the record being ranked:
crm-[p:People ORDER BY p-[:Company]->.\`Name\`]-> { … }
\`\`\`

- \`ORDER BY\` names a field of the records the hop yields (bare, or backticked only if the name has spaces); \`ASC\` is the default, \`DESC\` reverses. Records with an empty sort field sort last either way.
- The sort key can be any expression over the record being ranked, not just one of its fields: a short path through a single reference (\`p-[:Company]->.\`Name\`\`), or a value built from its fields. A key that reads a field the source can sort by is done at the source; anything else is read record by record here, and you get a note saying so. A key that answers with several values, or one that calls \`AI\`, is refused — a record needs one value to be ranked by.
- \`LIMIT n\` keeps the first n after sorting, so pair it with an \`ORDER BY\` unless the relationship is ordered by nature (see *record-order* below). On a multi-hop path it bounds which records the NEXT hop continues from.
- A source that can filter, sort, or limit in its own query API does the work there; where it can't, the platform does it over the records the hop yields. The answer is identical either way — what changes is how much the source has to hand over.
- When part of a \`WHERE\` narrows at the source and part of it doesn't, you get a note saying which test is left over and running here. It is a cost, not a mistake: the records are the same, the fetch is bigger. Move the leftover test onto a field the source can search if the fetch matters. Where *nothing* in the \`WHERE\` narrows at the source, the hop is refused instead — that is the whole collection coming over the wire, which is a different thing.
- A collection a source can search but not sort gives you the same kind of note about the \`ORDER BY\`: it runs here, over everything the \`WHERE\` let through. The order is the one you asked for; the fetch is bigger. Narrow the \`WHERE\` further if it matters.
- A collection whose source can't narrow at all gives you the same kind of note about the \`WHERE\` itself: it runs here, over the whole collection fetched first. The records are the WHERE's answer either way; the fetch is bigger.
- An instance-rooted hop with no \`WHERE\` and no \`LIMIT\` reads the collection *whole*, page after page. Nothing caps it, so scope it unless you genuinely mean every record.

### record-order

\`\`\`
# Some relationships are ordered by nature — a channel hands its messages back
# oldest-first, an email its attachments in the order it carried them.
Message: "\${JOIN(ch-[m:Messages LIMIT 20]->.\`Text\`, "\n")}"

# Everywhere else, say what you mean.
Message: "\${JOIN(crm-[c:Companies ORDER BY \`Created At\` DESC LIMIT 5]->.\`Name\`, ", ")}"

# One record, however they come back.
channel = ONLY(chat-[ch:Channels WHERE \`Name\` == "alerts"]->)
\`\`\`

A relationship either hands its records back in an order that means something or it doesn't, and the difference decides which aggregates may read it.

- \`JOIN\`, \`FIRST\` and \`LAST\` read a sequence. Over a relationship with no order and no \`ORDER BY\` they are refused while you write, with the fixes named.
- \`ONLY(<traversal>)\` is *the one that matched* — the spelling for a lookup. It hands back that record (or that value), and fails the run if there turns out to be more than one. It makes no claim about order, so it is what a \`WHERE\` narrowing to a single record wants.
- \`COUNT\`, \`SUM\`, \`AVG\`, \`MIN\`, \`MAX\` and \`COLLECT\` give the same answer whatever the order, so they read either.
- \`LIMIT n\` with no \`ORDER BY\` means *some n of them*, and is refused for the same reason — except over a relationship ordered by nature, where "the latest twenty" is exactly what it says.

Which relationships are ordered is the source's own fact, and each one says: chat messages and thread replies by time, a curated list's entries by when they were added, a document's sections and an email's attachments by their place in it, answers and callback fires by when they landed.

### what-a-source-can-filter

Expect the filter surface to differ per source. A CRM might filter companies by a categorised field at its query API but not by a long free-text one; a record's handful of related rows can be filtered on anything, because the set is already small. Each source declares — per relationship and per field — what it can do:

- Filter or sort by something the source can't, and you get an error **while authoring**, with the reason ("this source can't filter Companies by that field — it isn't filterable at the source"). You re-shape the automation then and there — never a silent, ruinous full read at run time.
- A filter that needs in-app judgement — \`AI(...)\` or \`EXISTS(...)\` — can run only over a **bounded** relationship (a record's few related rows), where judging each one in-app is cheap. Over an unbounded collection it's blocked: the platform can't be told to read millions and judge each. Narrow to a bounded relationship first, then judge.
- \`WITHIN\` filters by recency — \`\`Created At\` WITHIN 30d\` keeps records from the last 30 days (\`d\` days, \`h\` hours, \`w\` weeks).

What you can write against a source is the overlap of the language and that source's own abilities; you learn where that overlap ends while authoring, not in production.

### deferring-a-walk

Put \`lazy\` in front of a traversal and the walk waits until something reads it:

\`\`\`
recent = lazy crm-[c:Companies ORDER BY \`Created At\` DESC LIMIT 5]->
\`\`\`

- Nothing about the result changes — same records, same filters, same types. What changes is *when* the source is read, and whether it is read at all: an edge nobody looks at is never walked.
- Every read walks again, so what comes back is the source as it is now rather than as it was at the line where you wrote it. Two reads either side of a write see the write.
- It earns its keep on a record you hand to something else: an entry of a \`node { … }\` (anatomy's records-you-build) can be \`lazy\`, so an attachment is fetched only if the reader actually opens it, and a large related set costs nothing when a branch skips it.
- \`lazy\` and \`await\` are opposites in the same slot: \`await FIRST(…)\` waits for an edge to come into existence, \`lazy\` waits to look.

### what-a-block-hands-back

Hand a value out of a block with \`return\`, and bind the block to collect what its iterations returned:

\`\`\`
names = mentioned-[c:company]-> {
  return c.name
}

Message: "Logged \${JOIN(names, ", ")}"
\`\`\`

\`return\` runs once per position the head yields, so the binding is all of them together. What that collection is follows from what you returned:

- a plain **value** — a name, a number, a composed line — gives a **list**, one entry per iteration, ready for \`JOIN\`, \`COUNT\`, or an options list;
- a **record** — a write's handle, a traversed position, a \`node { … }\` literal — gives those records themselves, walked and read like any other position.

\`\`\`
orgs = mentioned-[c:company]-> {
  return write crm-[:Companies]-> { unique by (\`Name\`), Name: c.name }
}

Message: "Logged \${COUNT(orgs)} companies"
\`\`\`

- \`return\` may sit anywhere in the body, including inside an \`if\` arm — that arm's \`return\` is the block's. Every iteration hands back the same kind of thing.
- The list is in the head's order: order the head (or head it on a relationship ordered by nature) whenever you \`JOIN\` what comes back.
- A block that ran zero times hands back an empty list, so \`COUNT(names)\` is \`0\` rather than an error.
- To hand back several things at once, return a \`node { … }\` literal built from them; the entries then read by name.
- A body with no \`return\` hands nothing back: leave it unbound and it runs for its effects.

### Pitfalls

- **Reaching for a loop.** "For each attachment…" is a traversal-headed block. If you're trying to enumerate, you're describing an edge to traverse.
- **Counting the wrong thing.** \`COUNT\` over a *source* traversal (\`COUNT(msg-[:Attachments]->)\`) counts what the source holds; \`COUNT\` over a bound block (\`COUNT(orgs)\`) counts what the block *returned*. Both run — make sure you aggregate the one you mean.
- **Reaching inside a block from outside it.** A name bound in the body — the head's alias \`a\` included — does not exist after the closing brace. \`return\` what the rest of the automation needs.`,
  engineClaims: [
    {
      construct: 'graph-rooted query traversals (WHERE / ORDER BY / LIMIT on a collection hop)',
      status: 'runs',
      probe: `
import { manual, attio } from adapters
import { acme } from credentials

runs = manual()
crm  = attio(credentials: acme)

function \`Top Ten\`(go: <runs-[:Invocation]->>) {
  crm-[c:Companies WHERE \`Categories\` == "Customer" ORDER BY \`Created At\` DESC LIMIT 10]-> {
    write crm-[:Companies]-> {
      unique by (\`Name\`)
      Name: c.\`Name\`
    }
  }
  if EXISTS(crm-[k:Companies ORDER BY \`Name\` LIMIT 1]->) {
    crm-[top:Companies ORDER BY \`Name\` DESC LIMIT 1]-> {
      write top-[:Notes]-> { Title: "Last by name", Content: top.\`Name\` }
    }
  }
}

listen to runs {} fire \`Top Ten\`
`,
    },
    {
      construct: 'an ORDER BY key that walks one hop off the record it ranks',
      status: 'runs',
      probe: `
import { manual, attio } from adapters
import { acme } from credentials

runs = manual()
crm  = attio(credentials: acme)

function \`By Company\`(go: <runs-[:Invocation]->>) {
  crm-[p:People ORDER BY p-[:Company]->.\`Name\` LIMIT 5]-> {
    write crm-[:Companies]-> {
      unique by (\`Name\`)
      Name: p.\`Name\`
    }
  }
}

listen to runs {} fire \`By Company\`
`,
    },
    {
      construct: 'a lazy pass-through edge, walked by the callee that reads it',
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials

inbox = email()
crm   = attio(credentials: acme)

node Doc {
  Title: <text>
  node files {
    Name: <text>
  }
}

function \`Store\`(d: <Doc>) {
  book = attio(credentials: acme)
  d-[f:files]-> {
    write book-[:Companies]-> {
      unique by (\`Name\`)
      Name:        f.\`Name\`
      Description: d.Title
    }
  }
}

function \`Intake\`(m: <inbox-[:Email]->>) {
  \`Store\`(d: node { Title: m.\`Subject\`, files: lazy m-[a:Attachments]-> })
}
`,
    },
    {
      construct: 'a block returning a record — the returned handles counted and walked after it',
      status: 'runs',
      probe: `
import { email, attio, slack } from adapters
import { acme, team_workspace } from credentials

inbox = email()
crm   = attio(credentials: acme)
team  = slack(credentials: team_workspace)

function \`Intake\`(m: <inbox-[:Email]->>) {
  orgs = m-[f:Attachments]-> {
    return write crm-[:Companies]-> {
      unique by (\`Name\`)
      Name: f.\`Name\`
    }
  }
  orgs-[n:Notes]-> {
    write n { Title: "Logged" }
  }
  team-[ch:Channels WHERE \`Name\` == "general"]-> {
    write ch-[:Messages]-> {
      Message: "Logged \${COUNT(orgs)} companies"
    }
  }
}
`,
    },
    {
      construct: 'the record-order rules — ONLY for a lookup, JOIN over an ordered relationship, LIMIT on a sequenced one',
      status: 'runs',
      probe: `
import { email, attio, slack } from adapters
import { acme, team_workspace } from credentials

inbox = email()
crm   = attio(credentials: acme)
team  = slack(credentials: team_workspace)

function \`Digest\`(m: <inbox-[:Email]->>) {
  channel = ONLY(team-[ch:Channels WHERE \`Name\` == "general"]->)
  if channel == null { ERROR("no #general") }
  files  = JOIN(m-[a:Attachments]->.\`Name\`, ", ")
  recent = JOIN(crm-[c:Companies ORDER BY \`Created At\` DESC LIMIT 5]->.\`Name\`, ", ")
  said   = JOIN(channel-[msg:Messages LIMIT 20]->.\`Message\`, "\n")
  write channel-[:Messages]-> {
    Message: "\${files} / \${recent} / \${said}"
  }
}
`,
    },
    {
      construct: 'a block returning a value — every iteration collected as a list',
      status: 'runs',
      probe: `
import { email, slack } from adapters
import { team_workspace } from credentials

inbox = email()
team  = slack(credentials: team_workspace)

function \`Name Them\`(m: <inbox-[:Email]->>) {
  names = m-[f:Attachments]-> {
    if f.\`Name\` == "" {
      return "unnamed"
    }
    return f.\`Name\`
  }
  team-[ch:Channels WHERE \`Name\` == "general"]-> {
    write ch-[:Messages]-> {
      Message: "\${COUNT(names)} files: \${JOIN(names, ", ")}"
    }
  }
}
`,
    },
  ],
};

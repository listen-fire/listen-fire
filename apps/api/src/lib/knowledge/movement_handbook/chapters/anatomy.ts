import type { Chapter } from '../types';

export const anatomy: Chapter = {
  id: 'anatomy',
  title: 'Anatomy of an automation file',
  content: `## Anatomy of an automation file

Write a file (extension \`.mvt\`) in four passes, top to bottom: imports, constructions, declarations, entry points.

\`\`\`
import { email, attio } from adapters
import { acme_main } from credentials

inbox = email()
crm   = attio(credentials: acme_main)

function \`Inbound Intake\`(msg: <inbox-[:Email]->>) {
  write crm-[:Companies]-> {
    unique by (\`Name\`)
    Name: msg.\`Subject\`
  }
}

listen to inbox { key: "intake" } fire \`Inbound Intake\`
\`\`\`

Imports name every external thing the file touches; constructions turn adapter types into the concrete systems ("instances") you read and write; declarations hold the automations, record structures, and file-scope values; \`listen\` lines wire an automation to what fires it — a live channel, a schedule, an on-demand run (see the listeners chapter). Comments start with \`#\`.

### imports

Import from four sources, one mechanism:

\`\`\`
import { attio, email } from adapters
import { acme_main } from credentials
import { vc_url_retrieval } from plugins
import { \`Log Lead\`, Lead as \`Inbound Lead\` } from "lib/intake-routines"
\`\`\`

- \`adapters\` — adapter *types*, the kinds of system you can construct.
- \`credentials\` — your workspace's stored connections, by name.
- \`plugins\` — functions the platform ships, called like any other. Most run over what an extraction gives them and are written as its stages; one that takes all its inputs as arguments is called anywhere a function is.
- A quoted path — automations and record structures from another saved file. Only declarations it marks \`export\` are importable, and \`as\` renames locally.

The quoted path is the other file's saved name, matched exactly — no folders, no extension, no case-folding; \`"lib/…"\` is a naming habit, not a directory. Importing from a file changes nothing about that file: its own \`listen\` lines keep firing it, and never fire yours.

### constructions

Call an adapter type like a function to get an instance — the graph you actually read and write:

\`\`\`
crm   = attio(credentials: acme_main)
inbox = email()
\`\`\`

A credential is typed: an Attio credential cannot construct a Slack instance. Some sources are credential-free and construct with no arguments. Which record types and fields an instance offers depends on the workspace behind the credentials, so the schema is only known once it is constructed — which is why automations construct the instances they use rather than receiving them. A \`node\` you declare needs no construction: it names a structure, not a system.

Every construction takes \`dry_run\` as well:

\`\`\`
crm = attio(credentials: acme_main, dry_run: true)
\`\`\`

Writes to a dry-run instance are rehearsed — captured and reported instead of committed. Three traps:

- All-or-nothing per automation: mark every written instance \`dry_run: true\` or none; mixing them is flagged.
- A step that pauses for a person has nowhere to park in a rehearsal, so the run errors when it reaches one.
- \`sleep\` doesn't wait — it skips straight ahead.

### records-you-build

Some records exist only while the run does — one assembled from several reads, or a tidied view of what arrived. Build one with a \`node { … }\` literal:

\`\`\`
deal = node {
  Title:   msg.\`Subject\`
  Raised:  NUMBER(msg.\`Body\`)
  company: node { Name: msg.\`From\` }
  files:   lazy msg-[a:Attachments]-> node { Label: a.\`Name\`, Blob: a.\`File\` }
}
\`\`\`

- The entry's VALUE decides what it declares, and nothing marks it. A plain value is a **field**. A nested \`node { … }\` is an **edge** with one record behind it; a list of them (\`files: [node { … }, node { … }]\`) is an edge with several.
- An entry may be a **traversal** instead, and then the records it lands on are handed through exactly as they are — their own field names, their own values, an attached file still the source's own file. Nothing is copied: \`files: msg-[a:Attachments]->\`.
- Put \`node { … }\` on the end of that traversal to **rename** what it lands on, one record at a time. The reader gets \`Label\` and \`Blob\` and never learns what the source called them, which is what lets one automation serve several sources.
- \`lazy\` defers the walk until something reads the edge (see the traversal chapter). Without it the walk happens where the literal is written.
- Nothing is provisioned: building one is not an effect, and it is checked by its structure — what it carries — not by any name.

### collect-what-you-wrote

Act on everything a run wrote, however many branches wrote it. Give a \`node { … }\` an entry whose value is a **type** — the address the records come from — and add to it as you go:

\`\`\`
sent = node { messages: <chat-[:Channels]->-[:Messages]->> }

chat-[ch:Channels WHERE \`Name\` == "deals"]-> {
  if msg.\`Subject\` == "urgent" {
    first = write ch-[:Messages]-> { Message: "A big one just landed." }
    link sent -[:messages]-> first
    second = write ch-[:Messages]-> { Message: "Worth a look today." }
    link sent -[:messages]-> second
  } else {
    only = write ch-[:Messages]-> { Message: "A new company just landed." }
    link sent -[:messages]-> only
  }
}

sent-[m:messages]-> {
  write m-[:Replies]-> { Message: "✅ filed" }
}
\`\`\`

- The entry starts **empty** and its type says what may land on it — every record you add has to be one of those.
- \`link\` adds one record. Anything already in your hands goes there: one you wrote, one you traversed to, one a block handed back.
- A \`link\` inside a branch is still there after the branch — what grew is the record \`sent\` names, and that name means the same thing everywhere.
- The records come back in the order the links ran, and traversing the entry is the ordinary traversal: write off each one exactly as you would off any record.
- An entry nothing was linked to traverses zero times, and \`COUNT\` over it is 0.

### declared-structures

Name that structure when a callee wants to say what it takes — with the same nesting the literal uses, so a declaration reads like the record it describes:

\`\`\`
node Deal {
  Title:  <text>
  Raised: <number>
  node company {
    Name: <text>
  }
}

function \`Process Deal\`(d: <Deal>) { … }
\`\`\`

- A declaration IS the record it describes, so \`<Deal>\` types the parameter directly. Named at the top level with typed fields, it declares; anonymous with values (\`node { … }\`), it builds.
- A body holds typed fields and nested \`node <name> { … }\` declarations. **Nesting declares the relationship, and the nested name IS the relationship's name** — \`company\` above is what the callee traverses: \`d-[c:company]->\`. Nesting recurses; a declaration is a tree.
- A field's type is \`<text>\`, \`<number>\`, \`<boolean>\`, \`<date>\`, \`<datetime>\`, \`<file>\`, or \`<json>\` — or borrowed from a real graph's field, which keeps the declaration in step with the system it feeds: \`Stage: <crm-[:Companies]->.Stage>\`.
- The name is an annotation, never an identity: **what fits is decided by structure.** Anything carrying \`Title\` and \`Raised\` fits \`<Deal>\` — a literal built here, or a position that arrived from anywhere else. A nested node never gates the fit: a record with no \`company\` links fits too, and the traversal simply finds none. Extra entries are fine; the callee cannot see them.
- A declaration is not a place records live. There is nothing to write into it — build the record with a \`node { … }\` literal.

### automations

An automation is a function over a **position** — the graph point a triggering event hands it:

\`\`\`
function \`Inbound Intake\`(e: <inbox-[:Email]->>) { … }
\`\`\`

One declaration form, used two ways: an automation wired to a \`listen\` takes **exactly one** parameter, the event position; a library automation, called from other automations rather than fired directly, takes any number. The body is statements — writes, traversal blocks, branches, assignments, and \`return\`. There is no loop construct; repetition comes from traversals (see the traversal chapter).

\`=\` binds a name to a result — an instance, a write handle, an extract graph, or a plain value:

\`\`\`
greeting = "New enquiry from \${msg.\`From\`}"
company  = write crm-[:Companies]-> { … }
\`\`\`

File-scope value bindings (a reusable prompt string, say) are allowed above the automations that use them.

### composition

Reuse an automation by calling it, never by copying it — from the same file, or imported from a library file:

\`\`\`
node Lead {
  Name: <text>
}

function \`Log Lead\`(l: <Lead>) {
  write crm-[:Companies]-> {
    unique by (\`Name\`)
    Name: l.Name
  }
}

function \`Intake\`(msg: <inbox-[:Email]->>) {
  \`Log Lead\`(l: node { Name: msg.\`Subject\` })
}
\`\`\`

- Every argument is a **position**: pass a bound name (the event, a write handle) when the callee's parameter type already matches, or build one on the spot — \`\`Log Lead\`(l: node { … })\` assembles exactly what the callee declares out of whatever the caller holds, computed values included.
- Related records travel as **edges of that literal**, so a whole small graph goes down in one argument: \`node { Name: …, files: msg-[a:Attachments]-> }\`. A call that needs two unrelated things takes two parameters instead, one per thing.
- The callee sees only its parameters and ITS OWN file's top-level names — caller locals are invisible. An imported automation runs against its own file's imports and constructions, which is why a reusable automation constructs the instances it writes to.
- A callee's effects are its writes, recorded on the caller's run.
- An automation may not call itself, directly or through a cycle.

Mark a declaration \`export\` to share it — an exported automation, or an exported \`node\` structure. Unmarked declarations are private to their file; a file with at least one export is a **library**, and can still be an automation with listeners of its own.

### returning-a-value

Hand a result out of a body with \`return\`, and a call of that automation **is** what it returned. One automation shapes what another consumes:

\`\`\`
function \`Email To Doc\`(m: <inbox-[:Email]->>) {
  return node {
    title: m.\`Subject\`
    files: lazy m-[a:Attachments]-> node { name: a.\`Name\`, blob: a.\`File\` }
  }
}

function \`Intake\`(msg: <inbox-[:Email]->>) {
  doc = \`Email To Doc\`(m: msg)
  doc-[f:files]-> {
    write drive-[:Files]-> {
      Name: f.name
      Note: doc.title
    }
  }
}
\`\`\`

- \`return\` takes any expression — a field read, a computed string, a handle, a \`node { … }\` literal. It is the one way a value leaves a body, so what the caller can see is exactly what you chose to hand it. A \`return\` inside an \`if\` arm returns from the body around it.
- **Several results travel as one \`node { … }\`.** The entry's value decides how the caller reads it, exactly as in \`records-you-build\`: a plain value reads with a **dot** (\`doc.title\`), a nested literal or a traversal is an **edge** to walk (\`doc-[f:files]-> { … }\`). A name the callee never returned is simply not there.
- Because the value is an ordinary record, it fits a parameter by **structure**: hand it straight to anything whose declared shape it carries.
- A \`lazy\` entry stays deferred across the call — the caller gets the walk, not its answers, so reading it looks at the source as it is then.
- A body with no \`return\` hands nothing back. Call it on its own line and it runs for its effects; try to bind it and you are told there is nothing to bind.
- A value goes straight on as an argument, so shape-then-consume needs no name in between: pass the call itself where the argument goes, rather than binding it to a name first.

### Pitfalls

- **An automation with no effects.** A body with no \`write\`, \`link\`/\`unlink\`, or \`delete\` provisions nothing — there is nothing to run.`,
  engineClaims: [
    {
      construct: 'movement calls (composition) with a synthesised node argument',
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials

inbox = email()
crm   = attio(credentials: acme)

node Lead {
  Name: <text>
}

function \`Log Lead\`(l: <Lead>) {
  write crm-[:Companies]-> {
    unique by (\`Name\`)
    Name: l.Name
  }
}

function \`Intake\`(m: <inbox-[:Email]->>) {
  \`Log Lead\`(l: node { Name: m.\`Subject\` })
}
`,
    },
    {
      construct: 'a declared edge on a run-local node, grown by `link` from inside a branch and traversed after it',
      status: 'runs',
      probe: `
import { email, slack } from adapters
import { team_workspace } from credentials

inbox = email()
chat  = slack(credentials: team_workspace)

function \`Post And Confirm\`(msg: <inbox-[:Email]->>) {
  sent = node { messages: <chat-[:Channels]->-[:Messages]->> }

  chat-[ch:Channels WHERE \`Name\` == "deals"]-> {
    if msg.\`Subject\` == "urgent" {
      first = write ch-[:Messages]-> { Message: "A big one just landed." }
      link sent -[:messages]-> first
      second = write ch-[:Messages]-> { Message: "Worth a look today." }
      link sent -[:messages]-> second
    } else {
      only = write ch-[:Messages]-> { Message: "A new company just landed." }
      link sent -[:messages]-> only
    }
  }

  sent-[m:messages]-> {
    write m-[:Replies]-> { Message: "✅ filed" }
  }
}

listen to inbox { key: "intake" } fire \`Post And Confirm\`
`,
    },
    {
      construct: "a call's value — what the callee returned, bound and passed on",
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials

inbox = email()
crm   = attio(credentials: acme)

node Lead {
  Name: <text>
}

function \`Email To Lead\`(m: <inbox-[:Email]->>) {
  return node { Name: m.\`Subject\` }
}

function \`Log Lead\`(l: <Lead>) {
  write crm-[:Companies]-> {
    unique by (\`Name\`)
    Name: l.Name
  }
}

function \`Intake\`(m: <inbox-[:Email]->>) {
  lead = \`Email To Lead\`(m: m)
  \`Log Lead\`(l: lead)
  \`Log Lead\`(l: \`Email To Lead\`(m: m))
}
`,
    },
    {
      construct: 'a returned node carrying several results — one entry read by dot, one walked as an edge',
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials

inbox = email()
crm   = attio(credentials: acme)

function \`Email To Doc\`(m: <inbox-[:Email]->>) {
  return node {
    title: m.\`Subject\`
    files: lazy m-[a:Attachments]-> node { name: a.\`Name\` }
  }
}

function \`Intake\`(msg: <inbox-[:Email]->>) {
  doc = \`Email To Doc\`(m: msg)
  doc-[f:files]-> {
    write crm-[:Companies]-> {
      unique by (\`Name\`)
      Name:        f.name
      Description: doc.title
    }
  }
}
`,
    },
    {
      construct: 'multi-parameter library movements (any arity by call; entries stay arity-1)',
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials

inbox = email()
crm   = attio(credentials: acme)

node Lead {
  Name: <text>
}

node Note {
  Text: <text>
}

function \`Persist Pair\`(c: <Lead>, n: <Note>) {
  write crm-[:Companies]-> {
    unique by (\`Name\`)
    Name:        c.Name
    Description: n.Text
  }
}

function \`Intake\`(m: <inbox-[:Email]->>) {
  \`Persist Pair\`(c: node { Name: m.\`Subject\` }, n: node { Text: m.\`Subject\` })
}
`,
    },
    {
      construct: 'a node literal TREE — a single synthesised edge, traversed by the callee',
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials

inbox = email()
crm   = attio(credentials: acme)

node Deal {
  Title: <text>
  node company {
    Name: <text>
  }
}

function \`Log Deal\`(d: <Deal>) {
  book = attio(credentials: acme)
  d-[o:company]-> {
    write book-[:Companies]-> {
      unique by (\`Name\`)
      Name:        o.Name
      Description: d.Title
    }
  }
}

function \`Intake\`(m: <inbox-[:Email]->>) {
  \`Log Deal\`(d: node { Title: m.\`Subject\`, company: node { Name: m.\`From\` } })
}
`,
    },
    {
      construct: 'per-item synthesis on a traversal tail (renamed landings)',
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials

inbox = email()
crm   = attio(credentials: acme)

node Doc {
  Title: <text>
  node files {
    Label: <text>
  }
}

function \`Store\`(d: <Doc>) {
  book = attio(credentials: acme)
  d-[f:files]-> {
    write book-[:Companies]-> {
      unique by (\`Name\`)
      Name:        f.Label
      Description: d.Title
    }
  }
}

function \`Intake\`(m: <inbox-[:Email]->>) {
  \`Store\`(d: node { Title: m.\`Subject\`, files: lazy m-[a:Attachments]-> node { Label: a.\`Name\` } })
}
`,
    },
    {
      construct: 'file imports (shared movement libraries)',
      status: 'runs',
      probe: `
import { email } from adapters
import { \`Log Lead\` } from "lib/intake-routines"

inbox = email()

function \`Intake\`(m: <inbox-[:Email]->>) {
  \`Log Lead\`(l: m)
}
`,
    },
  ],
};

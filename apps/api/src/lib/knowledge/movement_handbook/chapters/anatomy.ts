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

Some records exist only while the run does — one assembled from several reads, or a tidied view of what arrived. Build one with a \`graph<Shape> { … }\` literal (see *graph-literals* below, the form to prefer). The anonymous \`node { … }\` literal builds the same kind of record, is still supported, and is what this section and many saved automations use:

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
- \`both = [one, two]\` gathers records you already hold into one list, and a block head walks them in the order written: \`both-[c:company]-> { … }\`. A list holds one kind of thing — records or values, never both.
- Nothing is provisioned: building one is not an effect, and it is checked by its structure — what it carries — not by any name.
- A literal names every entry it carries. Copying a whole record — a literal, an extracted one, a declared parameter — into a system is a write's job: \`...n\` or \`?...n\` in the write body (see the writes chapter).

### graph-literals

\`graph<Shape> { … }\` builds a local graph as a value. In the modern spelling \`node\` only **declares** a shape and \`graph\` only **builds** a value, so the two never blur:

\`\`\`
node Message {
  Body: <text>
  node Attachments {
    Name: <text>
    \`Content Type\`: <text>
  }
}

function \`Snapshot\`(m: <inbox-[:Email]->>) {
  msg = graph<Message> {
    Body: m.\`Body\`
    Attachments: m-[a:Attachments]-> {
      Name: a.\`Name\`
      \`Content Type\`: a.\`Content Type\`
    }
  }
  copy = graph<Message> {
    Body: m.\`Body\`
    Attachments: m-[:Attachments]->
  }
}
\`\`\`

- **With a shape** the literal is checked as TypeScript's \`satisfies\` checks one, and the value is then of that shape. A misspelt field is refused with the closest name, a mistyped field is refused, a field given where the shape has a nested node (or the reverse) is refused, and so is a required field never written. A \`<text | null>\` field may be left out; it then reads as absent.
- **Without a shape** — \`graph { … }\` — the type comes from the literal. \`graph<Shape> {}\` is the typed empty graph, valid when the shape requires no field; its nested nodes start empty (an edge holds zero or more records).
- **The body uses a write body's syntax.** \`{ … }\` is one nested record and \`[{ … }, { … }]\` several. A path followed by a field body — \`Attachments: m-[a:Attachments]-> { Name: a.\`Name\` }\` — builds one nested record per record on the path. A bare path — \`Attachments: m-[:Attachments]->\` — **copies** each record: the shape says which fields to take and follows the source's edge of the same name into every nested node; with no shape the records' own fields are copied.
- **Copies are snapshots.** Nothing in the graph points back into the system it was read from, so writing to the graph never reaches the source. A file is copied as the handle it is; nothing downloads.
- **\`...v\` spreads a computed map** (plugin output, JSON, a \`{ … }\` dict) into the body. With a shape, the shape decides whether a nested map is a nested record or a plain value; a map nobody can type is checked against the shape when the graph is built, and the run fails naming the first field that does not fit. Without a shape every nested map is a nested record, and a map whose keys are unknown is refused. Spreading something that is not a map is refused. Members take effect in the order written, as in a dict literal: a later field, child node or spread wins, so \`graph<Note> { ...v, text: "mine" }\` holds \`"mine"\`, and a spread after \`text: "mine"\` replaces it. A key written before a spread that always has it is refused when you save, since the spread overwrites it: move it after the spread to override. A spread of a record that may not be there overwrites nothing when it isn't, so it is no error.
- The result reads by path, \`WHERE\` and dot, takes \`write\`, \`link\` and \`delete\` like any record the run built, fits a parameter of its shape, and can be a function's return value.
- A copy whose records lack a field the shape requires is refused, and so is a shapeless copy over records nothing describes.

### collect-what-you-wrote

Act on everything a run wrote, however many branches wrote it. Give a \`node { … }\` an entry whose value is a **type** — the address the records come from — and add to it as you go:

\`\`\`
sent = node { messages: <chat-[:Channels]->-[:Messages]->> }

deals = ONLY(chat-[ch:Channels WHERE \`Name\` == "deals"]->)
if deals == null { ERROR("no #deals channel") }
if msg.\`Subject\` == "urgent" {
  first = write deals-[:Messages]-> { Message: "A big one just landed." }
  link sent -[:messages]-> first
  second = write deals-[:Messages]-> { Message: "Worth a look today." }
  link sent -[:messages]-> second
} else {
  only = write deals-[:Messages]-> { Message: "A new company just landed." }
  link sent -[:messages]-> only
}

sent-[m:messages]-> {
  write m-[:Replies]-> { Message: "✅ filed" }
}
\`\`\`

- The entry starts **empty** and its type says what may land on it — every record you add has to be one of those.
- \`link\` adds one record. Anything already in your hands goes there: one you wrote, one you traversed to, one a block handed back.
- A \`link\` inside a branch is still there after the branch — what grew is the record \`sent\` names, and that name means the same thing everywhere.
- Traversing the entry is the ordinary traversal: write off each one exactly as you would off any record.
- Say \`order by arrival\` after the type to keep the order the links landed in — \`sent = node { messages: <chat-[:Channels]->-[:Messages]->> order by arrival }\` — and \`FIRST\`, \`LAST\`, \`JOIN\` and \`LIMIT\` then read the entry. Without it the entry is a set, like any relationship with no order of its own (see the traversal chapter's *record-order*); \`document\` and \`chronological\` are the other two words, and all three read back in the order the links landed. The same clause works after a NESTED node's own \`}\` inside a declared type — \`node Entry { name: <text>  node founder { first: <text> } order by arrival }\` — so \`FIRST(e-[:founder]->)\` reads them back in the order they were written onto that landing.
- An entry nothing was linked to traverses zero times, and \`COUNT\` over it is 0.

Type the entry with a **declaration** rather than an address, and \`write\` into it to gather records before any of them reaches a system:

\`\`\`
node Company {
  name:    <text>
  website: <text>
  node founder { name: <text> }
}

deduped = node { companies: <Company> }

found-[c:company]-> {
  write deduped-[:companies]-> {
    unique by (FUZZY name)
    name:      c.name
    website ?: c.website
  }
}

deduped-[c:companies ORDER BY \`name\`]-> { … }
\`\`\`

- \`<Company>\` says what the landings CARRY rather than where they come from, so what lands is judged by its structure.
- The write builds or merges by identity exactly as a write into a system does: \`unique by\` decides, and \`?:\` fills only what is absent. The *identity* section of the writes chapter has the forms.
- Only records the run built on the entry are candidates to merge into — one you linked in or traversed to lives in a system, and is left alone.
- \`link\` still appends by reference, and both forms may grow the same entry.
- Grow a node the declaration NESTED on what the write handed back: \`c = write deduped-[:companies]-> { … }\`, then \`link c -[:founder]-> person\`. A landing is a whole record of that shape, so every nested node comes with it — empty, and appendable exactly as the entry itself is.

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
- A field's type is \`<text>\`, \`<number>\`, \`<boolean>\`, \`<date>\`, \`<datetime>\`, \`<file>\`, or \`<json>\` — or borrowed from a real graph's field, which keeps the declaration in step with the system it feeds: \`Stage: <crm-[:Companies]->.Stage>\`. A field holds its type: a number or a yes/no given to a \`<text>\` field is refused — write the text you mean, \`TOSTRING(n)\` or \`IF b THEN "Yes" ELSE "No" END\`. Add \`| null\` (\`<text | null>\`) for a field that may be missing: wherever the declaration is used — an extraction, a parameter, a collecting node's entries, a spread — it reads \`T | absent\`, so a null test on it works and a plain write of it needs \`?:\` or a guard.
- The name is an annotation, never an identity: **what fits is decided by structure.** Anything carrying \`Title\` and \`Raised\` fits \`<Deal>\` — a literal built here, or a position that arrived from anywhere else. A nested node never gates the fit: a record with no \`company\` links fits too, and the traversal simply finds none. Extra entries are fine; the callee cannot see them.
- A declaration may say what it, each field and each nested node **is**, in the words an extraction is given: \`node Deal: "each deal in the message" { Title: <text> "its headline"; node company: "the company raising" { … } }\`. Undescribed parts stay allowed. Words may use file-scope values bound **above** the declaration (\`"\${rules}"\`); an extraction then reuses the whole tree as \`node deal: <Deal>\` (extraction chapter, *basics*).
- A declaration is not a place records live. There is nothing to write into \`Deal\` itself — build the record with a \`node { … }\` literal, or write into an entry typed by it (see *collect-what-you-wrote*).

Extend a declaration when a later step needs more than an earlier one may see — an enrichment stage adds one field the first extraction must not be asked:

\`\`\`
node \`Recap Entry\` extends Entry {
  diverse_founder: <text | null> "whether any founder is from an under-represented group"
}
\`\`\`

- \`Recap Entry\` is every field and nested node of \`Entry\` — their types, their words and their \`order by\` — then its own, and it goes anywhere \`Entry\` does. Its own record-level words follow the base: \`node X extends Y: "…" { … }\`.
- It only adds. Restating something \`Entry\` already has is refused, by name. The base is declared in this file or imported, and the base's words still read the file that wrote them.

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

### functions-and-calls

\`function\` and \`movement\` declare the same thing, and so do a closure bound to a name and a plugin's or a built-in's own name: all of them are **functions**, called the same way. Write your own to the convention every built-in follows:

\`\`\`
name(data…, config record, lambda)
\`\`\`

- **Data first**, in an order that is obvious and that the checker backs up: \`MAP(xs, { onError: 'warn' }, f)\`, \`extract(content, Shape, { tier: 'careful' })\`.
- **A config record next** for options — a final record of named settings, each written down.
- **A lambda last** when the function calls back into your code.
- Leave out whatever makes no sense for the function. A collection is one list argument rather than a variadic run, so calls stay chainable.

The convention is for authors of functions; the language does not enforce it on a call.

\`\`\`
function \`Label\`(name: <text>, tags: <text[]>, cfg: <{ prefix: text, suffix?: text }>) {
  return "\${cfg.prefix}\${name} (\${JOIN(tags, ', ')})"
}

function \`Intake\`(m: <inbox-[:Email]->>) {
  title = label(m.\`Subject\`, ["new", "inbound"], { prefix: "> " })
  write crm-[:Companies]-> {
    unique by (\`Name\`)
    Name:        m.\`Subject\`
    Description: title
  }
}
\`\`\`

- **A call is positional**: arguments bind to the parameters in declared order, as TypeScript calls a function — \`\`Email To Doc\`(msg)\`, \`log_doc(email_to_doc(msg))\`. The named form (\`\`Email To Doc\`(m: msg)\`) is still supported and means the same; one call is all positional or all named, and a mix is a parse error. Too few or too many arguments is refused, naming what is missing; a type mismatch names the parameter the argument binds to. A plugin's arguments stay named.
- **A parameter can take a value, not only a record**: a scalar (\`<text>\`, \`<number>\`, \`<boolean>\`, \`<date>\`, \`<datetime>\`, \`<file>\`, \`<json>\`), a declared refinement (\`<Tone>\`), a list (\`<text[]>\`), or a config record written as a TypeScript object type (\`<{ k: T, j?: T }>\`). The argument is any expression, checked as TypeScript checks one: a record literal may not carry a key the parameter does not declare (the closest is suggested), a required key may not be missing, a string literal against a refinement must be one of its values, and a value that may be absent does not fill a required parameter. Inside the function an optional key reads as possibly absent.
- A value handed to a parameter that takes a record (\`persist(c: m.\`Subject\`)\` where \`c: <Lead>\`) is refused when you save.
- **Function names are case-insensitive**: \`upper(x)\`, \`UPPER(x)\` and \`Upper(x)\` are the same built-in, and \`Email_To_Doc(m)\` calls \`email_to_doc\`. Your own function \`\`Label\`\` above is called as \`label(…)\`. Variable names keep their case.
- **Names are checked when you save.** An unknown function name is refused with the closest function or built-in suggested (a write field is the exception: its target may offer functions of its own). Two functions whose names differ only by letter case, or a function named like a built-in in any case, are refused as a collision. A name holding a value shadows a built-in as in TypeScript, so \`upper = 3\` then \`upper(x)\` is refused.
- **A function that may wait is called on its own line.** One that \`await\`s parks the run inside it, however many calls deep, and the run resumes there: the rest of the function runs, its \`return\` comes back to the line that called it, and that line goes on. Call it as a statement, or as the whole right-hand side of a binding (\`answer = ask_partner(c)\`) — never inside an expression (see *calls-inside-expressions*).

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
  \`Log Lead\`(graph<Lead> { Name: msg.\`Subject\` })
}
\`\`\`

- Calls are positional (see *functions-and-calls*); the examples below that name an argument (\`\`Log Lead\`(l: …)\`) are the older, still supported spelling.
- Every argument is a **position**: pass a bound name (the event, a write handle) when the callee's parameter type already matches, or build one on the spot — \`\`Log Lead\`(graph<Lead> { … })\` (or the older \`node { … }\`) assembles exactly what the callee declares out of whatever the caller holds, computed values included.
- A system can publish the same record kind along two edges — a readable collection and the edge a listener fires along. A record reached by walking the collection matches a parameter typed on the listener's own address with no wrapper needed, because the two promises share one position.
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
      construct: 'a declared edge on a run-local node, ordered by arrival, grown by `link` from inside a branch and traversed after it',
      status: 'runs',
      probe: `
import { email, slack } from adapters
import { team_workspace } from credentials

inbox = email()
chat  = slack(credentials: team_workspace)

function \`Post And Confirm\`(msg: <inbox-[:Email]->>) {
  sent = node { messages: <chat-[:Channels]->-[:Messages]->> order by arrival }

  deals = ONLY(chat-[ch:Channels WHERE \`Name\` == "deals"]->)
  if deals == null { ERROR("no #deals channel") }
  if msg.\`Subject\` == "urgent" {
    first = write deals-[:Messages]-> { Message: "A big one just landed." }
    link sent -[:messages]-> first
    second = write deals-[:Messages]-> { Message: "Worth a look today." }
    link sent -[:messages]-> second
  } else {
    only = write deals-[:Messages]-> { Message: "A new company just landed." }
    link sent -[:messages]-> only
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
      construct: 'a write into a declaration-typed entry of a node the run built',
      status: 'runs',
      probe: `
import { manual } from adapters

runs = manual()

node Company {
  name:    <text>
  website: <text>
}

function \`Dedupe\`(go: <runs-[:Invocation]->>) {
  found = extract from [go.\`Text\`] {
    node company: "each company named in the supplied text" {
      name:    "the company's name"
      website: "its website, if given"
    }
  }

  deduped = node { companies: <Company> }

  found-[c:company]-> {
    write deduped-[:companies]-> {
      unique by (FUZZY name)
      name:      c.name
      website ?: c.website
    }
  }

  deduped-[c:companies ORDER BY \`name\`]-> {
    return c.name
  }
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
    {
      construct: 'graph literals — graph<Shape> with path-with-field-body children, a bare-path copy, and a spread of a map',
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials

inbox = email()
crm   = attio(credentials: acme)

node Message {
  Body: <text>
  node Attachments {
    Name: <text>
    \`Content Type\`: <text>
  }
}

node Setting {
  mode: <text | null>
  limit: <number | null>
}

function \`Snapshot\`(m: <inbox-[:Email]->>) {
  msg = graph<Message> {
    Body: m.\`Body\`
    Attachments: m-[a:Attachments]-> {
      Name: a.\`Name\`
      \`Content Type\`: a.\`Content Type\`
    }
  }
  copy = graph<Message> {
    Body: m.\`Body\`
    Attachments: m-[:Attachments]->
  }
  empty = graph<Setting> {}
  raw   = { mode: "fast", limit: 3 }
  cfg   = graph<Setting> { ...raw }
  loose = graph { title: m.\`Subject\` }
  msg-[a:Attachments]-> {
    write crm-[:Companies]-> { unique by (\`Name\`) Name: a.Name }
  }
}

`,
    },
    {
      construct: 'function convention — positional calls, value and record parameters, case-insensitive names',
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials

inbox = email()
crm   = attio(credentials: acme)

function \`Label\`(name: <text>, tags: <text[]>, cfg: <{ prefix: text, suffix?: text }>) {
  return "\${cfg.prefix}\${name} (\${JOIN(tags, ', ')})"
}

function \`Intake\`(m: <inbox-[:Email]->>) {
  title = label(m.\`Subject\`, ["new", "inbound"], { prefix: "> " })
  write crm-[:Companies]-> {
    unique by (\`Name\`)
    Name:        m.\`Subject\`
    Description: title
  }
}

`,
    },
  ],
};

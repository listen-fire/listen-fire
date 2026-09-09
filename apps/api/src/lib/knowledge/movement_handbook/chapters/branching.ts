import type { Chapter } from '../types';

export const branching: Chapter = {
  id: 'branching',
  title: 'Branching — if, else, and type tests',
  content: `## Branching — if, else, and type tests

Act only under a condition with a plain \`if\` over an ordinary boolean expression — a field value, \`EXISTS(…)\`, a combination with \`AND\`/\`OR\`.

### conditions

\`\`\`
function \`Inbound Intake\`(msg: <inbox-[:Email]->>) {
  if msg.\`Subject\` CONTAINS "order" {
    write crm-[:Companies]-> { … }
  }
}
\`\`\`

No \`else\` means the other cases simply do nothing. The statement \`if\` is lowercase, like the rest of the statement layer; the value-level conditional inside field expressions stays \`IF … THEN … ELSE … END\`.

### narrowing

Narrow a source that may be several kinds with \`IS\`, before you traverse it:

\`\`\`
function \`Route Change\`(ev: <crm-[:\`Webhook Event\`]->>) {
  if ev IS <crm-[:\`Webhook Event\` WHERE \`action\` == "record.created"]->> {
    ev-[rec:Companies]-> {
      write rec { Description: "logged on creation" }
    }
  }
}
\`\`\`

A change event stands for creates, updates, and deletes, and what you can reach differs by case — a deleted record isn't there to traverse to. Inside the arm \`ev\` is a *created* event, so the edges only a live record has are reachable; outside it they are not, and traversing without narrowing is refused while you author, naming the cases the edge belongs to. \`IS\` is valid anywhere a boolean is, including \`WHERE\` filters. If a record arrives without a kind on it — an event the trigger never discriminated, or one delivered without the field a test names — the run stops with that reason rather than picking a branch, so no arm ever runs against a record it can't identify.

An \`else\` narrows too: reaching it proves the record isn't what the arms above tested, so the else sees the kinds that are left, and an \`else if\` chain keeps eliminating down to one. Handle every kind and the final \`else\` has nothing left to reach — reading a field there is refused, which is how you find a branch that can't run.

A test can also name a **declared structure** instead of a kind: it holds when the record carries every field that structure declares, with a compatible type. A nested node never gates the test — a record with none of that relationship carries an empty set of them, and fits. Carrying more than the declaration is fine. It narrows exactly like the tests above: the arm keeps the kinds that fit, the \`else\` keeps the rest.

\`\`\`
node Contact {
  Name:  <text>
  Email: <text>
}

  if rec IS <Contact> {
    write chat-[:Messages]-> { Message: "\${rec.\`Name\`} <\${rec.\`Email\`}>" }
  }
\`\`\`

Presence narrows the same way: \`== null\` / \`!= null\` settles whether a value that might be missing is there — see *values that may not be there* in the expressions chapter, and the guard below.

### guard-with-error

Stop a run with a reason instead of writing bad data — and settle what follows in the same line:

\`\`\`
function \`Notify Company Change\`(evt: <crm-[:\`Webhook Event\`]->>) {
  channel = ONLY(chat-[ch:Channels WHERE \`Name\` == "automation-alerts"]->)
  if channel == null { ERROR("channel not found") }

  # \`channel\` is a present record from here on — no further guard needed
  write channel-[:Messages]-> { Message: "…" }
}
\`\`\`

- \`ERROR("…")\` ends the run immediately with that message as its reason; nothing after it executes, and the message shows in run history so whoever reads the run knows what tripped the guard. Interpolate it to name the culprit: \`ERROR("unexpected record kind: \${rec.\`Type\`}")\`.
- Because that arm ends the run, reaching the next line proves the condition was false. So a guard clause narrows the *rest of the body*, not just an \`else\`: check what you need, bail with a reason if it's missing, then write the rest as if it were always there. Stack one guard per thing you need.
- \`ONLY(<traversal>)\` over a bare path binds the found record itself, and the traversal might match nothing — so writing to it, linking off it, or reading a field off it is refused until a guard settles it.
- \`if EXISTS(x) { … }\` narrows only **inside** that arm and closes at the brace. Reach for it when absence wants no special handling, and for a guard clause when absence should stop the run.

\`ERROR\` inside a traversal block ends the whole run, not that iteration — and writes already made stay made, in this run and earlier iterations. Guard before you write, not after.

### Pitfalls

- **A flag set inside a block to detect presence.** A binding means one thing everywhere it is visible, so re-using an outer name inside a block is refused when you save. Nothing needs the flag: the block already runs once per position and not at all when there are none, so the block itself *is* the "has one" branch; pair it with \`if NOT EXISTS(msg-[:Attachments]->) { … }\` for "has none". \`COUNT(…)\` for how many, \`EXISTS(…)\` for whether-any.
- **Binding a field just to test it.** \`EXISTS\` and \`ISNULL\` read a field off a record directly — \`if EXISTS(x.\`Field\`) { … }\`, \`if ISNULL(x.\`Field\`) { ERROR("…") }\` — and narrow that field, and the record it came off, for what follows.
- **Using \`ERROR(…)\` for an ordinary skip.** A plain \`if\` with no \`else\` already does nothing; keep \`ERROR(…)\` for failures worth surfacing.`,
  engineClaims: [
    {
      construct: 'IS type tests (union narrowing through a branch)',
      status: 'runs',
      probe: `
import { attio } from adapters
import { acme } from credentials

crm = attio(credentials: acme)

function \`Route\`(ev: <crm-[:\`Webhook Event\`]->>) {
  if ev IS <crm-[:\`Webhook Event\` WHERE \`action\` == "record.created"]->> {
    ev-[rec:Companies]-> {
      write rec { Description: "logged on creation" }
    }
  }
}
`,
    },
    {
      construct: 'IS against a declared node (structural conformance as a test)',
      status: 'runs',
      probe: `
import { attio, slack } from adapters
import { acme as crmCred, team_workspace as slackCred } from credentials

crm  = attio(credentials: crmCred)
chat = slack(credentials: slackCred)

node Postable {
  Name: <text>
}

function \`Announce\`(evt: <crm-[:\`Webhook Event\` WHERE \`action\` == "record.created"]->>) {
  channel = ONLY(chat-[ch:Channels WHERE \`Name\` == "alerts"]->)
  if channel == null { ERROR("channel not found") }

  evt-[co:Companies]-> {
    if co IS <Postable> {
      write channel-[:Messages]-> { Message: "\${co.Name}" }
    }
  }
}
`,
    },
    {
      construct: 'standalone ERROR() statement (a guard that fails the run)',
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials

inbox = email()
crm   = attio(credentials: acme)

function \`Intake\`(m: <inbox-[:Email]->>) {
  if m.\`From\` == "" {
    ERROR("no sender — refusing to create a contact without one")
  }
  write crm-[:People]-> { unique by (\`Email\`), Name: m.\`From\`, Email: m.\`From\` }
}
`,
    },
    {
      construct: "'else if' chains",
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials

inbox = email()
crm   = attio(credentials: acme)

function \`Intake\`(m: <inbox-[:Email]->>) {
  sender = write crm-[:People]-> {
    unique by (\`Email\`)
    Name:  m.\`From\`
    Email: m.\`From\`
  }
  if m.\`Subject\` CONTAINS "order" {
    write sender-[:Notes]-> { Title: "Order", Content: m.\`Subject\` }
  } else if m.\`Subject\` CONTAINS "invoice" {
    write sender-[:Notes]-> { Title: "Invoice", Content: m.\`Subject\` }
  } else {
    write sender-[:Notes]-> { Title: "Other", Content: m.\`Subject\` }
  }
}
`,
    },
    {
      construct:
        'guard clause on an ONLY-bound record (`if x == null { ERROR(…) }`) narrowing the write below it, plus IF EXISTS THEN…ELSE…END for an optional field',
      status: 'runs',
      probe: `
import { attio, slack } from adapters
import { acme as crmCred, team_workspace as slackCred } from credentials

crm  = attio(credentials: crmCred)
chat = slack(credentials: slackCred)

function \`Notify Company Change\`(evt: <crm-[:\`Webhook Event\`]->>) {
  channel = ONLY(chat-[ch:Channels WHERE \`Name\` == "automation-alerts"]->)
  if channel == null { ERROR("channel not found") }

  if evt IS <crm-[:\`Webhook Event\` WHERE \`action\` == "record.created"]->> {
    evt-[co:Companies]-> {
      domain      = FIRST(co.Domains)
      \`Domain Line\` = IF EXISTS(domain) THEN "\\n<https://\${domain}|\${domain}>" ELSE "" END

      write channel-[:Messages]-> {
          Message: "*New company in Attio:* \${co.Name}\\n\${co.Description}\${\`Domain Line\`}"
      }
    }
  }
}

listen to crm { events: ["record.created", "record.updated"] } fire \`Notify Company Change\`
`,
    },
    {
      construct: 'a chain of flat guard clauses, each narrowing a separate ONLY-bound binding',
      status: 'runs',
      probe: `
import { attio, slack } from adapters
import { acme as crmCred, team_workspace as slackCred } from credentials

crm  = attio(credentials: crmCred)
chat = slack(credentials: slackCred)

function m(evt: <crm-[:\`Webhook Event\` WHERE \`action\` == "record.created"]->>) {
  channel = ONLY(chat-[ch:Channels WHERE \`Name\` == "alerts"]->)
  if channel == null { ERROR("channel not found") }

  evt-[co:Companies]-> {
    owner = ONLY(co-[t:Team]->)
    if owner == null { ERROR("no owner") }

    write channel-[:Messages]-> { Message: "\${co.Name} owned by \${owner.Name}" }
  }
}
`,
    },
  ],
};

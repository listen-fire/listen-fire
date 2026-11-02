import type { Chapter } from '../types';

export const asks: Chapter = {
  id: 'reviews',
  title: 'Reviews — waiting on a person or a system',
  content: `## Reviews — waiting on a person or a system

A run can wait for something outside it: a press on a button, a form someone fills in, a reply in a thread, a question answered. Each answer **arrives on an edge** of a record the run holds — a message's \`Interactions\`, a form's \`Submissions\`, a thread's \`Replies\`. Write the record, then \`await\` that edge: the run parks, holding nothing open, and resumes where it left off with the answer bound and every other binding it had — minutes or days later.

Reach for one only when a *judgement* is genuinely needed. A value you can compute, extract, or default with a \`?:\` set-if-empty field is not one.

### waiting-on-a-person

\`\`\`
msg = write deals-[:Messages]-> {
  Message: "New company: \${\`Company Name\`}. Pursue it?"
  Buttons: [{ Text: "Pursue", Value: "pursue" }, { Text: "Pass", Value: "pass" }]
}

r = race(
  () => {
    press = await msg-[:Interactions]->
    return only(press-[:Actions]->).Value
  },
  () => { await sleep(2d) },
)

if (r[0] == "pursue") {
  write crm-[:Companies]-> { unique by (FUZZY Name), Name: \`Company Name\` }
}
if (r[0] == null) {
  write msg-[:Replies]-> { Message: "Nobody decided in time — holding." }
}
\`\`\`

- The write that puts the question makes the record the answer lands on. There is nothing else to mint: no id, no address.
- \`await\` takes one hop off one record and binds one record: what arrived.
- The wait opens just before the write runs, so an answer that comes while the write is still finishing counts.
- **Give every wait a timeout.** Put it in a \`race\` with a \`sleep\`, as here. An answer that never comes otherwise leaves the run parked for good.
- What \`await\` binds is always there, so nothing after it needs a \`== null\` test (a record deleted while the run waits: \`deleted-records\`).
- Only an edge whose system announces what arrives on it can be awaited: a message's \`Interactions\` and \`Replies\`, a form's \`Submissions\`, a question's \`Response\`. Each system's chapter says which of its edges announce. Awaiting any other edge is refused when you save, with the read or the \`await until\` to write instead.

### await-and-await-new

- \`await x-[:Replies]->\` takes the first match already on the edge, in the order the system keeps it, or else the first to arrive.
- \`await new x-[:Replies]->\` takes only the first to arrive after \`x\` entered the run: when it was written (just before the write), read, or handed in as a parameter.
- The record that started the run, and each record its arrival brought with it (a change brings its deal), entered at delivery. So a change of that deal in the same delivery counts; the change that started the run never does.
- A record the run walks to that the arrival did not bring (the deal's company) enters at the walk: only what arrives after that counts.
- On an edge that only announces — a press, a form's answer — the two are the same: nothing is there before it arrives.
- On an edge whose system keeps no order, plain \`await\` is refused when you save, because there is no "first already there": write \`await new\`.
- A \`WHERE\` on the hop says which arrival counts.
- Two plain \`await\`s on the same record's edge share one wait, and both bind the same first match.
- The head is a name bound to one record, and the wait takes one hop off it. To wait at the end of a longer walk, bind the record the last hop leaves from, then await its edge.

\`\`\`
thread = only(ops-[m:Messages WHERE m.Message == go.Text]->)
if (thread == null) { fail("no message \\"\${go.Text}\\" in #ops") }
write thread-[:Replies]-> { Message: "Any update on this?" }

r = race(
  () => {
    reply = await new thread-[x:Replies WHERE x.User == thread.User]->
    return reply.Message
  },
  () => { await sleep(1d) },
)
\`\`\`

\`new\` skips the replies already in the thread, and the \`WHERE\` takes only its author's, so the nudge the run just posted never answers it.

### buttons

Buttons are a field of the message the run writes. A press arrives on the message's \`Interactions\`.

\`\`\`
msg = write approvals-[:Messages]-> {
  Message: "Approve the expense?"
  Buttons: [{ Text: "Approve", Value: "approve" }, { Text: "Reject", Value: "reject" }]
}

r = race(
  () => {
    press = await msg-[:Interactions]->
    return only(press-[:Actions]->).Value
  },
  () => { await sleep(1d) },
)

if (r[0] == "approve") { … }
\`\`\`

- A press is an \`Interaction\`: when it happened (\`At\`), the controls used (\`Actions\`, each with the \`Value\` and \`Text\` it was written with), and who pressed (\`By\`).
- \`Value\` is one of the values the buttons were written with, so \`r[0] == "aprove"\` is refused when you save, with a did-you-mean.
- A value built at run time leaves \`Value\` plain text, with a warning naming the path it was written at (\`Buttons[].Value\`).
- Which systems carry buttons, and their limits, is in each system's chapter (\`system:slack\`).
- To take every press, from anyone, each in its own run, write the message with a \`Topic\` beside its \`Buttons\` and listen on the presses: \`listen to chat-[:Channels]->-[m:Messages WHERE m.Topic == "lunch-poll"]->-[:Interactions]-> fire count_vote\`. The run keeps its tally in a table; \`system:slack\` shows the whole poll.

### host-links

A link a person opens to answer is a form from \`@lf/forms\`. Reach for one when the person is outside every system the automation uses, or when the answer has several typed fields. Its fields are a \`node\` you declare, and the answer is typed by it.

\`\`\`
forms = connect \`@lf/forms\`

node Refund {
  Approve: <boolean>
  Note: <text | null>
}

function \`Refund Check\`(go: <manual-[:Invocation]->>) {
  form = write forms-[:Forms]-> { Title: "Approve the refund for \${go.Text}?", Fields: Refund }
  write ops-[:Messages]-> { Message: "Approve or decline: \${form.Url}" }

  r = race(
    () => {
      answer = await form-[:Submissions]->
      if (answer.Approve) {
        write ops-[:Messages]-> { Message: "Refund approved. \${coalesce(answer.Note, "")}" }
      }
      return answer.Approve
    },
    () => { await sleep(2d) },
  )
  if (r[0] == null) { fail("nobody answered the refund form in two days") }
}
\`\`\`

- \`form.Url\` is the link. Send it wherever the person will see it: a channel, an email, a text message.
- The link is served at the host's public address (under \`listen-fire\`, \`lf.yaml\`'s \`publicUrl\`). A browser gets the form; a program fetching it as JSON gets the fields it must send.
- \`answer.Approve\` is a boolean and \`answer.Note\` is text or null, because \`Fields\` named \`Refund\`. Reading a field the node does not declare is refused when you save.
- \`Fields\` names a declared \`node\`: a record built in place is refused.
- The node may not declare a field every answer already has, such as \`Id\`: that is refused when you save.
- A form takes one answer; a different second one is turned away. It never expires, so the race's \`sleep\` is its deadline.
- A form is written, never listed: only the run that wrote it holds the link.

### questions

A question gives what buttons and a form do not: a page that renders the right control for whoever opens it, and an entry in that person's queue of things to decide. Connect its package, \`@lf/ask\`, and write one along a **family** edge, which is the kind of question and fixes the type of the answer.

Every family takes \`Prompt\` (the question) and an optional \`Detail\` (a longer explanation shown under it), plus the parameters below.

- **Check** — approve or decline. \`Answer\` is a boolean, \`true\` if they approved.
- **Provide** — supply one value. \`Answer Type\` (required) is \`"text"\`, \`"number"\`, \`"date"\`, or \`"boolean"\`; \`Answer\` is that type.
- **Choose** — pick ONE. \`Options\` (required, at least one) is the set; \`Answer\` is the option they chose.
- **Select** — pick a SUBSET. \`Options\` (required) again; \`Answer\` is the list they ticked, possibly empty.
- **Review** — an acknowledgement. Nothing to fill in: the person confirms they have read the \`Detail\`, and \`Answer\` carries no value.
- **Form** — collect several named fields at once. \`Fields\` (required) names them; name them literally and each becomes a field of the answer, \`a.Budget\`, every one text.

\`\`\`
q = write asks-[:Choose]-> { Prompt: "What next?", Options: ["pursue", "hold", "pass"] }
write ops-[:Messages]-> { Message: "What next? \${q.Url}" }

r = race(
  () => {
    a = await q-[:Response]->
    return a.Answer
  },
  () => { await sleep(2d) },
)

if (r[0] == "pursue") { … }
\`\`\`

- \`q.Url\` is the page. Nothing is sent for you: interpolate it into a message yourself.
- Spell a parameter out as a literal and the answer narrows: a \`Choose\` over \`["pursue", "hold", "pass"]\` answers one of exactly those, and comparing it to anything else is refused when you save. \`Answer Type: "number"\` answers a number. A literal \`Fields\` narrows into one field per name.
- Options built at run time give plain text: still correct, just unnarrowed. \`Fields\` built at run time leave one opaque value, \`a.Answer\`, which you can pass on into a structured field but not pick apart, compare or branch on. To act on a value, write \`Provide\`, \`Choose\`, \`Select\`, or a \`Form\` whose \`Fields\` are spelled out.
- When the run was started from a chat interface, a question nobody was sent is **relayed**: the person in the chat is shown it, and their decision is what answers it — never the assistant's own judgement.

### the-pick-idiom

Letting a person pick a **live record** — one company out of several you found — needs no special family. Offer the names, then filter the graph on the answer.

\`\`\`
found = crm-[c:Companies WHERE c.Categories == "Lead"]-> {
  return c.Name
}

q = write asks-[:Choose]-> { Prompt: "Which company did they mean?", Options: found }
write ops-[:Messages]-> { Message: "Which one? \${q.Url}" }

r = race(
  () => {
    a = await q-[:Response]->
    return a.Answer
  },
  () => { await sleep(1d) },
)

name = r[0]
if (name == null) { fail("nobody picked a company") }
pick = only(crm-[co:Companies WHERE co.Name == name]->)
if (pick == null) { fail("no company named \${name}") }
write pick-[:Notes]-> { Title: "Chosen", Content: "Picked from \${count(found)} candidates." }
\`\`\`

The answer names the record; the lookup after it keys on that name.

### deleted-records

A record deleted while a run waits on it leaves the wait waiting; race every wait on a person or a system with a \`sleep\`.

When the record a wait hangs off is deleted — the message, the form, the question — nothing more arrives on it, and many systems cannot say it went. So the wait never ends: what follows the \`await\` never runs, and the run stays parked.

- In a \`race\` arm, the arm never settles, so the \`sleep\` beside it takes the race.
- In an \`all\` arm or a \`map\` member, the \`all\` or the \`map\` never finishes.

So what \`await\` binds is always there where you read it, and so is what a function that awaits returns. \`listen-fire upgrade\` from 0.12 warns on each \`await\` that no \`sleep\` races (\`MOV_AWAIT_MAY_HANG\`).

### captured-values

A wait's \`WHERE\` that reads a record the run holds — \`thread.User\` in \`await new thread-[x:Replies WHERE x.User == thread.User]->\` — reads it once, when the wait is reached, and keeps that value while the run waits, as a closure keeps what it closed over. A change to that record while the run waits does not change which arrival counts.

- What the \`WHERE\` reads from a system, such as a walk off a connection, is read at every check.
- To follow a value that may change while the run waits, test it after the wait against the record re-read with \`refresh\`.

### timeout-and-escalation

A deadline, a reminder and an escalation are all **composed** from \`race\` and \`sleep\`:

\`\`\`
r = race(
  () => {
    press = await msg-[:Interactions]->
    return only(press-[:Actions]->).Value
  },
  () => {
    await sleep(6h)
    write msg-[:Replies]-> { Message: "Still waiting on this one." }
    await sleep(2d)
  },
)

if (r[0] == null) {
  write deals-[:Messages]-> { Message: "Nobody decided in time — holding." }
}
\`\`\`

- \`await\` marks where the run itself waits: on the answer (\`await msg-[:Interactions]->\`) and on the clock (\`await sleep(2d)\`), inside the arms. \`race\` says only how several waits **combine** — it settles on the first of them — so it is written without \`await\`.
- Each arm is a **function**, passed as an argument: \`() => { … }\` written where it stands, or the name of one declared elsewhere. An arm takes no parameters — it already sees everything in scope where you wrote it — and it starts the moment the combinator does.
- The value is a **receipt**: one slot per arm, in the order written, holding whatever that arm \`return\`ed. \`r[0]\` reads the first arm's slot, \`r[1]\` the second. An arm that hands nothing back has an always-null slot.
- Under \`race\`, only the arm that settled first has its slot filled and every other slot is null — so **a null test on a slot is the branch**. Arms still parked when one settles are dropped where they stand: their waiting stops, and whatever they had already done stays done. Arms that settle in the same moment all land.
- To wait for **every** one instead, use \`all\` (\`several-at-once\`): every one runs to the end and every slot is filled.
- Arms run at once. Arms writing the same \`unique by\` key take turns, so the record is made once.
- Durations are bare unit-suffixed literals: \`30s\`, \`90m\`, \`6h\`, \`2d\`, \`1h30m\`.
- To wait on a *condition* instead — "until this record is marked done" — hand \`until\` the condition and the cadence to re-check it on:

  \`\`\`
  await until(() => {
    refresh company
    return company.Stage == "Won"
  }, { every: 1h })
  \`\`\`

  \`(…) => { … }\` is a **closure**: a body written where it stands and run later, holding everything in scope at the point you wrote it. The run resumes the moment the closure returns true. \`refresh\` re-reads a handle so each check sees the record as it is now; a condition that needs no refresh can be a plain boolean expression instead. A condition takes no parameters and may only read — a write or an \`await\` inside one is refused, as is a cadence under a minute.

- Which of the two you write is the edge's to decide, and you are told when you save. Where the system announces what lands — a press, a reply, a form's answer — \`await\` the edge: the run sleeps and is woken the moment it arrives. Where nothing announces it, \`until\` with an \`every:\` is the form, because someone has to say how often to look.

### several-at-once

Put one decision in several places by writing the message in each, and give each its own arm. An arm is written where you know the place, so it can hand that back along with the answer:

\`\`\`
dealflow = only(team-[ch:Channels WHERE ch.Name == "dealflow"]->)
portfolio = only(team-[ch:Channels WHERE ch.Name == "portfolio"]->)
general = only(team-[ch:Channels WHERE ch.Name == "general"]->)
if (dealflow == null || portfolio == null || general == null) { fail("a channel is missing") }

in_dealflow = write dealflow-[:Messages]-> {
  Message: "Approve this?"
  Buttons: [{ Text: "Approve", Value: "approve" }]
}
in_portfolio = write portfolio-[:Messages]-> {
  Message: "Approve this?"
  Buttons: [{ Text: "Approve", Value: "approve" }]
}

r = race(
  () => {
    press = await in_dealflow-[:Interactions]->
    return { channel: "dealflow", at: press.At }
  },
  () => {
    press = await in_portfolio-[:Interactions]->
    return { channel: "portfolio", at: press.At }
  },
  () => { await sleep(1d) },
)

answered = coalesce(r[0], r[1])
if (answered != null) {
  write general-[:Messages]-> { Message: "approved in #\${answered.channel} at \${answered.at}" }
}
\`\`\`

- Whoever presses first settles it, wherever they were.
- Return a dict to hand back more than one thing at once; its entries read by name afterwards (\`answered.channel\`).

Wait on **different** things and take every answer with \`all\`, which runs them at once. Put the \`all\` in a race with a \`sleep\`, so one answer that never comes cannot hold the run for good:

\`\`\`
r = race(
  () => {
    both = all(
      () => {
        b = await budget-[:Response]->
        return b.Answer
      },
      () => {
        l = await legal-[:Response]->
        return l.Answer
      },
    )
    return both[0] && both[1]
  },
  () => { await sleep(3d) },
)

if (r[0] == true) { … }
\`\`\`

- Nothing \`all\` runs is dropped, so every slot is filled. There is no \`await\` in front: a function that waits parks the run, and \`all\` finishes when every one has.

### how-long-a-wait-lives

What a person can act on lives as long as its system keeps it: a message's buttons, a form's link. The run waits only while it is parked on them: once its race settles or the run ends, a later press or answer wakes nothing, though a form answered then still records its answer. Something that must react at any time, forever, is a listen (\`buttons\`).`,
  engineClaims: [
    {
      construct: 'write an ask along a Check family edge, deliver its Url, and await its Response inside a race arm; the timeout is a null test on the slot',
      status: 'runs',
      probe: `
inbox = connect \`@lf/email\`
team  = connect \`@lf/slack\` using team_workspace
crm   = connect \`@lf/attio\` using acme_main
asks  = connect \`@lf/ask\`

function \`Triage Inbound\`(msg: <inbox-[:Emails]->>) {
  \`Company Name\` = ai("the company this message is about")

  q = write asks-[:Check]-> {
    Prompt: "Pursue \${\`Company Name\`}?"
    Detail: "\${msg.Subject}"
  }
  dealflow = only(team-[ch:Channels WHERE ch.Name == "dealflow"]->)
  if (dealflow == null) { fail("no #dealflow channel") }
  write dealflow-[:Messages]-> { Message: "New: \${\`Company Name\`}. Pursue it? \${q.Url}" }

  r = race(
    () => {
      a = await q-[:Response]->
      return a.Answer
    },
    () => { await sleep(2d) },
  )

  decision = r[0]
  if (decision == true) {
    write crm-[:Companies]-> {
      unique by (FUZZY Name)
      Name: \`Company Name\`
    }
  }
  if (decision == null) {
    write dealflow-[:Messages]-> { Message: "Nobody decided in time." }
  }
}

listen to inbox-[e:Emails WHERE e.Key == "intake"]-> fire \`Triage Inbound\`
`,
    },
    {
      construct: 'buttons on a message, their press raced against a timeout, the press time read off slot 0',
      status: 'runs',
      probe: `
team = connect \`@lf/slack\` using team_workspace

function \`First Approval Wins\`(go: <manual-[:Invocation]->>) {
  approvals = only(team-[ch:Channels WHERE ch.Topic == "approvals"]->)
  if (approvals == null) { fail("no #approvals channel") }
  msg = write approvals-[:Messages]-> {
    Message: "Approve this?"
    Buttons: [{ Text: "Approve", Value: "approve" }]
  }

  r = race(
    () => {
      press = await msg-[:Interactions]->
      return press.At
    },
    () => { await sleep(1d) },
  )

  tapped = r[0]
  general = only(team-[g:Channels WHERE g.Name == "general"]->)
  if (general == null) { fail("no #general channel") }
  if (tapped != null) {
    write general-[:Messages]-> { Message: "Approved at \${tapped}." }
  }
  if (tapped == null) {
    write general-[:Messages]-> { Message: "Nobody approved in time." }
  }
}

listen to manual-[:Invocations]-> fire \`First Approval Wins\`
`,
    },
    {
      construct: 'buttons whose press carries the Value it was written with, narrowed to those values and compared after the race',
      status: 'runs',
      probe: `
team = connect \`@lf/slack\` using team_workspace
crm  = connect \`@lf/attio\` using acme_main

function \`Pursue Or Pass\`(go: <manual-[:Invocation]->>) {
  dealflow = only(team-[ch:Channels WHERE ch.Name == "dealflow"]->)
  if (dealflow == null) { fail("no #dealflow channel") }
  msg = write dealflow-[:Messages]-> {
    Message: "New company: \${go.Text}. Pursue it?"
    Buttons: [{ Text: "Pursue", Value: "pursue" }, { Text: "Pass", Value: "pass" }]
  }

  r = race(
    () => {
      press = await msg-[:Interactions]->
      return only(press-[:Actions]->).Value
    },
    () => {
      await sleep(6h)
      write msg-[:Replies]-> { Message: "Still waiting on this one." }
      await sleep(2d)
    },
  )

  if (r[0] == "pursue") {
    write crm-[:Companies]-> { unique by (FUZZY Name), Name: go.Text }
  }
  if (r[0] == null) {
    write msg-[:Replies]-> { Message: "Nobody decided in time — holding." }
  }
}

listen to manual-[:Invocations]-> fire \`Pursue Or Pass\`
`,
    },
    {
      construct: 'await on an edge that is also listed (a thread\'s Replies): the first reply already there, or the next, raced against a sleep',
      status: 'runs',
      probe: `
team = connect \`@lf/slack\` using team_workspace

function \`Who Takes It\`(go: <manual-[:Invocation]->>) {
  dealflow = only(team-[ch:Channels WHERE ch.Name == "dealflow"]->)
  if (dealflow == null) { fail("no #dealflow channel") }
  msg = write dealflow-[:Messages]-> { Message: "Who can take \${go.Text}? Reply in the thread." }

  r = race(
    () => {
      reply = await msg-[:Replies]->
      return reply.Message
    },
    () => { await sleep(1d) },
  )

  if (r[0] == null) {
    write dealflow-[:Messages]-> { Message: "Nobody picked up \${go.Text}." }
  }
}

listen to manual-[:Invocations]-> fire \`Who Takes It\`
`,
    },
    {
      construct: 'await new on a thread\'s Replies, its WHERE reading a record the run holds — only an answer from the author, after the run read the message',
      status: 'runs',
      probe: `
team = connect \`@lf/slack\` using team_workspace

function \`Chase The Author\`(go: <manual-[:Invocation]->>) {
  dealflow = only(team-[ch:Channels WHERE ch.Name == "dealflow"]->)
  if (dealflow == null) { fail("no #dealflow channel") }
  thread = only(dealflow-[m:Messages WHERE m.Message == go.Text]->)
  if (thread == null) { fail("no message \\"\${go.Text}\\" in #dealflow") }
  write thread-[:Replies]-> { Message: "Any update on this?" }

  r = race(
    () => {
      reply = await new thread-[x:Replies WHERE x.User == thread.User]->
      return reply.Message
    },
    () => { await sleep(1d) },
  )

  if (r[0] != null) {
    write dealflow-[:Messages]-> { Message: "Update: \${r[0]}" }
  }
}

listen to manual-[:Invocations]-> fire \`Chase The Author\`
`,
    },
    {
      construct: 'a race arm handing back WHICH place answered — a dict built in the arm that knows it, the first answered slot taken with coalesce',
      status: 'runs',
      probe: `
team = connect \`@lf/slack\` using team_workspace

function \`Which Place Answered\`(go: <manual-[:Invocation]->>) {
  \`Dealflow Channel\` = only(team-[ch:Channels WHERE ch.Name == "dealflow"]->)
  if (\`Dealflow Channel\` == null) { fail("no #dealflow channel") }
  \`Portfolio Channel\` = only(team-[p:Channels WHERE p.Name == "portfolio"]->)
  if (\`Portfolio Channel\` == null) { fail("no #portfolio channel") }

  dealflow = write \`Dealflow Channel\`-[:Messages]-> {
    Message: "Approve this?"
    Buttons: [{ Text: "Approve", Value: "approve" }]
  }
  portfolio = write \`Portfolio Channel\`-[:Messages]-> {
    Message: "Approve this?"
    Buttons: [{ Text: "Approve", Value: "approve" }]
  }

  r = race(
    () => {
      press = await dealflow-[:Interactions]->
      return { channel: "dealflow", at: press.At }
    },
    () => {
      press = await portfolio-[:Interactions]->
      return { channel: "portfolio", at: press.At }
    },
    () => { await sleep(1d) },
  )

  answered = coalesce(r[0], r[1])
  if (answered != null) {
    general = only(team-[g:Channels WHERE g.Name == "general"]->)
    if (general == null) { fail("no #general channel") }
    write general-[:Messages]-> {
      Message: "approved in #\${answered.channel} at \${answered.at}"
    }
  }
}

listen to manual-[:Invocations]-> fire \`Which Place Answered\`
`,
    },
    {
      construct: 'all over two awaiting closures, run at once inside a race with a sleep — both answers combined',
      status: 'runs',
      probe: `
team = connect \`@lf/slack\` using team_workspace
asks = connect \`@lf/ask\`

function \`Both Must Agree\`(go: <manual-[:Invocation]->>) {
  budget = write asks-[:Check]-> { Prompt: "Budget approved?" }
  legal  = write asks-[:Check]-> { Prompt: "Legal approved?" }

  dealflow = only(team-[ch:Channels WHERE ch.Name == "dealflow"]->)
  if (dealflow == null) { fail("no #dealflow channel") }
  write dealflow-[:Messages]-> {
    Message: "Budget: \${budget.Url}\\nLegal: \${legal.Url}"
  }

  r = race(
    () => {
      both = all(
        () => {
          b = await budget-[:Response]->
          return b.Answer
        },
        () => {
          l = await legal-[:Response]->
          return l.Answer
        },
      )
      return both[0] && both[1]
    },
    () => { await sleep(3d) },
  )

  if (r[0] == true) {
    general = only(team-[g:Channels WHERE g.Name == "general"]->)
    if (general == null) { fail("no #general channel") }
    write general-[:Messages]-> { Message: "Both approved: \${go.Text}." }
  }
}

listen to manual-[:Invocations]-> fire \`Both Must Agree\`
`,
    },
    {
      construct: 'await until — a closure condition refreshing a written handle, on a named cadence',
      status: 'runs',
      probe: `
crm  = connect \`@lf/attio\` using acme_main
team = connect \`@lf/slack\` using team_workspace

function \`Wait For The Name\`(go: <manual-[:Invocation]->>) {
  co = write crm-[:Companies]-> {
    unique by (FUZZY Name)
    Name: go.Text
  }

  await until(() => {
    refresh co
    return co.Name == "Acme"
  }, { every: 1h })

  dealflow = only(team-[ch:Channels WHERE ch.Name == "dealflow"]->)
  if (dealflow == null) { fail("no #dealflow channel") }
  write dealflow-[:Messages]-> { Message: "Renamed at last." }
}

listen to manual-[:Invocations]-> fire \`Wait For The Name\`
`,
    },
    {
      construct: 'a Provide question with a literal Answer Type, its typed answer filled into a record with ?:',
      status: 'runs',
      probe: `
team = connect \`@lf/slack\` using team_workspace
crm  = connect \`@lf/attio\` using acme_main
asks = connect \`@lf/ask\`

function \`Record Headcount\`(go: <manual-[:Invocation]->>) {
  q = write asks-[:Provide]-> {
    Prompt: "How many people work there?"
    \`Answer Type\`: "number"
  }
  dealflow = only(team-[ch:Channels WHERE ch.Name == "dealflow"]->)
  if (dealflow == null) { fail("no #dealflow channel") }
  write dealflow-[:Messages]-> { Message: "How many people work there? \${q.Url}" }

  a = await q-[:Response]->
  write crm-[:Companies]-> {
    unique by (FUZZY Name)
    Name:           go.Text
    Description ?:  "Headcount: \${a.Answer}"
  }
}

listen to manual-[:Invocations]-> fire \`Record Headcount\`
`,
    },
    {
      construct: 'a Choose question over literal options, its answer compared against one of them',
      status: 'runs',
      probe: `
team = connect \`@lf/slack\` using team_workspace
crm  = connect \`@lf/attio\` using acme_main
asks = connect \`@lf/ask\`

function \`Decide Next Step\`(go: <manual-[:Invocation]->>) {
  q = write asks-[:Choose]-> {
    Prompt: "What next?"
    Options: ["pursue", "hold", "pass"]
  }
  dealflow = only(team-[ch:Channels WHERE ch.Name == "dealflow"]->)
  if (dealflow == null) { fail("no #dealflow channel") }
  write dealflow-[:Messages]-> { Message: "What next? \${q.Url}" }

  a = await q-[:Response]->
  if (a.Answer == "pursue") {
    write crm-[:Companies]-> {
      unique by (FUZZY Name)
      Name: go.Text
    }
  }
}

listen to manual-[:Invocations]-> fire \`Decide Next Step\`
`,
    },
    {
      construct: 'a Select question over literal options, its chosen subset joined into a message',
      status: 'runs',
      probe: `
team = connect \`@lf/slack\` using team_workspace
asks = connect \`@lf/ask\`

function \`Pick Channels\`(go: <manual-[:Invocation]->>) {
  q = write asks-[:Select]-> {
    Prompt: "Which teams should hear about this?"
    Options: ["sales", "support", "finance"]
  }
  dealflow = only(team-[ch:Channels WHERE ch.Name == "dealflow"]->)
  if (dealflow == null) { fail("no #dealflow channel") }
  write dealflow-[:Messages]-> { Message: "Who should hear about this? \${q.Url}" }

  a = await q-[:Response]->
  write dealflow-[:Messages]-> { Message ?: "Telling: \${Text.join(a.Answer, ", ")}" }
}

listen to manual-[:Invocations]-> fire \`Pick Channels\`
`,
    },
    {
      construct: 'a Review question — an acknowledgement awaited before the work carries on',
      status: 'runs',
      probe: `
team = connect \`@lf/slack\` using team_workspace
crm  = connect \`@lf/attio\` using acme_main
asks = connect \`@lf/ask\`

function \`Acknowledge First\`(go: <manual-[:Invocation]->>) {
  q = write asks-[:Review]-> {
    Prompt: "Read this before it goes out"
    Detail: go.Text
  }
  dealflow = only(team-[ch:Channels WHERE ch.Name == "dealflow"]->)
  if (dealflow == null) { fail("no #dealflow channel") }
  write dealflow-[:Messages]-> { Message: "Please read: \${q.Url}" }

  await q-[:Response]->
  write crm-[:Companies]-> {
    unique by (FUZZY Name)
    Name: go.Text
  }
}

listen to manual-[:Invocations]-> fire \`Acknowledge First\`
`,
    },
    {
      construct: 'a Draft question — a structured artifact composed by a person, awaited',
      status: 'runs',
      probe: `
team = connect \`@lf/slack\` using team_workspace
asks = connect \`@lf/ask\`

function \`Draft The Reply\`(go: <manual-[:Invocation]->>) {
  q = write asks-[:Draft]-> {
    Prompt: "Draft the reply"
    Detail: go.Text
  }
  dealflow = only(team-[ch:Channels WHERE ch.Name == "dealflow"]->)
  if (dealflow == null) { fail("no #dealflow channel") }
  write dealflow-[:Messages]-> { Message: "Draft it here: \${q.Url}" }

  await q-[:Response]->
  write dealflow-[:Messages]-> { Message: "The draft is in." }
}

listen to manual-[:Invocations]-> fire \`Draft The Reply\`
`,
    },
    {
      construct: 'a Correct question whose Rows are written as literal objects',
      status: 'runs',
      probe: `
team = connect \`@lf/slack\` using team_workspace
asks = connect \`@lf/ask\`

function \`Fix The Rows\`(go: <manual-[:Invocation]->>) {
  q = write asks-[:Correct]-> {
    Prompt: "Fix anything that's wrong, drop anything that isn't real"
    Rows: [
      { Name: "Acme", Stage: "New", Owner: go.\`Run by (email)\` },
      { Name: "Initech", Stage: "Open", Owner: go.\`Run by (email)\` }
    ]
  }
  dealflow = only(team-[ch:Channels WHERE ch.Name == "dealflow"]->)
  if (dealflow == null) { fail("no #dealflow channel") }
  write dealflow-[:Messages]-> { Message: "Check these before they land: \${q.Url}" }

  await q-[:Response]->
  write dealflow-[:Messages]-> { Message: "Corrections in." }
}

listen to manual-[:Invocations]-> fire \`Fix The Rows\`
`,
    },
    {
      construct: 'a Form question collecting several named fields at once, one of them read back by name',
      status: 'runs',
      probe: `
team = connect \`@lf/slack\` using team_workspace
asks = connect \`@lf/ask\`

function \`Collect The Details\`(go: <manual-[:Invocation]->>) {
  q = write asks-[:Form]-> {
    Prompt: "Fill in the missing details"
    Fields: ["Company", "Contact", "Budget"]
  }
  dealflow = only(team-[ch:Channels WHERE ch.Name == "dealflow"]->)
  if (dealflow == null) { fail("no #dealflow channel") }
  write dealflow-[:Messages]-> { Message: "A few details needed: \${q.Url}" }

  a = await q-[:Response]->
  write dealflow-[:Messages]-> { Message: "Details in — budget \${a.Budget}." }
}

listen to manual-[:Invocations]-> fire \`Collect The Details\`
`,
    },
    {
      construct: 'the pick idiom — Choose over options gathered at run time, the answer filtering the graph back to the record',
      status: 'runs',
      probe: `
crm  = connect \`@lf/attio\` using acme_main
team = connect \`@lf/slack\` using team_workspace
asks = connect \`@lf/ask\`

function \`Pick The Company\`(go: <manual-[:Invocation]->>) {
  found = crm-[c:Companies WHERE c.Categories == "Lead"]-> {
    return c.Name
  }

  q = write asks-[:Choose]-> {
    Prompt: "Which company did they mean?"
    Options: found
  }
  dealflow = only(team-[ch:Channels WHERE ch.Name == "dealflow"]->)
  if (dealflow == null) { fail("no #dealflow channel") }
  write dealflow-[:Messages]-> { Message: "Which one? \${q.Url}" }

  r = race(
    () => {
      a = await q-[:Response]->
      return a.Answer
    },
    () => { await sleep(1d) },
  )

  name = r[0]
  if (name == null) { fail("nobody picked a company") }
  pick = only(crm-[co:Companies WHERE co.Name == name]->)
  if (pick == null) { fail("no company named \${name}") }
  write pick-[:Notes]-> {
    Title:   "Chosen"
    Content: go.Text
  }
}

listen to manual-[:Invocations]-> fire \`Pick The Company\`
`,
    },
    {
      construct: 'a host link: a form from @lf/forms, its Url sent, its typed submission raced against a sleep',
      status: 'runs',
      probe: `
team  = connect \`@lf/slack\` using team_workspace
forms = connect \`@lf/forms\`

node Decision {
  Pursue: <boolean>
  Note: <text | null>
}

function \`Decide By Link\`(go: <manual-[:Invocation]->>) {
  dealflow = only(team-[ch:Channels WHERE ch.Name == "dealflow"]->)
  if (dealflow == null) { fail("no #dealflow channel") }

  form = write forms-[:Forms]-> { Title: "Pursue this company?", Fields: Decision }
  write dealflow-[:Messages]-> { Message: "Pursue it? Answer here: \${form.Url}" }

  r = race(
    () => {
      answer = await form-[:Submissions]->
      if (answer.Pursue) {
        write dealflow-[:Messages]-> { Message: "Pursuing. \${coalesce(answer.Note, "")}" }
      }
      return answer.Pursue
    },
    () => { await sleep(2d) },
  )
  if (r[0] == null) { fail("nobody answered the form in two days") }
}

listen to manual-[:Invocations]-> fire \`Decide By Link\`
`,
    },
    {
      construct: 'a form whose answer is typed by a node, its fields read after the await',
      status: 'runs',
      probe: `
team  = connect \`@lf/slack\` using team_workspace
crm   = connect \`@lf/attio\` using acme_main
forms = connect \`@lf/forms\`

node Booking {
  Day: <date>
}

function \`Book The Follow Up\`(go: <manual-[:Invocation]->>) {
  company = write crm-[:Companies]-> {
    unique by (FUZZY Name)
    Name: go.Text
  }

  form = write forms-[:Forms]-> { Title: "Pick a day for \${company.Name}", Fields: Booking }
  dealflow = only(team-[ch:Channels WHERE ch.Name == "dealflow"]->)
  if (dealflow == null) { fail("no #dealflow channel") }
  write dealflow-[:Messages]-> { Message: "Pick a day: \${form.Url}" }

  booking = await form-[:Submissions]->
  write company-[:Notes]-> {
    Title:   "Follow-up booked"
    Content: "Booked for \${booking.Day}."
  }
}

listen to manual-[:Invocations]-> fire \`Book The Follow Up\`
`,
    },
    {
      construct: 'a named function called with the answer a form returned',
      status: 'runs',
      probe: `
crm   = connect \`@lf/attio\` using acme_main
forms = connect \`@lf/forms\`

node Booking {
  Day: <date>
}

function \`Book\`(c: <crm-[:Companies]->>, day: <date>) {
  write c-[:Notes]-> { Title: "Booked", Content: "Booked for \${day}." }
}

function \`Offer\`(go: <manual-[:Invocation]->>) {
  company = write crm-[:Companies]-> { unique by (FUZZY Name), Name: go.Text }
  form = write forms-[:Forms]-> { Title: "Pick a day for \${company.Name}", Fields: Booking }
  write company-[:Notes]-> { Title: "Pick a day", Content: "\${form.Url}" }
  booking = await form-[:Submissions]->
  \`Book\`(company, booking.Day)
}

listen to manual-[:Invocations]-> fire \`Offer\`
`,
    },
  ],
};

// Slack's conceptual authoring documentation — doc tier 3: what an author
// should know about Slack BEFORE instantiating it. Assembled into the
// automation handbook as the `system:slack` chapter, and bound by the same
// contract as every hand-written chapter (consumer-neutral prose, no internal
// vocabulary, every runnable example backed by a checked probe).
//
// Taught around waiting on the message itself: a press is an `Interaction`
// on the posted message, a reply a `Replies` member, both awaited. Buttons are
// a field of the write, and their Values type what a press answers with.

import type { AdapterManifest } from 'movement-engine/public/adapter';

type HandbookSection = NonNullable<AdapterManifest['handbookSection']>;

export const SLACK_HANDBOOK_SECTION: HandbookSection = {
  title: 'Slack — posts, buttons, and waiting on the channel',
  content: `## Slack — posts, buttons, and waiting on the channel

Posting to Slack is an ordinary write: a message written along a channel's \`Messages\` edge, or along a message's \`Replies\` edge. Slack's message field is \`Message\`. There is no cold open — a post always hangs off a channel you traversed to or a message that arrived, and the thread comes from that parent, never from a field. A posted message is also something to wait on: a press on one of its buttons arrives on its \`Interactions\`, and a reply in its thread on its \`Replies\`.

### shapes-of-post

Beside its \`Message\` text, a message you send carries at most one of:

- **a file** — \`File\`. One visible message, the text captioning the file.
- **buttons** — \`Buttons\`, each \`{ Text, Value }\`: the label shown, and what a press answers with.
- **Block Kit** — \`Blocks\`, Slack's own layout, for anything buttons cannot say.

\`\`\`
write ch-[:Messages]-> {
  Message: "This week's numbers."
  File:    report
}
\`\`\`

A write that sets two of them is refused while you write it. Plain text on its own is the unremarkable case; what a message cannot be is empty of all of them.

### buttons-and-a-press

Write the buttons with the message, then wait on the message for a press. The press is an \`Interaction\`: its \`Actions\` are the controls used, and an action's \`Value\` is one of the \`Value\`s you wrote. Waiting on a person goes in a \`race\` with a \`sleep\`, so nobody answering is an outcome too:

\`\`\`
msg = write finance-[:Messages]-> {
  Message: "\${expense.Description}: approve?"
  Buttons: [{ Text: "Approve", Value: "approve" }, { Text: "Reject", Value: "reject" }]
}

r = race(
  () => {
    press = await msg-[:Interactions]->
    if (press == null) { return null }
    return only(press-[:Actions]->).Value == "approve"
  },
  () => { await sleep(1d) },
)

if (r[0] == null) {
  write msg-[:Replies]-> { Message: "Nobody answered within a day." }
} else if (r[0]) {
  write msg-[:Replies]-> { Message: "Approved." }
}
\`\`\`

- The wait starts before the message is posted, so a press that comes the moment it appears is not missed.
- \`only(press-[:Actions]->).Value\` is \`"approve" | "reject"\` here: comparing it with a value the buttons never offered, such as \`"aprove"\`, is refused while you write it. Compare it where you read it, as here: the result of a \`race\` does not keep that type.
- \`press-[:By]->\` is the member who pressed.
- A message deleted while a run waits on it ends the wait: nothing after the \`await\` runs.

### blocks-are-verbatim

\`Blocks\` is Block Kit exactly as Slack's documentation spells it: a list of block objects, handed to Slack unchanged. Nothing checks inside them, so a malformed block fails loudly when the run posts it, not when you save. A press on a control inside them arrives on the message's \`Interactions\` like a button's: a select answers its chosen option's \`value\`, a date picker the date picked. Their values are not checked against anything, so reach for \`Buttons\` whenever buttons say it.

\`\`\`
write ch-[:Messages]-> {
  Message: "Pick a tier for \${deal.Name}."
  Blocks: [
    { type: "actions", elements: [
      { type: "static_select", placeholder: { type: "plain_text", text: "Tier" },
        options: [
          { text: { type: "plain_text", text: "Seed" }, value: "seed" },
          { text: { type: "plain_text", text: "Growth" }, value: "growth" }
        ] }
    ] }
  ]
}
\`\`\`

Keep writing the \`Message\` text alongside them: it is what a notification shows.

### waiting-for-a-reply

A message's \`Replies\` are its thread, oldest first. \`await msg-[:Replies]->\` takes the first reply already there, or else waits for the next; \`await new msg-[:Replies]->\` waits only for one posted after the message entered the run. A \`WHERE\` says whose reply counts:

\`\`\`
who = msg.User
r = race(
  () => { return await msg-[x:Replies WHERE x.User == who]-> },
  () => { await sleep(2d) },
)
if (r[0] == null) {
  write msg-[:Replies]-> { Message: "Bumping this in case it got buried." }
}
\`\`\`

### reacting-to-a-message

The lightest way to acknowledge a message is to react to it: an emoji written along the message's \`Reactions\` edge. It takes one field, the emoji's name without its colons, and the message it lands on is the one you wrote off — nothing addresses it by hand.

\`\`\`
write msg-[:Reactions]-> { Emoji: "eyes" }
\`\`\`

This is the natural "I've picked this up" before a slower step runs, and reacting twice with the same emoji is harmless — the second write finds it already there and changes nothing. Reactions only go on: you can add one, but you cannot read a message's reactions back or take one off.

### what-fires-a-run

Slack delivers only the events its app is subscribed to, so an automation reading Slack usually fires on the bot being mentioned rather than on every message in a channel; narrow further with \`events\` and \`channels\` on the listener. A run also needs the person who sent the message (or added the reaction) to be a known member of the team, matched on their Slack profile email — activity from guests, external members of a shared channel, other bots, and this platform's own posts is dropped before anything runs. A press and a thread reply are different: they reach the run waiting on their message whoever made them, so say in a \`WHERE\` whose answer counts when it matters. Slack only sends presses and replies its app is set up to send — interactivity switched on, and message events subscribed.

### Common mistakes

- **Setting two of \`File\`, \`Buttons\` and \`Blocks\` on one message.** One shape per message. Send the file, then post the buttons as a reply if you need both.
- **Waiting on a person without a \`sleep\` beside it.** A run waiting on a press nobody makes waits for ever; race it with the time it may take.
- **Expecting a bad block to fail at save time.** Blocks are passed through untouched; Slack is the one that validates them, at run time.
- **Promising every message in a channel.** What arrives depends on the workspace's subscription, and on the sender being a known member.`,
  engineClaims: [
    {
      construct: 'a Slack message with Buttons, a press on it awaited in a race with a sleep',
      status: 'runs',
      probe: `
import { \`@lf/slack\` as slack } from adapters
import { team_workspace } from credentials

team = connect slack using team_workspace

function sign_off(msg: <team-[:Message]->>) {
  ask = write msg-[:Replies]-> {
    Message: "Ship the release?"
    Buttons: [{ Text: "Ship", Value: "ship" }, { Text: "Hold", Value: "hold" }]
  }

  r = race(
    () => {
      press = await ask-[:Interactions]->
      if (press == null) { return null }
      return only(press-[:Actions]->).Value == "ship"
    },
    () => { await sleep(1d) },
  )

  if (r[0] == true) {
    general = only(team-[ch:Channels WHERE ch.Name == "general"]->)
    if (general == null) { fail("no #general channel") }
    write general-[:Messages]-> { Message: "Shipping now." }
  }
}

listen to team { events: ["app_mention"] } fire sign_off
`,
    },
    {
      construct: 'a reply in a Slack thread awaited on the message, with a nudge after two days',
      status: 'runs',
      probe: `
import { \`@lf/slack\` as slack } from adapters
import { team_workspace } from credentials

team = connect slack using team_workspace

function follow_up(msg: <team-[:Message]->>) {
  asked = write msg-[:Replies]-> { Message: "Who can take this?" }
  r = race(
    () => { return await new asked-[x:Replies WHERE x.User == msg.User]-> },
    () => { await sleep(2d) },
  )
  if (r[0] == null) {
    write asked-[:Replies]-> { Message: "Bumping this in case it got buried." }
  }
}

listen to team { events: ["app_mention"] } fire follow_up
`,
    },
  ],
};

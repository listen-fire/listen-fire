// WhatsApp's conceptual authoring documentation — doc tier 3: what an author
// should know about WhatsApp BEFORE instantiating it. Assembled into the
// automation handbook as the `system:whatsapp` chapter, and bound by the same
// contract as every hand-written chapter (consumer-neutral prose, no internal
// vocabulary, every runnable example backed by a checked probe).
//
// Acting on a message is taught as a url button (`cta_url`) that opens a form
// from the `@lf/forms` adapter, awaited on its Submissions: `callback(…)`
// retired at 0.13, and a reply button's tap reaches no run until WhatsApp
// reports its taps as Interactions, in Slack's shape. The platform fact that
// shapes the rest of the chapter — WhatsApp cannot edit a sent message and
// has no toast — is taught plainly: the ack an answer gets IS a reply.

import type { HandbookSection } from 'movement-engine/public/handbook';

export const WHATSAPP_HANDBOOK_SECTION: HandbookSection = {
  title: 'WhatsApp — the shared number, and a tap that acts',
  content: `## WhatsApp — the shared number, and a tap that acts

A listen starts at one of the three edges a record arrives on: \`-[:Messages]->\`, \`-[:Reactions]->\` (somebody reacting to a message) or \`-[:Locations]->\` (somebody sharing one), each its own kind of record. A WhatsApp send is always written along an edge off the message that arrived: \`-[:Replies]->\` threads a reply, \`-[:Reactions]->\` adds an emoji, \`-[:Typing]->\` shows the typing indicator. The recipient is never a field — it comes from whatever the write hangs off, and only reaches someone inside Meta's 24-hour service window (they must have messaged the number recently). Four things are worth settling before you build one: what runs when a record arrives, what a reply carries, what an interactive send replaces, and what a tap can and can't do here.

### running-when-a-message-arrives

\`\`\`
listen to wa-[m:Messages WHERE m.From == "447700900001"]-> fire answer

function answer(m: <wa-[:Messages]->>) {
  write m-[:Replies]-> { Body: "Got it: \${m.Body}" }
}
\`\`\`

A listen on \`Messages\` runs once per message sent to the number, the message itself as the parameter. A reaction is not a message: it arrives on \`Reactions\` and runs only a listen there (\`wa-[r:Reactions WHERE r.Emoji == "👍"]->\`), with the \`Emoji\`, the \`Reacted Message Id\` it is on and who sent it (an \`Emoji\` of nothing is a reaction taken back). A shared location likewise runs only a listen on \`Locations\`. WhatsApp cannot list conversations, so a listen narrows to one by the sender's number, \`From\`, digits with the country code first and no plus, or takes every sender by leaving the WHERE out.

### what-a-reply-carries

\`\`\`
write msg-[:Replies]-> {
  Body: "Here are the numbers you asked for."
  File: report
}
\`\`\`

\`Body\` is the message text and \`File\` the media to send (image, PDF, audio, video, routed by its content type). At least one of the two; set both and one message goes out with the \`Body\` captioning the file. Media arriving the other way is never on \`File\` — read it off \`msg-[:Attachments]->.File\`.

### reacting-and-showing-typing

\`\`\`
write msg-[:Reactions]-> { Emoji: "✅" }
write msg-[:Typing]-> {}
\`\`\`

A reaction is a record of the same kind you see arriving when somebody reacts to you: one \`Emoji\`, required.

Typing is an action rather than a record — nothing is created, so binding the write is refused. WhatsApp clears the indicator when your reply goes out, or by itself after about 25 seconds, which is exactly how to use it: show it, do the slow step, reply.

### buttons-are-verbatim

\`Interactive\` is WhatsApp's own \`interactive\` object, exactly as the Cloud API spells it, handed over unchanged — nothing wraps it or renames its keys, so a malformed object surfaces as a loud WhatsApp error when the send goes out, not when you save. Sending it REPLACES a plain-text send: the interactive type carries its own \`body.text\`, so the words live inside \`interactive.body.text\`, never in \`Body\` on the same send.

\`\`\`
write msg-[:Replies]-> {
  Interactive: {
    type: "button",
    body: { text: "Ship the release?" },
    action: { buttons: [
      { type: "reply", reply: { id: "yes", title: "Ship" } }
    ] }
  }
}
\`\`\`

Up to three reply buttons, each titled in 20 characters or fewer.

### a-tap-that-acts

A reply button's tap reaches no run yet. For a button that settles something, write a form from the \`@lf/forms\` adapter and send its \`Url\` on a url button (\`cta_url\`): the tap opens the form, and the run waits on what is submitted.

\`\`\`
node Decision {
  Send: <boolean>
}

form = write forms-[:Forms]-> { Title: "Send the update?", Fields: Decision }

write msg-[:Replies]-> {
  Interactive: {
    type: "cta_url",
    body: { text: "Send the update?" },
    action: { name: "cta_url", parameters: { display_text: "Answer", url: "\${form.Url}" } }
  }
}

r = race(
  () => {
    answer = await form-[:Submissions]->
    return answer.Send
  },
  () => { await sleep(1d) },
)
\`\`\`

A form also collects what a button cannot carry, a picked date or a typed answer, since WhatsApp captures nothing at tap time. If nobody answers within a day, \`r[0]\` is null.

### the-only-feedback-is-a-reply

WhatsApp cannot edit a message it already sent, and there is nothing like a toast either — so the whole of an answer's acknowledgement is a reply, quoting the message the button was on. The button stays exactly as it was sent, and a second submission of an answered form is turned away by the form itself. Design around that — say what happened in words, not in a message that changes shape.

### Common mistakes

- **Setting both \`Body\` and \`Interactive\`.** They're mutually exclusive — put the words inside \`interactive.body.text\`.
- **More than three reply buttons, or a title over 20 characters.** Both are WhatsApp errors at send time.
- **Expecting a button to capture typed text or a picked date.** WhatsApp buttons carry only what you wired in. Collect it on the form.
- **Expecting the message to change, or a toast to appear.** Neither happens — the ack IS the reply that comes back.
- **Reading \`File\` off a message.** It only ever goes out; what arrived is on \`Attachments\`.
- **Binding the typing write.** It creates nothing, so there is nothing to name.
- **Sending to someone who hasn't messaged the number recently.** Free-form sends — Interactive included — only reach people inside the 24-hour service window.`,
  engineClaims: [
    {
      construct: 'a WhatsApp url button (cta_url) that opens a form from @lf/forms, the run waiting on its submission inside a race with a sleep',
      status: 'runs',
      probe: `
wa = connect \`@lf/whatsapp\` using team_whatsapp
forms = connect \`@lf/forms\`

node Decision {
  Send: <boolean>
}

function confirm_send(msg: <wa-[:Messages]->>) {
  form = write forms-[:Forms]-> { Title: "Send the update?", Fields: Decision }

  write msg-[:Replies]-> {
    Interactive: {
      type: "cta_url",
      body: { text: "Send the update?" },
      action: { name: "cta_url", parameters: { display_text: "Answer", url: "\${form.Url}" } }
    }
  }

  r = race(
    () => {
      answer = await form-[:Submissions]->
      return answer.Send
    },
    () => { await sleep(1d) },
  )
  if (r[0] == true) {
    write msg-[:Replies]-> { Body: "Sending now." }
  }
}

listen to wa-[:Messages]-> fire confirm_send
`,
    },
  ],
};

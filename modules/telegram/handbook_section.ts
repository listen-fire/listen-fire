// Telegram's conceptual authoring documentation — doc tier 3: what an author
// should know about Telegram BEFORE instantiating it. Assembled into the
// automation handbook as the `system:telegram` chapter, and bound by the same
// contract as every hand-written chapter (consumer-neutral prose, no internal
// vocabulary, every runnable example backed by a checked probe).
//
// Acting on a message is taught as a `url` button that opens a form from the
// `@lf/forms` adapter, awaited on its Submissions: `callback(…)` retired at
// 0.13, and a `callback_data` tap has nothing to hand its payload to until
// Telegram reports its taps as Interactions, in Slack's shape.

import type { AdapterManifest } from 'movement-engine/public/adapter';

type HandbookSection = NonNullable<AdapterManifest['handbookSection']>;

export const TELEGRAM_HANDBOOK_SECTION: HandbookSection = {
  title: 'Telegram — bot chats, keyboards, and acting in the chat',
  content: `## Telegram — bot chats, keyboards, and acting in the chat

A Telegram message is always written along an edge: \`-[:Messages]->\` off a linked person, which sends into their private chat with the bot, or \`-[:Replies]->\` off a message that arrived, which threads under it. The chat is never a field — it comes from whatever the write hangs off. Four things about Telegram are worth settling before you build one: what a send can carry, how little the bot can see, what runs when a message arrives, and how a keyboard turns a message into something a person can act on with one tap.

### what-a-send-carries

\`\`\`
person = only(tg-[u:\`Linked Users\` WHERE u.Email == "ops@example.com"]->)
if (person == null) { fail("ops@example.com hasn't linked Telegram") }
write person-[:Messages]-> { Text: "The nightly run finished clean." }
\`\`\`

\`Text\` is the message, and it is required — a send carries no file, so anything you would have attached goes in the words or in a link inside them. (Media coming the other way is ordinary: read it off \`msg-[:Attachments]->.File\`.)

The write above starts a conversation from nothing: nobody has to message the bot first, as long as that person has linked. Reaching them is a traversal to \`Linked Users\`, and their private chat comes from the parent you land on.

### what-the-bot-can-see

Far less than "a chat app" suggests. In a one-to-one chat with the bot it sees every message sent to it. In a group it sees only direct replies to it and messages that @-mention it. It has no access to a person's other conversations at all — Telegram at large is never read.

So the natural framing is the bot chat as a deliberate capture channel: someone messages the bot, or forwards something to it, and that is the trigger surface. Never promise "everything posted in a group": that needs the bot's owner to turn privacy mode off, which the shared built-in bot cannot do — only somebody running their own bot can. And on the shared bot a person must complete the one-time linking step before anything they send reaches a run at all; their own bot has no such gate. Both facts change what is possible, so say them out loud while someone is describing what they want.

### running-when-a-message-arrives

\`\`\`
listen to tg-[m:Messages WHERE m.\`Chat Id\` == "42"]-> fire log_it

function log_it(m: <tg-[:Messages]->>) {
  write m-[:Replies]-> { Text: "Got it: \${m.Text}" }
}
\`\`\`

A listen on \`Messages\` runs once for each message the bot receives, the message itself as the parameter: read its \`Text\`, \`Sender Username\` and the rest straight off it, and reply under it. Telegram cannot list chats, so a listen narrows to one by the message's own \`Chat Id\` (a private chat's is the person's user id, shown on their \`Linked Users\` row), or takes every chat the bot is in by leaving the WHERE out. Only plain messages arrive: an edited message, a channel post and a button tap run nothing.

### keyboards-are-verbatim

\`Reply Markup\` is Telegram's own \`reply_markup\`, exactly as its documentation spells it, handed over unchanged. Nothing wraps it, renames its keys, or looks inside it — so a malformed keyboard surfaces as a loud Telegram error when the run sends it, not when you save. It is a single object, and the buttons live in rows inside it:

\`\`\`
write person-[:Messages]-> {
  Text: "Deploy is ready."
  \`Reply Markup\`: {
    inline_keyboard: [
      [ { text: "Release notes", url: "\${release.Url}" } ]
    ]
  }
}
\`\`\`

\`inline_keyboard\` is a list of ROWS and each row is a list of buttons, so two buttons in one row sit side by side and two rows of one stack vertically. A keyboard rides along with whatever else the message carries; nothing on a Telegram send excludes it.

### a-tap-that-acts

This is usually the reason to reach for a keyboard. A button either opens a link (\`url\`) or hands a payload back to the bot (\`callback_data\`). For a button that settles something, write a form from the \`@lf/forms\` adapter and put its \`Url\` on a \`url\` button: the tap opens the form, and the run waits on what is submitted.

\`\`\`
node Decision {
  Send: <boolean>
}

form = write forms-[:Forms]-> { Title: "Send the update?", Fields: Decision }

write msg-[:Replies]-> {
  Text: "Send the update? \${form.Url}"
  \`Reply Markup\`: {
    inline_keyboard: [ [ { text: "Answer", url: "\${form.Url}" } ] ]
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

Put the bare \`Url\` in the message text as well, so the question is still answerable wherever the buttons are not. A form also asks for what a button cannot carry, a picked date or a typed answer, since Telegram captures nothing at tap time. If nobody answers within a day, \`r[0]\` is null.

### Common mistakes

- **A flat list of buttons.** \`inline_keyboard\` is rows, so every button belongs inside a row list — a flat list is a Telegram error, not a single row.
- **A button with no link in it.** The keyboard looks right and a tap does nothing. A \`url\` button opening the form's \`Url\` is the whole mechanism.
- **Attaching a file to a send.** There is no field for one — put a link in the \`Text\`.
- **Expecting a keyboard to capture a date or free text.** Telegram buttons carry only what you wired in. Ask for anything the person has to fill in on the form.
- **Expecting a bad keyboard to fail at save time.** Its contents are passed through untouched; Telegram is the one that validates them, at run time.
- **Promising every message in a group.** What the bot sees depends on privacy mode and on being addressed, and on the shared bot the sender must have linked first.`,
  engineClaims: [
    {
      construct: 'a Telegram url button that opens a form from @lf/forms, the run waiting on its submission inside a race with a sleep',
      status: 'runs',
      probe: `
import { \`@lf/telegram\` as telegram, \`@lf/forms\` as forms_module } from adapters
import { team_telegram } from credentials

tg = connect telegram using team_telegram
forms = connect forms_module

node Decision {
  Send: <boolean>
}

function confirm_send(msg: <tg-[:Messages]->>) {
  form = write forms-[:Forms]-> { Title: "Send the update?", Fields: Decision }

  write msg-[:Replies]-> {
    Text: "Send the update? \${form.Url}"
    \`Reply Markup\`: {
      inline_keyboard: [ [ { text: "Answer", url: "\${form.Url}" } ] ]
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
    write msg-[:Replies]-> { Text: "Sending now." }
  }
}

listen to tg-[:Messages]-> fire confirm_send
`,
    },
  ],
};

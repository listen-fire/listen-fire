---
"@listen-fire/gmail": patch
"@listen-fire/fake-channels": patch
---

Gmail keeps drafts, and fires when a label is added to a message.

- Drafts: `write mail-[:Drafts]-> { To: [...], Subject: "...", Body: "..." }` keeps a new message unsent; `write msg-[:Drafts]-> { Body: "..." }` keeps a reply unsent, threaded as a reply is. A draft takes the fields a send does (`Files` included) and needs none of them. The write hands back the Draft's `Id`, `Message Id` and `Thread Id`.
- Drafts are opt-in at sign-in: the module declares a second credential, `gmail_drafts`, the only one that asks for Gmail's compose scope (`lf credential add --module gmail <name> --credential gmail_drafts`). A mailbox signed in under `gmail` refuses a draft, naming the scope and how to sign in again; reads and sends are unaffected. A host that asks for its own scopes says so in `granted_scopes`; a delegated host hands a `compose_access_token`.
- With two credentials declared, `lf credential add --module gmail` now needs `--credential gmail` (or `gmail_drafts`).
- `label_added`: `listen to gmail { events: ["label_added"], labels: ["Label_12"] } fire f` fires once per message and label when one of the listen's labels is added to a message already in the mailbox, delivering the message with `Added Label` set. It reads the same Gmail history as arrivals, under the same checkpoint. After Gmail forgets the checkpoint (about a quiet week), the label additions in the gap are skipped, never delivered late. A listen without `events` still receives arrivals only.
- The fake Gmail answers `drafts.create`, `drafts.list` and `messages.modify`, reports `labelsAdded` history (honouring `historyTypes`), and lists drafts in `/fake-gmail/state`.

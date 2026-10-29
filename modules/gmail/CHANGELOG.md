# @listen-fire/gmail

## 0.12.10

### Patch Changes

- The command is now `listen-fire`, no longer `lf`: every message, hint, description and handbook page that tells someone what to run names `listen-fire` (for example `listen-fire connect s3_files`, `listen-fire credential add --module webhook <name>`). Module names (`@lf/…`), `lf.yaml`, `.lf/` and `LF_*` variables are unchanged.

## 0.12.9

### Patch Changes

- 254d98e: The handbook text says "listen for both" where it said "ask for both" (the assembled handbook keeps the word "ask" for approvals).

## 0.12.8

### Patch Changes

- a3c0ead: Gmail keeps drafts, and fires when a label is added to a message.
  
  - Drafts: `write mail-[:Drafts]-> { To: [...], Subject: "...", Body: "..." }` keeps a new message unsent; `write msg-[:Drafts]-> { Body: "..." }` keeps a reply unsent, threaded as a reply is. A draft takes the fields a send does (`Files` included) and needs none of them. The write hands back the Draft's `Id`, `Message Id` and `Thread Id`.
  - Drafts are opt-in at sign-in: the module declares a second credential, `gmail_drafts`, the only one that asks for Gmail's compose scope (`lf credential add --module gmail <name> --credential gmail_drafts`). A mailbox signed in under `gmail` refuses a draft, naming the scope and how to sign in again; reads and sends are unaffected. A host that asks for its own scopes says so in `granted_scopes`; a delegated host hands a `compose_access_token`.
  - With two credentials declared, `lf credential add --module gmail` now needs `--credential gmail` (or `gmail_drafts`).
  - `label_added`: `listen to gmail { events: ["label_added"], labels: ["Label_12"] } fire f` fires once per message and label when one of the listen's labels is added to a message already in the mailbox, delivering the message with `Added Label` set. It reads the same Gmail history as arrivals, under the same checkpoint. After Gmail forgets the checkpoint (about a quiet week), the label additions in the gap are skipped, never delivered late. A listen without `events` still receives arrivals only.
  - The fake Gmail answers `drafts.create`, `drafts.list` and `messages.modify`, reports `labelsAdded` history (honouring `historyTypes`), and lists drafts in `/fake-gmail/state`.
  - `label_added` with no `labels` counts the mailbox's own (user) labels only, never Gmail's system labels (INBOX, UNREAD, STARRED, IMPORTANT, SENT, DRAFT, SPAM, TRASH, CHAT, CATEGORY_*). Arrival listens keep their INBOX default.
  - A listen's `labels` take a user label by its name as well as its id (looked up once per poll); a label the mailbox does not have fails the poll, naming the labels it has. The fake Gmail answers `labels.list` and `labels.create`, and its search matches a user label by name.
  - A sent message's and a reply's write handle now carries the catalog's field names (`Message Id`, `Thread Id`, `From`, `To`, `Cc`, `Subject`), as a draft's does, so a program reads them off the handle.

## 0.12.7

### Patch Changes

- 7cd7476: Each poll event is labelled with its kind, `eventType` `message_received` (adapter protocol 2.3). Its stated protocol minor is unchanged: an older host routes a labelled event correctly.

## 0.12.6

### Patch Changes

- Core imports are peers; first release under per-package versions.

## 0.12.5 and earlier: see the language's CHANGELOG.md at the repository root

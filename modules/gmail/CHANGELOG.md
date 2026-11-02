# @listen-fire/gmail

## 0.13.2

### Patch Changes

- 134ef2f: The core peer floor is now `>=0.13.0`. The handbook section's text is written for the 0.13 catalog, which a 0.12 core cannot read, so the range admitted a core its examples cannot be checked against.

## 0.13.1

### Patch Changes

- 3bbff43: A field that declares `changedIn` may also declare `unchangedValues`, the values that mean what they always did. A check for an upgrade does not warn (`MOV_FIELD_MEANING_CHANGED`) where a program compares the field only with literals among them (`==`, `!=`, `CONTAINS`, `IN`); the checker compares the literal with the list and reads nothing into its spelling. Gmail declares its own labels (`INBOX`, `UNREAD`, `STARRED`, `IMPORTANT`, `SENT`, `DRAFT`, `SPAM`, `TRASH`, `CHAT`, the five `CATEGORY_` tabs) for `Labels`, so a 0.12 listen on `INBOX` upgrades and moves the pin without `--all`, while one on a custom label's id still holds it.
- Updated dependencies [4516899]
- Updated dependencies [4bb86df]
- Updated dependencies [c7004f6]
  - @listen-fire/module-kit@0.14.0

## 0.13.0

### Minor Changes

- 1fc6a0a: Gmail listens on two edges, polled every minute (lf.yaml `pollEvery` overrides it for a connection). `Messages`, readable and listenable, hears each message added to the mailbox: `listen to mail-[m:Messages WHERE m.Labels CONTAINS "INBOX" AND m.Query == "from:acme"]-> fire f`. Sent mail and drafts are added too, so a listen says which labels it means. `Query` is a new field, an owned `GmailQuery` compared with `==` only: Gmail's search written as in its search box, applied at Gmail; read, it is the search a message was found by. `Labelings`, listenable only, hears each label added to a message already in the mailbox, landing a `Labeling` with its `Label`, `Label Type` (`user`, `system`) and the message's fields, and a `Message` edge to the message; `l.Label == "Deals"` takes a user label by its name. A label removed and added again is a second labeling. `Labels` takes `containsAny`: `m.Labels CONTAINS "Deals" OR m.Labels CONTAINS "Hiring"` hears mail carrying either, each user label by its name. The module applies the whole taken filter itself (`takenApplied`), names user labels as a person sees them, and carries `occurredAt` and, for a labeling, `about` its message. It declares how a 0.12 `listen to mail { query, labels, events }` becomes these (`listenSettingsBecome`, `events: ["label_added"]` choosing `Labelings`) and no longer declares `subscribableEvents`, `listenConfig`, a `fires` edge, event types or `Added Label`. `Labels` holds label names on every path, a walk and an arrival alike: a user label as the mailbox calls it (`Deals`), Gmail's own in capitals (`INBOX`), so a walk's `m.Labels CONTAINS "Deals"` is judged by the name its search is given. A labeling's `Label` is the label's name likewise, so `l.Label == "Deals"` compares what the arrival carries. Adapter protocol 2.6.

### Patch Changes

- 16e3776: A module's `poll` takes an edge's input alone (`PollEdgeInput`) and answers its arrivals (`PollEdgeAnswer`); `PollInput` and `PollAnswer` are gone from the kit, and a 0.12 settings poll's input reaches no module. Dealroom, Evertrace, GitHub, Gmail, Granola and System no longer refuse that input themselves. The in-process `Adapter.ensureEventSubscription` takes an edge's subscription; removing and refreshing one still take a 0.12 settings listen's webhook, so a host can remove it.
- c4af6cc: `listen-fire upgrade` never applies a rewrite that hears otherwise than the 0.12 listen did, unasked. Affinity: a listen naming `organization.updated` (or a person's or an opportunity's) is told that `Kind == "updated"` also hears each field value set or cleared on the record, which 0.12 heard only as field_value events, with the remedy `AND c.Field == null`, and is rewritten only under `--all`. Slack: a `message` or `app_mention` listen heard thread replies too, which now arrive on their root message's `Replies`, so it has no rewrite and is told to write one listen for each edge; a `reaction_added` listen is still rewritten onto `Reactions`. GitHub: `participating: false` heard every thread in 0.12, so it now compares nothing (`participating: true` is still `n.Participating == true`). Gmail: a `label_added` listen is told that a label removed and added again now runs it again, and is rewritten only under `--all`; and a 0.12 program reading `Labels` is warned on the upgrade (`MOV_FIELD_MEANING_CHANGED`) that it holds label names where it held ids.
- Updated dependencies [4c09d6a]
- Updated dependencies [faa7050]
- Updated dependencies [acec0bd]
- Updated dependencies [301dab3]
- Updated dependencies [3c2774e]
- Updated dependencies [dd81bed]
- Updated dependencies [c4af6cc]
- Updated dependencies [a942076]
- Updated dependencies [46efd84]
- Updated dependencies [9520af9]
- Updated dependencies [9e9316c]
- Updated dependencies [5bfc3f2]
- Updated dependencies [66d32d5]
- Updated dependencies [16e3776]
- Updated dependencies [16e3776]
- Updated dependencies [da1a05b]
- Updated dependencies [abc777e]
- Updated dependencies [ad23b9c]
  - @listen-fire/module-kit@0.13.0

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

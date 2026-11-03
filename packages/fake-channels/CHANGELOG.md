# @listen-fire/fake-channels

## 0.13.2

### Patch Changes

- f84d032: The fake Airtable keeps a written cell under its field's name, whichever of the field's id or name the write used, and reads it back by name, as Airtable does. It kept the key the write sent, so a row `@lf/airtable` had created (it writes by field id) read back with its fields missing: a `?:` on that row saw an empty field and overwrote it, and an update by id left the seeded name's value beside it.

## 0.13.1

### Patch Changes

- bbab91b: A reaction on a file arrives again: on the `Reactions` of each message that shares the file (read from `files.info`), as a reaction on that message does, its `Channel` and `Message` that message's. Since 0.13 it was dropped. When Slack does not answer `files.info` the delivery fails by name and Slack sends it again; a file in no conversation is on no message, and runs nothing. The fake Slack's `files.info` answers a seeded file's `shares`.
- Updated dependencies [4516899]
- Updated dependencies [4bb86df]
- Updated dependencies [c7004f6]
  - @listen-fire/module-kit@0.14.0

## 0.13.0

### Minor Changes

- 64aae54: The fake Slack builds a press as Slack posts it (`POST /slack/control/press`): the `block_actions` payload carries the message pressed with its blocks, and the action as its button was posted (its block id). It answers `auth.test` with its bot user, and logs every Web API method called (`/admin/slack/request_log/state`), so a test can say a call was never made. An outage makes the methods it names answer 500 until cleared (`POST /slack/control/outage { methods }`). A posted message's `ts` is seconds, a point and six digits, as Slack writes it (it was malformed, so its `Timestamp` read as no instant). The fake Airtable's record list honours `filterByFormula`'s equalities (`AND`, `OR`, `{Field} = "…"`, `RECORD_ID() = "…"`), so a `unique by` write finds its own row.

### Patch Changes

- c57641a: Airtable is listened to on a table's `Changes`, walked to by name (`listen to at-[b:Bases WHERE b.Name == "Finance"]->-[t:Tables WHERE t.Name == "Expenses"]->-[c:Changes WHERE c.Kind == "created"]-> fire review`). A change is one per row an edit touched (`Kind`, and the row before and after as `Previous` and `Current`, read through with `.` once tested present (`exists(c.Current) AND c.Current.Stage == …`; a created row has no `Previous`) and typed by the table's fields when the listen narrows to one table: `Candidates Change`), and its `Record` is the row as it is now, read from Airtable. One data webhook per base a listen's tables are in, over all its tables however many the listen watches (`Changes` declares `scopedBy: "Bases"`; at a connection positioned at its base it is delivered to the connection), and one schema webhook (`tableMetadata`) per base whose tables a listen narrows: 2 per base, the most Airtable lets one OAuth integration make, which the fake Airtable now enforces (a third live webhook on a base is refused); `Tables` declares `membersChange: "pushed"`, so a table renamed into the WHERE is watched from the rename. `Bases` is cheap to list and listed again hourly. A run can wait on a table's next change (`awaitKeys`). Adapter protocol 2.6. The root's `Base` collection is now `Bases`; `Record Change`, `listenConfig`, `subscribableEvents`, `subscriptionScopeKeys` and `listEventTypes` are gone, and a 0.12 settings listen is rewritten by `listen-fire upgrade`, keeping its meaning (`field` as `c.Current.F != c.Previous.F`, with `becomes` as `c.Current.F == v AND c.Previous.F != v`; the parameter retyped to the table's changes). A cell an update empties is absent from `Current`. Every cell of `Current` and `Previous` is the value its field declares (a collaborator by its email, a select by its name, a lookup as its values), so a listen compares them by value; attachments stay as Airtable sends them, and a `field` naming one is rewritten without `safe`. A registration with no webhook held first deletes any webhook left at its door, as Airtable keeps a lapsed one 7 days; a host must give each tenant connection a door URL of its own, or one tenant's registration deletes another's webhooks. A base's `Tables` and the root's `Bases` are read from Airtable each time they are listed, so a listen listed again sees a rename at once. A base holding a table named `Base`, `Table`, `Change`, `Row` or `Tables`, or one named as another table's changes (`Candidates Change`), or a table with a link field named `Changes`, is refused where it is described, naming what to rename. The module has a handbook section. The fake Airtable models schema webhooks, renames a table (`POST /airtable/control/rename-table`) or a base (`/rename-base`), and makes a table (`/create-table`).
- 3bb7aa9: Attio is listened to on a record's `Changes` (`listen to crm-[:Deals]->-[c:Changes WHERE c.Field == "Stage"]-> fire f`, `function f(c: <crm-[:DealChange]->>)`), each object's changes their own record type (`DealChange`, `CompanyChange`, …) with `Kind` (`created`, `updated`, `deleted`) and, on an update, `Field`, the changed attribute's title. A webhook delivery is the arrivals on each changed record's `Changes`, carrying the record as Attio holds it now, `about` it and `occurredAt` when the value took effect; a redelivery of the same change runs nothing. One webhook per connection serves every listen on `Changes` (`ensureEventSubscription({ edge: "Changes" })`). A run can wait on a record's next change: `awaitKeys` keys it by the record id. Adapter protocol 2.6. The `Webhook Event` type, `listEventTypes`, `subscribableEvents` and the snapshot trigger are gone. The fake Attio stamps each value it stores with `active_from` and each record with `created_at`, as Attio does.
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

## 0.12.8

### Patch Changes

- The command is now `listen-fire`, no longer `lf`: every message, hint, description and handbook page that tells someone what to run names `listen-fire` (for example `listen-fire connect s3_files`, `listen-fire credential add --module webhook <name>`). Module names (`@lf/…`), `lf.yaml`, `.lf/` and `LF_*` variables are unchanged.

## 0.12.7

### Patch Changes

- 26d988a: An Airtable listen can fire on one field changing, and on it changing to a value: `listen to hiring { base: "app…", table: "tbl…", field: "Stage", becomes: "Interview" } fire …` runs only when a change touched `Stage` and made it `Interview` (it was not `Interview` before). The `Record Change` event names the fields a change touched (`Changed Fields`) and reaches the row as it was through an `Old Record` edge, typed like the table, so `change-[:`Old Record`]->.Stage` is the `Stage` enum. A new Airtable webhook asks for previous cell values; select cells in a delivery read as their choice's name. The engine's listen scope gate (`eventMatchesTriggerScope`) applies `field` over an event's `changedFields` and `becomes` over its payload's `fields` and `previous`.
  
  The checker holds both keys against the table the listen watches. A module declares them with two new listen config formats: `field` (one field of the watched record) and `field-value` (a value of the field the `field` key names, beside exactly one `field` key). A `field` the table lacks is refused, naming the table's fields (`MOV_LISTEN_BAD_CONFIG`); a `becomes` that is not a choice of a select field is refused with a did-you-mean (`MOV_ENUM_UNKNOWN_VALUE`), and one of the wrong type for any other field (text for a number field) is refused (`MOV_LISTEN_BAD_CONFIG`), as is a `becomes` without a `field`. Only configs that could never fire are refused. `lf` applies the same `field` and `becomes` gate as the engine.
  
  A listen config format a checker does not know no longer refuses the catalog. A newer module may declare a format an older core lacks; its key's value is then a plain, unchecked value, and the checker says so once as an Info naming the format (`MOV_LISTEN_BAD_CONFIG`, severity info). `lf`'s manifest reader and the wire schema (`WireListenDeclarations`) keep such a format rather than refusing the manifest. So a module release no longer needs the core released first.
  
  `lf serve` registers Airtable webhooks. A module may declare `subscriptionScopeKeys` in its manifest (`module-kit` states them; Airtable's are `base` and `table`): `lf` then keeps one webhook per credential and scope, the scope being a listen's config values of those keys, and sends it as `scope` on `ensureEventSubscription` and `removeEventSubscription`, as the platform does. Each scoped webhook has its own door, `/api/public/webhook-sync/<provider>/<credential>/<key>` (the key is the scope's values, `appHIRE01.tblCAND01`), its own secret and pull cursor, and is kept in the credential's `webhook_subscriptions` field. A delivery there runs only the listens of that credential and scope; adding or removing a listen on another table registers or removes only that table's webhook. A module that declares no scope keys keeps its one webhook per credential, in the same fields and at the same door as before. A delivery's events are read (`preprocessInbound`, `wakeKeys`) as the user credential its door names, so a pulled source such as Airtable can read its payload feed. The fake Airtable gains a delivery door (`POST /airtable/control/deliver`) that queues a change on every webhook of the base that takes it and pings each one signed as Airtable signs, and its changes may carry previous cell values.
  
  Under `lf`, the event's `Record` and `Old Record` edges are narrowed to the table a movement's signature names, as the platform narrows them: in `function f(change: <hiring-[:`Record Change` WHERE `table` == "tblCAND01"]->>)`, `change-[:`Old Record`]->.Stage` is the Candidates table's `Stage` enum. A listen config key may declare `narrows: { collection, matchField }` (on the wire manifest; `module-kit` states it; Airtable's `base` and `table` do): it is one hop of the address. `lf` walks the address with the module's `edgesFrom` from the connection's root (a connection's entry position consumes the hops it pins), grafts a copy of the event node per address with its edges onto the last hop's collection retargeted at the walked table, and publishes the hop values a listen may name, so a listen's unknown table id is refused with a did-you-mean.
  
  Adapter protocol 2.4: an event subscription a source lets lapse. `ensureEventSubscription` may answer `expiresAt`, and a module may list `refreshEventSubscription` (`{ externalId, scope? }` → `{ expiresAt? }`); `PROTOCOL_MINOR` is 4 in `engine-contracts` and `module-wire` (`lf` and the engine speak 2.0 to 2.4). A module's stated minor is now what it needs its host to speak: its author's declared `protocolMinor`, else 0 — `protocolMinorOf`/`protocol_minor_of`, the module-kit stamping (TypeScript and Rust) and the slot manifests no longer raise it for offered methods, so a module listing `refreshEventSubscription`, a `.watch` or `work.enqueueIfAbsent` states 0 and an older host still reads it; `minorIntroducing`/`minor_introducing` name the minor that introduced a method a host requires. `lf` keeps each webhook's expiry with its registration and queues a `refresh_subscription` work row a day before it (halfway there for a lifetime under two days), which `lf serve` runs on its tick and `lf drain` takes, the wake slot told when it is due. A refresh that fails is printed once and tried again in 15 minutes; a webhook found lapsed is removed, registered anew and its pull cursor reset; one kept with no expiry is refreshed at once to learn it. Airtable answers its webhook's `expirationTime` as `expiresAt` from registering and refreshing, and lists `refreshEventSubscription`. The fake Airtable gains a clock (`POST /airtable/control/advance-clock { ms }`): a webhook past its expiry is pinged no more and cannot be refreshed. A webhook `lf serve` replaces because its events or door changed has its pull cursor reset too.
- d715ba3: An Airtable webhook asks for every field's current value (`includeCellValuesInFieldIds: "all"`) beside the previous ones, so a change event's `Record` is the whole row, not just the cells that changed; `Changed Fields` still names only those. `ensureEventSubscription` registers anew a held webhook whose specification asks for less (it lists the base's webhooks to read it). A table describes its rows' Airtable id as a read-only `Id` field, unless it has a field of that name. The fake Airtable lists a base's webhooks with their specifications and sends a change's other cells as `unchanged` when the webhook asked for them. Both additive to the field-change listen, new in this unreleased cycle.
- e013715: The fake Gmail keeps a binary attachment byte for byte: a seeded attachment may carry `contentBase64` (beside `content` for text), and a sent message's attachments are kept as their decoded bytes. The fake Drive splits a multipart upload as bytes, keeps them exactly (`contentBase64`), answers `size`, `md5Checksum` and `sha256Checksum`, and serves the exact bytes on `alt=media`; a copy carries the source's bytes and checksums.
- 847b0ed: The fake Drive takes an upload's type from its media part when the metadata names none, as real Drive does, so a PDF the Google Drive module uploads stays `application/pdf` rather than `application/octet-stream`.
- a3c0ead: Gmail keeps drafts, and fires when a label is added to a message.
  
  - Drafts: `write mail-[:Drafts]-> { To: [...], Subject: "...", Body: "..." }` keeps a new message unsent; `write msg-[:Drafts]-> { Body: "..." }` keeps a reply unsent, threaded as a reply is. A draft takes the fields a send does (`Files` included) and needs none of them. The write hands back the Draft's `Id`, `Message Id` and `Thread Id`.
  - Drafts are opt-in at sign-in: the module declares a second credential, `gmail_drafts`, the only one that asks for Gmail's compose scope (`lf credential add --module gmail <name> --credential gmail_drafts`). A mailbox signed in under `gmail` refuses a draft, naming the scope and how to sign in again; reads and sends are unaffected. A host that asks for its own scopes says so in `granted_scopes`; a delegated host hands a `compose_access_token`.
  - With two credentials declared, `lf credential add --module gmail` now needs `--credential gmail` (or `gmail_drafts`).
  - `label_added`: `listen to gmail { events: ["label_added"], labels: ["Label_12"] } fire f` fires once per message and label when one of the listen's labels is added to a message already in the mailbox, delivering the message with `Added Label` set. It reads the same Gmail history as arrivals, under the same checkpoint. After Gmail forgets the checkpoint (about a quiet week), the label additions in the gap are skipped, never delivered late. A listen without `events` still receives arrivals only.
  - The fake Gmail answers `drafts.create`, `drafts.list` and `messages.modify`, reports `labelsAdded` history (honouring `historyTypes`), and lists drafts in `/fake-gmail/state`.
  - `label_added` with no `labels` counts the mailbox's own (user) labels only, never Gmail's system labels (INBOX, UNREAD, STARRED, IMPORTANT, SENT, DRAFT, SPAM, TRASH, CHAT, CATEGORY_*). Arrival listens keep their INBOX default.
  - A listen's `labels` take a user label by its name as well as its id (looked up once per poll); a label the mailbox does not have fails the poll, naming the labels it has. The fake Gmail answers `labels.list` and `labels.create`, and its search matches a user label by name.
  - A sent message's and a reply's write handle now carries the catalog's field names (`Message Id`, `Thread Id`, `From`, `To`, `Cc`, `Subject`), as a draft's does, so a program reads them off the handle.
- 0215c37: `lf` describes a module once per position a program constructs it with, and sends that position on every call of the connection, so an Airtable base's tables are typed and checked under `lf`. A module's manifest may declare `positionArgs` (`module-kit` states them from the module's manifest); the fake Airtable's Companies table gains select fields with choices. The checker holds each text literal of a list written into a list of enum (an Airtable multiple select) against the enum, and a WHERE written inside a parameter's type (`<crm-[c:Companies WHERE c.Stage == "Lost"]->>`) against the enum of the field it compares, as it already did a single literal and a WHERE in a body (`MOV_ENUM_UNKNOWN_VALUE`). A listen on a positioned connection is polled in its position (the call's `settings`) under a checkpoint of its own.

## 0.12.6

### Patch Changes

- Core imports are peers; first release under per-package versions.

## 0.12.5 and earlier: see the language's CHANGELOG.md at the repository root

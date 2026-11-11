# @listen-fire/slack

## 0.13.5

### Patch Changes

- 32db044: `getActorCandidates` throws when it could not look the member up (no Slack client, a failed `users.info`, a failed Attio member fetch), so the host names who acted unknown instead of answering that nobody did. A member with no email is still no candidate. Slack asks `users.info` through its bounded delivery client, so a rate limited call fails at once.
- 74127fc: The actor each module names now says `proven: true`: the host admits a delivery only when the source system signed it (Slack, Telegram, Attio, WhatsApp), or the address is the source system's own answer to the connection's credential (Granola). Email states nothing, since nothing vouches for a `From` line.
- 74127fc: Slack declares a setting, `drop_own_messages`, off unless it is `on`: a message or reaction the app itself made, by its bot user or its bot id, is then no arrival. An app Slack cannot identify drops nothing and says so. `module-kit` lets an adapter module declare `settings` in its manifest.

## 0.13.4

### Patch Changes

- 134ef2f: The core peer floor is now `>=0.14.0`. The handbook section's examples use uses `?.`, which a 0.13 core does not read, so a 0.13 host installed it cleanly and then failed on its examples.

## 0.13.3

### Patch Changes

- 6040ec1: The handbook section keeps the handbook's prose rules: no `for each` or "ask" in prose. The WhatsApp button example connects with `using`, a credential, so it checks.

## 0.13.2

### Patch Changes

- d230f9c: The handbook section and the `Buttons` description read a press's value with `only(press-[:Actions]->)?.Value`, as the 0.14 language requires: `only(…)` may find nothing, and a field is read through it with `?.`.

## 0.13.1

### Patch Changes

- eb1f52f: A run a listen fires reads who caused it as its actor again (`@actor_email`, `@actor_name`, `@actor_id`, and the acting user resolved from it): each module reads it from the record that arrived, where 0.13.0 read the 0.12 event's payload, which a 0.13 run is never handed, and answered no actor.
  
  - Email: the sender, and each forwarding inbox the mail came through as a relay.
  - Slack: who posted the message, added the reaction or pressed the button.
  - Telegram and WhatsApp: the sender.
  - Attio: the workspace member who made the change. A change now keeps Attio's `actor` (`{ type, id }`) beside its named fields for this; it was dropped at delivery.
- 4516899: Each module says who acted where it builds an arrival (adapter protocol 2.7 `actor`): who posted, reacted or pressed in Slack, a Granola meeting's owner, a mail's sender, a Telegram or WhatsApp sender, the Attio member who made a change. A run reads `@actor_*` from it; `extractActor` and `getActorCandidates` read it from the run's trigger (`event.arrival.actor`), Slack still resolving the member's email through `users.info` and email still adding its forwarding relays. `module-kit` gains `firedActor(event)`.
- 83543ba: `connect` names the adapter and the credential itself (``gh = connect `@lf/github` using my_github``, `crm = connect #acme_crm using acme` for a module that is no package), with no `import … from adapters` or `from credentials`; the import form is deprecated and still checks under a `0.13` pin. The wasm checks the new form; the handbook, the modules' examples and the authoring MCP's guidance show only it, and the handbook's programs listen to the `manual` and `cron` units by name rather than connecting them.
  
  `@listen-fire/embed`: a module the host registers from a package (`modules: [{ module: slackModule, package: "@lf/slack" }]`) is connected by that package's name, as on every host; the host's own modules are connected as `#` and their adapter type.
- bbab91b: A reaction on a file arrives again: on the `Reactions` of each message that shares the file (read from `files.info`), as a reaction on that message does, its `Channel` and `Message` that message's. Since 0.13 it was dropped. When Slack does not answer `files.info` the delivery fails by name and Slack sends it again; a file in no conversation is on no message, and runs nothing. The fake Slack's `files.info` answers a seeded file's `shares`.
- 6ba7208: A thread reply arrives with its channel, as a message does, and `Replies` declares that it carries `Channels`. So a listen on a thread's replies narrows by the channel's name, `listen to chat-[ch:Channels WHERE ch.Name == "deals"]->-[:Messages]->-[:Replies]-> fire f`, where before it was refused at check (`MOV_LISTEN_UNWATCHABLE`). A reply does not carry its root message: a filter on that message stays refused.
- Updated dependencies [4516899]
- Updated dependencies [4bb86df]
- Updated dependencies [c7004f6]
  - @listen-fire/module-kit@0.14.0

## 0.13.0

### Minor Changes

- 1a80e92: A message write takes `Buttons` (`[{ Text, Value }]`), posted as the message text and one button per entry, and a run waits for a press with `await msg-[:Interactions]->`. A press is an `Interaction { Id, At }` with its `Actions` (`Action { Value, Text }`) and the member who pressed (`By`); the `Value` is typed by the Values the buttons were written with. `Replies` takes the first reply already in the thread or the next to arrive, and a deleted message ends either wait. The module speaks adapter protocol 2.5 (`awaitKeys`, and presses, thread replies and deletions reported as arrivals with the delivery) in place of `resolveAwait` and `wakeKeys`, and so needs a listen-fire that reads form-encoded deliveries: Slack posts a press as `payload=<json>`. A button without its `Text` or `Value`, or past Slack's limits (25 buttons, 75 characters on a label, 2000 in a value, 3000 of message text above them), is refused naming it. A thread reply that mentions the app arrives once on `Replies`, though Slack sends it as a message and a mention. The handbook section teaches buttons and waits; callback ids in Block Kit are no longer taught.
- 64aae54: Slack is listened to on the edge each record arrives on, each landing on its own record type: a channel's `Messages`, a message's `Reactions` and its `Interactions` (``listen to chat-[ch:Channels WHERE ch.Name IN ["deals"]]->-[m:Messages WHERE m.`Mentions App` == true]-> fire f``). A message and a reaction arrive carrying their channel (named from the cached channel read), a press carrying its channel and the message pressed, so a listen's filter on them is judged on the arrival with nothing listed; a reaction does not carry its message. A message written with `Buttons` may carry a `Topic`, stored as the id of the block its buttons sit in (`lf:<topic>`) and read back from there, so ``listen to chat-[:Channels]->-[m:Messages WHERE m.Topic == "lunch-poll"]->-[:Interactions]-> fire f`` runs once per press on any message that has it; a `Topic` without `Buttons` is refused by name. A message gains `Id` (`channel:ts`), `Topic` and `Mentions App`; a press walks to its `Message`; a message a run writes is handed `channel:ts` as its id. A delivery's lookups (the channel's name, the app's bot user) are bounded and never hold the delivery (`SLACK_LOOKUP_TIMEOUT_MS`, `SLACK_LOOKUP_RETRIES`, `SLACK_LOOKUP_FAILURE_CACHE_MS`; README). Block ids starting `lf:` are reserved for a `Topic`. Adapter protocol 2.6. It declares how a 0.12 `listen to chat { channels, events }` becomes a traversal (`listenSettingsBecome`). `listEventTypes`, the `fires` edges, `subscribableEvents`, `listenConfig` and `slackInboundEvents` are gone: `preprocessInbound` answers `arrivals`, no events.
- 28f6d44: `Replies` declares `listenable: true` (a reply named by its record id, its channel and `ts`) in place of the retired `awaitable` and `watchable`, as the 0.13 line requires. `await m-[:Replies]->` waits for a new reply as before. The core peers now start at 0.13.0: a 0.12 host does not know `listenable`, and would drop it, leaving `Replies` an edge nothing can wait on.
- acec0bd: Slack names the fields it could not read on an arrival (`unknown`, adapter protocol 2.6), so a listen whose filter reads one is reported undecided rather than skipped: a message's `Mentions App` when it cannot read the app's bot user (`auth.test`), and a carried channel's `Name` when it cannot read the channel (`conversations.info`), instead of guessing or dropping the channel.

### Patch Changes

- cf98af4: Examples wait with `await x-[:E]->` in place of the retired `await first(x-[:E]->)`, which a 0.13 check respells. The handbook drops its common-mistakes entry against writing `await` before a bare walk, which is now the form.
- 16e3776: A module's inbound declaration may name `redactFields`: the body and query fields that may carry a credential, dropped before a request is kept (a JSON body's own members, a form's fields and the members of a JSON object a form field holds, and the query's parameters). A body that names none is kept byte for byte. `@lf/slack` names its legacy verification `token`. A header whose name holds `token`, `key`, `auth`, `hmac` or `password` is never kept.
- c4af6cc: `listen-fire upgrade` never applies a rewrite that hears otherwise than the 0.12 listen did, unasked. Affinity: a listen naming `organization.updated` (or a person's or an opportunity's) is told that `Kind == "updated"` also hears each field value set or cleared on the record, which 0.12 heard only as field_value events, with the remedy `AND c.Field == null`, and is rewritten only under `--all`. Slack: a `message` or `app_mention` listen heard thread replies too, which now arrive on their root message's `Replies`, so it has no rewrite and is told to write one listen for each edge; a `reaction_added` listen is still rewritten onto `Reactions`. GitHub: `participating: false` heard every thread in 0.12, so it now compares nothing (`participating: true` is still `n.Participating == true`). Gmail: a `label_added` listen is told that a label removed and added again now runs it again, and is rewritten only under `--all`; and a 0.12 program reading `Labels` is warned on the upgrade (`MOV_FIELD_MEANING_CHANGED`) that it holds label names where it held ids.
- 75ea8a3: The Slack handbook section says a message deleted while a run waits on it leaves the wait waiting (listen-fire 0.13): nothing after the `await` runs, so race the wait with a `sleep`. It said the deletion ended the wait.
- c67d9a6: A message's `Timestamp` and a press's `At` each have a field id of their own (`timestamp`, `pressed_at`), and an arrival carries the instant under it. A host reads an arrival's fields by id before judging a listen, and the ids were Slack's raw `ts` and `action_ts`, so `m.Timestamp WITHIN 3d` compared Slack's raw epoch text and a lunch poll's presses never fired `count_vote`.
- 78d60a1: The handbook section says to point the Slack app's Interactivity and Event Subscriptions request URLs at the connection's door, which `listen-fire serve` prints for every Slack connection a run can wait on. It no longer says a `race`'s slot loses the type of a press's `Value`: the slot keeps it.
- de5c171: A button press whose member fields (`username`, `name`, `team_id`) Slack sends as null still lands on its message's `Interactions`, the null fields left out. Before, the press failed to parse and was dropped without a word.
- 6e58fbe: `Replies` and `Interactions` no longer declare `resolvesEmpty`, which 0.13 retires: a deleted message leaves the wait waiting on every edge, so there is nothing to declare, and a 0.13 `listen-fire` refuses a module that still declares it.
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

## 0.12.7

### Patch Changes

- 157ca3a: The response cache's eviction timer no longer keeps the host process alive for its 1 to 5 minute lifetime.

## 0.12.6

### Patch Changes

- Core imports are peers; first release under per-package versions.

## 0.12.5 and earlier: see the language's CHANGELOG.md at the repository root

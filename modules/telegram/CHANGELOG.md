# @listen-fire/telegram

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
- Updated dependencies [4516899]
- Updated dependencies [4bb86df]
- Updated dependencies [c7004f6]
  - @listen-fire/module-kit@0.14.0

## 0.13.0

### Minor Changes

- be7cd14: Telegram is listened to on `Messages`, a root edge (``listen to tg-[m:Messages WHERE m.`Chat Id` == "42"]-> fire f``, ``function f(m: <tg-[:Messages]->>)``): each message the bot receives is an arrival landing on the `Message`, named by `Id` (the chat and the message id, since Telegram numbers a message within its chat) and at the time of its `date`. Telegram cannot list chats, so a listen narrows to one by the message's `Chat Id`. Adapter protocol 2.6. It declares how a 0.12 `listen to tg {} fire f` becomes a listen on `Messages` (`listenSettingsBecome`). `listEventTypes`, the `fires` edge `Message` and `telegramInboundEvents` are gone: `preprocessInbound` answers `arrivals`, no events (`telegramInboundArrivals` is the parse).

### Patch Changes

- cf98af4: Examples wait with `await x-[:E]->` in place of the retired `await first(x-[:E]->)`, which a 0.13 check respells. The handbook drops its common-mistakes entry against writing `await` before a bare walk, which is now the form.
- 69fbb49: The handbook sections and the `Reply Markup` (Telegram) and `Interactive` (WhatsApp) field descriptions teach a url button that opens a form from `@lf/forms` (`form = write forms-[:Forms]-> { Title: …, Fields: … }`, its `form.Url` on the button, then `await form-[:Submissions]->`), in place of a callback id on the button: `callback(…)` retired at 0.13. A `callback_data` or reply button's tap reaches no run until these modules report taps as `Interactions`, as Slack does.
- bd3b097: The handbook section's form example waits for the submission inside a `race` with a `sleep`, so a form nobody answers ends the wait after a day.
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

## 0.12.6

### Patch Changes

- Core imports are peers; first release under per-package versions.

## 0.12.5 and earlier: see the language's CHANGELOG.md at the repository root

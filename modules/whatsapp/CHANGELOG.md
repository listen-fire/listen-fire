# @listen-fire/whatsapp

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

- acec0bd: A replayed request (`listen-fire listens replay`) reaches a module that checks its own requests with `replayed: true` (adapter protocol 2.6), read by module-kit's `inboundRequest` from the host's call alone, never from a header, the query or the body. `@lf/stripe`, `@lf/webhook`, `@lf/whatsapp` and `@lf/email` skip their signature and timestamp checks for it. A kept request holds only the headers a module names in `inbound.captureHeaders`, never a signature: `@lf/email` names `svix-id` (which tells a Resend notification from a Mailgun post), `@lf/forms` names `content-type`; the others need none (docs/contracts/adapter-protocol.md).
- 1c42d26: WhatsApp is listened to on the edge a record arrives on, each its own record type: `Messages` (`Message`), `Reactions` (`Reaction`, `about` the message it is on) and `Locations` (`Location`), root edges pushed to the connection's door (``listen to wa-[m:Messages WHERE m.From == "447700900001"]-> fire f``). A reaction runs only a listen on `Reactions`, never one on `Messages`. Each is named by its WhatsApp id (Meta's resend of a delivery is the same arrival) and at the time Meta stamped it. WhatsApp cannot list conversations, so a listen narrows to one by the sender's number, `From`. Adapter protocol 2.6. It declares how a 0.12 `listen to wa { events }` becomes a listen on the edge its events arrive on (`listenSettingsBecome`); one naming events of two kinds has no rewrite. `listEventTypes`, the `fires` edges, `subscribableEvents`, `defaultSubscribedEvents`, `triggerAcceptsWhatsappKind` and `whatsappInboundEvents` are gone: `checkInbound` and `preprocessInbound` answer `arrivals`, no events (`whatsappInboundArrivals` is the parse).

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

## 0.12.8

### Patch Changes

- The command is now `listen-fire`, no longer `lf`: every message, hint, description and handbook page that tells someone what to run names `listen-fire` (for example `listen-fire connect s3_files`, `listen-fire credential add --module webhook <name>`). Module names (`@lf/…`), `lf.yaml`, `.lf/` and `LF_*` variables are unchanged.

## 0.12.7

### Patch Changes

- 81e20ed: The manifest's description and trigger expectation say who reaches a listen on either host: where the number is the project's own (`lf`), every message sent to it; on the shared Listen-Fire number, only messages from a phone linked to the user's account. Before, both stated the shared-number rule alone, which is wrong under `lf`.

## 0.12.6

### Patch Changes

- Core imports are peers; first release under per-package versions.

## 0.12.5 and earlier: see the language's CHANGELOG.md at the repository root

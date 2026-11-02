# @listen-fire/email

## 0.13.1

### Patch Changes

- eb1f52f: A run a listen fires reads who caused it as its actor again (`@actor_email`, `@actor_name`, `@actor_id`, and the acting user resolved from it): each module reads it from the record that arrived, where 0.13.0 read the 0.12 event's payload, which a 0.13 run is never handed, and answered no actor.
  
  - Email: the sender, and each forwarding inbox the mail came through as a relay.
  - Slack: who posted the message, added the reaction or pressed the button.
  - Telegram and WhatsApp: the sender.
  - Attio: the workspace member who made the change. A change now keeps Attio's `actor` (`{ type, id }`) beside its named fields for this; it was dropped at delivery.
- 4516899: Each module says who acted where it builds an arrival (adapter protocol 2.7 `actor`): who posted, reacted or pressed in Slack, a Granola meeting's owner, a mail's sender, a Telegram or WhatsApp sender, the Attio member who made a change. A run reads `@actor_*` from it; `extractActor` and `getActorCandidates` read it from the run's trigger (`event.arrival.actor`), Slack still resolving the member's email through `users.info` and email still adding its forwarding relays. `module-kit` gains `firedActor(event)`.
- d07e8a0: An email's record carries only the email's own fields: Mailgun's `token`, `timestamp` and `signature` verify a post and are dropped, where they were merged into every record (and so reached every run, every write made from it, and the delivery's kept arrivals). The module names them in `inbound.redactFields`, so a kept request drops them from its body too.
- Updated dependencies [4516899]
- Updated dependencies [4bb86df]
- Updated dependencies [c7004f6]
  - @listen-fire/module-kit@0.14.0

## 0.13.0

### Minor Changes

- 1e85960: Inbound mail arrives on the connection's `Emails` edge, each message with the plus-suffix it was sent to as its `Key` (lowercased; the empty key for mail to the box itself): `listen to inbox-[e:Emails WHERE e.Key == "deals"]-> fire f`. `Emails` is unbounded, narrowed by `Key`, an `InboxKey` a listen writes lowercase, with the characters a plus-suffix can carry (`""` for the box itself). The module declares how a 0.12 `listen to inbox { key: "deals" }` becomes it (`listenSettingsBecome`; a listen with no key becomes `e.Key == ""`, and a key is lowercased, as 0.12 compared it), and no longer declares `listenConfig`, a `fires` edge or event types. Adapter protocol 2.6.
- acec0bd: A replayed request (`listen-fire listens replay`) reaches a module that checks its own requests with `replayed: true` (adapter protocol 2.6), read by module-kit's `inboundRequest` from the host's call alone, never from a header, the query or the body. `@lf/stripe`, `@lf/webhook`, `@lf/whatsapp` and `@lf/email` skip their signature and timestamp checks for it. A kept request holds only the headers a module names in `inbound.captureHeaders`, never a signature: `@lf/email` names `svix-id` (which tells a Resend notification from a Mailgun post), `@lf/forms` names `content-type`; the others need none (docs/contracts/adapter-protocol.md).

### Patch Changes

- 35e92b3: A listen's WHERE reads an arrival's fields by the names the program writes, as its run does, also where a module keys its records by its own field ids. The catalog's position carries `fieldIds` (name → id, where the two differ), and each host reads every record an arrival carries by those names before judging it (`named_fields` in Rust, `namedFields`/`namedArrival` in TypeScript, held by both to `conformance/listen-field-names.json`). So `inbox-[e:Emails WHERE e.Subject CONTAINS "Series A"]->` fires: before, an email listen reading any field but `Key` never fired, and nothing said so. An email's arrival also carries its derived `Body`.
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

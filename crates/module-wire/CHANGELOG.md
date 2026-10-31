# Changelog

## Unreleased

- `PROTOCOL_MINOR` is 6: adapter protocol 2.6, arrivals for listens. An arrival in the results check may name no `key` (one on a root edge), and may carry `parents` (landings or `null`), `about` (`{ recordType, externalId }`), `notFor` and `takenApplied`. 2.6 names no method, so `PROTOCOL_MINORS` gains no row.
- `PROTOCOL_MINOR` is 5: adapter protocol 2.5, arrivals. `PROTOCOL_MINORS` gains its row (`awaitKeys`). The results check takes `awaitKeys`' answer (`[{ key }` or `{ gone: true }]`) and the `arrivals` a module reports beside `preprocessInbound`'s events and on `checkInbound`'s `accepted`; an arrival names its identity, a gone one does not.
- `protocol_minor_of` is what a manifest declares (`protocolMinor`), else 0: the methods it lists no longer raise it. `minor_introducing(method)` names the minor that introduced a method, for a host that requires it.
- `PROTOCOL_MINOR` is 4: adapter protocol 2.4, `refreshEventSubscription`. `PROTOCOL_MINORS` gains its row, and the results check takes its answer (`{ expiresAt? }` or `null`) and `ensureEventSubscription`'s `expiresAt`.

## 0.12.7 - 2026-10-26

- `PROTOCOL_MINOR` is 3: adapter protocol 2.3, labelled poll events. It is a rule for sources and a host behaviour, not a feature a module states, so `PROTOCOL_MINORS` gains no row.

## 0.12.6 - 2026-10-25

- The adapter protocol minor: `PROTOCOL_MINOR`, the `PROTOCOL_MINORS` table and `protocol_minor_of`, the minor a manifest states from the features it uses.
- Its own version from here on; it no longer depends on the parser.

## 0.12.5 and earlier: see the language's CHANGELOG.md at the repository root

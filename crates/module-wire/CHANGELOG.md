# Changelog

## Unreleased

- `PROTOCOL_MINOR` is 8: adapter protocol 2.8, every request a runner sends to the slots it fills carries `hostRelease`, its release. 2.8 is a host behaviour and names no method, so `PROTOCOL_MINORS` gains no row.

## 0.12.9 - 2026-11-02

- `PROTOCOL_MINOR` is 7: adapter protocol 2.7, a poll's answer may say when the edge is next worth polling, and an arrival may name who acted. The results check keeps `poll`'s `pollAgainAt` (a non-empty string) and takes an arrival's `actor` (an actor identity). 2.7 is a host behaviour and names no method, so `PROTOCOL_MINORS` gains no row.
- The results check takes an arrival's landing and parents naming `unknown`, the fields the module could not read (adapter protocol 2.6, additive).
- The results check takes `poll`'s 2.6 answer for a listenable edge, `{ arrivals, cursor? }`, beside a listen's `{ events, checkpoint? }`.
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

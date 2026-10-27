# Changelog

## Unreleased

- `protocol_minor_of` is what a manifest declares (`protocolMinor`), else 0: the methods it lists no longer raise it. `minor_introducing(method)` names the minor that introduced a method, for a host that requires it.
- `PROTOCOL_MINOR` is 4: adapter protocol 2.4, `refreshEventSubscription`. `PROTOCOL_MINORS` gains its row, and the results check takes its answer (`{ expiresAt? }` or `null`) and `ensureEventSubscription`'s `expiresAt`.

## 0.12.7 - 2026-10-26

- `PROTOCOL_MINOR` is 3: adapter protocol 2.3, labelled poll events. It is a rule for sources and a host behaviour, not a feature a module states, so `PROTOCOL_MINORS` gains no row.

## 0.12.6 - 2026-10-25

- The adapter protocol minor: `PROTOCOL_MINOR`, the `PROTOCOL_MINORS` table and `protocol_minor_of`, the minor a manifest states from the features it uses.
- Its own version from here on; it no longer depends on the parser.

## 0.12.5 and earlier: see the language's CHANGELOG.md at the repository root

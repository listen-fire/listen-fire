# @listen-fire/engine-contracts

## 0.13.1

### Patch Changes

- 3bbff43: A field that declares `changedIn` may also declare `unchangedValues`, the values that mean what they always did. A check for an upgrade does not warn (`MOV_FIELD_MEANING_CHANGED`) where a program compares the field only with literals among them (`==`, `!=`, `CONTAINS`, `IN`); the checker compares the literal with the list and reads nothing into its spelling. Gmail declares its own labels (`INBOX`, `UNREAD`, `STARRED`, `IMPORTANT`, `SENT`, `DRAFT`, `SPAM`, `TRASH`, `CHAT`, the five `CATEGORY_` tabs) for `Labels`, so a 0.12 listen on `INBOX` upgrades and moves the pin without `--all`, while one on a custom label's id still holds it.

## 0.12.13

### Patch Changes

- The command is now `listen-fire`, no longer `lf`: every message, hint, description and handbook page that tells someone what to run names `listen-fire` (for example `listen-fire connect s3_files`, `listen-fire credential add --module webhook <name>`). Module names (`@lf/…`), `lf.yaml`, `.lf/` and `LF_*` variables are unchanged.

## 0.12.12

No changes in this release.

## 0.12.11

No changes in this release.

## 0.12.10

### Patch Changes

- 1cddbb8: A module's `checkInbound` answer can carry `deliveryId` in TypeScript: `InboundCheck`'s `accepted` outcome has it, and module-kit's `accepted(events, { deliveryId })` sets it. The wire and `lf` already took it (a repeat under the same id is answered `duplicate: true` and runs nothing). Additive.

## 0.12.9

No changes in this release.

## 0.12.8

No changes in this release.

## 0.12.7

No changes in this release.

## 0.12.6

### Patch Changes

- Adapter protocol 2.N: a module states the protocol minor it uses (`protocolMinor` on its manifest), and lf and the engine speak 2.0–2.2 and refuse a module outside that range by name. lf checks a slot module's protocol at start, so a slot module must answer `manifest` before anything else.

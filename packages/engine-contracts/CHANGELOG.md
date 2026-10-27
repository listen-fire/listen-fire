# @listen-fire/engine-contracts

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

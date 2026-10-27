---
"@listen-fire/engine-contracts": patch
"@listen-fire/module-kit": patch
---

A module's `checkInbound` answer can carry `deliveryId` in TypeScript: `InboundCheck`'s `accepted` outcome has it, and module-kit's `accepted(events, { deliveryId })` sets it. The wire and `lf` already took it (a repeat under the same id is answered `duplicate: true` and runs nothing). Additive.

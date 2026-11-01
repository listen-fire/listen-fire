---
"@listen-fire/engine-contracts": minor
"@listen-fire/module-kit": minor
"@listen-fire/stripe": minor
"@listen-fire/webhook": minor
"@listen-fire/whatsapp": minor
"@listen-fire/email": minor
---

`checkInbound` may be handed `replayed: true` (adapter protocol 2.6): the host is running a request it kept itself again (`listen-fire listens replay`), not one that arrived. A module that verifies its own requests skips its signature and timestamp checks for it: `@lf/stripe` (its five minute window), `@lf/webhook`, `@lf/whatsapp` and `@lf/email` (the Mailgun key, Resend's Svix signature and window) read it; `@lf/forms` checks no signature. Only the host's call carries it: a module reads `request.replayed` (module-kit's `inboundRequest`), never a header, the query or the body, which a sender controls. An older module ignores it and checks as before (docs/contracts/adapter-protocol.md).

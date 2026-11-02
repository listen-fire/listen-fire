# @listen-fire/webhook

## 0.13.0

### Minor Changes

- acec0bd: A replayed request (`listen-fire listens replay`) reaches a module that checks its own requests with `replayed: true` (adapter protocol 2.6), read by module-kit's `inboundRequest` from the host's call alone, never from a header, the query or the body. `@lf/stripe`, `@lf/webhook`, `@lf/whatsapp` and `@lf/email` skip their signature and timestamp checks for it. A kept request holds only the headers a module names in `inbound.captureHeaders`, never a signature: `@lf/email` names `svix-id` (which tells a Resend notification from a Mailgun post), `@lf/forms` names `content-type`; the others need none (docs/contracts/adapter-protocol.md).
- 1e85960: Each delivery arrives on the connection's `Requests` edge, its body untyped JSON, and the listen states the node it is: `listen to stripe-[:Requests]-><Payment> fire f`. The module declares how a 0.12 `listen to stripe { payload: <Payment> }` becomes it (`listenSettingsBecome`), and no longer declares `listenConfig`, a `fires` edge or event types. A delivery the sender names by an id (Stripe's `id`, the credential's `idField`) is that arrival's identity; one it names by nothing is its own. Adapter protocol 2.6.

### Patch Changes

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

## 0.12.9

### Patch Changes

- The command is now `listen-fire`, no longer `lf`: every message, hint, description and handbook page that tells someone what to run names `listen-fire` (for example `listen-fire connect s3_files`, `listen-fire credential add --module webhook <name>`). Module names (`@lf/…`), `lf.yaml`, `.lf/` and `LF_*` variables are unchanged.
- d0a1d12: Stripe's webhook signature check moves into module-kit (`verifyStripeSignature`, `stripeSignature`), so every module that takes Stripe's deliveries checks them one way. `@lf/webhook`'s `stripe` scheme now calls it and behaves as before: the `Stripe-Signature` header's `v1` HMAC of `<t>.<body>`, any of several `v1`s, and a signature older than five minutes refused.
  
  `@lf/webhook`'s handbook section and README point a Stripe sender to `@lf/stripe`, which types its events, objects and amounts.

## 0.12.8

### Patch Changes

- a6b6686: A new module, `@lf/webhook`: incoming webhooks from any sender. Each connection is one URL at `lf serve`'s hooks door (`/hooks/webhook/<credential>`, printed when `lf serve` starts). Its credential (`lf credential add --module webhook <name>`) says how deliveries are signed: `stripe` (the `Stripe-Signature` header, refused when older than five minutes), `hmac-sha256` (a header it names, hex or base64), or `none` (unsigned, written down, never a default). An unsigned, mis-signed or stale delivery is answered 401 and runs nothing; a body that is not a JSON object is answered 400. The listen declares what a delivery carries: `listen to stripe { payload: <Payment> } fire …`. A retried delivery runs once: `stripe` deduplicates on the body's `id`, the other schemes on the credential's optional `idField` (a top-level body field; absent means no dedupe), and the repeat is answered 200 `duplicate: true`. This is the package's first release: `changeset version` takes it from 0.12.7 to 0.12.8.

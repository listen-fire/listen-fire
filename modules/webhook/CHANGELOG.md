# @listen-fire/webhook

## 0.12.9

### Patch Changes

- The command is now `listen-fire`, no longer `lf`: every message, hint, description and handbook page that tells someone what to run names `listen-fire` (for example `listen-fire connect s3_files`, `listen-fire credential add --module webhook <name>`). Module names (`@lf/…`), `lf.yaml`, `.lf/` and `LF_*` variables are unchanged.
- d0a1d12: Stripe's webhook signature check moves into module-kit (`verifyStripeSignature`, `stripeSignature`), so every module that takes Stripe's deliveries checks them one way. `@lf/webhook`'s `stripe` scheme now calls it and behaves as before: the `Stripe-Signature` header's `v1` HMAC of `<t>.<body>`, any of several `v1`s, and a signature older than five minutes refused.
  
  `@lf/webhook`'s handbook section and README point a Stripe sender to `@lf/stripe`, which types its events, objects and amounts.

## 0.12.8

### Patch Changes

- a6b6686: A new module, `@lf/webhook`: incoming webhooks from any sender. Each connection is one URL at `lf serve`'s hooks door (`/hooks/webhook/<credential>`, printed when `lf serve` starts). Its credential (`lf credential add --module webhook <name>`) says how deliveries are signed: `stripe` (the `Stripe-Signature` header, refused when older than five minutes), `hmac-sha256` (a header it names, hex or base64), or `none` (unsigned, written down, never a default). An unsigned, mis-signed or stale delivery is answered 401 and runs nothing; a body that is not a JSON object is answered 400. The listen declares what a delivery carries: `listen to stripe { payload: <Payment> } fire …`. A retried delivery runs once: `stripe` deduplicates on the body's `id`, the other schemes on the credential's optional `idField` (a top-level body field; absent means no dedupe), and the repeat is answered 200 `duplicate: true`. This is the package's first release: `changeset version` takes it from 0.12.7 to 0.12.8.

# @listen-fire/webhook

## 0.12.8

### Patch Changes

- a6b6686: A new module, `@lf/webhook`: incoming webhooks from any sender. Each connection is one URL at `lf serve`'s hooks door (`/hooks/webhook/<credential>`, printed when `lf serve` starts). Its credential (`lf credential add --module webhook <name>`) says how deliveries are signed: `stripe` (the `Stripe-Signature` header, refused when older than five minutes), `hmac-sha256` (a header it names, hex or base64), or `none` (unsigned, written down, never a default). An unsigned, mis-signed or stale delivery is answered 401 and runs nothing; a body that is not a JSON object is answered 400. The listen declares what a delivery carries: `listen to stripe { payload: <Payment> } fire …`. A retried delivery runs once: `stripe` deduplicates on the body's `id`, the other schemes on the credential's optional `idField` (a top-level body field; absent means no dedupe), and the repeat is answered 200 `duplicate: true`. This is the package's first release: `changeset version` takes it from 0.12.7 to 0.12.8.

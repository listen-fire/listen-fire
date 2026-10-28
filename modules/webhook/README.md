# @listen-fire/webhook

Incoming webhooks from any sender as a Listen-Fire module (`@lf/webhook`, bundled with `lf`). Each connection is one URL; its credential says how deliveries to it are signed. The program declares only what a delivery carries. For Stripe, [`@lf/stripe`](../stripe/README.md) types its events, objects and amounts for you.

## Setting it up

```
lf connect @lf/webhook
lf credential add --module webhook StripeHook
```

The credential asks for:

- `scheme`, one of:
  - `stripe`: the `Stripe-Signature` header (`t=…,v1=…`), an HMAC-SHA256 of `<t>.<body>`. A signature older than five minutes is refused.
  - `hmac-sha256`: the HMAC-SHA256 of the exact body, in a header the credential names.
  - `none`: unsigned. Any POST runs. This is a choice written down, never a default.
- `secret`: the signing secret (for Stripe, the endpoint's `whsec_…`). Empty for `none`.
- `header` and `encoding` (`hex` or `base64`, default `hex`): for `hmac-sha256` only.
- `idField` (optional): a top-level body field holding the sender's id for a delivery, for `hmac-sha256` and `none`. A retry of a delivery with the same id runs once: the repeat is answered 200 `duplicate: true` and runs nothing. Without `idField` nothing is deduplicated. `stripe` always uses the body's `id` (the Stripe event id).

`lf serve` prints each connection's URL when it starts: `/hooks/webhook/<credential>`, under `publicUrl` when `lf.yaml` names one. Give that URL to the sender.

## What a movement sees

```
import { webhook, acme_crm } from adapters
import { StripeHook, acme } from credentials

stripe = connect webhook using StripeHook
crm = connect acme_crm using acme

node Payment {
  id: <text>
  amount: <number>
}

function `Payment Failed`(e: <Payment>) {
  write crm-[:Company]-> { Name: "${e.id} failed: ${e.amount}" }
}

listen to stripe { payload: <Payment> } fire `Payment Failed`
```

- `payload:` is required. It names a node the program declares, and the event is that node.
- `lf check` refuses a read of a field the node does not declare. It also checks the movement's parameter against the node.
- The node's fields are the body's top-level JSON keys.

## What a sender gets back

| Delivery | Answer |
|---|---|
| signed, and it fits a listen's payload | 202, its runs |
| unsigned, mis-signed or stale | 401, nothing runs |
| not a JSON object | 400 `body_not_object` |
| fits no listen's payload (a required field missing or null, or a value of another kind) | 400 `payload_mismatch`, naming the fields |

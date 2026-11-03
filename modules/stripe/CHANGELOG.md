# @listen-fire/stripe

## 0.13.3

### Patch Changes

- dab66a2: A customer's, an invoice's and a charge's description now says in its first sentence that their amounts are in major units of their `Currency` (490 usd is $490, not cents). The first sentence is what `listen-fire catalog`, `listen-fire runs show` and `listen-fire modules show` print for a record type, so a reader of any of them sees it beside the numbers. The amounts themselves are unchanged.

## 0.13.2

### Patch Changes

- 134ef2f: The core peer floor is now `>=0.13.0`. The handbook section's text is written for the 0.13 catalog, which a 0.12 core cannot read, so the range admitted a core its examples cannot be checked against.

## 0.13.1

### Patch Changes

- 83543ba: `connect` names the adapter and the credential itself (``gh = connect `@lf/github` using my_github``, `crm = connect #acme_crm using acme` for a module that is no package), with no `import … from adapters` or `from credentials`; the import form is deprecated and still checks under a `0.13` pin. The wasm checks the new form; the handbook, the modules' examples and the authoring MCP's guidance show only it, and the handbook's programs listen to the `manual` and `cron` units by name rather than connecting them.
  
  `@listen-fire/embed`: a module the host registers from a package (`modules: [{ module: slackModule, package: "@lf/slack" }]`) is connected by that package's name, as on every host; the host's own modules are connected as `#` and their adapter type.
- Updated dependencies [4516899]
- Updated dependencies [4bb86df]
- Updated dependencies [c7004f6]
  - @listen-fire/module-kit@0.14.0

## 0.13.0

### Minor Changes

- acec0bd: A replayed request (`listen-fire listens replay`) reaches a module that checks its own requests with `replayed: true` (adapter protocol 2.6), read by module-kit's `inboundRequest` from the host's call alone, never from a header, the query or the body. `@lf/stripe`, `@lf/webhook`, `@lf/whatsapp` and `@lf/email` skip their signature and timestamp checks for it. A kept request holds only the headers a module names in `inbound.captureHeaders`, never a signature: `@lf/email` names `svix-id` (which tells a Resend notification from a Mailgun post), `@lf/forms` names `content-type`; the others need none (docs/contracts/adapter-protocol.md).
- 3cc4e78: Each Stripe event arrives on the `Changes` of the object it is about, pushed to the connection's door: an invoice's, a subscription's, a customer's or a charge's (`listen to pay-[:Invoices]->-[c:Changes WHERE c.Kind == "payment_failed"]-> fire f`, `function f(c: <pay-[:InvoiceChange]->>)`). Each object's events are its own change type, `InvoiceChange`, `SubscriptionChange`, `CustomerChange` or `ChargeChange`: `Kind` is Stripe's event type without the object's prefix (`payment_failed`, `deleted`), only that object's, so a kind that never arrives on an edge is refused at check; `Type` is the whole of it, and its one edge (`Invoice`, `Subscription`, `Customer` or `Charge`) the object as the event had it. It answers `awaitKeys`: a run can wait on a record's next change (`await new inv-[:Changes]->`). Each arrival carries that object, so a WHERE on the hop it is listed by (`pay-[i:Invoices WHERE i.Currency == "usd"]->`) is judged on the arrival with no read; it is named by the event id and is `about` the object, with `occurredAt` Stripe's `created`. The `Event` type, its `fires` edge, `subscribableEvents` and event types are gone. It declares how a 0.12 `listen to pay { events: [...] }` becomes it (`listenSettingsBecome`): the events choose the object, and are compared as `Kind`; a listen naming the events of two objects, or none, has no rewrite and is told to write one listen per edge. Adapter protocol 2.6.

### Patch Changes

- 8a8d036: `@lf/stripe` reads charges and says why a payment failed. A `Charge` is one attempt to take a payment, failed ones included: `Amount`, `Amount Captured` and `Amount Refunded` in major units, `Status` (`succeeded`, `pending` or `failed`), `Paid`, `Refunded`, `Created`, `Failure Code` and `Failure Message` (Stripe's reason, written for the customer), the `outcome` object as `Outcome Type`, `Outcome Reason`, `Outcome Seller Message` (Stripe's reason, written for you), `Outcome Network Status`, `Outcome Network Decline Code`, `Outcome Advice Code` and `Outcome Risk Level`, `Receipt URL`, `Billing Details Name` and `Email`, and `Metadata`. The account has `Charges` (newest first), a customer has `Charges`, and a charge leads to its `Customer` and `Invoice`. `Created` bounds in a `Charges` WHERE (`>=`, `<`, `WITHIN 7d`) reach Stripe's listing, which paginates; Stripe cannot filter charges by status, so `Status` runs over what comes back. An invoice's `Charges` are every attempt to pay it, newest first, so a failed invoice's reason is `only(inv-[c:Charges WHERE c.Status == "failed" ORDER BY c.Created DESC LIMIT 1]->)`: since API version 2025-03-31.basil an invoice names no charge and a charge no invoice, so they are joined through Stripe's invoice payments and the payment intent's charges. The `charge.captured`, `.expired`, `.failed`, `.pending`, `.refunded`, `.succeeded` and `.updated` events are typed, and an Event leads to its `Charge`; a `charge.*` event about a dispute or a refund is still answered 200 and runs nothing. A restricted key now needs Read on Charges too. Still nothing is written to Stripe.
- 12559e3: `@lf/stripe` declares a re-send window of three days (`resendWindowSeconds`), as long as Stripe retries an undelivered event: a host keeps each event's identity that long, so a retry after the arrival log forgot the event is still a repeat.
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

## 0.12.8

### Patch Changes

- 8c9e723: A new module, `@lf/stripe`: Stripe's events and a read-only graph of customers, invoices and subscriptions. Deliveries come to `/hooks/stripe/<credential>` under `listen-fire serve`, checked against the endpoint's signing secret with module-kit's shared Stripe check (an unsigned, mis-signed or stale one is 401), and named by the event id so a retry runs once. Each is one `Event` labelled with its Stripe type, so `listen to pay { events: ["invoice.payment_failed"] }` narrows by it and `listen-fire check` refuses a type Stripe never sends; the invoice, subscription and customer events are typed, and any other is answered 200 and runs nothing. An event leads to its object along `Invoice`, `Subscription` or `Customer`. The account's `Customers`, `Invoices` and `Subscriptions` are joined by edges (an invoice's `Customer` and `Subscription`; a subscription's `Customer`, `Invoices` and `Latest Invoice`; a customer's `Invoices` and `Subscriptions`); `Email` on customers and `Status` and `Collection Method` on invoices and subscriptions reach Stripe. Every amount is in major units of its `Currency`, by Stripe's zero-decimal and three-decimal lists. Reads pin API version 2025-03-31.basil. The credential is an API key (a restricted read-only key is enough) and the webhook signing secret (`listen-fire credential add --module stripe <name>`). Nothing is written to Stripe. This is the package's first release: `changeset version` takes it from 0.12.7 to 0.12.8.

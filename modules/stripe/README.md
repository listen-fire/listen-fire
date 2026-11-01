# @listen-fire/stripe

Stripe as a Listen-Fire module (`@lf/stripe`, bundled with `listen-fire`). A program listens to Stripe's events (a failed payment or charge, a new or canceled subscription, a new customer) and walks from each one to the invoice, subscription, customer or charge it is about. It reads customers, invoices, subscriptions and charges as records joined by edges. Every amount is in major units of its currency. It writes nothing to Stripe.

## Setting it up

```
listen-fire connect @lf/stripe
listen-fire credential add --module stripe stripe_account
```

The credential asks for:

- `apiKey`: the key reads go out with. The program never holds it.
  - Use a restricted key with Read on Customers, Invoices, Subscriptions and Charges (Stripe dashboard: Developers, API keys, Create restricted key). The module needs nothing more.
  - A test-mode key (`rk_test_…`) reads test-mode data.
- `webhookSecret`: the webhook endpoint's signing secret (`whsec_…`). Leave it empty if the program only reads.

`listen-fire serve` prints the connection's URL when it starts: `/hooks/stripe/<credential>`, under `publicUrl` when `lf.yaml` names one. Add it as an endpoint in Stripe's dashboard (Developers, Webhooks), choose the events the program listens for, and copy the endpoint's signing secret into the credential.

## What a movement sees

```
import { stripe, mcp, gmail, slack } from adapters
import { stripe_account, crm, billing_mail, team_slack } from credentials

pay = connect stripe using stripe_account
cr = connect mcp using crm
mail = connect gmail using billing_mail
chat = connect slack using team_slack

function `Payment Failed`(e: <pay-[:Change]->>) {
  inv = only(e-[:Invoice]->)
  if (inv == null) { fail("${e.Type} is not about an invoice") }
  c = only(cr-[x:find_customer_by_email WHERE x.email == inv.`Customer Email`]->)
  if (c == null || c.found != true) {
    fail("payment failed on ${inv.Number} but no CRM customer for ${inv.`Customer Email`}")
  }
  amount = Currency.formatFigure(inv.`Amount Due`, inv.Currency)

  if (c.plan == "monthly") {
    write mail-[:Messages]-> {
      To: [inv.`Customer Email`]
      Subject: "Your Ledgerline payment didn't go through"
      Body: "Hi ${coalesce(c.name, inv.`Customer Name`)},\n\nWe tried to take your Ledgerline payment of ${amount} and it didn't go through. It's usually an expired card or a bank check.\n\nYou can update your card and pay here: ${inv.`Hosted Invoice URL`}\n\nWe'll try again in a few days. If anything's changed, just reply to this email.\n\nThe Ledgerline team"
    }
  } else if (c.plan == "yearly") {
    accounts = only(chat-[ch:Channels WHERE ch.Name == "accounts"]->)
    if (accounts == null) { fail("no #accounts channel") }
    write accounts-[:Messages]-> {
      Message: "Annual-plan payment failed: *${coalesce(c.company, inv.`Customer Name`)}* (${c.name}, ${inv.`Customer Email`}) — ${amount}, invoice ${inv.Number}. Account manager: ${c.account_manager}. Invoice: ${inv.`Hosted Invoice URL`}"
    }
  } else {
    fail("payment failed on ${inv.Number} but ${inv.`Customer Email`} is on an unrecognised plan: ${c.plan}")
  }
}

listen to pay-[:Invoices]->-[c:Changes WHERE c.Kind == "payment_failed"]-> fire `Payment Failed`
```

- A listen fires once per Stripe event delivered to the connection's URL, on the `Changes` of the object the event is about: an invoice's, a subscription's, a customer's or a charge's.
- `Kind` is the event type without its object's prefix (`payment_failed` for `invoice.payment_failed`, `deleted` for `customer.subscription.deleted`). `listen-fire check` refuses a kind Stripe does not send, naming the ones it does. `Type` is the whole event type.
- A change's `Invoice`, `Subscription`, `Customer` or `Charge` edge is the object it is about, as it was when the event happened; the others are empty.
- The event carries its object, so walking to it reads nothing from Stripe, and a WHERE on the object's hop (`pay-[i:Invoices WHERE i.Currency == "usd"]->-[c:Changes WHERE c.Kind == "paid"]->`) is judged on the event. Walking on from it (an invoice's `Customer`) does read.
- Stripe re-sends an event it could not deliver for up to three days; the same event runs once.

The event types:

- Invoices: `invoice.created`, `.deleted`, `.finalization_failed`, `.finalized`, `.marked_uncollectible`, `.overdue`, `.overpaid`, `.paid`, `.payment_action_required`, `.payment_attempt_required`, `.payment_failed`, `.payment_succeeded`, `.sent`, `.upcoming`, `.updated`, `.voided`, `.will_be_due`.
- Subscriptions: `customer.subscription.created`, `.deleted`, `.paused`, `.pending_update_applied`, `.pending_update_expired`, `.resumed`, `.trial_will_end`, `.updated`.
- Customers: `customer.created`, `customer.updated`, `customer.deleted`.
- Charges: `charge.captured`, `.expired`, `.failed`, `.pending`, `.refunded`, `.succeeded`, `.updated`.

## Why a payment failed

```
last = only(inv-[c:Charges WHERE c.Status == "failed" ORDER BY c.Created DESC LIMIT 1]->)
reason = coalesce(last.`Failure Message`, last.`Outcome Seller Message`)
```

- An invoice names no charge in Stripe's API version `2025-03-31.basil` (and no charge an invoice), so `Charges` joins them through the invoice's payments: each payment intent that tried to pay it, and the charges of each. A charge made outside any payment intent is read too; a payment record is not.
- Each attempt is its own charge. The failed ones carry `Failure Code` and `Failure Message` (Stripe's reason, written for the customer) and `Outcome Seller Message` (written for you), with `Outcome Network Decline Code` and `Outcome Advice Code` when the card network declined.
- A walk costs a few requests: the invoice's payments, then one listing of charges per payment intent.
- The payment intent's `last_payment_error` is not read: an event carries the invoice as it was, without the intent, so a field for it would be empty on exactly the invoices a failed-payment program starts from.

## Money

- Every amount (`Amount Due`, `Amount Paid`, `Amount Remaining`, `Subtotal`, `Total`, a charge's `Amount`, `Amount Captured` and `Amount Refunded`, a customer's `Balance`) is in major units of the record's `Currency`.
- An invoice of 1999 cents reads 19.99; one of ¥500 reads 500; one of 5.120 KWD reads 5.12. Never divide by 100.
- The divisor is Stripe's: its zero-decimal currencies as they are, its three-decimal ones by 1000, every other by 100. ISK and UGX are divided by 100, because Stripe sends them as two-decimal values.
- `Currency` is Stripe's lowercase ISO code (`usd`). ``Currency.formatFigure(inv.`Amount Due`, inv.Currency)`` writes the amount with its symbol.

## The graph

| From | Edge | To | Notes |
|---|---|---|---|
| the account | `Customers` | Customer | newest first; `Email ==` reaches Stripe (its match is case-sensitive) |
| the account | `Invoices` | Invoice | newest first; `Status ==` and `Collection Method ==` reach Stripe |
| the account | `Subscriptions` | Subscription | every status, canceled included; `Status ==` and `Collection Method ==` reach Stripe |
| the account | `Charges` | Charge | newest first, failed attempts included; `Created` bounds (`>=`, `<`, `WITHIN 7d`) reach Stripe; `Status` does not |
| Customer, Invoice, Subscription, Charge | `Changes` | Change | listened to, not listed: the events Stripe delivers about it |
| Change | `Invoice`, `Subscription`, `Customer`, `Charge` | the object | the one the event is about; nothing along the others |
| Invoice | `Customer` | Customer | |
| Invoice | `Subscription` | Subscription | nothing for a one-off invoice |
| Subscription | `Customer` | Customer | |
| Subscription | `Invoices`, `Latest Invoice` | Invoice | |
| Customer | `Invoices` | Invoice | |
| Customer | `Subscriptions` | Subscription | every status, canceled included |
| Customer | `Charges` | Charge | newest first; the customer reaches Stripe |
| Invoice | `Charges` | Charge | every attempt to pay it, newest first |
| Charge | `Customer` | Customer | nothing for a charge made without one |
| Charge | `Invoice` | Invoice | nothing for a charge that paid no invoice |

- Field names are Stripe's: on a charge `Amount Refunded`, `Failure Code`, `Failure Message`, `Receipt URL`, `Billing Details Name` and the `outcome` object's `Outcome Type`, `Outcome Reason`, `Outcome Seller Message`; on the rest `Amount Due`, `Customer Email`, `Customer Name`, `Hosted Invoice URL`, `Invoice PDF`, `Status`, `Billing Reason`, `Attempt Count`, `Next Payment Attempt`, `Period End`, `Cancel At Period End`, `Trial End`, `Metadata`.
- Timestamps are dates, not Stripe's unix seconds.
- Other filters run over what Stripe answers, so pin `Status` on a busy account and bound a charge walk with `Created`.
- Reads pin Stripe API version `2025-03-31.basil`. An event is shaped by its endpoint's version; an invoice's subscription is read where either puts it.

## What Stripe gets back

| Delivery | Answer |
|---|---|
| signed by the endpoint's secret, of a type above | 202, its runs (none when no listen selects its type) |
| the same event again (a retry) | 2xx `duplicate: true`, nothing runs |
| unsigned, mis-signed, or older than five minutes | 401, nothing runs |
| to a connection whose credential has no `webhookSecret` | 401, nothing runs; `listen-fire serve` says what to set |
| of a type this module does not type (`charge.dispute.*`, `payout.*`, …) | 2xx, nothing runs |
| not a Stripe event | 400 `not_a_stripe_event` |

## Not in v1

- Writes: refunds, voiding or finalizing an invoice, canceling a subscription, updating a customer.
- Registering the webhook endpoint for you. Today it is added in Stripe's dashboard.
- Stripe Connect: events and reads on connected accounts (the event's `account`, the `Stripe-Account` header).
- More objects and events: payment intents, refunds, disputes (`charge.dispute.*`, `charge.refund.updated`), prices and products, a subscription's items, and a customer's discount, source and tax id events.
- Stripe's thin events (API v2 event destinations), which carry no object.

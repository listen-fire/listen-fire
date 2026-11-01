// Stripe's manifest: what the host's catalog, editor, handbook and checker
// read about the adapter, construction-free. Data only, so a host can list
// Stripe without loading the adapter.

import type { AdapterManifest } from 'movement-engine/public/adapter';

import { STRIPE_ADAPTER_TYPE, STRIPE_CHANGES_EDGE_NAME, STRIPE_CHANGED_OBJECTS, STRIPE_EVENT_TYPES, STRIPE_INVOICE_OBJECT, kindOf, type StripeChangedObject } from './types';

const STRIPE_HANDBOOK_CONTENT = `Stripe as a graph: its events, your customers, invoices, subscriptions and charges. Read-only. The credential holds an API key (a restricted key with Read on Customers, Invoices, Subscriptions and Charges is enough) and the webhook endpoint's signing secret; a program never holds either.

### listening — Stripe's events

\`\`\`
function \`Payment Failed\`(c: <pay-[:Change]->>) {
  invoice = only(c-[:Invoice]->)
  owed = Currency.formatFigure(invoice.\`Amount Due\`, invoice.Currency)
  …
}

listen to pay-[:Invoices]->-[c:Changes WHERE c.Kind == "payment_failed"]-> fire \`Payment Failed\`
\`\`\`

\`listen-fire serve\` prints the connection's URL (\`/hooks/stripe/<credential>\`): add it as the endpoint in Stripe's dashboard, with the events you listen for. A delivery is checked against the endpoint's signing secret; an unsigned, mis-signed or stale one (older than five minutes) runs nothing. Stripe retries a delivery and re-sends an event for up to three days; the same event runs once.

Each event arrives on the \`Changes\` of the object it is about: an invoice's (\`Kind\` \`payment_failed\`, \`paid\`, \`upcoming\`, …), a subscription's (\`created\`, \`updated\`, \`deleted\`, \`trial_will_end\`, …), a customer's (\`created\`, \`updated\`, \`deleted\`) or a charge's (\`succeeded\`, \`failed\`, \`refunded\`, …). \`Kind\` is Stripe's event type without the object's prefix; \`Type\` is the whole of it. A WHERE on the object's hop is judged on the object as the event had it (\`pay-[i:Invoices WHERE i.Currency == "usd"]->-[c:Changes WHERE c.Kind == "paid"]->\`). Walk \`Invoice\`, \`Subscription\`, \`Customer\` or \`Charge\` from a change for its object, as it was when the event happened.

### reading — customers, invoices, subscriptions, charges

\`\`\`
c = only(pay-[x:Customers WHERE x.Email == "ada@example.com"]->)
unpaid = c-[i:Invoices WHERE i.Status == "open"]->
week = pay-[ch:Charges WHERE ch.Created WITHIN 7d AND ch.Status == "succeeded"]->
\`\`\`

\`Email ==\` on \`Customers\` and \`Status ==\` on \`Invoices\` and \`Subscriptions\` reach Stripe; other filters run over what comes back. \`Subscriptions\` holds canceled ones too: pin \`Status\`. An invoice leads to its \`Customer\`, \`Subscription\` and \`Charges\`, a subscription to its \`Customer\`, \`Invoices\` and \`Latest Invoice\`, a customer to its \`Invoices\`, \`Subscriptions\` and \`Charges\`, a charge to its \`Customer\` and \`Invoice\`.

A \`Charge\` is one attempt to take a payment, failed ones included (\`Status\` is \`succeeded\`, \`pending\` or \`failed\`). \`Created\` bounds (\`>=\`, \`<\`, \`WITHIN 7d\`) reach Stripe; \`Status\` and \`Currency\` do not, so bound \`Created\` on a busy account. Why a payment failed: an invoice's \`Charges\` come newest first, and the failed one carries \`Failure Message\` (for the customer), \`Failure Code\` and \`Outcome Seller Message\` (for you):

\`\`\`
last = only(inv-[ch:Charges WHERE ch.Status == "failed" ORDER BY ch.Created DESC LIMIT 1]->)
reason = coalesce(last.\`Failure Message\`, last.\`Outcome Seller Message\`)
\`\`\`

Field names are Stripe's: \`Amount Due\`, \`Customer Email\`, \`Hosted Invoice URL\`, \`Status\`, \`Billing Reason\`, \`Next Payment Attempt\`, \`Metadata\`; on a charge \`Amount Refunded\`, \`Failure Code\`, \`Receipt URL\`, \`Billing Details Name\`, and the \`outcome\` object's \`Outcome Type\`, \`Outcome Reason\`, \`Outcome Seller Message\`.

### money

Every amount (\`Amount Due\`, \`Total\`, a charge's \`Amount\`, a customer's \`Balance\`) is in major units of the record's \`Currency\`: 19.99 for a usd invoice of 1999 cents, 500 for ¥500. Never divide by 100. \`Currency\` is Stripe's lowercase ISO code, which \`Currency.formatFigure\` reads.`;

/** What a 0.12 listen naming `object`'s events becomes: a listen on that
 *  object's `Changes`, its events compared as `Kind`. */
function changesOf(object: StripeChangedObject) {
  return {
    path: [object.collection, STRIPE_CHANGES_EDGE_NAME],
    aliases: [object.kind.charAt(0), 'c'],
    // The 0.12 event position a fired parameter was typed as.
    paramFrom: 'Event',
    keys: {
      events: { hop: 1, field: 'Kind', op: 'in' as const, values: Object.fromEntries(object.events.map((type) => [type, kindOf(type)])) },
    },
  };
}

const INVOICE_CHANGES = changesOf(STRIPE_INVOICE_OBJECT);

/**
 * Static manifest. A webhook source (Stripe's deliveries, checked at the door
 * against the endpoint's signing secret) and a read-only graph. Nothing is
 * SUBSCRIBED to: Stripe's endpoint is set in its dashboard, and each event it
 * delivers arrives on the `Changes` of the object it is about.
 */
export const STRIPE_MANIFEST: AdapterManifest = {
  adapterType: STRIPE_ADAPTER_TYPE,
  displayName: 'Stripe',
  website: 'https://stripe.com',
  description:
    'Stripe customers, invoices, subscriptions and charges. Run a movement on a failed payment, a new ' +
    'subscription or a cancellation, and read customers, invoices, subscriptions and charges. Read-only.',
  authoringHints:
    'Listen on a record’s Changes, narrowed by Kind (Stripe’s event type without its object’s prefix): ' +
    'pay-[:Invoices]->-[c:Changes WHERE c.Kind == "payment_failed"]->, pay-[:Charges]->-[c:Changes WHERE ' +
    'c.Kind == "failed"]->, pay-[:Subscriptions]->-[c:Changes WHERE c.Kind == "deleted"]->. Walk the change’s ' +
    'Invoice, Subscription, Customer or Charge edge for its object — no data.object to dig into. Why a payment failed: an invoice’s Charges (newest first) ' +
    'carry Failure Message, Failure Code and Outcome Seller Message. Sales over a period: the account’s ' +
    'Charges bounded by Created (WITHIN 7d), then Status == "succeeded". Amounts are already in major ' +
    'units of Currency: never divide by 100. Nothing is writable.',
  handbookSection: {
    title: 'Stripe — events, customers, invoices, subscriptions and charges',
    content: STRIPE_HANDBOOK_CONTENT,
  },
  triggerExpectation:
    'Fires once per Stripe event delivered to the connection’s URL and signed by the endpoint’s ' +
    'secret, on the Changes of the object it is about, its Kind the event type without the ' +
    'object’s prefix. Stripe sends only the events its endpoint is subscribed to; a retry or ' +
    're-send of the same event within three days runs nothing. An event of a type this module ' +
    'does not type is answered 200 and runs nothing.',
  supportedTriggers: ['webhook'],
  // Stripe re-sends an undelivered event for up to three days: a default,
  // lf.yaml's `resendWindow` overrides it.
  resendWindowSeconds: 259_200,
  methods: ['listEntryPoints', 'describe', 'edgesFrom', 'getFieldValue', 'getRelated', 'checkInbound'],
  requiredCredentialType: 'STRIPE',
  // Every 0.12 listen names its events and is rewritten by them (`byEvent`).
  // One naming none heard every event, on every object's `Changes`, so it
  // has no one rewrite (`absent`).
  listenSettingsBecome: {
    ...INVOICE_CHANGES,
    keys: { events: { ...INVOICE_CHANGES.keys.events, values: Object.fromEntries(STRIPE_EVENT_TYPES.map((type) => [type, kindOf(type)])), absent: [...STRIPE_EVENT_TYPES] } },
    byEvent: Object.fromEntries(STRIPE_CHANGED_OBJECTS.flatMap((object) => object.events.map((type) => [type, changesOf(object)]))),
  },
  triggerKinds: ['STRIPE'],
  vocabulary: {
    // Stripe's mark (the S), one filled path.
    icon: {
      d: 'M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0 9.667 0 7.589.654 6.104 1.872 4.56 3.147 3.757 4.992 3.757 7.218c0 4.039 2.467 5.76 6.476 7.219 2.585.92 3.445 1.574 3.445 2.583 0 .98-.84 1.545-2.354 1.545-1.875 0-4.965-.921-6.99-2.109l-.9 5.555C5.175 22.99 8.385 24 11.714 24c2.641 0 4.843-.624 6.328-1.813 1.664-1.305 2.525-3.236 2.525-5.732 0-4.128-2.524-5.851-6.594-7.305h.003z',
      fill: true,
      viewBox: '0 0 24 24',
    },
    eventPhrase: {
      default: [{ template: 'When something changes in Stripe' }],
    },
  },
};

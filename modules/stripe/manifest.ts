// Stripe's manifest: what the host's catalog, editor, handbook and checker
// read about the adapter, construction-free. Data only, so a host can list
// Stripe without loading the adapter.

import type { AdapterManifest } from 'movement-engine/public/adapter';

import { STRIPE_ADAPTER_TYPE, STRIPE_EVENT_TYPES } from './types';

const STRIPE_HANDBOOK_CONTENT = `Stripe as a graph: its events, your customers, invoices and subscriptions. Read-only. The credential holds an API key (a restricted key with Read on Customers, Invoices and Subscriptions is enough) and the webhook endpoint's signing secret; a program never holds either.

### listening — Stripe's events

\`\`\`
function \`Payment Failed\`(e: <pay-[:Event]->>) {
  invoice = only(e-[:Invoice]->)
  if (invoice == null) { fail("not an invoice event") }
  owed = Currency.formatFigure(invoice.\`Amount Due\`, invoice.Currency)
  …
}

listen to pay { events: ["invoice.payment_failed"] } fire \`Payment Failed\`
\`\`\`

\`lf serve\` prints the connection's URL (\`/hooks/stripe/<credential>\`): add it as the endpoint in Stripe's dashboard, with the events you listen for. A delivery is checked against the endpoint's signing secret; an unsigned, mis-signed or stale one (older than five minutes) runs nothing. Stripe retries a delivery, and the same event runs once.

\`events\` selects Stripe's event types: the invoice events (\`invoice.payment_failed\`, \`invoice.paid\`, \`invoice.upcoming\`, …), the subscription events (\`customer.subscription.created\`, \`.updated\`, \`.deleted\`, \`.trial_will_end\`, …) and \`customer.created\`, \`.updated\`, \`.deleted\`. \`lf check\` refuses a type Stripe never sends. An event's \`Type\` says which it is. Walk \`Invoice\`, \`Subscription\` or \`Customer\` for the object it is about, as it was when the event happened (nothing along the other two).

### reading — customers, invoices, subscriptions

\`\`\`
c = only(pay-[x:Customers WHERE x.Email == "ada@example.com"]->)
unpaid = c-[i:Invoices WHERE i.Status == "open"]->
\`\`\`

\`Email ==\` on \`Customers\` and \`Status ==\` on \`Invoices\` and \`Subscriptions\` reach Stripe; other filters run over what comes back. \`Subscriptions\` holds canceled ones too: pin \`Status\`. An invoice leads to its \`Customer\` and \`Subscription\`, a subscription to its \`Customer\`, \`Invoices\` and \`Latest Invoice\`, a customer to its \`Invoices\` and \`Subscriptions\`.

Field names are Stripe's: \`Amount Due\`, \`Customer Email\`, \`Hosted Invoice URL\`, \`Status\`, \`Billing Reason\`, \`Next Payment Attempt\`, \`Metadata\`.

### money

Every amount (\`Amount Due\`, \`Total\`, a customer's \`Balance\`) is in major units of the record's \`Currency\`: 19.99 for a usd invoice of 1999 cents, 500 for ¥500. Never divide by 100. \`Currency\` is Stripe's lowercase ISO code, which \`Currency.formatFigure\` reads.`;

/**
 * Static manifest. A webhook source (Stripe's deliveries, checked at the door
 * against the endpoint's signing secret) and a read-only graph. Nothing is
 * SUBSCRIBED to: `subscribableEvents` is Stripe's event types this module
 * types, which the door labels each event with, so a listen's `events`
 * narrows by type and `lf check` refuses one Stripe never sends.
 */
export const STRIPE_MANIFEST: AdapterManifest = {
  adapterType: STRIPE_ADAPTER_TYPE,
  displayName: 'Stripe',
  website: 'https://stripe.com',
  description:
    'Stripe customers, invoices and subscriptions. Run a movement on a failed payment, a new ' +
    'subscription or a cancellation, and read customers, invoices and subscriptions. Read-only.',
  authoringHints:
    'Listen on Event with events naming Stripe event types (invoice.payment_failed, ' +
    'customer.subscription.deleted, …). Walk the event’s Invoice, Subscription or Customer edge ' +
    'for its object — no data.object to dig into. Amounts are already in major units of ' +
    'Currency: never divide by 100. Nothing is writable.',
  handbookSection: {
    title: 'Stripe — events, customers, invoices and subscriptions',
    content: STRIPE_HANDBOOK_CONTENT,
  },
  triggerExpectation:
    'Fires once per Stripe event delivered to the connection’s URL and signed by the endpoint’s ' +
    'secret, labelled with its type, so `events` narrows by type. Stripe sends only the events ' +
    'its endpoint is subscribed to; a retry of the same event runs nothing. An event of a type ' +
    'this module does not type is answered 200 and runs nothing.',
  supportedTriggers: ['webhook'],
  methods: ['listEntryPoints', 'describe', 'edgesFrom', 'getFieldValue', 'getRelated', 'listEventTypes', 'checkInbound'],
  requiredCredentialType: 'STRIPE',
  subscribableEvents: [...STRIPE_EVENT_TYPES],
  triggerKinds: ['STRIPE'],
  vocabulary: {
    // Stripe's mark (the S), one filled path.
    icon: {
      d: 'M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0 9.667 0 7.589.654 6.104 1.872 4.56 3.147 3.757 4.992 3.757 7.218c0 4.039 2.467 5.76 6.476 7.219 2.585.92 3.445 1.574 3.445 2.583 0 .98-.84 1.545-2.354 1.545-1.875 0-4.965-.921-6.99-2.109l-.9 5.555C5.175 22.99 8.385 24 11.714 24c2.641 0 4.843-.624 6.328-1.813 1.664-1.305 2.525-3.236 2.525-5.732 0-4.128-2.524-5.851-6.594-7.305h.003z',
      fill: true,
      viewBox: '0 0 24 24',
    },
    eventPhrase: {
      'invoice.payment_failed': [{ template: 'When a Stripe payment fails' }],
      'invoice.paid': [{ template: 'When a Stripe invoice is paid' }],
      'customer.subscription.created': [{ template: 'When a Stripe subscription starts' }],
      'customer.subscription.deleted': [{ template: 'When a Stripe subscription is canceled' }],
      default: [{ template: 'When a Stripe event arrives' }],
    },
  },
};

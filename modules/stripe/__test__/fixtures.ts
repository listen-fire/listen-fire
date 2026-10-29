// Stripe's objects and events as Stripe's API reference shows them (the
// examples on "The Customer object", "The Invoice object", "The Subscription
// object" and "The Event object", API version 2025-03-31.basil), with the
// keys this module reads and enough of the rest to be the real shape. Each
// builder takes overrides, so a test states only what it is about.

export type Json = Record<string, unknown>;

export function stripeCustomer(overrides: Json = {}): Json {
  return {
    id: 'cus_NffrFeUfNV2Hib',
    object: 'customer',
    address: null,
    balance: 0,
    created: 1680893993,
    currency: 'usd',
    default_source: null,
    delinquent: false,
    description: null,
    email: 'jennyrosen@example.com',
    invoice_prefix: '0759376C',
    invoice_settings: { custom_fields: null, default_payment_method: null, footer: null, rendering_options: null },
    livemode: false,
    metadata: {},
    name: 'Jenny Rosen',
    next_invoice_sequence: 1,
    phone: null,
    preferred_locales: [],
    shipping: null,
    tax_exempt: 'none',
    test_clock: null,
    ...overrides,
  };
}

export function stripeInvoice(overrides: Json = {}): Json {
  return {
    id: 'in_1MtHbELkdIwHu7ixl4OzzPMv',
    object: 'invoice',
    account_country: 'US',
    account_name: 'Stripe Docs',
    amount_due: 4900,
    amount_paid: 0,
    amount_overpaid: 0,
    amount_remaining: 4900,
    amount_shipping: 0,
    attempt_count: 1,
    attempted: true,
    auto_advance: true,
    billing_reason: 'subscription_cycle',
    collection_method: 'charge_automatically',
    created: 1680644467,
    currency: 'usd',
    customer: 'cus_NffrFeUfNV2Hib',
    customer_address: null,
    customer_email: 'jennyrosen@example.com',
    customer_name: 'Jenny Rosen',
    customer_phone: null,
    description: null,
    discounts: [],
    due_date: null,
    hosted_invoice_url: 'https://invoice.stripe.com/i/acct_1M2JTkLkdIwHu7ix/test_YWNjdF8xTTJKVGtMa2RJd0h1N2l4',
    invoice_pdf: 'https://pay.stripe.com/invoice/acct_1M2JTkLkdIwHu7ix/test_YWNjdF8xTTJKVGtMa2RJd0h1N2l4/pdf',
    lines: { object: 'list', data: [], has_more: false, total_count: 0, url: '/v1/invoices/in_1MtHbELkdIwHu7ixl4OzzPMv/lines' },
    livemode: false,
    metadata: {},
    next_payment_attempt: 1680903667,
    number: 'D2A1F3B4-0001',
    parent: {
      quote_details: null,
      subscription_details: { metadata: { crm_id: 'C-10486' }, subscription: 'sub_1MowQVLkdIwHu7ixeRlqHVzs' },
      type: 'subscription_details',
    },
    period_end: 1680644467,
    period_start: 1678226467,
    starting_balance: 0,
    statement_descriptor: null,
    status: 'open',
    status_transitions: { finalized_at: 1680644468, marked_uncollectible_at: null, paid_at: null, voided_at: null },
    subtotal: 4900,
    subtotal_excluding_tax: 4900,
    test_clock: null,
    total: 4900,
    total_excluding_tax: 4900,
    webhooks_delivered_at: 1680644467,
    ...overrides,
  };
}

export function stripeSubscription(overrides: Json = {}): Json {
  return {
    id: 'sub_1MowQVLkdIwHu7ixeRlqHVzs',
    object: 'subscription',
    application: null,
    billing_cycle_anchor: 1679609767,
    cancel_at: null,
    cancel_at_period_end: false,
    canceled_at: null,
    cancellation_details: { comment: null, feedback: null, reason: null },
    collection_method: 'charge_automatically',
    created: 1679609767,
    currency: 'usd',
    customer: 'cus_NffrFeUfNV2Hib',
    days_until_due: null,
    default_payment_method: null,
    description: null,
    ended_at: null,
    items: {
      object: 'list',
      data: [
        {
          id: 'si_Na6dzxczY5fwHx',
          object: 'subscription_item',
          current_period_end: 1682288167,
          current_period_start: 1679609767,
          price: { id: 'price_1MowQULkdIwHu7ixraBm864M', object: 'price', currency: 'usd', recurring: { interval: 'month', interval_count: 1 }, unit_amount: 4900 },
          quantity: 1,
        },
      ],
      has_more: false,
      url: '/v1/subscription_items?subscription=sub_1MowQVLkdIwHu7ixeRlqHVzs',
    },
    latest_invoice: 'in_1MtHbELkdIwHu7ixl4OzzPMv',
    livemode: false,
    metadata: { crm_id: 'C-10486' },
    start_date: 1679609767,
    status: 'past_due',
    trial_end: null,
    trial_start: null,
    ...overrides,
  };
}

/** An event about `object`, as Stripe delivers it to a webhook endpoint. */
export function stripeEvent(type: string, object: Json, overrides: Json = {}): Json {
  return {
    id: 'evt_1NG8Du2eZvKYlo2CUI79vXWy',
    object: 'event',
    api_version: '2025-03-31.basil',
    created: 1686089970,
    data: { object },
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type,
    ...overrides,
  };
}

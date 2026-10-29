// Stripe adapter — the names and ids the rest of the package shares, the
// vocabularies Stripe documents, and the flat payloads positions carry.
//
// The ONE rule (module-kit adapter/base.ts): a position's `recordType` is the
// pretty DISPLAY NAME; the `stripe:*` typeIds below are this adapter's private
// currency and never ride a position.

export const STRIPE_ADAPTER_TYPE = 'stripe';

/** The account meta node a movement obtains by constructing the adapter. */
export const STRIPE_ACCOUNT_TYPE_ID = 'stripe:account';
export const STRIPE_ACCOUNT_DISPLAY_NAME = 'Stripe';

export const STRIPE_EVENT_TYPE_ID = 'stripe:event';
export const STRIPE_EVENT_DISPLAY_NAME = 'Event';

export const STRIPE_CUSTOMER_TYPE_ID = 'stripe:customer';
export const STRIPE_CUSTOMER_DISPLAY_NAME = 'Customer';

export const STRIPE_INVOICE_TYPE_ID = 'stripe:invoice';
export const STRIPE_INVOICE_DISPLAY_NAME = 'Invoice';

export const STRIPE_SUBSCRIPTION_TYPE_ID = 'stripe:subscription';
export const STRIPE_SUBSCRIPTION_DISPLAY_NAME = 'Subscription';

// ── Root collections (Title Case, plural, distinct from the type each yields)

export const STRIPE_CUSTOMERS_COLLECTION = 'Customers';
export const STRIPE_INVOICES_COLLECTION = 'Invoices';
export const STRIPE_SUBSCRIPTIONS_COLLECTION = 'Subscriptions';

// ── Edges below the root: read id (private) ↔ natural name (what authors write)

/** One record: an event's object, an invoice's customer or subscription, a
 *  subscription's customer. The same name leaves several types. */
export const STRIPE_CUSTOMER_EDGE = 'customer_edge';
export const STRIPE_CUSTOMER_EDGE_NAME = 'Customer';
export const STRIPE_INVOICE_EDGE = 'invoice_edge';
export const STRIPE_INVOICE_EDGE_NAME = 'Invoice';
export const STRIPE_SUBSCRIPTION_EDGE = 'subscription_edge';
export const STRIPE_SUBSCRIPTION_EDGE_NAME = 'Subscription';
export const STRIPE_LATEST_INVOICE_EDGE = 'latest_invoice_edge';
export const STRIPE_LATEST_INVOICE_EDGE_NAME = 'Latest Invoice';
/** Many records: a customer's or a subscription's invoices, a customer's
 *  subscriptions. */
export const STRIPE_INVOICES_EDGE = 'invoices_edge';
export const STRIPE_INVOICES_EDGE_NAME = 'Invoices';
export const STRIPE_SUBSCRIPTIONS_EDGE = 'subscriptions_edge';
export const STRIPE_SUBSCRIPTIONS_EDGE_NAME = 'Subscriptions';

// ── Vocabularies (Stripe's API reference, "Types of events" and each object) ─

/** The invoice events: `data.object` is an Invoice. */
export const STRIPE_INVOICE_EVENTS = [
  'invoice.created',
  'invoice.deleted',
  'invoice.finalization_failed',
  'invoice.finalized',
  'invoice.marked_uncollectible',
  'invoice.overdue',
  'invoice.overpaid',
  'invoice.paid',
  'invoice.payment_action_required',
  'invoice.payment_attempt_required',
  'invoice.payment_failed',
  'invoice.payment_succeeded',
  'invoice.sent',
  'invoice.upcoming',
  'invoice.updated',
  'invoice.voided',
  'invoice.will_be_due',
] as const;

/** The subscription events: `data.object` is a Subscription. */
export const STRIPE_SUBSCRIPTION_EVENTS = [
  'customer.subscription.created',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.pending_update_applied',
  'customer.subscription.pending_update_expired',
  'customer.subscription.resumed',
  'customer.subscription.trial_will_end',
  'customer.subscription.updated',
] as const;

/** The customer events: `data.object` is a Customer. (A customer's discount,
 *  source and tax id events are about other objects, not typed here.) */
export const STRIPE_CUSTOMER_EVENTS = ['customer.created', 'customer.deleted', 'customer.updated'] as const;

/** Every event a listen can select (`events: [...]`), and the closed set an
 *  Event's `Type` is. */
export const STRIPE_EVENT_TYPES = [...STRIPE_CUSTOMER_EVENTS, ...STRIPE_SUBSCRIPTION_EVENTS, ...STRIPE_INVOICE_EVENTS] as const;
export type StripeEventType = (typeof STRIPE_EVENT_TYPES)[number];

export function isStripeEventType(value: unknown): value is StripeEventType {
  return typeof value === 'string' && (STRIPE_EVENT_TYPES as readonly string[]).includes(value);
}

/** An invoice's `status`. */
export const STRIPE_INVOICE_STATUSES = ['draft', 'open', 'paid', 'uncollectible', 'void'] as const;

/** A subscription's `status`. */
export const STRIPE_SUBSCRIPTION_STATUSES = ['incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused'] as const;

/** An invoice's or a subscription's `collection_method`. */
export const STRIPE_COLLECTION_METHODS = ['charge_automatically', 'send_invoice'] as const;

/** Why an invoice was made (`billing_reason`). */
export const STRIPE_BILLING_REASONS = [
  'automatic_pending_invoice_item_invoice',
  'manual',
  'quote_accept',
  'subscription',
  'subscription_create',
  'subscription_cycle',
  'subscription_threshold',
  'subscription_update',
  'upcoming',
] as const;

/** The discriminator every event the door accepts carries. */
export const STRIPE_EVENT_TAG = 'stripe:event';

// ── Payloads: the flat field bags positions carry, keyed by field id ─────────
// Field ids are Stripe's own names. Amounts are in MAJOR units of `currency`
// (money.ts); timestamps are ISO 8601. The ids of related records (`customer`,
// `subscription`, `latest_invoice`) ride along for the edges and are not
// fields: a program walks the edge instead.

export interface StripeCustomerPayload {
  id: string;
  email: string | null;
  name: string | null;
  description: string | null;
  phone: string | null;
  currency: string | null;
  balance: number | null;
  delinquent: boolean | null;
  created: string | null;
  livemode: boolean;
  metadata: Record<string, string>;
  /** Set on the object a `customer.deleted` event carries. */
  deleted: boolean;
}

export interface StripeInvoicePayload {
  id: string;
  number: string | null;
  status: string | null;
  currency: string;
  amount_due: number | null;
  amount_paid: number | null;
  amount_remaining: number | null;
  subtotal: number | null;
  total: number | null;
  customer_email: string | null;
  customer_name: string | null;
  hosted_invoice_url: string | null;
  invoice_pdf: string | null;
  billing_reason: string | null;
  collection_method: string | null;
  attempt_count: number | null;
  attempted: boolean | null;
  next_payment_attempt: string | null;
  due_date: string | null;
  period_start: string | null;
  period_end: string | null;
  created: string | null;
  description: string | null;
  livemode: boolean;
  metadata: Record<string, string>;
  /** The customer's id, followed by `Customer`. */
  customer: string | null;
  /** The subscription's id, followed by `Subscription`. */
  subscription: string | null;
}

export interface StripeSubscriptionPayload {
  id: string;
  status: string;
  currency: string | null;
  collection_method: string | null;
  cancel_at_period_end: boolean | null;
  cancel_at: string | null;
  canceled_at: string | null;
  ended_at: string | null;
  start_date: string | null;
  trial_start: string | null;
  trial_end: string | null;
  created: string | null;
  description: string | null;
  days_until_due: number | null;
  livemode: boolean;
  metadata: Record<string, string>;
  /** The customer's id, followed by `Customer`. */
  customer: string | null;
  /** The latest invoice's id, followed by `Latest Invoice`. */
  latest_invoice: string | null;
}

/** What a delivered event carries: its own fields, and the object it is
 *  about as Stripe sent it (a snapshot at the event's time), read by the
 *  `Invoice`, `Subscription` and `Customer` edges. */
export interface StripeEventPayload {
  id: string;
  type: StripeEventType;
  created: string | null;
  livemode: boolean;
  api_version: string | null;
  previous_attributes: Record<string, unknown> | null;
  object: Record<string, unknown>;
}

// The Stripe type graph: the entry surface and every type descriptor.
//
// The shape follows Stripe's own nouns. An account reaches its customers,
// invoices and subscriptions; a customer holds its invoices and
// subscriptions; an invoice and a subscription lead to their customer, and an
// invoice to the subscription that made it. An event is ABOUT one object,
// reached along `Invoice`, `Subscription` or `Customer` rather than through
// an untyped `data.object`. Field names are Stripe's (`amount_due` reads as
// `Amount Due`, `hosted_invoice_url` as `Hosted Invoice URL`), so a program
// written against Stripe's API reference reads as it expects and `listen-fire check`
// refuses a field Stripe does not have.
//
// Money: every amount is in MAJOR units of the record's `Currency` (19.99 for
// `amount_due: 1999` in usd, 500 for 500 jpy), never Stripe's minor units.
//
// Everything here is STATIC — no credential, no network — so `describe` is
// free and the walk hydrates every target rather than stubbing.

import type { SchemaEntryPoint, SchemaFieldDescriptor, SchemaReferenceDescriptor, SchemaTypeDescriptor } from 'movement-engine/public/catalog';

import { META_RECORD_TYPE } from 'movement-engine/public/catalog';
import {
  STRIPE_ACCOUNT_DISPLAY_NAME,
  STRIPE_ACCOUNT_TYPE_ID,
  STRIPE_BILLING_REASONS,
  STRIPE_COLLECTION_METHODS,
  STRIPE_CUSTOMERS_COLLECTION,
  STRIPE_CUSTOMER_DISPLAY_NAME,
  STRIPE_CUSTOMER_EDGE,
  STRIPE_CUSTOMER_EDGE_NAME,
  STRIPE_CUSTOMER_TYPE_ID,
  STRIPE_EVENT_DISPLAY_NAME,
  STRIPE_EVENT_TYPES,
  STRIPE_EVENT_TYPE_ID,
  STRIPE_INVOICES_COLLECTION,
  STRIPE_INVOICES_EDGE,
  STRIPE_INVOICES_EDGE_NAME,
  STRIPE_INVOICE_DISPLAY_NAME,
  STRIPE_INVOICE_EDGE,
  STRIPE_INVOICE_EDGE_NAME,
  STRIPE_INVOICE_STATUSES,
  STRIPE_INVOICE_TYPE_ID,
  STRIPE_LATEST_INVOICE_EDGE,
  STRIPE_LATEST_INVOICE_EDGE_NAME,
  STRIPE_SUBSCRIPTIONS_COLLECTION,
  STRIPE_SUBSCRIPTIONS_EDGE,
  STRIPE_SUBSCRIPTIONS_EDGE_NAME,
  STRIPE_SUBSCRIPTION_DISPLAY_NAME,
  STRIPE_SUBSCRIPTION_EDGE,
  STRIPE_SUBSCRIPTION_EDGE_NAME,
  STRIPE_SUBSCRIPTION_STATUSES,
  STRIPE_SUBSCRIPTION_TYPE_ID,
} from './types';

/** A read-only field; `extra` carries what differs. */
function field(
  fieldId: string,
  displayName: string,
  kind: SchemaFieldDescriptor['kind'],
  extra: Partial<SchemaFieldDescriptor> = {},
): SchemaFieldDescriptor {
  return { fieldId, displayName, kind, writable: false, required: false, ...extra };
}

/** An amount, in major units of the record's `Currency`. */
function money(fieldId: string, displayName: string, what: string, extra: Partial<SchemaFieldDescriptor> = {}): SchemaFieldDescriptor {
  return field(fieldId, displayName, 'number', {
    description: `${what}, in major units of \`Currency\` (Stripe's \`${fieldId}\` is in minor units; this is already divided: 19.99 usd, 500 jpy).`,
    ...extra,
  });
}

const EQ = { filterOperators: ['eq' as const] };
/** Never null in Stripe's object. */
const REQUIRED = { required: true };

/** A listing Stripe filters by query parameters and answers newest first. */
const NEWEST_FIRST = {
  filter: 'native',
  order: 'bounded',
  supportsLimit: true,
  naturalOrder: { field: 'Created', direction: 'desc' },
} as const;

const CUSTOMERS_DESCRIPTION =
  'Your customers, newest first. `Email ==` reaches Stripe (its match is case-sensitive); ' +
  'other filters run over what comes back.';
const INVOICES_DESCRIPTION =
  'Invoices, newest first. `Status ==` and `Collection Method ==` reach Stripe; other filters run over what comes back.';
const SUBSCRIPTIONS_DESCRIPTION =
  'Subscriptions of every status (canceled included), newest first. `Status ==` and ' +
  '`Collection Method ==` reach Stripe; other filters run over what comes back.';

export function stripeEntryPoints(): SchemaEntryPoint[] {
  return [
    { typeId: STRIPE_CUSTOMER_TYPE_ID, displayName: STRIPE_CUSTOMER_DISPLAY_NAME, writable: false, readable: true, collectionName: STRIPE_CUSTOMERS_COLLECTION, description: CUSTOMERS_DESCRIPTION },
    { typeId: STRIPE_INVOICE_TYPE_ID, displayName: STRIPE_INVOICE_DISPLAY_NAME, writable: false, readable: true, collectionName: STRIPE_INVOICES_COLLECTION, description: INVOICES_DESCRIPTION },
    { typeId: STRIPE_SUBSCRIPTION_TYPE_ID, displayName: STRIPE_SUBSCRIPTION_DISPLAY_NAME, writable: false, readable: true, collectionName: STRIPE_SUBSCRIPTIONS_COLLECTION, description: SUBSCRIPTIONS_DESCRIPTION },
    // The EVENT edge: what a delivery to the connection's URL is.
    {
      typeId: STRIPE_EVENT_TYPE_ID,
      displayName: STRIPE_EVENT_DISPLAY_NAME,
      writable: false,
      readable: false,
      fires: true,
      description:
        'Delivered once per Stripe event sent to the connection’s URL. `events` selects ' +
        'Stripe’s event types (["invoice.payment_failed"]).',
    },
  ];
}

/** The account meta node — what this connection IS, and the edges leaving it. */
export const STRIPE_ROOT: SchemaTypeDescriptor = {
  typeId: META_RECORD_TYPE,
  displayName: STRIPE_ACCOUNT_DISPLAY_NAME,
  description:
    'The Stripe account the API key belongs to. Walk `Customers`, `Invoices` or ' +
    '`Subscriptions`; listen on `Event` to be told about Stripe’s events.',
  fields: [],
  references: [
    { fieldId: STRIPE_CUSTOMERS_COLLECTION, targetTypeId: STRIPE_CUSTOMER_TYPE_ID, cardinality: 'many', direction: 'outgoing', name: STRIPE_CUSTOMERS_COLLECTION, description: CUSTOMERS_DESCRIPTION, capability: NEWEST_FIRST },
    { fieldId: STRIPE_INVOICES_COLLECTION, targetTypeId: STRIPE_INVOICE_TYPE_ID, cardinality: 'many', direction: 'outgoing', name: STRIPE_INVOICES_COLLECTION, description: INVOICES_DESCRIPTION, capability: NEWEST_FIRST },
    { fieldId: STRIPE_SUBSCRIPTIONS_COLLECTION, targetTypeId: STRIPE_SUBSCRIPTION_TYPE_ID, cardinality: 'many', direction: 'outgoing', name: STRIPE_SUBSCRIPTIONS_COLLECTION, description: SUBSCRIPTIONS_DESCRIPTION, capability: NEWEST_FIRST },
    {
      fieldId: `fires:${STRIPE_EVENT_TYPE_ID}`,
      targetTypeId: STRIPE_EVENT_TYPE_ID,
      cardinality: 'one',
      direction: 'outgoing',
      name: STRIPE_EVENT_DISPLAY_NAME,
      fires: true,
      readable: false,
      description: 'A Stripe event, signed by the endpoint’s secret — what a listen delivers.',
    },
  ],
};

const CUSTOMER_EDGE: SchemaReferenceDescriptor = {
  fieldId: STRIPE_CUSTOMER_EDGE,
  targetTypeId: STRIPE_CUSTOMER_TYPE_ID,
  cardinality: 'one',
  direction: 'outgoing',
  name: STRIPE_CUSTOMER_EDGE_NAME,
  required: true,
  description: 'The customer it belongs to (fetched from Stripe).',
};

const INVOICES_EDGE: SchemaReferenceDescriptor = {
  fieldId: STRIPE_INVOICES_EDGE,
  targetTypeId: STRIPE_INVOICE_TYPE_ID,
  cardinality: 'many',
  direction: 'outgoing',
  name: STRIPE_INVOICES_EDGE_NAME,
  description: INVOICES_DESCRIPTION,
  sequenced: 'chronological',
  capability: NEWEST_FIRST,
};

const EVENT_DESCRIPTOR: SchemaTypeDescriptor = {
  typeId: STRIPE_EVENT_TYPE_ID,
  displayName: STRIPE_EVENT_DISPLAY_NAME,
  description:
    'A Stripe event: what happened (`Type`) and when. Walk `Invoice`, `Subscription` or ' +
    '`Customer` for the object it is about, as it was when the event happened.',
  fields: [
    field('id', 'Id', 'string', { required: true, description: 'The event id (`evt_…`), the same on every retry of the delivery.' }),
    field('type', 'Type', 'enum', { required: true, enumValues: [...STRIPE_EVENT_TYPES], description: 'What happened: `invoice.payment_failed`, `customer.subscription.deleted`, `customer.created`, …' }),
    field('created', 'Created', 'date', { required: true }),
    field('livemode', 'Livemode', 'boolean', { required: true, description: 'True for live mode, false for test mode.' }),
    field('api_version', 'API Version', 'string', { description: 'The API version the object is shaped by (the endpoint’s).' }),
    field('previous_attributes', 'Previous Attributes', 'json', { description: 'On an `*.updated` event: the fields that changed, with their values before (Stripe’s units).' }),
  ],
  references: [
    {
      fieldId: STRIPE_INVOICE_EDGE,
      targetTypeId: STRIPE_INVOICE_TYPE_ID,
      cardinality: 'one',
      direction: 'outgoing',
      name: STRIPE_INVOICE_EDGE_NAME,
      description: 'The invoice an `invoice.*` event is about; nothing for another event.',
    },
    {
      fieldId: STRIPE_SUBSCRIPTION_EDGE,
      targetTypeId: STRIPE_SUBSCRIPTION_TYPE_ID,
      cardinality: 'one',
      direction: 'outgoing',
      name: STRIPE_SUBSCRIPTION_EDGE_NAME,
      description: 'The subscription a `customer.subscription.*` event is about; nothing for another event.',
    },
    {
      fieldId: STRIPE_CUSTOMER_EDGE,
      targetTypeId: STRIPE_CUSTOMER_TYPE_ID,
      cardinality: 'one',
      direction: 'outgoing',
      name: STRIPE_CUSTOMER_EDGE_NAME,
      description: 'The customer a `customer.created`, `.updated` or `.deleted` event is about; nothing for another event (walk its invoice’s or subscription’s `Customer`).',
    },
  ],
};

const CUSTOMER_DESCRIPTOR: SchemaTypeDescriptor = {
  typeId: STRIPE_CUSTOMER_TYPE_ID,
  displayName: STRIPE_CUSTOMER_DISPLAY_NAME,
  description: 'A customer: its invoices and its subscriptions.',
  fields: [
    field('id', 'Id', 'string', { required: true, description: 'The customer id (`cus_…`).' }),
    field('email', 'Email', 'string', { capability: EQ, description: '`==` in a `Customers` WHERE reaches Stripe (case-sensitive there).' }),
    field('name', 'Name', 'string'),
    field('description', 'Description', 'string'),
    field('phone', 'Phone', 'string'),
    field('currency', 'Currency', 'string', { description: 'The three-letter ISO code it is billed in, lowercase (`usd`); unset until it is first billed.' }),
    money('balance', 'Balance', 'What it owes on its next invoice (negative: credit)'),
    field('delinquent', 'Delinquent', 'boolean', { description: 'Its latest invoice’s payment failed, or a payment is past due.' }),
    field('created', 'Created', 'date'),
    field('livemode', 'Livemode', 'boolean'),
    field('metadata', 'Metadata', 'json', { description: 'Your own key-value pairs (`c.Metadata.crm_id`).' }),
    field('deleted', 'Deleted', 'boolean', { description: 'True on the customer a `customer.deleted` event carries.' }),
  ],
  references: [
    { ...INVOICES_EDGE, description: `Its invoices. ${INVOICES_DESCRIPTION}` },
    {
      fieldId: STRIPE_SUBSCRIPTIONS_EDGE,
      targetTypeId: STRIPE_SUBSCRIPTION_TYPE_ID,
      cardinality: 'many',
      direction: 'outgoing',
      name: STRIPE_SUBSCRIPTIONS_EDGE_NAME,
      description: `Its subscriptions. ${SUBSCRIPTIONS_DESCRIPTION}`,
      sequenced: 'chronological',
      capability: NEWEST_FIRST,
    },
  ],
};

const INVOICE_DESCRIPTOR: SchemaTypeDescriptor = {
  typeId: STRIPE_INVOICE_TYPE_ID,
  displayName: STRIPE_INVOICE_DISPLAY_NAME,
  description: 'An invoice: what is owed and paid, and where the customer pays it. Walk `Customer` and `Subscription`.',
  fields: [
    field('id', 'Id', 'string', { required: true, description: 'The invoice id (`in_…`).' }),
    field('number', 'Number', 'string', { description: 'The number on the invoice, once it is finalized.' }),
    field('status', 'Status', 'enum', { enumValues: [...STRIPE_INVOICE_STATUSES], capability: EQ }),
    field('currency', 'Currency', 'string', { required: true, description: 'The three-letter ISO code, lowercase (`usd`). `Currency.formatFigure(amount, code)` writes an amount with it.' }),
    money('amount_due', 'Amount Due', 'What the customer owes', REQUIRED),
    money('amount_paid', 'Amount Paid', 'What has been paid', REQUIRED),
    money('amount_remaining', 'Amount Remaining', 'What is still owed', REQUIRED),
    money('subtotal', 'Subtotal', 'The total before discounts and tax', REQUIRED),
    money('total', 'Total', 'The total after discounts and tax', REQUIRED),
    field('customer_email', 'Customer Email', 'string', { description: 'The customer’s email when the invoice was finalized.' }),
    field('customer_name', 'Customer Name', 'string', { description: 'The customer’s name when the invoice was finalized.' }),
    field('hosted_invoice_url', 'Hosted Invoice URL', 'string', { description: 'Where the customer sees and pays it; unset until it is finalized.' }),
    field('invoice_pdf', 'Invoice PDF', 'string', { description: 'The PDF’s URL; unset until it is finalized.' }),
    field('billing_reason', 'Billing Reason', 'enum', { enumValues: [...STRIPE_BILLING_REASONS], description: 'Why it was made (`subscription_cycle`, `subscription_create`, `manual`, …).' }),
    field('collection_method', 'Collection Method', 'enum', { enumValues: [...STRIPE_COLLECTION_METHODS], capability: EQ, required: true }),
    field('attempt_count', 'Attempt Count', 'number', { required: true, description: 'Payment attempts made so far.' }),
    field('attempted', 'Attempted', 'boolean', REQUIRED),
    field('next_payment_attempt', 'Next Payment Attempt', 'date', { description: 'When Stripe tries again; unset when it will not.' }),
    field('due_date', 'Due Date', 'date'),
    field('period_start', 'Period Start', 'date', REQUIRED),
    field('period_end', 'Period End', 'date', REQUIRED),
    field('created', 'Created', 'date', REQUIRED),
    field('description', 'Description', 'string'),
    field('livemode', 'Livemode', 'boolean', REQUIRED),
    field('metadata', 'Metadata', 'json', { description: 'Your own key-value pairs.' }),
  ],
  references: [
    CUSTOMER_EDGE,
    {
      fieldId: STRIPE_SUBSCRIPTION_EDGE,
      targetTypeId: STRIPE_SUBSCRIPTION_TYPE_ID,
      cardinality: 'one',
      direction: 'outgoing',
      name: STRIPE_SUBSCRIPTION_EDGE_NAME,
      description: 'The subscription that made it; nothing for a one-off invoice.',
    },
  ],
};

const SUBSCRIPTION_DESCRIPTOR: SchemaTypeDescriptor = {
  typeId: STRIPE_SUBSCRIPTION_TYPE_ID,
  displayName: STRIPE_SUBSCRIPTION_DISPLAY_NAME,
  description: 'A subscription: its status and its invoices. Walk `Customer`.',
  fields: [
    field('id', 'Id', 'string', { required: true, description: 'The subscription id (`sub_…`).' }),
    field('status', 'Status', 'enum', { required: true, enumValues: [...STRIPE_SUBSCRIPTION_STATUSES], capability: EQ }),
    field('currency', 'Currency', 'string', { required: true, description: 'The three-letter ISO code, lowercase.' }),
    field('collection_method', 'Collection Method', 'enum', { enumValues: [...STRIPE_COLLECTION_METHODS], capability: EQ, required: true }),
    field('cancel_at_period_end', 'Cancel At Period End', 'boolean', REQUIRED),
    field('cancel_at', 'Cancel At', 'date'),
    field('canceled_at', 'Canceled At', 'date'),
    field('ended_at', 'Ended At', 'date'),
    field('start_date', 'Start Date', 'date', REQUIRED),
    field('trial_start', 'Trial Start', 'date'),
    field('trial_end', 'Trial End', 'date'),
    field('created', 'Created', 'date', REQUIRED),
    field('description', 'Description', 'string'),
    field('days_until_due', 'Days Until Due', 'number', { description: 'For `send_invoice`: days the customer has to pay each invoice.' }),
    field('livemode', 'Livemode', 'boolean', REQUIRED),
    field('metadata', 'Metadata', 'json', { description: 'Your own key-value pairs (`s.Metadata.crm_id`).' }),
  ],
  references: [
    CUSTOMER_EDGE,
    { ...INVOICES_EDGE, description: `The invoices it made. ${INVOICES_DESCRIPTION}` },
    {
      fieldId: STRIPE_LATEST_INVOICE_EDGE,
      targetTypeId: STRIPE_INVOICE_TYPE_ID,
      cardinality: 'one',
      direction: 'outgoing',
      name: STRIPE_LATEST_INVOICE_EDGE_NAME,
      description: 'The most recent invoice it made.',
    },
  ],
};

const DESCRIPTORS: Record<string, SchemaTypeDescriptor> = {
  [STRIPE_EVENT_TYPE_ID]: EVENT_DESCRIPTOR,
  [STRIPE_CUSTOMER_TYPE_ID]: CUSTOMER_DESCRIPTOR,
  [STRIPE_INVOICE_TYPE_ID]: INVOICE_DESCRIPTOR,
  [STRIPE_SUBSCRIPTION_TYPE_ID]: SUBSCRIPTION_DESCRIPTOR,
};

/** The account meta descriptor — the node `edgesFrom` roots at, addressed by
 *  type id (author-time introspection reaches it that way). */
export const STRIPE_ACCOUNT_DESCRIPTOR: SchemaTypeDescriptor = {
  ...STRIPE_ROOT,
  typeId: STRIPE_ACCOUNT_TYPE_ID,
};

/** `describe` over an already-resolved INTERNAL type id. Null for an id this
 *  adapter does not own. */
export function describeStripeType(typeId: string): SchemaTypeDescriptor | null {
  return DESCRIPTORS[typeId] ?? null;
}

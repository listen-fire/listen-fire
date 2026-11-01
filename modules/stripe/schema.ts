// The Stripe type graph: the entry surface and every type descriptor.
//
// The shape follows Stripe's own nouns. An account reaches its customers,
// invoices, subscriptions and charges; a customer holds its invoices,
// subscriptions and charges; an invoice and a subscription lead to their
// customer, and an invoice to the subscription that made it and the charges
// that tried to pay it. A charge leads to its customer and invoice. An event
// is ABOUT one object, reached along `Invoice`, `Subscription`, `Customer` or
// `Charge` rather than through an untyped `data.object`. Field names are Stripe's (`amount_due` reads as
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
  STRIPE_CHARGES_COLLECTION,
  STRIPE_CHARGES_EDGE,
  STRIPE_CHARGES_EDGE_NAME,
  STRIPE_CHARGE_DISPLAY_NAME,
  STRIPE_CHARGE_EDGE,
  STRIPE_CHARGE_EDGE_NAME,
  STRIPE_CHARGE_STATUSES,
  STRIPE_CHARGE_TYPE_ID,
  STRIPE_COLLECTION_METHODS,
  STRIPE_CUSTOMERS_COLLECTION,
  STRIPE_CUSTOMER_DISPLAY_NAME,
  STRIPE_CUSTOMER_EDGE,
  STRIPE_CUSTOMER_EDGE_NAME,
  STRIPE_CUSTOMER_TYPE_ID,
  STRIPE_CHANGES_EDGE,
  STRIPE_CHANGES_EDGE_NAME,
  STRIPE_CHANGED_OBJECTS,
  STRIPE_CHARGE_OBJECT,
  STRIPE_CUSTOMER_OBJECT,
  STRIPE_INVOICE_OBJECT,
  STRIPE_SUBSCRIPTION_OBJECT,
  kindOf,
  type StripeChangedObject,
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
const CHARGES_DESCRIPTION =
  'Charges (every attempt to take a payment, failed ones included), newest first. `Created` bounds ' +
  '(`>=`, `<`, `WITHIN 7d`) reach Stripe, as does the customer a `Customer` hop starts from; ' +
  'other filters (`Status`, `Currency`) run over what comes back, so bound `Created` on a busy account.';
const SUBSCRIPTIONS_DESCRIPTION =
  'Subscriptions of every status (canceled included), newest first. `Status ==` and ' +
  '`Collection Method ==` reach Stripe; other filters run over what comes back.';

export function stripeEntryPoints(): SchemaEntryPoint[] {
  return [
    { typeId: STRIPE_CUSTOMER_TYPE_ID, displayName: STRIPE_CUSTOMER_DISPLAY_NAME, writable: false, readable: true, collectionName: STRIPE_CUSTOMERS_COLLECTION, description: CUSTOMERS_DESCRIPTION },
    { typeId: STRIPE_INVOICE_TYPE_ID, displayName: STRIPE_INVOICE_DISPLAY_NAME, writable: false, readable: true, collectionName: STRIPE_INVOICES_COLLECTION, description: INVOICES_DESCRIPTION },
    { typeId: STRIPE_SUBSCRIPTION_TYPE_ID, displayName: STRIPE_SUBSCRIPTION_DISPLAY_NAME, writable: false, readable: true, collectionName: STRIPE_SUBSCRIPTIONS_COLLECTION, description: SUBSCRIPTIONS_DESCRIPTION },
    { typeId: STRIPE_CHARGE_TYPE_ID, displayName: STRIPE_CHARGE_DISPLAY_NAME, writable: false, readable: true, collectionName: STRIPE_CHARGES_COLLECTION, description: CHARGES_DESCRIPTION },
    // Reached only along a record's `Changes`; published so each is named.
    ...STRIPE_CHANGED_OBJECTS.map((object) => ({ typeId: object.changeTypeId, displayName: object.changeDisplayName, writable: false, readable: false })),
  ];
}

/** The account meta node — what this connection IS, and the edges leaving it. */
export const STRIPE_ROOT: SchemaTypeDescriptor = {
  typeId: META_RECORD_TYPE,
  displayName: STRIPE_ACCOUNT_DISPLAY_NAME,
  description:
    'The Stripe account the API key belongs to. Walk `Customers`, `Invoices`, `Subscriptions` or ' +
    '`Charges`; listen on a record’s `Changes` to be told about Stripe’s events ' +
    '(`pay-[:Invoices]->-[c:Changes WHERE c.Kind == "payment_failed"]->`).',
  fields: [],
  references: [
    { fieldId: STRIPE_CUSTOMERS_COLLECTION, targetTypeId: STRIPE_CUSTOMER_TYPE_ID, cardinality: 'many', direction: 'outgoing', name: STRIPE_CUSTOMERS_COLLECTION, description: CUSTOMERS_DESCRIPTION, capability: NEWEST_FIRST },
    { fieldId: STRIPE_INVOICES_COLLECTION, targetTypeId: STRIPE_INVOICE_TYPE_ID, cardinality: 'many', direction: 'outgoing', name: STRIPE_INVOICES_COLLECTION, description: INVOICES_DESCRIPTION, capability: NEWEST_FIRST },
    { fieldId: STRIPE_SUBSCRIPTIONS_COLLECTION, targetTypeId: STRIPE_SUBSCRIPTION_TYPE_ID, cardinality: 'many', direction: 'outgoing', name: STRIPE_SUBSCRIPTIONS_COLLECTION, description: SUBSCRIPTIONS_DESCRIPTION, capability: NEWEST_FIRST },
    { fieldId: STRIPE_CHARGES_COLLECTION, targetTypeId: STRIPE_CHARGE_TYPE_ID, cardinality: 'many', direction: 'outgoing', name: STRIPE_CHARGES_COLLECTION, description: CHARGES_DESCRIPTION, capability: NEWEST_FIRST },
  ],
};

/**
 * A record's `Changes`: the events Stripe sends about it, pushed to the
 * connection's door (Stripe's endpoint is the connection's, so one endpoint
 * serves every listen). Each arrival carries the record as its event had it, so a WHERE on that hop
 * is judged on the arrival, with no read.
 */
function changesEdge(object: StripeChangedObject, what: string): SchemaReferenceDescriptor {
  return {
    fieldId: STRIPE_CHANGES_EDGE,
    targetTypeId: object.changeTypeId,
    cardinality: 'many',
    direction: 'outgoing',
    name: STRIPE_CHANGES_EDGE_NAME,
    readable: false,
    listenable: true,
    delivery: 'connection',
    identity: 'Id',
    attributes: true,
    carries: [object.collection],
    description: `The events Stripe sends about ${what}, each once, as the endpoint delivers them (\`Kind\` is what happened).`,
  };
}

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

const CHARGES_EDGE: SchemaReferenceDescriptor = {
  fieldId: STRIPE_CHARGES_EDGE,
  targetTypeId: STRIPE_CHARGE_TYPE_ID,
  cardinality: 'many',
  direction: 'outgoing',
  name: STRIPE_CHARGES_EDGE_NAME,
  description: CHARGES_DESCRIPTION,
  sequenced: 'chronological',
  capability: NEWEST_FIRST,
};

/** An object's change type: one Stripe event about it. `Kind` and `Type`
 *  are only the object's own, so a WHERE naming another object's kind is
 *  refused at check. */
function changeDescriptor(object: StripeChangedObject): SchemaTypeDescriptor {
  const noun = object.displayName.toLowerCase();
  const [example] = object.events;
  return {
    typeId: object.changeTypeId,
    displayName: object.changeDisplayName,
    description:
      `A Stripe event about ${noun === 'invoice' ? 'an' : 'a'} ${noun}: what happened (\`Kind\`, \`Type\`) and when. Walk ` +
      `\`${object.edgeName}\` for the ${noun}, as it was when the event happened.`,
    fields: [
      field('id', 'Id', 'string', { required: true, description: 'The event id (`evt_…`), the same on every retry of the delivery.' }),
      field('kind', 'Kind', 'enum', {
        required: true,
        enumValues: object.events.map(kindOf),
        description: `What happened to the ${noun}: its event type without \`${object.prefix}\` (\`${kindOf(example)}\` for \`${example}\`).`,
      }),
      field('type', 'Type', 'enum', { required: true, enumValues: [...object.events], description: `What happened, as Stripe names it: \`${example}\`, …` }),
      field('created', 'Created', 'date', { required: true }),
      field('livemode', 'Livemode', 'boolean', { required: true, description: 'True for live mode, false for test mode.' }),
      field('api_version', 'API Version', 'string', { description: 'The API version the object is shaped by (the endpoint’s).' }),
      field('previous_attributes', 'Previous Attributes', 'json', { description: 'On an `updated` event: the fields that changed, with their values before (Stripe’s units).' }),
    ],
    references: [
      {
        fieldId: object.edge,
        targetTypeId: object.typeId,
        cardinality: 'one',
        direction: 'outgoing',
        name: object.edgeName,
        required: true,
        description: `The ${noun} the event is about, as the event had it.`,
      },
    ],
  };
}

const CUSTOMER_DESCRIPTOR: SchemaTypeDescriptor = {
  typeId: STRIPE_CUSTOMER_TYPE_ID,
  displayName: STRIPE_CUSTOMER_DISPLAY_NAME,
  description: 'A customer: its invoices, subscriptions and charges.',
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
    changesEdge(STRIPE_CUSTOMER_OBJECT, 'a customer (`customer.created`, `.updated`, `.deleted`)'),
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
    { ...CHARGES_EDGE, description: `Its charges. ${CHARGES_DESCRIPTION}` },
  ],
};

const INVOICE_DESCRIPTOR: SchemaTypeDescriptor = {
  typeId: STRIPE_INVOICE_TYPE_ID,
  displayName: STRIPE_INVOICE_DISPLAY_NAME,
  description: 'An invoice: what is owed and paid, and where the customer pays it. Walk `Customer`, `Subscription` and `Charges` (why a payment failed).',
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
    changesEdge(STRIPE_INVOICE_OBJECT, 'an invoice (`invoice.payment_failed`, `invoice.paid`, …)'),
    CUSTOMER_EDGE,
    {
      fieldId: STRIPE_SUBSCRIPTION_EDGE,
      targetTypeId: STRIPE_SUBSCRIPTION_TYPE_ID,
      cardinality: 'one',
      direction: 'outgoing',
      name: STRIPE_SUBSCRIPTION_EDGE_NAME,
      description: 'The subscription that made it; nothing for a one-off invoice.',
    },
    {
      ...CHARGES_EDGE,
      description:
        'The charges that tried to pay it, newest first, failed attempts included: a failed charge’s `Failure Message`, ' +
        '`Failure Code` and `Outcome Seller Message` are why the payment failed. Read through the invoice’s payments ' +
        '(payment intents and charges), so each walk costs a few requests.',
      // Stripe lists these through the invoice's payments, not one filtered query: nothing is pushed.
      capability: { filter: 'bounded', order: 'bounded', supportsLimit: true, naturalOrder: { field: 'Created', direction: 'desc' } },
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
    changesEdge(STRIPE_SUBSCRIPTION_OBJECT, 'a subscription (`customer.subscription.created`, `.deleted`, …)'),
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

const CHARGE_DESCRIPTOR: SchemaTypeDescriptor = {
  typeId: STRIPE_CHARGE_TYPE_ID,
  displayName: STRIPE_CHARGE_DISPLAY_NAME,
  description:
    'A charge: one attempt to take a payment, successful or not. `Status` says which; a failed one says why in ' +
    '`Failure Code`, `Failure Message` and `Outcome Seller Message`. Walk `Customer` and `Invoice`.',
  fields: [
    field('id', 'Id', 'string', { required: true, description: 'The charge id (`ch_…`).' }),
    money('amount', 'Amount', 'What was to be collected (for a failed charge, what was attempted)', REQUIRED),
    money('amount_captured', 'Amount Captured', 'What was captured (less than `Amount` after a partial capture)', REQUIRED),
    money('amount_refunded', 'Amount Refunded', 'What has been refunded (less than `Amount` after a partial refund)', REQUIRED),
    field('currency', 'Currency', 'string', { required: true, description: 'The three-letter ISO code, lowercase (`usd`). `Currency.formatFigure(amount, code)` writes an amount with it.' }),
    field('status', 'Status', 'enum', { required: true, enumValues: [...STRIPE_CHARGE_STATUSES], description: '`succeeded`, `pending` or `failed`. Stripe cannot filter a listing by it: it runs over what comes back.' }),
    field('paid', 'Paid', 'boolean', { required: true, description: 'True if it succeeded, or was authorized for later capture.' }),
    field('captured', 'Captured', 'boolean', REQUIRED),
    field('refunded', 'Refunded', 'boolean', { required: true, description: 'True only when fully refunded; a partial refund shows in `Amount Refunded`.' }),
    field('disputed', 'Disputed', 'boolean', REQUIRED),
    field('created', 'Created', 'date', {
      required: true,
      capability: { filterOperators: ['gt', 'gte', 'lt', 'lte', 'within'], orderable: true },
      description: 'When it was made. Bounds (`>=`, `<`, `WITHIN 7d`) in a `Charges` WHERE reach Stripe, which counts whole seconds.',
    }),
    field('description', 'Description', 'string'),
    field('failure_code', 'Failure Code', 'string', { description: 'Stripe’s code for why it failed (`card_declined`, `expired_card`, …); unset when it did not fail.' }),
    field('failure_message', 'Failure Message', 'string', { description: 'Stripe’s message for why it failed, written for the customer; unset when it did not fail.' }),
    field('outcome_type', 'Outcome Type', 'string', { description: 'Whether the payment was accepted: `authorized`, `manual_review`, `issuer_declined`, `blocked` or `invalid`.' }),
    field('outcome_reason', 'Outcome Reason', 'string', { description: 'A more detailed explanation of the outcome type (`highest_risk_level`, `elevated_risk_level`, `low_probability_of_authorization`, `rule`, or the issuer’s reason); unset for an ordinary success.' }),
    field('outcome_seller_message', 'Outcome Seller Message', 'string', { description: 'A description of the outcome written for you, not your customer (“Payment complete.”, “Stripe blocked this charge as too risky.”).' }),
    field('outcome_network_status', 'Outcome Network Status', 'string', { description: '`approved_by_network`, `declined_by_network`, `not_sent_to_network` or `reversed_after_approval`.' }),
    field('outcome_network_decline_code', 'Outcome Network Decline Code', 'string', { description: 'For a charge the card network declined, the network’s own code for why.' }),
    field('outcome_advice_code', 'Outcome Advice Code', 'string', { description: 'How to proceed after a decline: `confirm_card_data`, `do_not_try_again` or `try_again_later`.' }),
    field('outcome_risk_level', 'Outcome Risk Level', 'string', { description: 'Radar’s assessment: `normal`, `elevated`, `highest`, `not_assessed` or `unknown`.' }),
    field('receipt_url', 'Receipt URL', 'string', { description: 'Where the customer sees the receipt, kept up to date with refunds.' }),
    field('receipt_email', 'Receipt Email', 'string', { description: 'The address the receipt went to.' }),
    field('billing_details_name', 'Billing Details Name', 'string', { description: 'The name on the payment method; unset when none was given.' }),
    field('billing_details_email', 'Billing Details Email', 'string', { description: 'The email on the payment method; unset when none was given.' }),
    field('livemode', 'Livemode', 'boolean', REQUIRED),
    field('metadata', 'Metadata', 'json', { description: 'Your own key-value pairs.' }),
  ],
  references: [
    changesEdge(STRIPE_CHARGE_OBJECT, 'a charge (`charge.failed`, `charge.succeeded`, `charge.refunded`, …)'),
    {
      ...CUSTOMER_EDGE,
      required: false,
      description: 'The customer it was for; nothing for a charge made without one.',
    },
    {
      fieldId: STRIPE_INVOICE_EDGE,
      targetTypeId: STRIPE_INVOICE_TYPE_ID,
      cardinality: 'one',
      direction: 'outgoing',
      name: STRIPE_INVOICE_EDGE_NAME,
      description:
        'The invoice it tried to pay; nothing for a charge that paid no invoice. Found through the charge’s payment intent ' +
        '(Stripe’s API version 2025-03-31.basil removed `invoice` from the charge), so one request.',
    },
  ],
};

const DESCRIPTORS: Record<string, SchemaTypeDescriptor> = {
  ...Object.fromEntries(STRIPE_CHANGED_OBJECTS.map((object) => [object.changeTypeId, changeDescriptor(object)])),
  [STRIPE_CUSTOMER_TYPE_ID]: CUSTOMER_DESCRIPTOR,
  [STRIPE_INVOICE_TYPE_ID]: INVOICE_DESCRIPTOR,
  [STRIPE_SUBSCRIPTION_TYPE_ID]: SUBSCRIPTION_DESCRIPTOR,
  [STRIPE_CHARGE_TYPE_ID]: CHARGE_DESCRIPTOR,
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

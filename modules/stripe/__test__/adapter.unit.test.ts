// Stripe adapter against the fake Stripe — the entry surface and what the
// checker projects from it, an event's object along its typed edge, the walks
// between customers, invoices and subscriptions, the WHERE pushdown, and
// amounts in major units.

import {
  ADAPTER_META_TYPE_ID,
  instanceSchemaFromDescriptors,
  makeMetaPosition,
  makeStablePosition,
  type SourcePosition,
} from 'movement-engine/public/catalog';
import type { Expression } from 'engine-contracts/expression/expression';

import { StripeAdapter } from '../adapter';
import { StripeClient, STRIPE_API_VERSION } from '../api_client';
import { eventOf } from '../inbound';
import { STRIPE_EVENT_DISPLAY_NAME, STRIPE_EVENT_TYPES } from '../types';
import { startFakeStripe, type FakeStripe } from './fake_stripe';
import { stripeCharge, stripeCustomer, stripeEvent, stripeFailedCharge, stripeInvoice, stripeInvoicePayment, stripeSubscription, type Json } from './fixtures';

const log = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
const KEY = 'rk_test_adapter';

let fake: FakeStripe;
let adapter: StripeAdapter;

beforeEach(async () => {
  fake = await startFakeStripe({ apiKey: KEY });
  fake.customer(stripeCustomer());
  fake.customer(stripeCustomer({ id: 'cus_ada', email: 'ada@example.com', name: 'Ada', created: 1690000000 }));
  fake.subscription(stripeSubscription());
  fake.subscription(stripeSubscription({ id: 'sub_old', status: 'canceled', created: 1600000000, latest_invoice: null }));
  fake.invoice(stripeInvoice());
  fake.invoice(stripeInvoice({ id: 'in_paid', status: 'paid', amount_paid: 4900, amount_remaining: 0, created: 1670000000 }));
  const door = { webhookSecret: async () => undefined, now: () => 0, log };
  adapter = new StripeAdapter(async () => new StripeClient({ apiKey: KEY, baseUrl: fake.url, fetch, log, retry: { attempts: 1 } }), door);
});

afterEach(async () => {
  await fake.close();
});

const meta = (): SourcePosition => makeMetaPosition('stripe');

async function walk(from: SourcePosition, edge: string, extra: { where?: Expression; limit?: number; orderBy?: { fieldId: string; direction: 'asc' | 'desc' } } = {}): Promise<SourcePosition[]> {
  return (await adapter.getRelated({ position: from, fieldId: edge, direction: 'outgoing', ...extra })).map((r) => r.position);
}

async function read(position: SourcePosition | undefined, field: string): Promise<unknown> {
  if (position === undefined) throw new Error(`no position to read ${field} of`);
  return adapter.getFieldValue({ position, fieldId: field });
}

const eq = (field: string, value: string): Expression => ({ type: 'compare', op: 'eq', left: { type: 'edge_property', propertyTypeId: field }, right: { type: 'static', value } }) as Expression;
const or = (...operands: Expression[]): Expression => ({ type: 'logical', op: 'or', operands }) as Expression;

/** The Event position a delivery of `body` seeds a run with. */
function delivered(body: Json): SourcePosition {
  const event = eventOf(body);
  if (!event.ok) throw new Error(event.message);
  return makeStablePosition({ adapterType: 'stripe', recordType: STRIPE_EVENT_DISPLAY_NAME, recordId: event.payload.id, data: event.payload });
}

const idOf = (position: SourcePosition): string | undefined => (position.identity.kind === 'stable' ? position.identity.recordId : undefined);
const listings = () => fake.requests.map((r) => r.path);

describe('StripeAdapter surface', () => {
  it('projects to a checker schema with the four collections, the event and every type', async () => {
    const entries = await adapter.listEntryPoints();
    const descriptors = new Map(
      (await Promise.all(entries.map(async (e) => [e.typeId, await adapter.describe(e.typeId)] as const))).flatMap(([id, d]) => (d ? [[id, d] as const] : [])),
    );
    const metaDescriptor = await adapter.describe(ADAPTER_META_TYPE_ID);
    const { schema, notes } = instanceSchemaFromDescriptors({
      adapterType: 'stripe',
      entries,
      descriptors,
      ...(metaDescriptor !== null ? { metaDescriptor } : {}),
      supportsInPlaceUpdate: false,
    });
    expect(Object.keys(schema.collections).sort()).toEqual(['Charges', 'Customers', 'Invoices', 'Subscriptions']);
    expect(Object.keys(schema.positions).sort()).toEqual(expect.arrayContaining(['Charge', 'Customer', 'Event', 'Invoice', 'Subscription']));
    expect(schema.positions['Customer']?.propertyCapabilities?.['Email']).toEqual({ filterOperators: ['eq'] });
    expect(notes.filter((n) => n.includes('root descriptor'))).toEqual([]);
  });

  it('types an event’s Type as Stripe’s event types, and its object as four edges', async () => {
    const event = await adapter.describe(STRIPE_EVENT_DISPLAY_NAME);
    expect(event?.fields.find((f) => f.displayName === 'Type')).toMatchObject({ kind: 'enum', enumValues: [...STRIPE_EVENT_TYPES] });
    expect(event?.references.map((r) => [r.name, r.targetTypeId, r.cardinality])).toEqual([
      ['Invoice', 'stripe:invoice', 'one'],
      ['Subscription', 'stripe:subscription', 'one'],
      ['Customer', 'stripe:customer', 'one'],
      ['Charge', 'stripe:charge', 'one'],
    ]);
  });

  it('writes nothing: no field or edge is writable', async () => {
    for (const type of ['Customer', 'Invoice', 'Subscription', 'Charge', 'Event']) {
      const descriptor = await adapter.describe(type);
      expect(descriptor?.fields.filter((f) => f.writable)).toEqual([]);
      expect(descriptor?.references.filter((r) => r.writable === true)).toEqual([]);
    }
  });
});

describe('an event’s object', () => {
  it('is the invoice an invoice event carries, typed, in major units, with no call to Stripe', async () => {
    const event = delivered(stripeEvent('invoice.payment_failed', stripeInvoice()));
    expect(await read(event, 'Type')).toBe('invoice.payment_failed');
    const [invoice] = await walk(event, 'Invoice');
    expect(await read(invoice, 'Amount Due')).toBe(49);
    expect(await read(invoice, 'Currency')).toBe('usd');
    expect(await read(invoice, 'Customer Email')).toBe('jennyrosen@example.com');
    expect(await read(invoice, 'Hosted Invoice URL')).toMatch(/^https:\/\/invoice\.stripe\.com\//);
    expect(await read(invoice, 'Next Payment Attempt')).toBe('2023-04-07T21:41:07.000Z');
    expect(await walk(event, 'Subscription')).toEqual([]);
    expect(await walk(event, 'Customer')).toEqual([]);
    expect(fake.requests).toEqual([]);
  });

  it('is in major units for a zero-decimal currency', async () => {
    const yen = delivered(stripeEvent('invoice.payment_failed', stripeInvoice({ currency: 'jpy', amount_due: 5000, amount_remaining: 5000, subtotal: 5000, total: 5000 })));
    const [invoice] = await walk(yen, 'Invoice');
    expect(await read(invoice, 'Amount Due')).toBe(5000);
    expect(await read(invoice, 'Total')).toBe(5000);
  });

  it('is the subscription of a subscription event, and the customer of a customer event', async () => {
    const [subscription] = await walk(delivered(stripeEvent('customer.subscription.deleted', stripeSubscription({ status: 'canceled' }))), 'Subscription');
    expect(await read(subscription, 'Status')).toBe('canceled');
    expect(await read(subscription, 'Metadata')).toEqual({ crm_id: 'C-10486' });
    const [customer] = await walk(delivered(stripeEvent('customer.deleted', stripeCustomer({ deleted: true }))), 'Customer');
    expect(await read(customer, 'Email')).toBe('jennyrosen@example.com');
    expect(await read(customer, 'Deleted')).toBe(true);
  });
});

describe('StripeAdapter walks', () => {
  it('follows an invoice to its customer and to the subscription that made it, and on to its invoices', async () => {
    const [invoice] = await walk(delivered(stripeEvent('invoice.payment_failed', stripeInvoice())), 'Invoice');
    const [customer] = await walk(invoice!, 'Customer');
    expect(await read(customer, 'Name')).toBe('Jenny Rosen');
    const [subscription] = await walk(invoice!, 'Subscription');
    expect(await read(subscription, 'Status')).toBe('past_due');
    expect(fake.requests.map((r) => [r.path, r.authorization, r.stripeVersion])).toEqual([
      ['/v1/customers/cus_NffrFeUfNV2Hib', `Bearer ${KEY}`, STRIPE_API_VERSION],
      ['/v1/subscriptions/sub_1MowQVLkdIwHu7ixeRlqHVzs', `Bearer ${KEY}`, STRIPE_API_VERSION],
    ]);
    const [latest] = await walk(subscription!, 'Latest Invoice');
    expect(await read(latest, 'Id')).toBe('in_1MtHbELkdIwHu7ixl4OzzPMv');
    expect((await walk(subscription!, 'Invoices')).length).toBe(2);
    expect(listings().at(-1)).toBe('/v1/invoices?subscription=sub_1MowQVLkdIwHu7ixeRlqHVzs&limit=100');
  });

  it('reads an invoice’s subscription where API versions before 2025-03-31 put it', async () => {
    const old = stripeInvoice({ parent: undefined, subscription: 'sub_1MowQVLkdIwHu7ixeRlqHVzs' });
    const [invoice] = await walk(delivered(stripeEvent('invoice.paid', old, { api_version: '2024-06-20' })), 'Invoice');
    expect((await walk(invoice!, 'Subscription')).length).toBe(1);
  });

  it('finds nothing along an edge Stripe has no record for', async () => {
    const [invoice] = await walk(delivered(stripeEvent('invoice.paid', stripeInvoice({ customer: 'cus_gone' }))), 'Invoice');
    expect(await walk(invoice!, 'Customer')).toEqual([]);
  });

  it('pushes Email == down to the customers listing, and reads the rest over what comes back', async () => {
    const [ada] = await walk(meta(), 'Customers', { where: eq('Email', 'ada@example.com'), limit: 1 });
    expect(await read(ada, 'Name')).toBe('Ada');
    expect(listings()).toEqual(['/v1/customers?email=ada%40example.com&limit=1']);
    await walk(meta(), 'Customers', { where: or(eq('Email', 'ada@example.com'), eq('Name', 'Jenny Rosen')), limit: 1 });
    expect(listings().at(-1)).toBe('/v1/customers?limit=100');
  });

  it('asks for every status of subscription unless the WHERE pins one, so a canceled one is not lost', async () => {
    expect((await walk(meta(), 'Subscriptions')).length).toBe(2);
    expect(listings().at(-1)).toBe('/v1/subscriptions?status=all&limit=100');
    const [customer] = await walk(meta(), 'Customers', { where: eq('Email', 'jennyrosen@example.com') });
    const active = await walk(customer!, 'Subscriptions', { where: eq('Status', 'past_due') });
    expect(active.length).toBe(1);
    expect(listings().at(-1)).toBe('/v1/subscriptions?customer=cus_NffrFeUfNV2Hib&status=past_due&limit=100');
  });

  it('pushes an invoice Status == down, and leaves a value Stripe does not take to the engine', async () => {
    const [customer] = await walk(meta(), 'Customers', { where: eq('Email', 'jennyrosen@example.com') });
    expect((await walk(customer!, 'Invoices', { where: eq('Status', 'open') })).length).toBe(1);
    expect(listings().at(-1)).toBe('/v1/invoices?customer=cus_NffrFeUfNV2Hib&status=open&limit=100');
    await walk(customer!, 'Invoices', { where: eq('Status', 'opne') });
    expect(listings().at(-1)).toBe('/v1/invoices?customer=cus_NffrFeUfNV2Hib&limit=100');
  });

  it('pages a listing by cursor until Stripe says there is no more', async () => {
    for (let i = 0; i < 150; i++) fake.customer(stripeCustomer({ id: `cus_${String(i).padStart(3, '0')}`, created: 1700000000 + i }));
    expect((await walk(meta(), 'Customers')).length).toBe(152);
    expect(listings()).toEqual(['/v1/customers?limit=100', '/v1/customers?limit=100&starting_after=cus_050']);
  });
});

describe('charges', () => {
  const PI = 'pi_3MtwBwLkdIwHu7ix28a3tqPa';
  const failedAt = (id: string, created: number, overrides: Json = {}) => stripeFailedCharge({ id, created, payment_intent: PI, customer: 'cus_NffrFeUfNV2Hib', ...overrides });

  beforeEach(() => {
    fake.charge(stripeCharge({ id: 'ch_old', created: 1600000000, currency: 'usd', amount: 2500, customer: 'cus_ada' }));
    fake.charge(stripeCharge({ id: 'ch_yen', created: 1700000000, currency: 'jpy', amount: 5000, customer: 'cus_ada' }));
    fake.charge(failedAt('ch_try1', 1680644500));
    fake.charge(failedAt('ch_try2', 1680730900));
    fake.invoicePayment(stripeInvoicePayment({ payment: { type: 'payment_intent', payment_intent: PI } }));
  });

  it('lists the account’s charges newest first, amounts in major units, with Stripe’s own failure and outcome fields', async () => {
    const charges = await walk(meta(), 'Charges');
    expect(await Promise.all(charges.map((c) => read(c, 'Id')))).toEqual(['ch_yen', 'ch_try2', 'ch_try1', 'ch_old']);
    const [yen, , , old] = charges;
    expect([await read(yen, 'Amount'), await read(yen, 'Currency')]).toEqual([5000, 'jpy']);
    expect(await read(old, 'Amount')).toBe(25);
    expect(await read(old, 'Amount Refunded')).toBe(0);
    expect(await read(old, 'Status')).toBe('succeeded');
    expect(await read(old, 'Outcome Seller Message')).toBe('Payment complete.');
    expect(await read(old, 'Failure Message')).toBeNull();
    expect(await read(old, 'Created')).toBe('2020-09-13T12:26:40.000Z');
    expect(listings()).toEqual(['/v1/charges?limit=100']);
  });

  it('reads a failed charge’s reason', async () => {
    const [failed] = (await walk(meta(), 'Charges')).filter((c) => idOf(c) === 'ch_try2');
    expect(await read(failed, 'Status')).toBe('failed');
    expect(await read(failed, 'Paid')).toBe(false);
    expect(await read(failed, 'Failure Code')).toBe('expired_card');
    expect(await read(failed, 'Failure Message')).toBe('Your card has expired.');
    expect(await read(failed, 'Outcome Type')).toBe('issuer_declined');
    expect(await read(failed, 'Outcome Reason')).toBe('expired_card');
    expect(await read(failed, 'Outcome Seller Message')).toBe('The bank returned the decline code `expired_card`.');
    expect(await read(failed, 'Outcome Network Decline Code')).toBe('54');
    expect(await read(failed, 'Outcome Advice Code')).toBe('confirm_card_data');
  });

  it('pushes Created bounds down as whole seconds, and leaves Status to the engine', async () => {
    const created = (op: string, value: string | number): Expression => ({ type: 'compare', op, left: { type: 'edge_property', propertyTypeId: 'Created' }, right: { type: 'static', value } }) as Expression;
    const and = (...operands: Expression[]): Expression => ({ type: 'logical', op: 'and', operands }) as Expression;
    const since = await walk(meta(), 'Charges', { where: created('gte', '2023-04-05T00:00:00.000Z') });
    expect(since.length).toBe(2);
    expect(listings().at(-1)).toBe('/v1/charges?created%5Bgte%5D=1680652800&limit=100');
    await walk(meta(), 'Charges', { where: and(created('gte', '2023-04-05'), created('lt', '2023-04-06'), created('gte', '2023-04-04'), eq('Status', 'failed')) });
    expect(listings().at(-1)).toBe('/v1/charges?created%5Bgte%5D=1680652800&created%5Blt%5D=1680739200&limit=100');
    await walk(meta(), 'Charges', { where: created('gt', 1680652800500) });
    expect(listings().at(-1)).toBe('/v1/charges?created%5Bgt%5D=1680652800&limit=100');
  });

  it('pushes WITHIN down as a lower bound from now', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1700000000_000);
    try {
      const within: Expression = { type: 'compare', op: 'within', left: { type: 'edge_property', propertyTypeId: 'Created' }, right: { type: 'static', value: '7d' } } as Expression;
      expect(await walk(meta(), 'Charges', { where: within, limit: 1 })).toHaveLength(1);
      expect(listings().at(-1)).toBe(`/v1/charges?created%5Bgte%5D=${1700000000 - 7 * 86400}&limit=100`);
    } finally {
      now.mockRestore();
    }
  });

  it('bounds a LIMIT only when the whole WHERE reached Stripe', async () => {
    await walk(meta(), 'Charges', { limit: 2 });
    expect(listings().at(-1)).toBe('/v1/charges?limit=2');
    await walk(meta(), 'Charges', { where: eq('Status', 'failed'), limit: 2 });
    expect(listings().at(-1)).toBe('/v1/charges?limit=100');
  });

  it('pages a listing by cursor', async () => {
    for (let i = 0; i < 120; i++) fake.charge(stripeCharge({ id: `ch_${String(i).padStart(3, '0')}`, created: 1710000000 + i }));
    expect((await walk(meta(), 'Charges')).length).toBe(124);
    expect(listings()).toEqual(['/v1/charges?limit=100', '/v1/charges?limit=100&starting_after=ch_020']);
  });

  it('is a customer’s Charges: the customer reaches Stripe', async () => {
    const [ada] = await walk(meta(), 'Customers', { where: eq('Email', 'ada@example.com') });
    expect((await walk(ada!, 'Charges')).length).toBe(2);
    expect(listings().at(-1)).toBe('/v1/charges?customer=cus_ada&limit=100');
  });

  it('is an invoice’s Charges: every attempt of the payment intent that pays it, newest first, failure reasons readable', async () => {
    const [invoice] = await walk(delivered(stripeEvent('invoice.payment_failed', stripeInvoice())), 'Invoice');
    const attempts = await walk(invoice!, 'Charges');
    expect(await Promise.all(attempts.map((c) => read(c, 'Id')))).toEqual(['ch_try2', 'ch_try1']);
    expect(await read(attempts[0], 'Failure Message')).toBe('Your card has expired.');
    expect(await read(attempts[0], 'Outcome Seller Message')).toBe('The bank returned the decline code `expired_card`.');
    expect(listings()).toEqual([`/v1/invoice_payments?invoice=in_1MtHbELkdIwHu7ixl4OzzPMv&limit=100`, `/v1/charges?payment_intent=${PI}&limit=100`]);
    expect(await walk(invoice!, 'Charges', { limit: 1, orderBy: { fieldId: 'Created', direction: 'desc' } })).toHaveLength(1);
  });

  it('is an invoice’s Charges through a charge made outside any payment intent, and none for a payment record', async () => {
    fake.invoice(stripeInvoice({ id: 'in_legacy', customer: 'cus_ada' }));
    fake.charge(stripeCharge({ id: 'ch_legacy', created: 1690000000 }));
    fake.invoicePayment(stripeInvoicePayment({ id: 'inpay_1', invoice: 'in_legacy', payment: { type: 'charge', charge: 'ch_legacy' } }));
    fake.invoicePayment(stripeInvoicePayment({ id: 'inpay_2', invoice: 'in_legacy', payment: { type: 'payment_record', payment_record: 'prec_1' } }));
    const [invoice] = await walk(delivered(stripeEvent('invoice.paid', stripeInvoice({ id: 'in_legacy' }))), 'Invoice');
    expect(await Promise.all((await walk(invoice!, 'Charges')).map((c) => read(c, 'Id')))).toEqual(['ch_legacy']);
    fake.invoice(stripeInvoice({ id: 'in_unpaid' }));
    const [unpaid] = await walk(delivered(stripeEvent('invoice.paid', stripeInvoice({ id: 'in_unpaid' }))), 'Invoice');
    expect(await walk(unpaid!, 'Charges')).toEqual([]);
  });

  it('leads from a charge to its customer, and to the invoice its payment intent paid', async () => {
    const [failed] = (await walk(meta(), 'Charges')).filter((c) => idOf(c) === 'ch_try1');
    const [customer] = await walk(failed!, 'Customer');
    expect(await read(customer, 'Name')).toBe('Jenny Rosen');
    const [invoice] = await walk(failed!, 'Invoice');
    expect(await read(invoice, 'Id')).toBe('in_1MtHbELkdIwHu7ixl4OzzPMv');
    expect(listings().slice(-2)).toEqual([
      `/v1/invoice_payments?payment%5Btype%5D=payment_intent&payment%5Bpayment_intent%5D=${PI}&limit=1`,
      '/v1/invoices/in_1MtHbELkdIwHu7ixl4OzzPMv',
    ]);
    const [yen] = (await walk(meta(), 'Charges')).filter((c) => idOf(c) === 'ch_yen');
    expect(await walk(yen!, 'Invoice')).toEqual([]);
    expect(await walk(yen!, 'Customer')).toHaveLength(1);
  });

  it('is the charge a charge event carries, typed, with no call to Stripe', async () => {
    const event = delivered(stripeEvent('charge.failed', failedAt('ch_evt', 1686089900)));
    expect(await read(event, 'Type')).toBe('charge.failed');
    const [charge] = await walk(event, 'Charge');
    expect(await read(charge, 'Failure Code')).toBe('expired_card');
    expect(await read(charge, 'Amount')).toBe(10.99);
    expect(await walk(event, 'Invoice')).toEqual([]);
    expect(fake.requests).toEqual([]);
    expect(STRIPE_EVENT_TYPES).toEqual(expect.arrayContaining(['charge.succeeded', 'charge.failed', 'charge.refunded']));
  });
});

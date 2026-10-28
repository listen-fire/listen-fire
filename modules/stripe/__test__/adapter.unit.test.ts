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
import { stripeCustomer, stripeEvent, stripeInvoice, stripeSubscription, type Json } from './fixtures';

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

async function walk(from: SourcePosition, edge: string, extra: { where?: Expression; limit?: number } = {}): Promise<SourcePosition[]> {
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

const listings = () => fake.requests.map((r) => r.path);

describe('StripeAdapter surface', () => {
  it('projects to a checker schema with the three collections, the event and every type', async () => {
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
    expect(Object.keys(schema.collections).sort()).toEqual(['Customers', 'Invoices', 'Subscriptions']);
    expect(Object.keys(schema.positions).sort()).toEqual(expect.arrayContaining(['Customer', 'Event', 'Invoice', 'Subscription']));
    expect(schema.positions['Customer']?.propertyCapabilities?.['Email']).toEqual({ filterOperators: ['eq'] });
    expect(notes.filter((n) => n.includes('root descriptor'))).toEqual([]);
  });

  it('types an event’s Type as Stripe’s event types, and its object as three edges', async () => {
    const event = await adapter.describe(STRIPE_EVENT_DISPLAY_NAME);
    expect(event?.fields.find((f) => f.displayName === 'Type')).toMatchObject({ kind: 'enum', enumValues: [...STRIPE_EVENT_TYPES] });
    expect(event?.references.map((r) => [r.name, r.targetTypeId, r.cardinality])).toEqual([
      ['Invoice', 'stripe:invoice', 'one'],
      ['Subscription', 'stripe:subscription', 'one'],
      ['Customer', 'stripe:customer', 'one'],
    ]);
  });

  it('writes nothing: no field or edge is writable', async () => {
    for (const type of ['Customer', 'Invoice', 'Subscription', 'Event']) {
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

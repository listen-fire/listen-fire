// The door as a host loads the module: a Stripe delivery checked against the
// connection's signing secret, and what an accepted one becomes.

import type { CredentialFields, ModuleCredential } from 'module-kit';
import type { InboundCheckInput } from 'movement-engine/public/adapter';

import { adapterInProcess, refusingFiles, refusingKv, stripeSignature } from 'module-kit';

import { stripeModule } from '../index';
import { stripeCustomer, stripeEvent, stripeFailedCharge, stripeInvoice, stripeSubscription } from './fixtures';

const SECRET = 'whsec_test_secret';
const silent = { debug: () => {}, info: () => {}, warn: jest.fn(), error: () => {} };

function load(fields: CredentialFields) {
  const credential: ModuleCredential = { name: 'acme_stripe', fields: async () => fields, update: async () => {} };
  return adapterInProcess(stripeModule, {
    tenant: 'team-1',
    credential,
    fetch: globalThis.fetch,
    log: silent,
    files: refusingFiles('no files'),
    kv: refusingKv('no kv'),
    validateResults: true,
  }).adapter;
}

const now = () => Math.floor(Date.now() / 1000);

function post(body: string, headers: Record<string, string> = {}, method = 'POST'): InboundCheckInput {
  return { request: { method, path: '/hooks/stripe/acme_stripe', query: '', headers, body: Buffer.from(body).toString('base64') } };
}

const signed = (body: string, secret = SECRET, at = now()) => post(body, { 'stripe-signature': stripeSignature(secret, body, at) });

const FAILED = JSON.stringify(stripeEvent('invoice.payment_failed', stripeInvoice(), { id: 'evt_failed_1' }));

describe('a Stripe delivery', () => {
  const stripe = load({ apiKey: 'rk_test_x', webhookSecret: SECRET });

  it('is one arrival on the Changes of the invoice it is about, carrying the invoice, named by its event id', async () => {
    const answer = await stripe.checkInbound!(signed(FAILED));
    expect(answer).toMatchObject({
      outcome: 'accepted',
      deliveryId: 'evt_failed_1',
      events: [],
      arrivals: [
        {
          edge: 'Changes',
          key: 'in_1MtHbELkdIwHu7ixl4OzzPMv',
          identity: 'evt_failed_1',
          occurredAt: '2023-06-06T22:19:30.000Z',
          about: { recordType: 'Invoice', externalId: 'in_1MtHbELkdIwHu7ixl4OzzPMv' },
          landing: {
            recordId: 'evt_failed_1',
            recordType: 'InvoiceChange',
            fields: { Id: 'evt_failed_1', Kind: 'payment_failed', Type: 'invoice.payment_failed', id: 'evt_failed_1', kind: 'payment_failed', object: { id: 'in_1MtHbELkdIwHu7ixl4OzzPMv', object: 'invoice' } },
          },
          parents: [{ recordId: 'in_1MtHbELkdIwHu7ixl4OzzPMv', recordType: 'Invoice', fields: { id: 'in_1MtHbELkdIwHu7ixl4OzzPMv', Id: 'in_1MtHbELkdIwHu7ixl4OzzPMv', Status: 'open' } }],
        },
      ],
    });
  });

  it('is named the same on a retry, so the host runs it once', async () => {
    const first = await stripe.checkInbound!(signed(FAILED));
    const retry = await stripe.checkInbound!(signed(FAILED, SECRET, now() + 30));
    expect([first, retry].map((a) => ('deliveryId' in a ? a.deliveryId : undefined))).toEqual(['evt_failed_1', 'evt_failed_1']);
  });

  it('is refused (401) unsigned, signed with another secret, or stale', async () => {
    for (const request of [post(FAILED), signed(FAILED, 'whsec_other'), signed(FAILED, SECRET, now() - 600)]) {
      expect(await stripe.checkInbound!(request)).toEqual({ outcome: 'refused', status: 401 });
    }
  });

  it('is accepted unsigned, stale or on a connection with no signing secret when the host replays its own capture of it', async () => {
    const replayed = (request: InboundCheckInput): InboundCheckInput => ({ ...request, replayed: true });
    const hour = 3600;
    for (const [conn, request] of [
      [stripe, signed(FAILED, SECRET, now() - hour * 24 * 3)],
      [stripe, post(FAILED)],
      [load({ apiKey: 'rk_test_x' }), post(FAILED)],
    ] as const) {
      expect(await conn.checkInbound!(replayed(request))).toMatchObject({ outcome: 'accepted', deliveryId: 'evt_failed_1' });
    }
  });

  it('is refused whatever a sender puts in the request to say it was replayed: only the host\'s call says so', async () => {
    const stale = signed(FAILED, SECRET, now() - 600);
    const forged: InboundCheckInput[] = [
      { ...stale, request: { ...stale.request, headers: { ...stale.request.headers, replayed: 'true', 'x-replayed': 'true' } } },
      { ...stale, request: { ...stale.request, query: 'replayed=true' } },
      { ...stale, request: { ...stale.request, body: Buffer.from(JSON.stringify({ ...JSON.parse(FAILED), replayed: true })).toString('base64') } },
      { ...stale, replayed: false },
    ];
    for (const request of forged) {
      expect(await stripe.checkInbound!(request)).toEqual({ outcome: 'refused', status: 401 });
    }
  });

  it('is refused (401) on a connection whose credential holds no signing secret, saying what to set', async () => {
    silent.warn.mockClear();
    expect(await load({ apiKey: 'rk_test_x' }).checkInbound!(signed(FAILED))).toEqual({ outcome: 'refused', status: 401 });
    expect(silent.warn).toHaveBeenCalledWith(expect.stringContaining('holds no webhookSecret'));
  });

  it('is answered 200 and runs nothing when its type is not one this module types', async () => {
    const dispute = JSON.stringify(stripeEvent('charge.dispute.created', { id: 'dp_1', object: 'dispute' }));
    expect(await stripe.checkInbound!(signed(dispute))).toMatchObject({ outcome: 'reply', status: 200, json: { received: true, ignored: expect.stringContaining('charge.dispute.created is not an event @lf/stripe types') } });
  });

  it('is answered 400 when the body is not a Stripe event, and 405 when it is not a POST', async () => {
    for (const body of ['not json', '{"id":"pay_1"}', JSON.stringify({ ...stripeEvent('invoice.paid', stripeInvoice()), data: {} })]) {
      expect(await stripe.checkInbound!(signed(body))).toMatchObject({ outcome: 'reply', status: 400, json: { error: 'not_a_stripe_event' } });
    }
    expect(await stripe.checkInbound!(post('', {}, 'GET'))).toMatchObject({ outcome: 'reply', status: 405 });
  });

  it('carries the previous attributes of an update', async () => {
    const updated = stripeEvent('customer.subscription.updated', stripeSubscription(), { data: { object: stripeSubscription(), previous_attributes: { status: 'active' } } });
    const answer = await stripe.checkInbound!(signed(JSON.stringify(updated)));
    expect(answer).toMatchObject({ outcome: 'accepted', arrivals: [{ about: { recordType: 'Subscription' }, landing: { fields: { Kind: 'updated', 'Previous Attributes': { status: 'active' } } } }] });
  });

  it('is one arrival on a charge’s Changes for a charge event, carrying the charge', async () => {
    const failed = JSON.stringify(stripeEvent('charge.failed', stripeFailedCharge(), { id: 'evt_charge_1' }));
    expect(await stripe.checkInbound!(signed(failed))).toMatchObject({
      outcome: 'accepted',
      deliveryId: 'evt_charge_1',
      arrivals: [{ edge: 'Changes', identity: 'evt_charge_1', landing: { fields: { Kind: 'failed', object: { object: 'charge', failure_code: 'expired_card' } } }, parents: [{ recordType: 'Charge', fields: { 'Failure Code': 'expired_card' } }] }],
    });
  });

  it('lands a customer event on the customer’s Changes, and a subscription event on the subscription’s, though both start customer.', async () => {
    const created = await stripe.checkInbound!(signed(JSON.stringify(stripeEvent('customer.created', stripeCustomer()))));
    expect(created).toMatchObject({ outcome: 'accepted', arrivals: [{ about: { recordType: 'Customer' }, landing: { fields: { Kind: 'created' } } }] });
    const subscribed = await stripe.checkInbound!(signed(JSON.stringify(stripeEvent('customer.subscription.created', stripeSubscription()))));
    expect(subscribed).toMatchObject({ outcome: 'accepted', arrivals: [{ about: { recordType: 'Subscription' }, landing: { fields: { Kind: 'created' } } }] });
  });
});

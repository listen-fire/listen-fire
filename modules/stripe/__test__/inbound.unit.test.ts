// The door as a host loads the module: a Stripe delivery checked against the
// connection's signing secret, and what an accepted one becomes.

import type { CredentialFields, ModuleCredential } from 'module-kit';
import type { InboundCheckInput } from 'movement-engine/public/adapter';

import { adapterInProcess, refusingFiles, refusingKv, stripeSignature } from 'module-kit';

import { stripeModule } from '../index';
import { stripeCustomer, stripeEvent, stripeInvoice, stripeSubscription } from './fixtures';

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

  it('is one Event, labelled with its type and named by its event id', async () => {
    const answer = await stripe.checkInbound!(signed(FAILED));
    expect(answer).toMatchObject({
      outcome: 'accepted',
      deliveryId: 'evt_failed_1',
      events: [
        {
          tag: 'stripe:event',
          eventType: 'invoice.payment_failed',
          occurredAt: '2023-06-06T22:19:30.000Z',
          payload: { id: 'evt_failed_1', type: 'invoice.payment_failed', created: '2023-06-06T22:19:30.000Z', livemode: false, api_version: '2025-03-31.basil', object: { id: 'in_1MtHbELkdIwHu7ixl4OzzPMv', object: 'invoice' } },
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

  it('is refused (401) on a connection whose credential holds no signing secret, saying what to set', async () => {
    silent.warn.mockClear();
    expect(await load({ apiKey: 'rk_test_x' }).checkInbound!(signed(FAILED))).toEqual({ outcome: 'refused', status: 401 });
    expect(silent.warn).toHaveBeenCalledWith(expect.stringContaining('holds no webhookSecret'));
  });

  it('is answered 200 and runs nothing when its type is not one this module types', async () => {
    const charge = JSON.stringify(stripeEvent('charge.failed', { id: 'ch_1', object: 'charge' }));
    expect(await stripe.checkInbound!(signed(charge))).toMatchObject({ outcome: 'reply', status: 200, json: { received: true, ignored: expect.stringContaining('charge.failed is not an event @lf/stripe types') } });
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
    expect(answer).toMatchObject({ outcome: 'accepted', events: [{ eventType: 'customer.subscription.updated', payload: { previous_attributes: { status: 'active' } } }] });
  });

  it('types every customer, subscription and invoice event', async () => {
    const created = await stripe.checkInbound!(signed(JSON.stringify(stripeEvent('customer.created', stripeCustomer()))));
    expect(created).toMatchObject({ outcome: 'accepted', events: [{ eventType: 'customer.created' }] });
  });
});

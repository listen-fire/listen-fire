// The module as a host loads it: its check of a request at the door, with the
// connection's credential, and the manifest it declares.

import type { CredentialFields, ModuleCredential } from 'module-kit';
import type { InboundCheckInput } from 'movement-engine/public/adapter';

import { adapterInProcess, refusingFiles, refusingKv } from 'module-kit';

import { webhookModule } from '../index';
import { stripeSignature } from '../signing';

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function loaded(fields: CredentialFields) {
  const credential: ModuleCredential = { name: 'StripeHook', fields: async () => fields, update: async () => {} };
  return adapterInProcess(webhookModule, {
    tenant: 'team-1',
    credential,
    fetch: globalThis.fetch,
    log: silent,
    files: refusingFiles('no files'),
    kv: refusingKv('no kv'),
    validateResults: true,
  });
}

const load = (fields: CredentialFields) => loaded(fields).adapter;

function post(body: string, headers: Record<string, string> = {}, method = 'POST'): InboundCheckInput {
  return { request: { method, path: '/hooks/webhook/StripeHook', query: '', headers, body: Buffer.from(body).toString('base64') } };
}

const BODY = '{"id":"pay_1","amount":1200}';
const now = () => Math.floor(Date.now() / 1000);

describe('checkInbound', () => {
  const stripe = load({ scheme: 'stripe', secret: 'whsec_test' });

  it('accepts a signed delivery as one event, its body the payload', async () => {
    const answer = await stripe.checkInbound!(post(BODY, { 'stripe-signature': stripeSignature('whsec_test', BODY, now()) }));
    expect(answer).toEqual({ outcome: 'accepted', events: [{ payload: { id: 'pay_1', amount: 1200 }, tag: 'delivery' }] });
  });

  it('refuses (401) an unsigned, mis-signed or stale delivery', async () => {
    const unsigned: Record<string, string> = {};
    for (const headers of [unsigned, { 'stripe-signature': stripeSignature('whsec_wrong', BODY, now()) }, { 'stripe-signature': stripeSignature('whsec_test', BODY, now() - 3600) }]) {
      expect(await stripe.checkInbound!(post(BODY, headers))).toEqual({ outcome: 'refused', status: 401 });
    }
  });

  it('answers 400 for a body that is not a JSON object, and 405 for a GET', async () => {
    for (const body of ['not json', '[1,2]']) {
      const answer = await stripe.checkInbound!(post(body, { 'stripe-signature': stripeSignature('whsec_test', body, now()) }));
      expect(answer).toMatchObject({ outcome: 'reply', status: 400, json: { error: 'body_not_object' } });
    }
    expect(await stripe.checkInbound!(post('', {}, 'GET'))).toMatchObject({ outcome: 'reply', status: 405 });
  });

  it('accepts an unsigned delivery when the credential says none', async () => {
    const open = load({ scheme: 'none' });
    expect(await open.checkInbound!(post(BODY))).toMatchObject({ outcome: 'accepted' });
  });
});

describe('the connection', () => {
  it('fails describing when its credential does not say how it is signed', async () => {
    await expect(load({ scheme: 'stripe' }).listEntryPoints()).rejects.toThrow('the webhook credential StripeHook is signed with stripe but holds no secret');
  });

  it('declares its door, its payload key and its one event', async () => {
    const { manifest } = loaded({ scheme: 'none' });
    expect(manifest['inbound']).toEqual({ providerKey: 'webhook', scheme: 'module', secretIssuedBy: 'provider' });
    expect(manifest['listenConfig']).toEqual([{ key: 'payload', required: true, format: 'type' }]);
    expect(manifest['methods']).toEqual(expect.arrayContaining(['checkInbound', 'listEventTypes']));
    expect(await load({ scheme: 'none' }).listEventTypes!()).toEqual([{ tag: 'delivery', positionType: 'Delivery' }]);
  });
});

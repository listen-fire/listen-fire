// The module as a host loads it: its check of a request at the door, with the
// connection's credential, and the manifest it declares.

import type { CredentialFields, ModuleCredential } from 'module-kit';
import type { InboundCheckInput } from 'movement-engine/public/adapter';

import { adapterInProcess, hmacSha256Hex, refusingFiles, refusingKv } from 'module-kit';

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

  it('accepts a signed delivery as one arrival on Requests, its body the landing’s fields', async () => {
    const answer = await stripe.checkInbound!(post(BODY, { 'stripe-signature': stripeSignature('whsec_test', BODY, now()) }));
    expect(answer).toEqual({
      outcome: 'accepted',
      events: [],
      arrivals: [{ edge: 'Requests', identity: 'pay_1', landing: { recordType: 'Request', fields: { id: 'pay_1', amount: 1200 } } }],
      deliveryId: 'pay_1',
    });
  });

  it('names an arrival the sender names nothing by afresh each time', async () => {
    const open = load({ scheme: 'none' });
    const identities = await Promise.all([1, 2].map(async () => ((await open.checkInbound!(post('{"amount":1}'))) as { arrivals: Array<{ identity: string }> }).arrivals[0]?.identity));
    expect(identities[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(identities[0]).not.toEqual(identities[1]);
  });

  it('names a Stripe delivery by the body’s id, so a retry is the same delivery', async () => {
    const sign = (body: string) => ({ 'stripe-signature': stripeSignature('whsec_test', body, now()) });
    const first = await stripe.checkInbound!(post(BODY, sign(BODY)));
    const retry = await stripe.checkInbound!(post(BODY, sign(BODY)));
    expect(first).toMatchObject({ deliveryId: 'pay_1' });
    expect(retry).toMatchObject({ deliveryId: 'pay_1' });
    const noId = '{"amount":1}';
    expect(await stripe.checkInbound!(post(noId, sign(noId)))).not.toHaveProperty('deliveryId');
  });

  it('names a delivery by the credential’s idField on the other schemes, and by nothing when it names none', async () => {
    const body = '{"ref":"r-9","amount":1}';
    const keyed = load({ scheme: 'none', idField: 'ref' });
    expect(await keyed.checkInbound!(post(body))).toMatchObject({ deliveryId: 'r-9' });
    const signature = hmacSha256Hex('s3', body);
    const signed = load({ scheme: 'hmac-sha256', secret: 's3', header: 'x-sig', idField: 'ref' });
    expect(await signed.checkInbound!(post(body, { 'x-sig': signature }))).toMatchObject({ deliveryId: 'r-9' });
    const unkeyed = load({ scheme: 'none' });
    expect(await unkeyed.checkInbound!(post(body))).not.toHaveProperty('deliveryId');
    expect(await keyed.checkInbound!(post('{"amount":1}'))).not.toHaveProperty('deliveryId');
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

  it('declares its door, its one listenable edge, and how a 0.12 payload listen becomes it', async () => {
    const { manifest } = loaded({ scheme: 'none' });
    expect(manifest['inbound']).toEqual({ providerKey: 'webhook', scheme: 'module', secretIssuedBy: 'provider' });
    expect(manifest).not.toHaveProperty('listenConfig');
    expect(manifest['listenSettingsBecome']).toEqual({ path: ['Requests'], aliases: ['r'], keys: { payload: { hop: 0, op: 'type' } } });
    expect(manifest['methods']).toEqual(expect.arrayContaining(['checkInbound']));
    expect(manifest['methods']).not.toContain('listEventTypes');
    expect(manifest['protocolMinor']).toBe(6);
    expect(await load({ scheme: 'none' }).listEntryPoints()).toEqual([
      { typeId: 'Request', displayName: 'Request', collectionName: 'Requests', writable: false, readable: false, listenable: true, delivery: 'connection' },
    ]);
    expect(await load({ scheme: 'none' }).describe('Request')).toBeNull();
  });
});

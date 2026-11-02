// Email's own check of a request at its inbound door: a Mailgun form post or
// a Resend (Svix) notification, signed with the subscription's secret.

import { createHmac } from 'node:crypto';

import type { CredentialFields, ModuleCredential } from 'module-kit';
import type { InboundCheckInput } from 'movement-engine/public/adapter';
import { arrivalTriggerOf } from 'movement-engine/public/inbound';

import { adapterInProcess, refusingFiles, refusingKv } from 'module-kit';

import { emailModule } from '../index';
import { svixSignature } from '../inbound/svix';

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function load(fields: CredentialFields = {}) {
  const calls: string[] = [];
  const fetch: typeof globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('/attachments')) return new Response(JSON.stringify({ data: [], has_more: false }));
    return new Response(JSON.stringify({ id: 'em_1', from: 'Ada <ada@example.com>', to: ['in+k@lf.test'], subject: 'Hello', text: 'Hi', message_id: '<m-1@example.com>' }));
  };
  const credential: ModuleCredential = { name: 'email', fields: async () => fields, update: async () => {} };
  const loaded = adapterInProcess(emailModule, {
    tenant: 'team-1',
    credential,
    fetch,
    log: silent,
    files: refusingFiles('no files'),
    kv: refusingKv('no kv'),
    validateResults: true,
  });
  return { adapter: loaded.adapter, calls };
}

function request(input: { body: string; headers?: Record<string, string>; secret?: string; method?: string }): InboundCheckInput {
  return {
    request: {
      method: input.method ?? 'POST',
      path: '/api/public/webhook-sync/email/mail',
      query: '',
      headers: input.headers ?? {},
      body: Buffer.from(input.body, 'utf-8').toString('base64'),
    },
    ...(input.secret !== undefined ? { secret: input.secret } : {}),
  };
}

const MAILGUN_KEY = 'mailgun-signing-key';

function mailgunForm(key = MAILGUN_KEY, headers: Record<string, string> = {}): string {
  const timestamp = '1760000000';
  const token = 'tok-1';
  const signature = createHmac('sha256', key).update(timestamp + token).digest('hex');
  return new URLSearchParams({
    ...headers,
    sender: 'ada@example.com',
    recipient: 'in+k@lf.test',
    To: 'in+k@lf.test',
    subject: 'Hello',
    'body-plain': 'Hi there',
    'Message-Id': '<m-1@example.com>',
    timestamp,
    token,
    signature,
  }).toString();
}

const RESEND_SECRET = `whsec_${Buffer.from('resend-secret').toString('base64')}`;

function resendDelivery(body: string, secret = RESEND_SECRET): Record<string, string> {
  const id = 'msg_1';
  const timestamp = String(Math.floor(Date.now() / 1000));
  return { 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': `v1,${svixSignature({ secret, id, timestamp, body })}` };
}

describe('@lf/email checks its own inbound', () => {
  it('accepts a Mailgun post signed with the key, as one email arriving on Emails under its plus-suffix', async () => {
    const { adapter } = load();
    const answer = await adapter.checkInbound!(request({ body: mailgunForm(), secret: MAILGUN_KEY }));
    expect(answer.outcome).toBe('accepted');
    if (answer.outcome !== 'accepted') return;
    expect(answer.events).toEqual([]);
    expect(answer.arrivals).toHaveLength(1);
    expect(answer.arrivals?.[0]).toMatchObject({
      edge: 'Emails',
      identity: '<m-1@example.com>',
      landing: { recordType: 'Email', fields: { bodyText: 'Hi there', subject: 'Hello', sender: 'ada@example.com', Key: 'k' } },
    });
    expect(answer.arrivals?.[0]).not.toHaveProperty('key');
  });

  it("carries only the email's own fields: Mailgun's token, timestamp and signature prove the post and are never in the record", async () => {
    const { adapter } = load();
    const answer = await adapter.checkInbound!(request({ body: mailgunForm(), secret: MAILGUN_KEY }));
    expect(answer.outcome).toBe('accepted');
    if (answer.outcome !== 'accepted') return;
    const arrival = answer.arrivals?.[0];
    const fields = arrival !== undefined && 'landing' in arrival ? arrival.landing.fields : {};
    for (const signing of ['token', 'timestamp', 'signature']) expect(fields).not.toHaveProperty(signing);
    expect(fields).toMatchObject({ subject: 'Hello', sender: 'ada@example.com', recipient: 'in+k@lf.test' });
    expect(JSON.stringify(answer)).not.toContain('tok-1');
  });

  it('refuses a Mailgun post signed with another key (406, never retried)', async () => {
    const { adapter } = load();
    expect(await adapter.checkInbound!(request({ body: mailgunForm('wrong'), secret: MAILGUN_KEY }))).toEqual({ outcome: 'refused', status: 406 });
  });

  it('refuses a Mailgun post with no signature, and any post when no key is set', async () => {
    const { adapter } = load();
    const unsigned = new URLSearchParams({ sender: 'ada@example.com', subject: 'x' }).toString();
    expect(await adapter.checkInbound!(request({ body: unsigned, secret: MAILGUN_KEY }))).toEqual({ outcome: 'refused', status: 406 });
    expect(await adapter.checkInbound!(request({ body: mailgunForm() }))).toEqual({ outcome: 'refused', status: 401 });
  });

  it('accepts a Resend notification signed with the secret, fetching the message', async () => {
    const { adapter, calls } = load({ resendApiKey: 're_1' });
    const body = JSON.stringify({ type: 'email.received', data: { email_id: 'em_1', from: 'ada@example.com', to: ['in+k@lf.test'] } });
    const answer = await adapter.checkInbound!(request({ body, headers: resendDelivery(body), secret: RESEND_SECRET }));
    expect(answer.outcome).toBe('accepted');
    if (answer.outcome !== 'accepted') return;
    expect(answer.arrivals?.[0]).toMatchObject({ edge: 'Emails', identity: '<m-1@example.com>', landing: { fields: { subject: 'Hello', bodyText: 'Hi' } } });
    expect(calls[0]).toBe('https://api.resend.com/emails/receiving/em_1');
  });

  it("the run an email fires reads its sender as the actor, and a forwarding inbox it came through as a relay", async () => {
    const { adapter } = load({ resendApiKey: 're_1' });
    /** The event the run the delivery's one arrival fires is handed, as the host hands it. */
    const fired = async (input: InboundCheckInput) => {
      const answer = await adapter.checkInbound!(input);
      const arrival = answer.outcome === 'accepted' ? answer.arrivals?.[0] : undefined;
      if (arrival === undefined || 'gone' in arrival) throw new Error('no email arrived');
      return arrivalTriggerOf({ pipelineInputId: 'inbox:triage', adapterType: 'email', arrival, now: new Date() });
    };
    const forwarded = await fired(request({ body: mailgunForm(MAILGUN_KEY, { 'X-Forwarded-For': 'dealflow@fund.example' }), secret: MAILGUN_KEY }));
    expect(await adapter.extractActor!({ event: forwarded })).toMatchObject({ identifier: 'ada@example.com', scheme: 'email', email: 'ada@example.com' });
    expect((await adapter.getActorCandidates!({ event: forwarded })).map((c) => [c.identity.identifier, c.source])).toEqual([
      ['ada@example.com', 'originator'],
      ['dealflow@fund.example', 'relay'],
      ['in+k@lf.test', 'relay'],
    ]);
    const body = JSON.stringify({ type: 'email.received', data: { email_id: 'em_1', from: 'Ada <ada@example.com>', to: ['in+k@lf.test'] } });
    const sent = await fired(request({ body, headers: resendDelivery(body), secret: RESEND_SECRET }));
    expect(await adapter.extractActor!({ event: sent })).toMatchObject({ identifier: 'ada@example.com', name: 'Ada', label: 'Ada' });
    // The door names the sender on the arrival itself, and a run reads that.
    expect(sent.arrival?.actor).toEqual({ identifier: 'ada@example.com', scheme: 'email', adapterType: 'email', email: 'ada@example.com', name: 'Ada', label: 'Ada' });
    expect(forwarded.arrival?.actor).toEqual({ identifier: 'ada@example.com', scheme: 'email', adapterType: 'email', email: 'ada@example.com', label: 'ada@example.com' });
  });

  it('refuses a Resend notification with a bad or missing signature', async () => {
    const { adapter, calls } = load({ resendApiKey: 're_1' });
    const body = JSON.stringify({ type: 'email.received', data: { email_id: 'em_1', from: 'ada@example.com' } });
    const forged = resendDelivery(body, `whsec_${Buffer.from('other').toString('base64')}`);
    expect(await adapter.checkInbound!(request({ body, headers: forged, secret: RESEND_SECRET }))).toEqual({ outcome: 'refused', status: 406 });
    expect(await adapter.checkInbound!(request({ body, headers: { 'svix-id': 'msg_1' }, secret: RESEND_SECRET }))).toEqual({ outcome: 'refused', status: 406 });
    expect(await adapter.checkInbound!(request({ body, headers: resendDelivery(body) }))).toEqual({ outcome: 'refused', status: 401 });
    expect(calls).toEqual([]);
  });

  it('accepts a Mailgun post signed with another key, and a Resend notification stale or unsigned, when the host replays its own capture of it, and only then', async () => {
    const { adapter, calls } = load({ resendApiKey: 're_1' });
    const mailgun = await adapter.checkInbound!({ ...request({ body: mailgunForm('wrong') }), replayed: true });
    expect(mailgun).toMatchObject({ outcome: 'accepted', arrivals: [{ edge: 'Emails' }] });
    const body = JSON.stringify({ type: 'email.received', data: { email_id: 'em_1', from: 'ada@example.com', to: ['in+k@lf.test'] } });
    const stale = { 'svix-id': 'msg_1', 'svix-timestamp': String(Math.floor(Date.now() / 1000) - 86_400), 'svix-signature': 'v1,not-the-signature' };
    const resend = await adapter.checkInbound!({ ...request({ body, headers: stale }), replayed: true });
    expect(resend).toMatchObject({ outcome: 'accepted', arrivals: [{ edge: 'Emails', identity: '<m-1@example.com>' }] });
    // The message is still fetched afresh: replay skips the check, not the lookup.
    expect(calls[0]).toBe('https://api.resend.com/emails/receiving/em_1');
    expect(await adapter.checkInbound!({ ...request({ body: mailgunForm('wrong'), headers: { replayed: 'true' }, secret: MAILGUN_KEY }), replayed: false })).toEqual({ outcome: 'refused', status: 406 });
    expect(await adapter.checkInbound!(request({ body, headers: stale, secret: RESEND_SECRET }))).toEqual({ outcome: 'refused', status: 406 });
  });

  it('acknowledges a Resend event that is not mail arriving, running nothing', async () => {
    const { adapter } = load({ resendApiKey: 're_1' });
    const body = JSON.stringify({ type: 'email.delivered', data: {} });
    expect(await adapter.checkInbound!(request({ body, headers: resendDelivery(body), secret: RESEND_SECRET }))).toEqual({ outcome: 'accepted', events: [] });
  });

  it('takes no GET', async () => {
    const { adapter } = load();
    expect(await adapter.checkInbound!(request({ body: '', method: 'GET', secret: MAILGUN_KEY }))).toEqual({ outcome: 'refused', status: 405 });
  });
});

// `@lf/webhook` in lf, end to end: a Stripe-signed connection and an unsigned
// one in one project, each a URL `lf serve` prints. The movement declares what
// a delivery carries (`node Payment`), `lf check` refuses a field it does not
// declare, and `lf serve` runs a correctly signed delivery (its amount reaches
// the fake CRM), refuses a mis-signed or stale one (401, no run), refuses a
// body that does not fit the declared node (400, naming the field, no run),
// and takes an unsigned delivery on the connection whose credential says none.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { companies, project, served } from './example';
import { lf, ok } from './interactive';
import { stripeSignature } from '../../../../modules/webhook/signing';

const PAYMENTS = `import { acme_crm, webhook } from adapters
import { acme, StripeHook, FormsHook } from credentials

crm = connect acme_crm using acme
stripe = connect webhook using StripeHook
forms = connect webhook using FormsHook

node Payment {
  id: <text>
  amount: <number>
  note: <text | null>
}

function \`Payment Failed\`(e: <Payment>) {
  write crm-[:Company]-> { Name: "\${e.id} failed: \${e.amount}" }
}

listen to stripe { payload: <Payment> } fire \`Payment Failed\`
listen to forms { payload: <Payment> } fire \`Payment Failed\`
`;

const SECRET = 'whsec_test_secret';

async function webhookProject(): Promise<string> {
  const dir = project();
  rmSync(join(dir, 'movements/companies.mvt'));
  writeFileSync(join(dir, 'movements/payments.mvt'), PAYMENTS);
  const connected = await ok(lf(dir, ['connect', '@lf/webhook', '--yes'], { answers: [] }));
  assert.match(connected, /installed @lf\/webhook as externals\/webhook/);
  assert.doesNotMatch(connected, /webhooks are signed with/, 'the sender issues the secret: lf connect generates none');
  // Asked as a person answers: scheme, secret, header, encoding.
  assert.match(await ok(lf(dir, ['credential', 'add', '--module', 'webhook', 'StripeHook'], { answers: ['stripe', SECRET, '', ''] })), /added StripeHook/);
  assert.match(await ok(lf(dir, ['credential', 'add', '--module', 'webhook', 'FormsHook'], { answers: ['none', '', '', ''] })), /added FormsHook/);
  return dir;
}

function post(url: string, body: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body }).then(async (r) => ({ status: r.status, body: await r.text() }));
}

const now = () => Math.floor(Date.now() / 1000);

test('lf check types the event by the declared payload and refuses a field it does not declare', async () => {
  const dir = await webhookProject();
  const check = await lf(dir, ['check']).done;
  assert.equal(check.code, 0, check.out);

  writeFileSync(join(dir, 'movements/payments.mvt'), PAYMENTS.replace('failed: ${e.amount}', 'failed: ${e.currency}'));
  const refused = await lf(dir, ['check']).done;
  assert.equal(refused.code, 1, refused.out);
  assert.match(refused.out, /MOV_UNKNOWN_PROPERTY .*has no field 'currency' — it has: id, amount, note/);

  writeFileSync(join(dir, 'movements/payments.mvt'), PAYMENTS.replace('{ payload: <Payment> } fire `Payment Failed`\nlisten to forms', '{} fire `Payment Failed`\nlisten to forms'));
  const missing = await lf(dir, ['check']).done;
  assert.equal(missing.code, 1, missing.out);
  assert.match(missing.out, /MOV_LISTEN_BAD_CONFIG .*requires a 'payload' config/);
  console.log([refused.out.trim(), missing.out.trim()].join('\n'));
});

test('lf serve prints each connection’s URL, runs a signed delivery, and refuses a mis-signed, stale or misfitting one', async () => {
  const dir = await webhookProject();
  const serving = await served(dir);
  try {
    const stripeUrl = (await serving.waitFor(/^webhook StripeHook: /)).replace(/^webhook StripeHook: /, '');
    const formsUrl = (await serving.waitFor(/^webhook FormsHook: /)).replace(/^webhook FormsHook: /, '');
    assert.equal(stripeUrl, `http://127.0.0.1:${serving.port}/hooks/webhook/StripeHook`);

    const body = '{"id":"pay_1","amount":1200,"type":"payment_intent.payment_failed"}';
    const signedOk = await post(stripeUrl, body, { 'stripe-signature': stripeSignature(SECRET, body, now()) });
    assert.equal(signedOk.status, 202, signedOk.body);
    console.log(signedOk.body);
    assert.deepEqual(companies(dir), ['pay_1 failed: 1200']);

    const wrongSecret = await post(stripeUrl, body.replace('pay_1', 'pay_2'), { 'stripe-signature': stripeSignature('whsec_other', body.replace('pay_1', 'pay_2'), now()) });
    assert.equal(wrongSecret.status, 401, wrongSecret.body);
    const unsigned = await post(stripeUrl, body.replace('pay_1', 'pay_3'));
    assert.equal(unsigned.status, 401, unsigned.body);
    const stale = await post(stripeUrl, body.replace('pay_1', 'pay_4'), { 'stripe-signature': stripeSignature(SECRET, body.replace('pay_1', 'pay_4'), now() - 600) });
    assert.equal(stale.status, 401, stale.body);

    const misfit = '{"id":"pay_5","amount":"twelve"}';
    const refused = await post(stripeUrl, misfit, { 'stripe-signature': stripeSignature(SECRET, misfit, now()) });
    assert.equal(refused.status, 400, refused.body);
    assert.match(refused.body, /payload_mismatch/);
    assert.match(refused.body, /`amount` is text, not a number/);
    console.log(refused.body);
    assert.deepEqual(companies(dir), ['pay_1 failed: 1200'], 'nothing refused ran');

    const open = '{"id":"pay_6","amount":7}';
    const unsignedOpen = await post(formsUrl, open);
    assert.equal(unsignedOpen.status, 202, unsignedOpen.body);
    assert.deepEqual(companies(dir), ['pay_1 failed: 1200', 'pay_6 failed: 7']);
  } finally {
    await serving.stop();
  }
});

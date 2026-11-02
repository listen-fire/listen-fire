// `@lf/webhook` in listen-fire, end to end: a Stripe-signed connection and an unsigned
// one in one project, each a URL `listen-fire serve` prints. Each delivery arrives on
// the connection's `Requests` edge, its body untyped JSON, and the listen states what
// it is (`listen to stripe-[:Requests]-><Payment>`). `listen-fire check` refuses a field
// the node does not declare, and `listen-fire serve` runs a correctly signed delivery
// (its amount reaches the fake CRM), refuses a mis-signed or stale one (401, no run),
// refuses a body that does not fit the stated node (400, naming the field, no run),
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

listen to stripe-[:Requests]-><Payment> fire \`Payment Failed\`
listen to forms-[:Requests]-><Payment> fire \`Payment Failed\`
`;

const SECRET = 'whsec_test_secret';

async function webhookProject(): Promise<string> {
  const dir = project();
  rmSync(join(dir, 'movements/companies.mvt'));
  writeFileSync(join(dir, 'movements/payments.mvt'), PAYMENTS);
  const connected = await ok(lf(dir, ['connect', '@lf/webhook', '--yes'], { answers: [] }));
  assert.match(connected, /installed @lf\/webhook as externals\/webhook/);
  assert.doesNotMatch(connected, /webhooks are signed with/, 'the sender issues the secret: listen-fire connect generates none');
  // Asked as a person answers: scheme, secret, header, encoding, idField.
  assert.match(await ok(lf(dir, ['credential', 'add', '--module', 'webhook', 'StripeHook'], { answers: ['stripe', SECRET, '', '', ''] })), /added StripeHook/);
  assert.match(await ok(lf(dir, ['credential', 'add', '--module', 'webhook', 'FormsHook'], { answers: ['none', '', '', '', ''] })), /added FormsHook/);
  return dir;
}

function post(url: string, body: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body }).then(async (r) => ({ status: r.status, body: await r.text() }));
}

const now = () => Math.floor(Date.now() / 1000);

test('listen-fire check types the landing by the node the listen states and refuses a field it does not declare', async () => {
  const dir = await webhookProject();
  const check = await lf(dir, ['check']).done;
  assert.equal(check.code, 0, check.out);

  writeFileSync(join(dir, 'movements/payments.mvt'), PAYMENTS.replace('failed: ${e.amount}', 'failed: ${e.currency}'));
  const refused = await lf(dir, ['check']).done;
  assert.equal(refused.code, 1, refused.out);
  assert.match(refused.out, /MOV_UNKNOWN_PROPERTY .*has no field 'currency' — it has: id, amount, note/);

  writeFileSync(join(dir, 'movements/payments.mvt'), PAYMENTS.replace('stripe-[:Requests]-><Payment> fire', 'stripe-[:Requests]-> fire'));
  const missing = await lf(dir, ['check']).done;
  assert.equal(missing.code, 1, missing.out);
  assert.match(missing.out, /MOV_LISTEN_PARAM_MISMATCH .*what lands on '-\[:Requests\]->' is untyped — state its type after the traversal: `listen to stripe-\[:Requests\]-><Payment> fire `Payment Failed``/);
  console.log([refused.out.trim(), missing.out.trim()].join('\n'));
});

test('listen-fire serve prints each connection’s URL, runs a signed delivery, and refuses a mis-signed, stale or misfitting one', async () => {
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

test('a webhook delivery fires a listen whose function types its parameter by the payload node; a misfit runs nothing', async () => {
  const dir = await webhookProject();
  // Two listens on one connection, each stating another node: a delivery fits one.
  const refunds = PAYMENTS.replace(
    'listen to forms-[:Requests]-><Payment> fire `Payment Failed`',
    'node Refund {\n  refund: <text>\n}\n\nfunction refunded(r: <Refund>) {\n  write crm-[:Company]-> { Name: "refund ${r.refund}" }\n}\n\nlisten to forms-[:Requests]-><Payment> fire `Payment Failed`\nlisten to forms-[:Requests]-><Refund> fire refunded',
  );
  writeFileSync(join(dir, 'movements/payments.mvt'), refunds);
  const check = await lf(dir, ['check']).done;
  assert.equal(check.code, 0, check.out);
  const serving = await served(dir);
  try {
    const url = (await serving.waitFor(/^webhook FormsHook: /)).replace(/^webhook FormsHook: /, '');
    assert.equal((await post(url, '{"id":"pay_7","amount":3}')).status, 202);
    assert.equal((await post(url, '{"refund":"re_1"}')).status, 202);
    assert.deepEqual(companies(dir), ['pay_7 failed: 3', 'refund re_1'], 'each ran only the listen whose node it fits');
    // A delivery another listen took says nothing of the listen it does not fit.
    assert.equal(serving.lines.filter((l) => / is not a (Payment|Refund) /.test(l)).length, 0, serving.lines.join('\n'));
    // A body that fits neither node is refused, naming what each listen states.
    const misfit = await post(url, '{"id":"pay_8"}');
    assert.equal(misfit.status, 400, misfit.body);
    assert.match(misfit.body, /Payment, as the listen firing payments:Payment Failed states it: `amount` is missing/);
    assert.match(misfit.body, /Refund, as the listen firing payments:refunded states it: `refund` is missing/);
    assert.deepEqual(companies(dir), ['pay_7 failed: 3', 'refund re_1'], 'the misfit ran nothing');
  } finally {
    await serving.stop();
  }
});

test('a function over one of several payload nodes is fired by a listen stating either, and runs', async () => {
  const dir = await webhookProject();
  const settled = PAYMENTS.replace(
    'listen to forms-[:Requests]-><Payment> fire `Payment Failed`',
    'node Refund {\n  id: <text>\n  refund: <text>\n}\n\nfunction settled(e: <Payment | Refund>) {\n  write crm-[:Company]-> { Name: "settled ${e.id}" }\n}\n\nlisten to forms-[:Requests]-><Payment> fire settled\nlisten to forms-[:Requests]-><Refund> fire settled',
  );
  writeFileSync(join(dir, 'movements/payments.mvt'), settled);
  const check = await lf(dir, ['check']).done;
  assert.equal(check.code, 0, check.out);
  const serving = await served(dir);
  try {
    const url = (await serving.waitFor(/^webhook FormsHook: /)).replace(/^webhook FormsHook: /, '');
    assert.equal((await post(url, '{"id":"pay_7","amount":3}')).status, 202);
    assert.equal((await post(url, '{"id":"re_1","refund":"late"}')).status, 202);
    assert.deepEqual(companies(dir), ['settled pay_7', 'settled re_1'], serving.lines.join('\n'));
  } finally {
    await serving.stop();
  }
});

test('the same signed Stripe delivery posted twice runs once; the repeat is answered 2xx as a duplicate', async () => {
  const dir = await webhookProject();
  const serving = await served(dir);
  try {
    const url = (await serving.waitFor(/^webhook StripeHook: /)).replace(/^webhook StripeHook: /, '');
    const body = '{"id":"evt_1","amount":1200}';
    const sign = () => ({ 'stripe-signature': stripeSignature(SECRET, body, now()) });
    const first = await post(url, body, sign());
    assert.equal(first.status, 202, first.body);
    const again = await post(url, body, sign());
    assert.ok(again.status >= 200 && again.status < 300, again.body);
    assert.match(again.body, /"duplicate":\s*true/);
    assert.deepEqual(companies(dir), ['evt_1 failed: 1200'], 'the retry ran nothing');
    const other = '{"id":"evt_2","amount":5}';
    assert.equal((await post(url, other, { 'stripe-signature': stripeSignature(SECRET, other, now()) })).status, 202);
    assert.deepEqual(companies(dir), ['evt_1 failed: 1200', 'evt_2 failed: 5']);
    const receipts = JSON.parse(await ok(lf(dir, ['deliveries', '--json']))) as { deliveries: { externalId: string }[] };
    assert.deepEqual(receipts.deliveries.map((d) => d.externalId).sort(), ['evt_1', 'evt_2'], 'the retry kept no second receipt');
    console.log(again.body);
  } finally {
    await serving.stop();
  }
});

test('a delivery is acknowledged with what it brought, and its kept request holds no token the sender put in the query or the body', async () => {
  const dir = await webhookProject();
  // Under --doors-only the door answers with the module's acknowledgement (and the rows it queued).
  const doors = await served(dir, ['--doors-only']);
  try {
    const url = (await doors.waitFor(/^webhook FormsHook: /)).replace(/^webhook FormsHook: /, '');
    const answer = await post(`${url}?token=q-secret&source=form`, '{"id":"pay_9","amount":2,"token":"b-secret","api_key":"k-secret"}');
    assert.equal(answer.status, 202, answer.body);
    assert.equal((JSON.parse(answer.body) as { eventsProcessed: number }).eventsProcessed, 1, answer.body);
  } finally {
    await doors.stop();
  }
  const [delivery] = (JSON.parse(await ok(lf(dir, ['deliveries', '--json']))) as { deliveries: { id: string }[] }).deliveries;
  const kept = (JSON.parse(await ok(lf(dir, ['deliveries', 'show', delivery.id, '--request']))) as { delivery: { request: { query: string; body: string } } }).delivery.request;
  assert.equal(kept.query, 'source=form', 'the query keeps all but the token');
  assert.deepEqual(JSON.parse(Buffer.from(kept.body, 'base64').toString('utf8')), { id: 'pay_9', amount: 2 }, 'the body keeps all but the token and the key');
});

test('a payload node imported from another file gates deliveries like one declared in the file', async () => {
  const dir = await webhookProject();
  const types = 'export node Payment {\n  id: <text>\n  amount: <number>\n  note: <text | null>\n}\n';
  writeFileSync(join(dir, 'movements/types.mvt'), types);
  const [, rest] = PAYMENTS.split(/node Payment \{[^}]*\}\n\n/);
  const imports = PAYMENTS.split('\ncrm = connect')[0] + '\nimport { Payment } from "types"\n\ncrm = connect' + PAYMENTS.split('\ncrm = connect')[1].split('\nnode Payment')[0];
  writeFileSync(join(dir, 'movements/payments.mvt'), `${imports}\n${rest}`);
  const check = await lf(dir, ['check']).done;
  assert.equal(check.code, 0, check.out);
  const serving = await served(dir);
  try {
    const url = (await serving.waitFor(/^webhook StripeHook: /)).replace(/^webhook StripeHook: /, '');
    const misfit = '{"id":"pay_9","amount":"twelve"}';
    const refused = await post(url, misfit, { 'stripe-signature': stripeSignature(SECRET, misfit, now()) });
    assert.equal(refused.status, 400, refused.body);
    assert.match(refused.body, /`amount` is text, not a number/);
    assert.deepEqual(companies(dir), [], 'the misfit ran nothing');
  } finally {
    await serving.stop();
  }
});

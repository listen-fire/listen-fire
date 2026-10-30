// `@lf/stripe`'s charges, end to end: the two questions fresh agents could not
// answer before the module read charges (stripe_eval_programs.ts), checked
// against Stripe's types and run against the fake Stripe
// (modules/stripe/__test__/fake_stripe.ts) with Slack on packages/fake-channels.
//
// 1. a failed payment posts the customer's name, the amount and currency, and
//    Stripe's own reason (read from the invoice's failed charge) to #billing;
// 2. the weekly report counts and totals the last 7 days' successful charges
//    per currency and names the three largest with their customers.

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { test } from 'node:test';

import { lf as lfSync, served } from './example';
import { fakeChannels, type Fake } from './gmail_fixture';
import { lf, ok } from './interactive';
import { startFakeStripe, type FakeStripe } from '../../../../modules/stripe/__test__/fake_stripe';
import { stripeCharge, stripeCustomer, stripeEvent, stripeFailedCharge, stripeInvoice, stripeInvoicePayment } from '../../../../modules/stripe/__test__/fixtures';
import { stripeSignature } from '../../../../packages/module-kit/stripe_signature';
import { FAILED_PAYMENT, WEEKLY_CHARGES, WEEKLY_CHARGES_ON_DEMAND } from './stripe_eval_programs';

const API_KEY = 'rk_test_charges';
const SECRET = 'whsec_charges_secret';

const REPO = resolve(__dirname, '../../../..');
process.env.LF_MODULES_DIR ??= join(REPO, 'modules');
process.env.LF_SERVE_MODULE ??= join(REPO, 'apps/cli/node_modules/.bin/serve-module');

interface World {
  dir: string;
  stripe: FakeStripe;
  channels: Fake;
  close(): Promise<void>;
}

async function chargesWorld(program: string): Promise<World> {
  const stripe = await startFakeStripe({ apiKey: API_KEY });
  const channels = await fakeChannels();
  const close = async () => (await stripe.close(), await channels.stop());
  try {
    const dir = join(mkdtempSync(join(tmpdir(), 'lf-stripe-charges-')), 'project');
    assert.equal(lfSync(join(dir, '..'), 'init', 'project').code, 0);
    await ok(lf(dir, ['connect', '@lf/stripe', '--yes', '--base-url', stripe.url], { answers: [] }));
    assert.match(await ok(lf(dir, ['credential', 'add', '--module', 'stripe', 'stripe_account'], { answers: [API_KEY, SECRET] })), /added stripe_account/);
    await ok(lf(dir, ['connect', '@lf/slack', '--yes']));
    await ok(lf(dir, ['credential', 'add', '--module', '@lf/slack', 'team_slack'], { answers: ['xoxb-test', '', '', `${channels.url}/slack/`] }));
    const seeded = await fetch(`${channels.url}/admin/slack/seed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entities: [{ entity_type: 'channel', id: 'C010', data: { id: 'C010', name: 'billing', is_private: false, is_member: true, num_members: 4 } }] }),
    });
    assert.equal(seeded.status, 200);
    writeFileSync(join(dir, 'movements/hello.mvt'), program);
    return { dir, stripe, channels, close };
  } catch (error) {
    await close();
    throw error;
  }
}

const run = (dir: string, ...args: string[]) => lf(dir, args).done;

async function slackMessages(channels: Fake): Promise<string[]> {
  const rows = (await (await fetch(`${channels.url}/admin/slack/message/state`)).json()) as Array<{ channel: string; text: string; user: string }>;
  return rows.filter((m) => m.user === 'bot').map((m) => `${m.channel} ${m.text}`);
}

const now = () => Math.floor(Date.now() / 1000);
const DAY = 86_400;

function deliver(url: string, event: object): Promise<{ status: number; body: string }> {
  const body = JSON.stringify(event);
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': stripeSignature(SECRET, body, now()) }, body }).then(async (r) => ({
    status: r.status,
    body: await r.text(),
  }));
}

test('listen-fire check passes both programs, and refuses a charge field Stripe does not have', async () => {
  for (const [name, program] of [
    ['failed payment', FAILED_PAYMENT],
    ['weekly charges', WEEKLY_CHARGES],
    ['weekly charges, on demand', WEEKLY_CHARGES_ON_DEMAND],
  ] as const) {
    const world = await chargesWorld(program);
    try {
      const checked = await run(world.dir, 'check');
      assert.equal(checked.code, 0, `${name}: ${checked.out}`);
      assert.deepEqual(world.stripe.requests, [], 'checking reads nothing from Stripe');
    } finally {
      await world.close();
    }
  }
  const world = await chargesWorld(FAILED_PAYMENT.replace('attempt.`Failure Message`', 'attempt.failure_message'));
  try {
    const wrong = await run(world.dir, 'check');
    assert.equal(wrong.code, 1, wrong.out);
    assert.match(wrong.out, /MOV_UNKNOWN_PROPERTY .*failure_message/);
    assert.match(wrong.out, /Failure Message/, 'the diagnostic names the field Stripe has');
  } finally {
    await world.close();
  }
});

test('a failed payment posts the customer, the amount and Stripe’s reason to #billing', async () => {
  const world = await chargesWorld(FAILED_PAYMENT);
  const serving = await served(world.dir);
  try {
    const url = (await serving.waitFor(/^stripe stripe_account: /)).replace(/^stripe stripe_account: /, '');
    world.stripe.customer(stripeCustomer({ id: 'cus_diego', name: 'Diego Alvarez', email: 'diego@alvareztiles.es' }));
    const invoice = stripeInvoice({ id: 'in_diego', customer: 'cus_diego', customer_name: null, amount_due: 4900, currency: 'eur' });
    world.stripe.invoice(invoice);
    world.stripe.invoicePayment(stripeInvoicePayment({ invoice: 'in_diego', payment: { type: 'payment_intent', payment_intent: 'pi_diego' } }));
    // Two attempts: the older failed for another reason, the newest is the one to report.
    world.stripe.charge(stripeFailedCharge({ id: 'ch_first', created: 1700000000, payment_intent: 'pi_diego', customer: 'cus_diego', failure_message: 'Your card has insufficient funds.' }));
    world.stripe.charge(stripeFailedCharge({ id: 'ch_second', created: 1700086400, payment_intent: 'pi_diego', customer: 'cus_diego', currency: 'eur', failure_message: 'Your card has expired.' }));

    const delivered = await deliver(url, stripeEvent('invoice.payment_failed', invoice, { id: 'evt_diego' }));
    assert.equal(delivered.status, 202, delivered.body);
    const messages = await slackMessages(world.channels);
    assert.deepEqual(messages, ['C010 Payment failed: Diego Alvarez — €49 (eur). Stripe says: Your card has expired.']);

    const runs = await run(world.dir, 'runs');
    const id = runs.out.trim().split('\n').find((l) => l.includes('Payment Failed'))?.split(' ')[0] ?? '';
    const shown = await run(world.dir, 'runs', 'show', id);
    assert.equal(shown.code, 0, shown.out);
    assert.equal((JSON.parse(shown.out) as { run?: { status?: string } }).run?.status, 'completed', shown.out);
    console.log(messages.join('\n'));
    console.log(world.stripe.requests.map((r) => r.path).join('\n'));
  } finally {
    await serving.stop();
    await world.close();
  }
});

test('the weekly report counts and totals the last 7 days’ successful charges per currency, and names the three largest', async () => {
  const world = await chargesWorld(WEEKLY_CHARGES_ON_DEMAND);
  try {
    const at = (daysAgo: number) => now() - daysAgo * DAY;
    for (const [id, name] of [['ada', 'Ada Lovelace'], ['bo', 'Bo Chen'], ['cy', 'Cy Young'], ['di', 'Di Prince'], ['ed', 'Ed Poe']] as const) {
      world.stripe.customer(stripeCustomer({ id: `cus_${id}`, name, email: `${id}@example.com` }));
    }
    const charge = (id: string, customer: string, amount: number, currency: string, daysAgo: number, overrides: Record<string, unknown> = {}) =>
      world.stripe.charge(stripeCharge({ id: `ch_${id}`, customer: `cus_${customer}`, amount, currency, created: at(daysAgo), ...overrides }));
    charge('a1', 'ada', 12000, 'usd', 1);
    charge('a2', 'bo', 45000, 'usd', 2);
    charge('a3', 'cy', 3000, 'usd', 3);
    charge('a4', 'di', 99000, 'usd', 6);
    charge('a5', 'ed', 1500, 'usd', 0.5);
    charge('e1', 'bo', 8000, 'eur', 4);
    charge('e2', 'cy', 2500, 'eur', 5);
    charge('j1', 'ed', 150000, 'jpy', 2);
    // Not in the report: too old, failed, still pending.
    charge('old', 'ada', 777700, 'usd', 9);
    world.stripe.charge(stripeFailedCharge({ id: 'ch_fail', customer: 'cus_ada', amount: 555500, currency: 'usd', created: at(1) }));
    charge('pend', 'di', 666600, 'usd', 1, { status: 'pending', paid: false });

    const ran = await run(world.dir, 'run', 'Weekly Charges');
    assert.equal(ran.code, 0, ran.out);
    const messages = await slackMessages(world.channels);
    console.log(messages.join('\n'));
    console.log(world.stripe.requests.map((r) => r.path).join('\n'));
    assert.equal(messages.length, 1, JSON.stringify(messages));
    const report = messages[0] ?? '';
    assert.match(report, /Last 7 days: 8 successful charges\./);
    assert.match(report, /^C010 Last 7 days: 8 successful charges\./);
    assert.match(report, /\nUSD: 5 charges, 1,605 total\. Largest: Di Prince 990, Bo Chen 450, Ada Lovelace 120\b/);
    assert.match(report, /\nEUR: 2 charges, 105 total\. Largest: Bo Chen 80, Cy Young 25\b/);
    assert.match(report, /\nJPY: 1 charges, 150,000 total\. Largest: Ed Poe 150,000\b/);
    assert.doesNotMatch(report, /GBP/, 'a currency with no charge has no line');
    // Stripe was asked for the week only: the 7 day bound reached every listing.
    const listings = world.stripe.requests.map((r) => r.path).filter((p) => p.startsWith('/v1/charges'));
    assert.ok(listings.length >= 1, listings.join('\n'));
    for (const listing of listings) assert.match(listing, /created%5Bgte%5D=\d+/);
  } finally {
    await world.close();
  }
});

// `@lf/stripe` in lf, end to end: the site's failed-payment demo, rewritten for
// the Stripe module. A project connects the bundled Stripe module against the
// fake Stripe (modules/stripe/__test__/fake_stripe.ts), the demo's CRM as an
// MCP server (modules/mcp/__test__/fake_server.ts, kind `billing`), and Gmail
// and Slack against packages/fake-channels, each with a credential added as a
// person adds it. `lf check` types the program against Stripe's fields and
// event types and refuses a wrong one by name; `lf serve` runs a signed
// delivery once (a monthly customer is emailed, an annual one's account
// manager told in #accounts, a yen amount written in yen), refuses an
// unsigned one, runs nothing for a redelivery or an event no listen selects;
// `lf runs show` shows each run. A second movement reads customers and their
// invoices through the module's graph.

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { served } from './example';
import { fakeChannels, gmailProject, type Fake } from './gmail_fixture';
import { lf, ok } from './interactive';
import { startFakeMcpServer, type FakeMcpServer } from '../../../../modules/mcp/__test__/fake_server';
import { startFakeStripe, type FakeStripe } from '../../../../modules/stripe/__test__/fake_stripe';
import { stripeCustomer, stripeEvent, stripeInvoice, stripeSubscription } from '../../../../modules/stripe/__test__/fixtures';
import { stripeSignature } from '../../../../packages/module-kit/stripe_signature';

const API_KEY = 'rk_test_e2e';
const SECRET = 'whsec_e2e_secret';
const CRM_TOKEN = 'crm-key';

// The demo program (listen-fire-site, video/agents/data.js), its Stripe half
// written for @lf/stripe: no hand-declared event node, no type check, no
// untyped data.object, no division by 100.
const PAYMENTS = `import { stripe, mcp, gmail, slack } from adapters
import { stripe_account, crm, billing_mail, team_slack } from credentials

pay = connect stripe using stripe_account
cr = connect mcp using crm
mail = connect gmail using billing_mail
chat = connect slack using team_slack

function \`Payment Failed\`(e: <pay-[:Event]->>) {
  inv = only(e-[:Invoice]->)
  if (inv == null) { fail("\${e.Type} is not about an invoice") }
  c = only(cr-[x:find_customer_by_email WHERE x.email == inv.\`Customer Email\`]->)
  if (c == null || c.found != true) {
    fail("payment failed on \${inv.Number} but no CRM customer for \${inv.\`Customer Email\`}")
  }
  amount = Currency.formatFigure(inv.\`Amount Due\`, inv.Currency)

  if (c.plan == "monthly") {
    write mail-[:Messages]-> {
      To: [inv.\`Customer Email\`]
      Subject: "Your Ledgerline payment didn't go through"
      Body: "Hi \${coalesce(c.name, inv.\`Customer Name\`)},\\n\\nWe tried to take your Ledgerline payment of \${amount} and it didn't go through. It's usually an expired card or a bank check.\\n\\nYou can update your card and pay here: \${inv.\`Hosted Invoice URL\`}\\n\\nWe'll try again in a few days. If anything's changed, just reply to this email.\\n\\nThe Ledgerline team"
    }
  } else if (c.plan == "yearly") {
    accounts = only(chat-[ch:Channels WHERE ch.Name == "accounts"]->)
    if (accounts == null) { fail("no #accounts channel") }
    write accounts-[:Messages]-> {
      Message: "Annual-plan payment failed: *\${coalesce(c.company, inv.\`Customer Name\`)}* (\${c.name}, \${inv.\`Customer Email\`}) — \${amount}, invoice \${inv.Number}. Account manager: \${c.account_manager}. Invoice: \${inv.\`Hosted Invoice URL\`}"
    }
  } else {
    fail("payment failed on \${inv.Number} but \${inv.\`Customer Email\`} is on an unrecognised plan: \${c.plan}")
  }
}

listen to pay { events: ["invoice.payment_failed"] } fire \`Payment Failed\`
`;

// A workspace-built lf finds its bundled modules beside its own (canonical)
// path; a worktree's lf may be the main checkout's, so the modules and
// serve-module this tree holds are named.
const REPO = resolve(__dirname, '../../../..');
const HOST = { LF_MODULES_DIR: join(REPO, 'modules'), LF_SERVE_MODULE: join(REPO, 'apps/cli/node_modules/.bin/serve-module') };
process.env.LF_MODULES_DIR ??= HOST.LF_MODULES_DIR;
process.env.LF_SERVE_MODULE ??= HOST.LF_SERVE_MODULE;

interface World {
  dir: string;
  stripe: FakeStripe;
  channels: Fake;
  crm: FakeMcpServer;
  close(): Promise<void>;
}

/** A project with Stripe, the CRM, Gmail and Slack connected to the fakes,
 *  and the payments movement in place. */
async function paymentsWorld(): Promise<World> {
  const stripe = await startFakeStripe({ apiKey: API_KEY });
  const channels = await fakeChannels();
  const crm = await startFakeMcpServer({ kind: 'billing', token: CRM_TOKEN });
  const close = async () => (await stripe.close(), await crm.close(), await channels.stop());
  try {
    const { dir } = await gmailProject(channels, 'gmail', 'billing_mail');
    const connected = await ok(lf(dir, ['connect', '@lf/stripe', '--yes', '--base-url', stripe.url], { answers: [] }));
    assert.doesNotMatch(connected, /webhooks are signed with/, 'Stripe issues the secret: lf connect generates none');
    // Asked as a person answers: the API key, then the endpoint's signing secret.
    assert.match(await ok(lf(dir, ['credential', 'add', '--module', 'stripe', 'stripe_account'], { answers: [API_KEY, SECRET] })), /added stripe_account/);
    await ok(lf(dir, ['connect', '@lf/mcp', '--yes'], { answers: [] }));
    await ok(lf(dir, ['credential', 'add', '--module', '@lf/mcp', 'crm', '--credential', 'mcp_token'], { answers: [crm.url, CRM_TOKEN, ''] }));
    await ok(lf(dir, ['connect', '@lf/slack', '--yes'], { answers: [''] }));
    await ok(lf(dir, ['credential', 'add', '--module', '@lf/slack', 'team_slack'], { answers: ['xoxb-test', '', '', `${channels.url}/slack/`] }));
    const seeded = await fetch(`${channels.url}/admin/slack/seed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entities: [{ entity_type: 'channel', id: 'C009', data: { id: 'C009', name: 'accounts', is_private: false, is_member: true, num_members: 3 } }] }),
    });
    assert.equal(seeded.status, 200);
    writeFileSync(join(dir, 'movements/hello.mvt'), PAYMENTS);
    return { dir, stripe, channels, crm, close };
  } catch (error) {
    await close();
    throw error;
  }
}

function run(dir: string, ...args: string[]): Promise<{ code: number; out: string }> {
  return lf(dir, args).done;
}

async function checkWith(dir: string, from: string, to: string): Promise<{ code: number; out: string }> {
  assert.ok(PAYMENTS.includes(from), from);
  writeFileSync(join(dir, 'movements/hello.mvt'), PAYMENTS.replace(from, to));
  const checked = await run(dir, 'check');
  writeFileSync(join(dir, 'movements/hello.mvt'), PAYMENTS);
  return checked;
}

const now = () => Math.floor(Date.now() / 1000);

function deliver(url: string, event: object, secret = SECRET): Promise<{ status: number; body: string }> {
  const body = JSON.stringify(event);
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': stripeSignature(secret, body, now()) }, body }).then(async (r) => ({
    status: r.status,
    body: await r.text(),
  }));
}

/** An invoice.payment_failed event for `email`, `amountDue` in `currency`'s minor units. */
function paymentFailed(id: string, email: string, name: string, amountDue: number, currency = 'usd') {
  const invoice = stripeInvoice({ id: `in_${id}`, number: `LL-${id}`, customer_email: email, customer_name: name, amount_due: amountDue, amount_remaining: amountDue, total: amountDue, subtotal: amountDue, currency, hosted_invoice_url: `https://invoice.stripe.com/i/${id}` });
  return stripeEvent('invoice.payment_failed', invoice, { id: `evt_${id}` });
}

async function outbox(channels: Fake): Promise<Array<{ to: string; subject: string; body: string }>> {
  const { outbox: sent } = await channels.state();
  return (sent as Array<Record<string, unknown>>).map((m) => ({ to: String(m['to']), subject: String(m['subject']), body: String(m['body']) }));
}

async function slackMessages(channels: Fake): Promise<string[]> {
  const rows = (await (await fetch(`${channels.url}/admin/slack/message/state`)).json()) as Array<{ channel: string; text: string; user: string }>;
  return rows.filter((m) => m.user === 'bot').map((m) => `${m.channel} ${m.text}`);
}

test('lf check types the program against Stripe: a field an invoice lacks, an event type Stripe never sends', async () => {
  const world = await paymentsWorld();
  try {
    const check = await run(world.dir, 'check');
    assert.equal(check.code, 0, check.out);

    const wrongField = await checkWith(world.dir, 'Currency.formatFigure(inv.`Amount Due`', 'Currency.formatFigure(inv.amount_due');
    assert.equal(wrongField.code, 1, wrongField.out);
    assert.match(wrongField.out, /MOV_UNKNOWN_PROPERTY .*amount_due/);
    assert.match(wrongField.out, /Amount Due/, 'the diagnostic names the field Stripe has');

    const wrongType = await checkWith(world.dir, '"invoice.payment_failed"', '"invoice.payment_faild"');
    assert.notEqual(wrongType.code, 0, wrongType.out);
    assert.match(wrongType.out, /invoice\.payment_faild/);
    assert.match(wrongType.out, /invoice\.payment_failed/, 'the diagnostic names the type Stripe sends');
    console.log([wrongField, wrongType].map((c) => c.out.trim()).join('\n---\n'));
    assert.deepEqual(world.stripe.requests, [], 'checking reads nothing from Stripe');
  } finally {
    await world.close();
  }
});

test('lf serve runs a signed failed payment once: the monthly customer is emailed, the annual one’s manager told in Slack', async () => {
  const world = await paymentsWorld();
  const serving = await served(world.dir);
  try {
    const url = (await serving.waitFor(/^stripe stripe_account: /)).replace(/^stripe stripe_account: /, '');
    assert.equal(url, `http://127.0.0.1:${serving.port}/hooks/stripe/stripe_account`);

    const monthly = await deliver(url, paymentFailed('m1', 'diego@alvareztiles.es', 'Diego Alvarez', 4900));
    assert.equal(monthly.status, 202, monthly.body);
    const yearly = await deliver(url, paymentFailed('y1', 'amara@okonkwolegal.com', 'Okonkwo Legal', 129000));
    assert.equal(yearly.status, 202, yearly.body);
    const yen = await deliver(url, paymentFailed('j1', 'kenji@hoshinotea.jp', 'Kenji Hoshino', 5000, 'jpy'));
    assert.equal(yen.status, 202, yen.body);

    const again = await deliver(url, paymentFailed('m1', 'diego@alvareztiles.es', 'Diego Alvarez', 4900));
    assert.ok(again.status >= 200 && again.status < 300, again.body);
    assert.match(again.body, /"duplicate":\s*true/);
    const unsigned = await deliver(url, paymentFailed('m2', 'diego@alvareztiles.es', 'Diego Alvarez', 4900), 'whsec_wrong');
    assert.equal(unsigned.status, 401, unsigned.body);
    // An event no listen selects, and one the module does not type: each is
    // answered 2xx (so Stripe does not retry it) and runs nothing.
    const paid = await deliver(url, stripeEvent('invoice.paid', stripeInvoice({ status: 'paid' }), { id: 'evt_paid' }));
    const charge = await deliver(url, stripeEvent('charge.failed', { id: 'ch_1', object: 'charge' }, { id: 'evt_charge' }));
    for (const quiet of [paid, charge]) assert.deepEqual([quiet.status, JSON.parse(quiet.body)], [202, { runs: [] }]);
    console.log([monthly, again, unsigned, paid, charge].map((a) => `${a.status} ${a.body}`).join('\n'));

    const mails = await outbox(world.channels);
    assert.deepEqual(mails.map((m) => m.to).sort(), ['diego@alvareztiles.es', 'kenji@hoshinotea.jp'], JSON.stringify(mails));
    const diego = mails.find((m) => m.to === 'diego@alvareztiles.es');
    assert.match(diego?.body ?? '', /^Hi Diego Alvarez,/);
    assert.match(diego?.body ?? '', /payment of \$49 and/);
    assert.match(diego?.body ?? '', /pay here: https:\/\/invoice\.stripe\.com\/i\/m1/);
    assert.match(mails.find((m) => m.to === 'kenji@hoshinotea.jp')?.body ?? '', /payment of ¥5K and/, 'a yen amount is in yen: 5000, not 50');
    assert.deepEqual(await slackMessages(world.channels), [
      'C009 Annual-plan payment failed: *Okonkwo Legal* (Amara Okonkwo, amara@okonkwolegal.com) — $1.3K, invoice LL-y1. Account manager: Priya Shah. Invoice: https://invoice.stripe.com/i/y1',
    ]);
    assert.deepEqual(world.stripe.requests, [], 'the event carried the invoice: no read of Stripe');

    const runs = await run(world.dir, 'runs');
    const ids = runs.out.trim().split('\n').filter((l) => l.includes('Payment Failed')).map((l) => l.split(' ')[0] ?? '');
    assert.equal(ids.length, 3, runs.out);
    for (const id of ids) {
      const shown = await run(world.dir, 'runs', 'show', id);
      assert.equal(shown.code, 0, shown.out);
      const record = JSON.parse(shown.out) as { run?: { status?: string; writeRecords?: Array<{ adapter: string; recordType: string }> } };
      assert.equal(record.run?.status, 'completed', shown.out);
      assert.ok(record.run?.writeRecords?.some((w) => w.adapter === 'gmail' || w.adapter === 'slack'), shown.out);
    }
    console.log(runs.out.trim());
  } finally {
    await serving.stop();
    await world.close();
  }
});

test('a movement reads customers, their invoices and subscriptions through the graph, amounts in major units', async () => {
  const world = await paymentsWorld();
  try {
    world.stripe.customer(stripeCustomer({ id: 'cus_diego', email: 'diego@alvareztiles.es', name: 'Diego Alvarez' }));
    const madeBy = { type: 'subscription_details', quote_details: null, subscription_details: { metadata: {}, subscription: 'sub_diego' } };
    world.stripe.invoice(stripeInvoice({ id: 'in_open', customer: 'cus_diego', status: 'open', amount_remaining: 4900, parent: madeBy }));
    world.stripe.invoice(stripeInvoice({ id: 'in_old', customer: 'cus_diego', status: 'paid', amount_remaining: 0, created: 1600000000 }));
    world.stripe.subscription(stripeSubscription({ id: 'sub_diego', customer: 'cus_diego', status: 'past_due' }));
    writeFileSync(
      join(world.dir, 'movements/owed.mvt'),
      `import { stripe } from adapters
import { stripe_account } from credentials

pay = connect stripe using stripe_account

function owed(run: <manual-[:Invocation]->>) {
  c = only(pay-[x:Customers WHERE x.Email == "diego@alvareztiles.es"]->)
  if (c == null) { fail("no customer") }
  open = only(c-[i:Invoices WHERE i.Status == "open"]->)
  if (open == null) { fail("nothing open") }
  sub = only(open-[:Subscription]->)
  if (sub == null) { fail("no subscription") }
  return "\${c.Name} owes \${open.\`Amount Remaining\`} \${open.Currency} on \${open.Id}, subscription \${sub.Status}"
}

listen to manual fire owed
`,
    );
    const ran = await run(world.dir, 'run', 'owed');
    assert.equal(ran.code, 0, ran.out);
    assert.match(ran.out, /returned "Diego Alvarez owes 49 usd on in_open, subscription past_due"/);
    assert.deepEqual(
      world.stripe.requests.map((r) => r.path),
      ['/v1/customers?email=diego%40alvareztiles.es&limit=100', '/v1/invoices?customer=cus_diego&status=open&limit=100', '/v1/subscriptions/sub_diego'],
    );
  } finally {
    await world.close();
  }
});

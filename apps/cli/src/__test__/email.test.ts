// `@lf/email` under listen-fire, as the handbook writes it: connected with no
// credential (receiving needs none), a listen per key on the connection's
// `Emails` (`inbox-[e:Emails WHERE e.Key == "deals"]->`), and each message,
// posted signed to the module's door as Mailgun posts it, firing the listens
// whose key its address carries (the empty key for the box itself): none, and
// a line saying so, when no listen names it.

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { lf } from './example';
import { lf as lfAsked, ok } from './interactive';

// A workspace-built listen-fire finds its bundled modules beside its own
// (canonical) path; a worktree's listen-fire may be the main checkout's.
const REPO = resolve(__dirname, '../../../..');
process.env.LF_MODULES_DIR ??= join(REPO, 'modules');
process.env.LF_SERVE_MODULE ??= join(REPO, 'apps/cli/node_modules/.bin/serve-module');

/** The Mailgun signing key the install checks its door's posts with. */
const SIGNING_KEY = 'mailgun-signing-key';

const INTAKE = [
  'import { email } from adapters',
  '',
  'inbox = connect email',
  '',
  'function deal(m: <inbox-[:Emails]->>) { return "deal: ${m.Subject}" }',
  'function intro(m: <inbox-[:Emails]->>) { return "intro: ${m.Subject}" }',
  'function boxed(m: <inbox-[:Emails]->>) { return "box: ${m.Subject}" }',
  '',
  'listen as "Deal intake" to inbox-[e:Emails WHERE e.Key == "deals"]-> fire deal',
  'listen as "Q3 deal intake" to inbox-[e:Emails WHERE e.Key == "deals_q3"]-> fire deal',
  'listen as "Intro intake" to inbox-[e:Emails WHERE e.Key IN ["intros", "customer-support"]]-> fire intro',
  'listen as "Box intake" to inbox-[e:Emails WHERE e.Key == ""]-> fire boxed',
  '',
].join('\n');

/** What a message says besides where it goes. */
interface Said {
  sender: string;
  subject: string;
  body: string;
}

const HELLO: Said = { sender: 'ada@example.com', subject: 'Hello', body: 'Hi' };

/** One message to `recipient`, posted to the module's door as Mailgun signs it. */
function sentTo(dir: string, recipient: string, id = recipient, said: Said = HELLO): ReturnType<typeof lf> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const token = `tok-${id}`;
  const signature = createHmac('sha256', SIGNING_KEY).update(timestamp + token).digest('hex');
  const form = new URLSearchParams({ sender: said.sender, recipient, To: recipient, subject: said.subject, 'body-plain': said.body, 'Message-Id': `<m-${id}>`, timestamp, token, signature });
  const file = join(dir, 'mail.form');
  writeFileSync(file, form.toString());
  return lf(dir, 'run', '--webhook', 'email', '--body', file, '--header', 'content-type:application/x-www-form-urlencoded');
}

async function intake(listens = INTAKE): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'lf-email-'));
  assert.equal(lf(dir, 'init', dir).code, 0);
  const connected = await ok(lfAsked(dir, ['connect', '@lf/email', '--webhook-secret', SIGNING_KEY], { answers: [''] }));
  assert.match(connected, /connected email/);
  assert.match(connected, /works without a user credential/);
  writeFileSync(join(dir, 'movements/intake.mvt'), listens);
  return dir;
}

test('mail is routed by the Emails key the listen names, the box itself by the empty key; a key no plus-suffix carries is refused', async () => {
  const dir = await intake();
  const check = lf(dir, 'check');
  assert.equal(check.code, 0, check.out);

  const deals = sentTo(dir, 'inbox+deals@acme.test');
  assert.equal(deals.code, 0, deals.out);
  assert.match(deals.out, /returned "deal: Hello"/);
  assert.doesNotMatch(deals.out, /intro:/);
  // The key is the plus-suffix in any case; IN takes either of its keys.
  assert.match(sentTo(dir, 'Inbox <inbox+INTROS@acme.test>').out, /returned "intro: Hello"/);
  assert.match(sentTo(dir, 'inbox+customer-support@acme.test').out, /returned "intro: Hello"/);
  // A key holds what a plus-suffix can, and mail to the box itself has the empty key.
  assert.match(sentTo(dir, 'inbox+Deals_Q3@acme.test').out, /returned "deal: Hello"/);
  const boxed = sentTo(dir, 'inbox@acme.test');
  assert.match(boxed.out, /returned "box: Hello"/);
  assert.doesNotMatch(boxed.out, /deal:|intro:/);
  // A key no listen names runs nothing, and says so with its key.
  const stray = sentTo(dir, 'inbox+hiring@acme.test');
  assert.equal(stray.code, 0, stray.out);
  assert.doesNotMatch(stray.out, /completed|returned/);
  assert.match(stray.out, /email: the arrival \S+ on Emails \(its Key is "hiring"\) matches the WHERE of no listen on it: it runs nothing/);
  // The same message posted again runs nothing more.
  const again = sentTo(dir, 'inbox+deals@acme.test');
  assert.doesNotMatch(again.out, /returned "deal: Hello"/);

  // A key is lowercase, as the module carries it: it refuses one it could never route.
  writeFileSync(join(dir, 'movements/intake.mvt'), INTAKE.replace('e.Key == "deals"', 'e.Key == "Deals Desk"'));
  const refused = lf(dir, 'check');
  assert.equal(refused.code, 1, refused.out);
  assert.match(refused.out, /MOV_OWNED_VALUE_INVALID .*"Deals Desk" is not an InboxKey: it does not match/);
  // A listen with no key would hear every team's mail.
  writeFileSync(join(dir, 'movements/intake.mvt'), INTAKE.replace('-[e:Emails WHERE e.Key == "deals"]->', '-[:Emails]->'));
  const unbounded = lf(dir, 'check');
  assert.equal(unbounded.code, 1, unbounded.out);
  assert.match(unbounded.out, /MOV_UNBOUNDED_EDGE/);
});

test("a listen's WHERE reads a message's fields by the names the run reads them by", async () => {
  const listens = [
    'import { email } from adapters',
    '',
    'inbox = connect email',
    '',
    'function deal(m: <inbox-[:Emails]->>) { return "deal: ${m.Subject}" }',
    '',
    'listen to inbox-[e:Emails WHERE e.Key == "deals" AND e.Subject CONTAINS "Series A" AND e.From CONTAINS "acme.test" AND e.Body CONTAINS "term sheet"]-> fire deal',
    '',
  ].join('\n');
  const dir = await intake(listens);
  const check = lf(dir, 'check');
  assert.equal(check.code, 0, check.out);

  const pitch: Said = { sender: 'Rita <rita@acme.test>', subject: 'Series A for Acme', body: 'The term sheet is attached.' };
  const fired = sentTo(dir, 'inbox+deals@acme.test', 'pitch', pitch);
  assert.equal(fired.code, 0, fired.out);
  assert.match(fired.out, /returned "deal: Series A for Acme"/);

  // Each field the WHERE reads decides: a message failing any one runs nothing.
  for (const [id, said] of [
    ['other-subject', { ...pitch, subject: 'Lunch?' }],
    ['other-sender', { ...pitch, sender: 'eve@elsewhere.test' }],
    ['other-body', { ...pitch, body: 'No attachment.' }],
  ] as const) {
    const skipped = sentTo(dir, 'inbox+deals@acme.test', id, said);
    assert.equal(skipped.code, 0, skipped.out);
    assert.doesNotMatch(skipped.out, /returned/, id);
    assert.match(skipped.out, /matches the WHERE of no listen on it: it runs nothing/, id);
  }
});

test("a message's record carries only the email's own fields: Mailgun's signing fields reach no run and no kept request", async () => {
  const listens = [
    'import { email } from adapters',
    '',
    'inbox = connect email',
    '',
    'function seen(m: <inbox-[:Emails]->>) { return { subject: m.Subject, key: m.Key } }',
    '',
    'listen to inbox-[e:Emails WHERE e.Key == "deals"]-> fire seen',
    '',
  ].join('\n');
  const dir = await intake(listens);
  const check = lf(dir, 'check');
  assert.equal(check.code, 0, check.out);

  const fired = sentTo(dir, 'inbox+deals@acme.test', 'signed');
  assert.equal(fired.code, 0, fired.out);
  assert.match(fired.out, /returned/);
  const runId = /run ([0-9a-f-]{36})/.exec(fired.out)?.[1];
  assert.ok(runId, fired.out);
  const shown = lf(dir, 'runs', 'show', runId);
  assert.equal(shown.code, 0, shown.out);
  const arrival = (JSON.parse(shown.out) as { run: { event: { arrival: { landing: { fields: Record<string, unknown> } } } } }).run.event.arrival;
  assert.equal(arrival.landing.fields['subject'], 'Hello');
  for (const signing of ['token', 'timestamp', 'signature']) assert.equal(signing in arrival.landing.fields, false, `the run's record holds ${signing}`);
  assert.doesNotMatch(shown.out, /tok-signed/);

  const listed = lf(dir, 'deliveries');
  assert.equal(listed.code, 0, listed.out);
  const deliveryId = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.exec(listed.out)?.[0];
  assert.ok(deliveryId, listed.out);
  const kept = (JSON.parse(lf(dir, 'deliveries', 'show', deliveryId, '--request').out) as { delivery: { request: { body: string } } }).delivery.request;
  const keptForm = new URLSearchParams(Buffer.from(kept.body, 'base64').toString('utf8'));
  assert.equal(keptForm.get('subject'), 'Hello');
  for (const signing of ['token', 'timestamp', 'signature']) assert.equal(keptForm.has(signing), false, `the kept body holds ${signing}`);
});

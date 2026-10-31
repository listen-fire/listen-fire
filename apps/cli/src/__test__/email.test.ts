// `@lf/email` under listen-fire, as the handbook writes it: connected with no
// credential (receiving needs none), a listen per key on the connection's
// `Emails` (`inbox-[e:Emails WHERE e.Key == "deals"]->`), and each message,
// posted signed to the module's door as Mailgun posts it, firing the listens
// whose key its address carries: none when no listen names it.

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
  '',
  'listen as "Deal intake" to inbox-[e:Emails WHERE e.Key == "deals"]-> fire deal',
  'listen as "Intro intake" to inbox-[e:Emails WHERE e.Key IN ["intros", "customer-support"]]-> fire intro',
  '',
].join('\n');

/** One message to `recipient`, posted to the module's door as Mailgun signs it. */
function sentTo(dir: string, recipient: string, id = recipient): ReturnType<typeof lf> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const token = `tok-${id}`;
  const signature = createHmac('sha256', SIGNING_KEY).update(timestamp + token).digest('hex');
  const form = new URLSearchParams({ sender: 'ada@example.com', recipient, To: recipient, subject: 'Hello', 'body-plain': 'Hi', 'Message-Id': `<m-${id}>`, timestamp, token, signature });
  const file = join(dir, 'mail.form');
  writeFileSync(file, form.toString());
  return lf(dir, 'run', '--webhook', 'email', '--body', file, '--header', 'content-type:application/x-www-form-urlencoded');
}

async function intake(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'lf-email-'));
  assert.equal(lf(dir, 'init', dir).code, 0);
  const connected = await ok(lfAsked(dir, ['connect', '@lf/email', '--webhook-secret', SIGNING_KEY], { answers: [''] }));
  assert.match(connected, /connected email/);
  assert.match(connected, /works without a user credential/);
  writeFileSync(join(dir, 'movements/intake.mvt'), INTAKE);
  return dir;
}

test('mail is routed by the Emails key the listen names; a key outside the slug pattern is refused', async () => {
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
  // A key no listen names, and mail to the box itself, run nothing.
  for (const stray of ['inbox+hiring@acme.test', 'inbox@acme.test']) {
    const ran = sentTo(dir, stray);
    assert.equal(ran.code, 0, ran.out);
    assert.doesNotMatch(ran.out, /completed|returned/, stray);
  }
  // The same message posted again runs nothing more.
  const again = sentTo(dir, 'inbox+deals@acme.test');
  assert.doesNotMatch(again.out, /returned "deal: Hello"/);

  // A key is a slug: the module refuses one it could never route.
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

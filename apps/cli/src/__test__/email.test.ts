// `@lf/email` under listen-fire, as the handbook writes it: connected with no
// credential (receiving needs none), a listen keyed per plus-suffix, and each
// message routed to the listen whose key its address carries — to none when
// no listen has that key.

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { lf } from './example';
import { lf as lfAsked, ok } from './interactive';

const INTAKE = [
  'import { email } from adapters',
  '',
  'inbox = connect email',
  '',
  'function deal(m: <inbox-[:Email]->>) { return "deal: ${m.Subject}" }',
  'function intro(m: <inbox-[:Email]->>) { return "intro: ${m.Subject}" }',
  '',
  'listen as "Deal intake" to inbox { key: "deals" } fire deal',
  'listen as "Intro intake" to inbox { key: "intros" } fire intro',
  '',
].join('\n');

function sentTo(dir: string, recipient: string): ReturnType<typeof lf> {
  const file = join(dir, 'mail.json');
  const event = { payload: { recipient, subject: 'Hello', messageId: `m-${recipient}` }, tag: 'email.received', recordType: 'email' };
  writeFileSync(file, JSON.stringify({ external: 'email', event }));
  return lf(dir, 'run', '--event', file);
}

test('listen-fire connect @lf/email needs no credential; a listen per key checks clean and mail is routed by plus-suffix', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lf-email-'));
  assert.equal(lf(dir, 'init', dir).code, 0);
  const connected = await ok(lfAsked(dir, ['connect', '@lf/email'], { answers: [''] }));
  assert.match(connected, /connected email/);
  assert.match(connected, /works without a user credential/);
  writeFileSync(join(dir, 'movements/intake.mvt'), INTAKE);
  const check = lf(dir, 'check');
  assert.equal(check.code, 0, check.out);

  const deals = sentTo(dir, 'inbox+deals@acme.test');
  assert.equal(deals.code, 0, deals.out);
  assert.match(deals.out, /returned "deal: Hello"/);
  assert.doesNotMatch(deals.out, /intro:/);
  assert.match(sentTo(dir, 'Inbox <inbox+INTROS@acme.test>').out, /returned "intro: Hello"/);
  const stray = sentTo(dir, 'inbox+hiring@acme.test');
  assert.equal(stray.code, 0, stray.out);
  assert.match(stray.out, /no listen on email has the key "hiring"/);
  assert.doesNotMatch(stray.out, /completed/);
});

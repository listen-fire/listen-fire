// Gmail drafts and the label-added event with lf, against the fake Gmail in
// packages/fake-channels, every step as a person types it: lf connect @lf/gmail
// (pointed at the fake) → lf credential add --headless (the plain sign-in, or
// the `gmail_drafts` one that also asks for the compose scope) → lf check →
// lf run, and lf run --poll for a listen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lf as lfSync } from './example';
import { COMPOSE_SCOPE, fakeChannels, gmailProject } from './gmail_fixture';

const DRAFTS = `import { gmail } from adapters
import { henry_mail } from credentials

mail = connect gmail using henry_mail

function draft(run: <manual-[:Invocation]->>) {
  fresh = write mail-[:Drafts]-> {
    To: ["rita@acme.example"]
    Subject: "Your Q3 figures"
    Body: "Draft for Henry to check."
  }
  asked = only(mail-[m:Messages WHERE m.Subject == "Q3 question"]->)
  if (asked == null) { fail("no Q3 question") }
  answer = write asked-[:Drafts]-> { Body: "Looking now." }
  return "\${fresh.Id} \${fresh.Subject} / \${answer.Id} \${answer.Subject}"
}

listen to manual fire draft
`;

test('with drafts enabled, a program creates a draft and a reply draft, and neither is sent', async () => {
  const fake = await fakeChannels();
  try {
    const { dir, asked } = await gmailProject(fake, 'gmail_drafts');
    assert.ok(asked.split(' ').includes(COMPOSE_SCOPE), `the drafts sign-in asks for the compose scope: ${asked}`);
    await fake.message({ id: 'm-q3', subject: 'Q3 question', from: 'Rita <rita@acme.example>', bodyText: 'Where are the figures?', threadId: 't-q3' });
    writeFileSync(join(dir, 'movements/hello.mvt'), DRAFTS);

    const checked = lfSync(dir, 'check');
    assert.equal(checked.code, 0, checked.out);
    const run = lfSync(dir, 'run', 'draft');
    assert.equal(run.code, 0, run.out);
    assert.match(run.out, /2 write\(s\)/);
    const returned = /returned "(.*)"/.exec(run.out)?.[1] ?? '';
    assert.match(returned, /^draft-\S+ Your Q3 figures \/ draft-\S+ Re: Q3 question$/, run.out);

    const state = await fake.state();
    assert.deepEqual(state.outbox, [], 'nothing was sent');
    assert.equal(state.drafts.length, 2);
    const [fresh, reply] = state.drafts;
    assert.equal(fresh?.to, 'rita@acme.example');
    assert.equal(fresh?.subject, 'Your Q3 figures');
    assert.equal(fresh?.body, 'Draft for Henry to check.');
    assert.equal(reply?.threadId, 't-q3');
    assert.equal(reply?.to, 'Rita <rita@acme.example>');
    assert.equal(reply?.inReplyTo, '<m-q3@fake-gmail.local>');
  } finally {
    await fake.stop();
  }
});

test('a mailbox signed in without drafts refuses a draft, saying how to enable it, and sends nothing', async () => {
  const fake = await fakeChannels();
  try {
    const { dir, asked } = await gmailProject(fake, 'gmail');
    assert.ok(!asked.split(' ').includes(COMPOSE_SCOPE), `the plain sign-in does not ask for the compose scope: ${asked}`);
    await fake.message({ id: 'm-q3', subject: 'Q3 question', bodyText: 'Where are the figures?' });
    writeFileSync(join(dir, 'movements/hello.mvt'), DRAFTS);
    const run = lfSync(dir, 'run', 'draft');
    assert.notEqual(run.code, 0, run.out);
    assert.match(run.out, /gmail\.compose/);
    assert.match(run.out, /--credential gmail_drafts/);
    const state = await fake.state();
    assert.deepEqual(state.drafts, []);
    assert.deepEqual(state.outbox, []);
  } finally {
    await fake.stop();
  }
});

const labelled = (listen: string) => `import { gmail } from adapters
import { henry_mail } from credentials

mail = connect gmail using henry_mail

function tagged(msg: <mail-[:Message]->>) {
  fail("tagged \${msg.Subject} with \${msg.\`Added Label\`}")
}

${listen}
`;

test('labelling an existing message fires a listen on that label, named as a person sees it, once; another label does not', async () => {
  const fake = await fakeChannels();
  try {
    const { dir } = await gmailProject(fake, 'gmail');
    const deals = await fake.makeLabel('Deals');
    const newsletters = await fake.makeLabel('Newsletters');
    await fake.message({ id: 'm-old', subject: 'Acme intro' });
    await fake.message({ id: 'm-other', subject: 'Newsletter' });
    writeFileSync(join(dir, 'movements/hello.mvt'), labelled('listen to mail { events: ["label_added"], labels: ["Deals"] } fire tagged'));
    const checked = lfSync(dir, 'check');
    assert.equal(checked.code, 0, checked.out);

    // The first poll sets the mark, fires nothing, and says so.
    const first = lfSync(dir, 'run', '--poll', 'tagged');
    assert.doesNotMatch(first.out, /MOVENG_ERROR: tagged/, first.out);
    assert.match(first.out, /^gmail: hello:tagged armed; it fires on changes from now$/m, first.out);

    await fake.label('m-old', [deals]);
    await fake.label('m-other', [newsletters]);
    const fired = lfSync(dir, 'run', '--poll', 'tagged');
    assert.match(fired.out, new RegExp(`MOVENG_ERROR: tagged Acme intro with ${deals}`), fired.out);
    assert.doesNotMatch(fired.out, /tagged Newsletter/, fired.out);
    assert.equal(fired.out.split('MOVENG_ERROR: tagged').length - 1, 1, fired.out);

    // A second poll finds nothing new: the label fires once. Armed already, it says nothing of it.
    const again = lfSync(dir, 'run', '--poll', 'tagged');
    assert.doesNotMatch(again.out, /MOVENG_ERROR: tagged/, again.out);
    assert.doesNotMatch(again.out, /armed/, again.out);

    // A new arrival is not a label being added.
    await fake.message({ id: 'm-new', subject: 'Fresh deal', labelIds: ['INBOX', deals] });
    const arrival = lfSync(dir, 'run', '--poll', 'tagged');
    assert.doesNotMatch(arrival.out, /MOVENG_ERROR: tagged/, arrival.out);
  } finally {
    await fake.stop();
  }
});

test('a label listen naming no labels fires for user labels only, never for Gmail’s own', async () => {
  const fake = await fakeChannels();
  try {
    const { dir } = await gmailProject(fake, 'gmail');
    const deals = await fake.makeLabel('Deals');
    await fake.message({ id: 'm-old', subject: 'Acme intro', labelIds: ['UNREAD'] });
    writeFileSync(join(dir, 'movements/hello.mvt'), labelled('listen to mail { events: ["label_added"] } fire tagged'));
    lfSync(dir, 'run', '--poll', 'tagged');

    await fake.label('m-old', ['INBOX', 'STARRED']);
    const system = lfSync(dir, 'run', '--poll', 'tagged');
    assert.doesNotMatch(system.out, /MOVENG_ERROR: tagged/, system.out);

    await fake.label('m-old', [deals]);
    const user = lfSync(dir, 'run', '--poll', 'tagged');
    assert.match(user.out, new RegExp(`MOVENG_ERROR: tagged Acme intro with ${deals}`), user.out);
  } finally {
    await fake.stop();
  }
});

test('a label the mailbox does not have fails the poll, naming the labels it has', async () => {
  const fake = await fakeChannels();
  try {
    const { dir } = await gmailProject(fake, 'gmail');
    await fake.makeLabel('Deals');
    writeFileSync(join(dir, 'movements/hello.mvt'), labelled('listen to mail { events: ["label_added"], labels: ["Dealz"] } fire tagged'));
    const run = lfSync(dir, 'run', '--poll', 'tagged');
    assert.match(run.out, /'Dealz', which dev-loop@listen-fire\.local does not have — its labels are Deals/, run.out);
  } finally {
    await fake.stop();
  }
});

test('a sent message and a reply carry their ids under the catalog’s names on the handle', async () => {
  const fake = await fakeChannels();
  try {
    const { dir } = await gmailProject(fake, 'gmail');
    await fake.message({ id: 'm-q3', subject: 'Q3 question', from: 'rita@acme.example', threadId: 't-q3' });
    writeFileSync(
      join(dir, 'movements/hello.mvt'),
      `import { gmail } from adapters
import { henry_mail } from credentials

mail = connect gmail using henry_mail

function send(run: <manual-[:Invocation]->>) {
  sent = write mail-[:Messages]-> { To: ["rita@acme.example"], Subject: "Figures", Body: "Attached." }
  asked = only(mail-[m:Messages WHERE m.Subject == "Q3 question"]->)
  if (asked == null) { fail("no Q3 question") }
  reply = write asked-[:Replies]-> { Body: "Looking now." }
  return "\${sent.\`Message Id\`} \${sent.\`Thread Id\`} \${sent.Subject} / \${reply.\`Message Id\`} \${reply.\`Thread Id\`} \${reply.Subject}"
}

listen to manual fire send
`,
    );
    const run = lfSync(dir, 'run', 'send');
    assert.equal(run.code, 0, run.out);
    const returned = /returned "(.*)"/.exec(run.out)?.[1] ?? '';
    assert.match(returned, /^(sent-\S+) \1 Figures \/ sent-\S+ t-q3 Re: Q3 question$/, run.out);
  } finally {
    await fake.stop();
  }
});

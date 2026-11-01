// Gmail listens as edges with listen-fire, against the fake Gmail in
// packages/fake-channels, every step as a person types it: a listen on
// `Messages` narrowed by Gmail's own search (`Query`) and by any field, two
// listens with one WHERE sharing a poll, and `listen-fire upgrade` rewriting a
// 0.12 settings listen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lf } from './example';
import { fakeChannels, gmailProject } from './gmail_fixture';

const program = (body: string) => `import { gmail } from adapters
import { henry_mail } from credentials

mail = connect gmail using henry_mail

${body}
`;

const HEARD = (name: string) => `function ${name}(m: <mail-[:Messages]->>) {
  fail("${name} heard \${m.Subject}")
}`;

test('a gmail listen polls its query at Gmail and applies the subject over what came back', async () => {
  const fake = await fakeChannels();
  try {
    const { dir } = await gmailProject(fake, 'gmail');
    writeFileSync(
      join(dir, 'movements/hello.mvt'),
      program(`${HEARD('invoices')}

listen to mail-[m:Messages WHERE m.Labels CONTAINS "INBOX" AND m.Query == "from:acme" AND m.Subject CONTAINS "invoice"]-> fire invoices`),
    );
    const checked = lf(dir, 'check');
    assert.equal(checked.code, 0, checked.out);

    const armed = lf(dir, 'run', '--poll', 'invoices');
    assert.match(armed.out, /^gmail: hello:invoices armed; it fires on changes from now$/m, armed.out);

    await fake.message({ id: 'm-acme-invoice', from: 'Rita <rita@acme.example>', subject: 'Your invoice' });
    await fake.message({ id: 'm-acme-hello', from: 'Rita <rita@acme.example>', subject: 'Hello' });
    await fake.message({ id: 'm-other-invoice', from: 'Bob <bob@other.example>', subject: 'An invoice' });
    const fired = lf(dir, 'run', '--poll', 'invoices');
    assert.match(fired.out, /MOVENG_ERROR: invoices heard Your invoice/, fired.out);
    // Gmail's search left out the other sender; the subject check, the greeting.
    assert.doesNotMatch(fired.out, /heard Hello|heard An invoice/, fired.out);
    assert.equal(fired.out.split('MOVENG_ERROR: invoices heard').length - 1, 1, fired.out);
  } finally {
    await fake.stop();
  }
});

test('two gmail listens with one WHERE share a poll, and each hears the mail', async () => {
  const fake = await fakeChannels();
  try {
    const { dir } = await gmailProject(fake, 'gmail');
    const where = 'm:Messages WHERE m.Labels CONTAINS "INBOX" AND m.Query == "from:acme"';
    writeFileSync(
      join(dir, 'movements/hello.mvt'),
      program(`${HEARD('deals')}

${HEARD('intros')}

listen to mail-[${where}]-> fire deals
listen to mail-[${where}]-> fire intros`),
    );
    const checked = lf(dir, 'check');
    assert.equal(checked.code, 0, checked.out);

    const armed = lf(dir, 'run', '--poll', 'deals');
    assert.match(armed.out, /^gmail: hello:deals, hello:intros armed; it fires on changes from now$/m, armed.out);

    await fake.message({ id: 'm-acme', from: 'rita@acme.example', subject: 'Figures' });
    const fired = lf(dir, 'run', '--poll', 'deals');
    assert.match(fired.out, /MOVENG_ERROR: deals heard Figures/, fired.out);
    assert.match(fired.out, /MOVENG_ERROR: intros heard Figures/, fired.out);
  } finally {
    await fake.stop();
  }
});

test('upgrade rewrites gmail { query, labels, every }, saying where the interval went, as a fix it applies only with --all', async () => {
  const fake = await fakeChannels();
  try {
    const { dir } = await gmailProject(fake, 'gmail');
    const file = join(dir, 'movements/hello.mvt');
    const old = program(`function triage(m: <mail-[:Message]->>) {
  return m.Subject
}

listen to mail { query: "from:acme", labels: ["INBOX", "SPAM"], every: 5m } fire triage`);
    writeFileSync(file, old);
    const lfYaml = join(dir, 'lf.yaml');
    writeFileSync(lfYaml, readFileSync(lfYaml, 'utf8').replace(/^engine: .*$/m, 'engine: 0.12.13'));

    const held = lf(dir, 'upgrade');
    assert.equal(held.code, 1, held.out);
    assert.match(
      held.out,
      /MOV_LISTEN_SETTINGS_RETIRED .*Write `listen to mail-\[m:Messages WHERE m\.Query == "from:acme" AND \(m\.Labels CONTAINS "INBOX" OR m\.Labels CONTAINS "SPAM"\)\]-> fire triage` \(`every` is gone: the module sets the interval; set `pollEvery` for this connection in lf\.yaml\)/,
    );
    assert.equal(readFileSync(file, 'utf8'), old);

    const upgraded = lf(dir, 'upgrade', '--all');
    assert.equal(upgraded.code, 0, upgraded.out);
    assert.equal(
      readFileSync(file, 'utf8'),
      old
        .replace('<mail-[:Message]->>', '<mail-[:Messages]->>')
        .replace(
          'listen to mail { query: "from:acme", labels: ["INBOX", "SPAM"], every: 5m } fire triage',
          'listen to mail-[m:Messages WHERE m.Query == "from:acme" AND (m.Labels CONTAINS "INBOX" OR m.Labels CONTAINS "SPAM")]-> fire triage',
        ),
    );
    const checked = lf(dir, 'check');
    assert.equal(checked.code, 0, checked.out);
    assert.doesNotMatch(checked.out, /MOV_LISTEN_SETTINGS_RETIRED/);

    // A label listen lands on Labelings; one with no labels heard the mailbox's own.
    writeFileSync(file, program(`function filed(m: <mail-[:Message]->>) {
  return m.Subject
}

listen to mail { events: ["label_added"] } fire filed`));
    writeFileSync(lfYaml, readFileSync(lfYaml, 'utf8').replace(/^engine: .*$/m, 'engine: 0.12.13'));
    const labelled = lf(dir, 'upgrade');
    assert.equal(labelled.code, 0, labelled.out);
    assert.match(readFileSync(file, 'utf8'), /function filed\(m: <mail-\[:Labelings\]->>\)/);
    assert.match(readFileSync(file, 'utf8'), /listen to mail-\[l:Labelings WHERE l\.`Label Type` == "user"\]-> fire filed/);
    assert.equal(lf(dir, 'check').code, 0);
  } finally {
    await fake.stop();
  }
});

test('an upgraded listen on two user labels, written by name, hears mail carrying either', async () => {
  const fake = await fakeChannels();
  try {
    const { dir } = await gmailProject(fake, 'gmail');
    const deals = await fake.makeLabel('Deals');
    const hiring = await fake.makeLabel('Hiring');
    const file = join(dir, 'movements/hello.mvt');
    writeFileSync(file, program(`function triage(m: <mail-[:Message]->>) {
  fail("triage heard \${m.Subject}")
}

listen to mail { labels: ["Deals", "Hiring"] } fire triage`));
    const lfYaml = join(dir, 'lf.yaml');
    writeFileSync(lfYaml, readFileSync(lfYaml, 'utf8').replace(/^engine: .*$/m, 'engine: 0.12.13'));

    // Gmail takes the labels together, by name: the fix is safe.
    const upgraded = lf(dir, 'upgrade');
    assert.equal(upgraded.code, 0, upgraded.out);
    assert.match(readFileSync(file, 'utf8'), /listen to mail-\[m:Messages WHERE m\.Labels CONTAINS "Deals" OR m\.Labels CONTAINS "Hiring"\]-> fire triage/);
    assert.equal(lf(dir, 'check').code, 0);

    const armed = lf(dir, 'run', '--poll', 'triage');
    assert.match(armed.out, /^gmail: hello:triage armed; it fires on changes from now$/m, armed.out);

    await fake.message({ id: 'm-hiring', subject: 'A candidate', labelIds: ['INBOX', hiring] });
    await fake.message({ id: 'm-deals', subject: 'A term sheet', labelIds: [deals] });
    await fake.message({ id: 'm-plain', subject: 'A newsletter', labelIds: ['INBOX'] });
    const fired = lf(dir, 'run', '--poll', 'triage');
    assert.match(fired.out, /MOVENG_ERROR: triage heard A candidate/, fired.out);
    assert.match(fired.out, /MOVENG_ERROR: triage heard A term sheet/, fired.out);
    assert.doesNotMatch(fired.out, /heard A newsletter/, fired.out);
  } finally {
    await fake.stop();
  }
});

test('a walk of Messages by a user label name returns its messages, whose Labels are names', async () => {
  const fake = await fakeChannels();
  try {
    const { dir } = await gmailProject(fake, 'gmail');
    const deals = await fake.makeLabel('Deals');
    await fake.message({ id: 'm-deals', subject: 'A term sheet', labelIds: ['INBOX', deals] });
    await fake.message({ id: 'm-plain', subject: 'A newsletter', labelIds: ['INBOX'] });
    writeFileSync(join(dir, 'movements/hello.mvt'), program(`function look(run: <manual-[:Invocations]->>) {
  m = only(mail-[x:Messages WHERE x.Labels CONTAINS "Deals"]->)
  if (m == null) { fail("no Deals mail") }
  return "\${m.Subject} / \${m.Labels}"
}

listen to manual-[:Invocations]-> fire look`));
    assert.equal(lf(dir, 'check').code, 0);
    const walked = lf(dir, 'run', 'look');
    assert.equal(walked.code, 0, walked.out);
    assert.match(walked.out, /returned "A term sheet \/ .*INBOX.*Deals.*"/, walked.out);
    assert.doesNotMatch(walked.out, /Label_/, walked.out);
  } finally {
    await fake.stop();
  }
});

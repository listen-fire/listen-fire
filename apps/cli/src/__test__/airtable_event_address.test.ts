// A parameter typed by an Airtable event address names a table the
// connection's base has, or `listen-fire check` refuses it where it is written,
// against the fake Airtable (packages/fake-channels: bases "Pipeline Tracker"
// and "Ops"). An address that names no table used to leave the parameter
// untyped, so a misspelled field read off its record checked clean.

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';

import { lf as lfSync } from './example';
import { lf, ok } from './interactive';

async function fakeChannels(): Promise<{ url: string; stop(): Promise<void> }> {
  const cwd = mkdtempSync(join(tmpdir(), 'lf-airtable-fake-'));
  const child: ChildProcess = spawn(process.execPath, [require.resolve('@listen-fire/fake-channels/bin/fake-channels.cjs')], {
    cwd,
    env: { ...process.env, FAKE_CHANNELS_PORT: '0' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const exited = new Promise<void>((done) => child.once('exit', () => done()));
  const url = await new Promise<string>((found, failed) => {
    createInterface({ input: child.stdout! }).on('line', (line) => {
      const port = /running on http:\/\/localhost:(\d+)/.exec(line)?.[1];
      if (port !== undefined) found(`http://127.0.0.1:${port}`);
    });
    void exited.then(() => failed(new Error('fake-channels exited before listening')));
  });
  return { url, stop: async () => (child.kill('SIGTERM'), exited) };
}

async function connected(url: string): Promise<string> {
  const dir = join(mkdtempSync(join(tmpdir(), 'lf-airtable-')), 'airtable-address');
  assert.equal(lfSync(join(dir, '..'), 'init', 'airtable-address').code, 0);
  await ok(
    lf(dir, ['connect', '@lf/airtable', '--yes', '--base-url', `${url}/airtable`, '--oauth-authorize-url', `${url}/oauth/authorize`, '--oauth-token-url', `${url}/oauth/token`, '--client-id', 'lf-airtable-app', '--client-secret', 'lf-airtable-secret', '--redirect-port', '8978']),
  );
  const adding = lf(dir, ['credential', 'add', '--module', '@lf/airtable', 'my_airtable', '--credential', 'airtable', '--headless'], { answers: ['', ''] });
  const authorize = (await adding.line(/^\s+http:\/\/127\.0\.0\.1:\d+\/oauth\/authorize\?/)).trim();
  const location = (await fetch(authorize, { redirect: 'manual' })).headers.get('location');
  assert.ok(location !== null);
  await adding.line(/paste the URL your browser was sent back to/);
  adding.answer(location);
  await ok(adding);
  mkdirSync(join(dir, 'movements'), { recursive: true });
  return dir;
}

/** The expense review a builder wrote, against `base` and `table`, reading `field`. */
function check(dir: string, input: { base: string; table: string; field: string }) {
  writeFileSync(
    join(dir, 'movements/expenses.mvt'),
    `import { \`@lf/airtable\` as airtable } from adapters
import { my_airtable } from credentials

finance = connect airtable using my_airtable { base: "${input.base}" }

function \`Review Expense\`(change: <finance-[e:\`Record Change\` WHERE e.table == "${input.table}"]->>) {
  expense = only(change-[:Record]->)
  if (expense != null && expense.${input.field} > 500) {
    write expense { Vendor: "flagged" }
  }
}

listen to finance { base: "${input.base}", table: "${input.table}", events: ["record.created"] } fire \`Review Expense\`
`,
  );
  return lfSync(dir, 'check');
}

test('an Airtable event address must name a table the base has, and then types the record it carries', async () => {
  const fake = await fakeChannels();
  try {
    const dir = await connected(fake.url);

    const nowhere = check(dir, { base: 'Finance', table: 'Expenses', field: 'Amout' });
    assert.equal(nowhere.code, 1, nowhere.out);
    assert.match(nowhere.out, /expenses\.mvt:6:\d+ error MOV_UNKNOWN_POSITION .*"Expenses"/);
    assert.match(nowhere.out, /warning MOV_CONSTRUCT_UNKNOWN_OPTION 'base' value "Finance" isn't one this connection can see — try: "Pipeline Tracker", "Ops"/);

    const noTable = check(dir, { base: 'Ops', table: 'Expenses', field: 'Spend' });
    assert.equal(noTable.code, 1, noTable.out);
    assert.match(noTable.out, /expenses\.mvt:6:\d+ error MOV_ENUM_UNKNOWN_VALUE "Expenses" .*expected one of: tblVENDORS/);
    assert.doesNotMatch(noTable.out, /MOV_UNKNOWN_POSITION/);

    const misspelled = check(dir, { base: 'Ops', table: 'tblVENDORS', field: 'Spendd' });
    assert.equal(misspelled.code, 1, misspelled.out);
    assert.match(misspelled.out, /error MOV_UNKNOWN_PROPERTY .*Spendd/);
    assert.doesNotMatch(misspelled.out, /MOV_UNKNOWN_POSITION|MOV_CONSTRUCT_UNKNOWN_OPTION/);

    const right = check(dir, { base: 'Ops', table: 'tblVENDORS', field: 'Spend' });
    assert.equal(right.code, 0, right.out);
  } finally {
    await fake.stop();
  }
});

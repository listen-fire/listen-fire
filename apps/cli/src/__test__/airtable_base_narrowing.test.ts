// Narrowing an Airtable base (`-[b:Bases WHERE …]->`) by name types it through to that base's tables,
// as the module's authoring hints promise, under `listen-fire check` against the
// fake Airtable (packages/fake-channels: bases "Pipeline Tracker" and "Ops").

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';

import { lf as lfSync } from './example';
import { freePort, lf, ok } from './interactive';

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
  const dir = join(mkdtempSync(join(tmpdir(), 'lf-airtable-')), 'airtable-base');
  assert.equal(lfSync(join(dir, '..'), 'init', 'airtable-base').code, 0);
  await ok(
    lf(dir, ['connect', '@lf/airtable', '--yes', '--base-url', `${url}/airtable`, '--oauth-authorize-url', `${url}/oauth/authorize`, '--oauth-token-url', `${url}/oauth/token`, '--client-id', 'lf-airtable-app', '--client-secret', 'lf-airtable-secret', '--redirect-port', '0']),
  );
  const adding = lf(dir, ['credential', 'add', '--module', '@lf/airtable', 'my_airtable', '--credential', 'airtable', '--headless', '--redirect-port', String(await freePort())], { answers: ['', ''] });
  const authorize = (await adding.line(/^\s+http:\/\/127\.0\.0\.1:\d+\/oauth\/authorize\?/)).trim();
  const location = (await fetch(authorize, { redirect: 'manual' })).headers.get('location');
  assert.ok(location !== null);
  await adding.line(/paste the URL your browser was sent back to/);
  adding.answer(location);
  await ok(adding);
  mkdirSync(join(dir, 'movements'), { recursive: true });
  return dir;
}

interface Written {
  base: string;
  table: string;
  field: string;
}

/** The program a builder wrote: a base narrowed by name, a row written to one of its tables. */
function program(input: Written) {
  return `import { \`@lf/airtable\` as airtable } from adapters
import { my_airtable } from credentials

pipeline = connect airtable using my_airtable

function track(run: <manual-[:Invocations]->>) {
  base = only(pipeline-[b:Bases WHERE b.Name == "${input.base}"]->)
  if (base == null) { fail("no base") }
  write base-[:${input.table}]-> { ${input.field}: "Acme Narrowed" }
}

listen to manual-[:Invocations]-> fire track
`;
}

function check(dir: string, input: Written) {
  writeFileSync(join(dir, 'movements/pipeline.mvt'), program(input));
  return lfSync(dir, 'check');
}

function refused(result: { code: number; out: string }, pattern: RegExp) {
  assert.equal(result.code, 1, `${pattern}: ${result.out}`);
  assert.match(result.out, pattern);
}

test('a Base narrowed by name is typed by its own tables, and the write reaches it', async () => {
  const fake = await fakeChannels();
  try {
    const dir = await connected(fake.url);

    const right = check(dir, { base: 'Pipeline Tracker', table: 'Companies', field: 'Name' });
    assert.equal(right.code, 0, right.out);

    refused(check(dir, { base: 'Pipeline Tracker', table: 'Nope', field: 'Name' }), /pipeline\.mvt:9:\d+ error MOV_LINKED_UNKNOWN_EDGE .*'Nope'.*Companies, Contacts/);
    refused(check(dir, { base: 'Pipeline Tracker', table: 'Companies', field: 'Nmae' }), /pipeline\.mvt:9:\d+ error MOV_WRITE_UNKNOWN_FIELD .*Nmae/);

    const nowhere = check(dir, { base: 'Pipeline Trackr', table: 'Companies', field: 'Name' });
    refused(nowhere, /pipeline\.mvt:7:\d+ error MOV_UNKNOWN_POSITION 'pipeline' has no Base whose Name is "Pipeline Trackr" — it has: "Pipeline Tracker", "Ops" — did you mean 'Pipeline Tracker'\?/);
    assert.doesNotMatch(nowhere.out, /pipeline\.mvt:9:/, 'the write off it is not refused again');

    // The run lands the write where the check said it would: the record the
    // WHERE chose carries only its type (`Base`), so the check hands the run
    // the type `-[:Companies]->` creates off the base it chose.
    assert.equal(check(dir, { base: 'Pipeline Tracker', table: 'Companies', field: 'Name' }).code, 0);
    const ran = lfSync(dir, 'run', 'track');
    assert.equal(ran.code, 0, ran.out);
    assert.match(JSON.stringify(await fetch(`${fake.url}/airtable/v0/appTEST001/tblCOMPANIES`).then((r) => r.json())), /Acme Narrowed/);
  } finally {
    await fake.stop();
  }
});

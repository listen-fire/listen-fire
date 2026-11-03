// `listen-fire example <words>`: the command answers every query exactly as
// the handbook's lookup does (packages/handbook/micro_examples.ts; the binary
// ports its ranking, and this holds the two to one answer), and the examples
// that name a system the handbook's catalog does not carry are checked here,
// by `listen-fire check` against that module's fake (fake-channels' Airtable:
// bases "Pipeline Tracker" and "Ops").

import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';

import table from '../../../../packages/handbook/__test__/example_queries.json';
import { microExamples, renderExampleIndex, renderExampleLookup, searchExamples } from '../../../../packages/handbook/micro_examples';
import { lf as lfSync } from './example';
import { freePort, lf, ok } from './interactive';
import { lfBinary } from './lf_bin';

function example(...words: string[]): { code: number; out: string } {
  const ran = spawnSync(lfBinary(), ['example', ...words], { encoding: 'utf8' });
  return { code: ran.status ?? -1, out: ran.stdout + ran.stderr };
}

/** Phrasings beyond the quality table, so the parity covers stems, camelCase, punctuation and misses. */
const MORE = ["today's date", 'Dict.keys', 'groupBy', 'unique_by', 'records recorded recording', 'listenTo arrivals', 'zzzz qqqq', 'the a of'];

test('the command answers every query as the handbook does', () => {
  for (const query of [...table.queries.map((row) => row.query), ...MORE]) {
    const found = searchExamples(query);
    const ran = example(query);
    assert.equal(ran.out, `${renderExampleLookup(query, found)}\n`, query);
    assert.equal(ran.code, found.length > 0 ? 0 : 1, query);
  }
});

test('words given apart are one query', () => {
  assert.equal(example('create', 'or', 'update').out, example('create or update').out);
});

test('with no words, every example by its intent', () => {
  const ran = example();
  assert.equal(ran.code, 0);
  const [heading, ...rest] = ran.out.trimEnd().split('\n');
  assert.match(heading, /^listen-fire example <words…>/);
  assert.equal(rest.join('\n'), renderExampleIndex());
});

async function fakeChannels(): Promise<{ url: string; stop(): Promise<void> }> {
  const cwd = mkdtempSync(join(tmpdir(), 'lf-micro-fake-'));
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

/** A project with `@lf/airtable` installed against the fake and a credential `my_airtable`, as the examples name it. */
async function airtableProject(url: string): Promise<string> {
  const dir = join(mkdtempSync(join(tmpdir(), 'lf-micro-')), 'micro');
  assert.equal(lfSync(join(dir, '..'), 'init', 'micro').code, 0);
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
  // The starter movement is not an example's; each example is the project's only file.
  rmSync(join(dir, 'movements'), { recursive: true, force: true });
  mkdirSync(join(dir, 'movements'));
  return dir;
}

test('an example naming a system the handbook does not carry is checked against its fake: 0 errors', async () => {
  const faked = microExamples().filter((e) => e.fake);
  assert.ok(faked.length > 0);
  const fake = await fakeChannels();
  try {
    const dir = await airtableProject(fake.url);
    for (const e of faked) {
      assert.equal(e.kind, 'file', `${e.id} is a whole file`);
      writeFileSync(join(dir, 'movements/example.mvt'), `${e.code}\n`);
      const checked = lfSync(dir, 'check');
      assert.equal(checked.code, 0, `${e.id}:\n${checked.out}`);
      assert.doesNotMatch(checked.out, / error /, e.id);
    }
  } finally {
    await fake.stop();
  }
});

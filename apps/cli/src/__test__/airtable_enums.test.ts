// An Airtable select field's choices are the checker's enum, and a base the
// connection names (`{ base: "Pipeline Tracker" }`) is typed by its own tables,
// against the fake Airtable (packages/fake-channels): `lf check` refuses an
// unknown field and an unknown choice in a write and in a WHERE comparison,
// and accepts a known one; `lf run` writes a known one into the named base.

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';

import { lf as lfSync } from './example';
import { lf, ok } from './interactive';

interface Fake {
  url: string;
  json(path: string): Promise<unknown>;
  stop(): Promise<void>;
}

async function fakeChannels(): Promise<Fake> {
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
  return { url, json: async (path) => (await fetch(`${url}${path}`)).json(), stop: async () => (child.kill('SIGTERM'), exited) };
}

const HEAD = `import { \`@lf/airtable\` as airtable } from adapters
import { henry_airtable } from credentials

crm = connect airtable using henry_airtable { base: "Pipeline Tracker" }
`;

const write = (fields: string) => `write crm-[:Companies]-> { unique by (Name)\n    Name: "Acme"\n    ${fields} }`;
const KNOWN = write('Stage: "Won"\n    Tags: ["Hot"]');

async function connected(): Promise<{ dir: string; fake: Fake }> {
  const fake = await fakeChannels();
  const dir = join(mkdtempSync(join(tmpdir(), 'lf-airtable-')), 'airtable-enums');
  assert.equal(lfSync(join(dir, '..'), 'init', 'airtable-enums').code, 0);
  await ok(
    lf(dir, ['connect', '@lf/airtable', '--yes', '--base-url', `${fake.url}/airtable`, '--oauth-authorize-url', `${fake.url}/oauth/authorize`, '--oauth-token-url', `${fake.url}/oauth/token`], {
      answers: ['lf-airtable-app', 'lf-airtable-secret', '8977'],
    }),
  );
  const adding = lf(dir, ['credential', 'add', '--module', '@lf/airtable', 'henry_airtable', '--credential', 'airtable', '--headless'], { answers: ['', ''] });
  const authorize = (await adding.line(/^\s+http:\/\/127\.0\.0\.1:\d+\/oauth\/authorize\?/)).trim();
  const location = (await fetch(authorize, { redirect: 'manual' })).headers.get('location');
  assert.ok(location !== null);
  await adding.line(/paste the URL your browser was sent back to/);
  adding.answer(location);
  await ok(adding);
  mkdirSync(join(dir, 'movements'), { recursive: true });
  return { dir, fake };
}

/** `tag` as a function over `param`, whose body is `body`. */
function check(dir: string, input: { param?: string; body?: string }) {
  const param = input.param ?? 'crm-[c:Companies]->';
  writeFileSync(join(dir, 'movements/tag.mvt'), `${HEAD}\nfunction tag(company: <${param}>) {\n  ${input.body ?? KNOWN}\n}\n`);
  return lfSync(dir, 'check');
}

function refused(result: { code: number; out: string }, pattern: RegExp) {
  assert.equal(result.code, 1, `${pattern}: ${result.out}`);
  assert.match(result.out, pattern);
}

test('lf check holds Airtable select values to the base\'s choices, and lf run writes a known one', async () => {
  const { dir, fake } = await connected();
  try {
    const known = check(dir, {});
    assert.equal(known.code, 0, known.out);
    refused(check(dir, { body: write('Bogus: "x"') }), /MOV_WRITE_UNKNOWN_FIELD/);
    refused(check(dir, { body: write('Stage: "Lost"\n    Tags: ["Hot"]') }), /MOV_ENUM_UNKNOWN_VALUE "Lost"/);
    const where = (stage: string) => ({ body: `crm-[c:Companies WHERE c.\`Stage\` == "${stage}"]-> {\n    ${KNOWN}\n  }` });
    const open = check(dir, where('Open'));
    assert.equal(open.code, 0, open.out);
    refused(check(dir, where('Lost')), /MOV_ENUM_UNKNOWN_VALUE "Lost"/);

    // The known write, run, reaches the base the connection names.
    writeFileSync(join(dir, 'movements/tag.mvt'), `${HEAD}\nfunction tag(run: <manual-[:Invocation]->>) {\n  ${KNOWN}\n}\n\nlisten to manual fire tag\n`);
    const ran = lfSync(dir, 'run', 'tag');
    assert.equal(ran.code, 0, ran.out);
    const stored = JSON.stringify(await fake.json('/airtable/v0/appTEST001/tblCOMPANIES'));
    assert.match(stored, /Acme/);
    assert.match(stored, /Won/);
  } finally {
    await fake.stop();
  }
});

// A multiple select is a list of its enum: each literal of a list written into
// it is one of the base's choices, and a WHERE inside a parameter's type is
// held against the choices as one in a body is.
test('an unknown choice inside a multiple select write, or in a parameter type WHERE, is refused', async () => {
  const { dir, fake } = await connected();
  try {
    refused(check(dir, { body: write('Tags: ["Hot", "Cold"]') }), /MOV_ENUM_UNKNOWN_VALUE "Cold"/);
    refused(check(dir, { param: 'crm-[c:Companies WHERE c.`Stage` == "Lost"]->' }), /MOV_ENUM_UNKNOWN_VALUE "Lost"/);
  } finally {
    await fake.stop();
  }
});

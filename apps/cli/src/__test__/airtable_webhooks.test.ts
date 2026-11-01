// Airtable listens under listen-fire serve, against the fake Airtable
// (packages/fake-channels). A listen walks to the tables it hears by name —
// `at-[b:Bases WHERE b.Name == "Hiring"]->-[t:Tables WHERE t.Name ==
// "Expenses"]->-[c:Changes …]->` — and listen-fire registers one webhook per
// table it lands on, plus one schema webhook per base whose tables it narrows.
// A change runs only its table's listens, judged on its Kind, Field and New;
// a table renamed into the filter is watched from the moment Airtable's schema
// webhook reports it, its earlier changes never replayed. A 0.12 listen in
// the settings form is rewritten onto the table's Changes by upgrade.

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';

import { lf as lfSync, served } from './example';
import { lf, ok } from './interactive';

const REPO = resolve(__dirname, '../../../..');
process.env.LF_MODULES_DIR ??= join(REPO, 'modules');
process.env.LF_SERVE_MODULE ??= join(REPO, 'packages/module-kit/bin/serve-module.cjs');

interface Fake {
  url: string;
  json(path: string, body?: unknown): Promise<unknown>;
  stop(): Promise<void>;
}

async function fakeChannels(): Promise<Fake> {
  const cwd = mkdtempSync(join(tmpdir(), 'lf-airtable-webhooks-fake-'));
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
  const json = async (path: string, body?: unknown) => {
    const answer = await fetch(`${url}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(answer.status, 200, `${path}: ${await answer.clone().text()}`);
    return answer.json() as Promise<unknown>;
  };
  return { url, json, stop: async () => (child.kill('SIGTERM'), exited) };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  await new Promise<void>((done) => server.close(() => done()));
  return address.port;
}

/** Wait, up to 20s, for `holds` to hold over the server's output. */
async function until(holds: () => boolean, lines: string[]): Promise<void> {
  for (const deadline = Date.now() + 20_000; !holds(); ) {
    if (Date.now() > deadline) throw new Error(`timed out; saw:\n${lines.join('\n')}`);
    await new Promise((done) => setTimeout(done, 50));
  }
}

/** A Hiring base: candidates with a Stage select, the interviews a movement
 *  writes, and roles. */
const HIRING = [
  { entity_type: 'base', id: 'appHIRE01', data: { id: 'appHIRE01', name: 'Hiring' } },
  {
    entity_type: 'table:appHIRE01',
    id: 'tblCAND01',
    data: {
      id: 'tblCAND01',
      name: 'Candidates',
      primaryFieldId: 'fldCName',
      fields: [
        { id: 'fldCName', name: 'Name', type: 'singleLineText' },
        { id: 'fldCEmail', name: 'Email', type: 'email' },
        { id: 'fldStage', name: 'Stage', type: 'singleSelect', options: { choices: [{ id: 'selApplied', name: 'Applied' }, { id: 'selInterview', name: 'Interview' }, { id: 'selRejected', name: 'Rejected' }] } },
      ],
    },
  },
  {
    entity_type: 'table:appHIRE01',
    id: 'tblINTV01',
    data: {
      id: 'tblINTV01',
      name: 'Interviews',
      primaryFieldId: 'fldICand',
      fields: [
        { id: 'fldICand', name: 'Candidate', type: 'singleLineText' },
        { id: 'fldIFrom', name: 'From', type: 'singleLineText' },
        { id: 'fldIChanged', name: 'Changed', type: 'singleLineText' },
      ],
    },
  },
  { entity_type: 'record:appHIRE01:tblCAND01', id: 'recADA', data: { id: 'recADA', fields: { Name: 'Ada Lovelace', Email: 'ada@example.com', Stage: 'Applied' } } },
  {
    entity_type: 'table:appHIRE01',
    id: 'tblROLE01',
    data: { id: 'tblROLE01', name: 'Roles', primaryFieldId: 'fldRName', fields: [{ id: 'fldRName', name: 'Title', type: 'singleLineText' }] },
  },
  {
    entity_type: 'table:appHIRE01',
    id: 'tblEXPN01',
    data: { id: 'tblEXPN01', name: 'Expenses', primaryFieldId: 'fldEName', fields: [{ id: 'fldEName', name: 'Item', type: 'singleLineText' }] },
  },
];

/** A project connected to the fake Airtable as `henry_airtable`, seeded with
 *  the Hiring base. */
async function hiringProject(fake: Fake): Promise<string> {
  await fake.json('/admin/airtable/seed', { entities: HIRING });
  const dir = join(mkdtempSync(join(tmpdir(), 'lf-airtable-webhooks-')), 'hiring');
  assert.equal(lfSync(join(dir, '..'), 'init', 'hiring').code, 0);
  await ok(
    lf(dir, ['connect', '@lf/airtable', '--yes', '--base-url', `${fake.url}/airtable`, '--oauth-authorize-url', `${fake.url}/oauth/authorize`, '--oauth-token-url', `${fake.url}/oauth/token`, '--client-id', 'lf-airtable-app', '--client-secret', 'lf-airtable-secret', '--redirect-port', '8978']),
  );
  const adding = lf(dir, ['credential', 'add', '--module', '@lf/airtable', 'henry_airtable', '--credential', 'airtable', '--headless'], { answers: ['', ''] });
  const authorize = (await adding.line(/^\s+http:\/\/127\.0\.0\.1:\d+\/oauth\/authorize\?/)).trim();
  const location = (await fetch(authorize, { redirect: 'manual' })).headers.get('location');
  assert.ok(location !== null);
  await adding.line(/paste the URL your browser was sent back to/);
  adding.answer(location);
  await ok(adding);
  mkdirSync(join(dir, 'movements'), { recursive: true });
  return dir;
}

interface Webhook {
  id: string;
  baseId: string;
  notificationUrl: string;
  dataTypes: string[];
  recordChangeScope?: string;
  expirationTime: string;
}

interface Deliveries {
  deliveries: Array<{ webhookId: string; targetUrl: string; status: number }>;
}

const HEAD = `import { \`@lf/airtable\` as airtable } from adapters
import { henry_airtable } from credentials

at = connect airtable using henry_airtable
`;

/** A listen on the Expenses tables of the Hiring base, firing `review`. */
const EXPENSES = `${HEAD}
function review(c: <at-[:Change]->>) {
  return c.Kind
}

listen to at-[b:Bases WHERE b.Name == "Hiring"]->-[t:Tables WHERE t.Name == "Expenses"]->-[c:Changes WHERE c.Kind == "created"]-> fire review
`;

/** Serve `dir` at a public URL of its own; `door` names a webhook's door. */
async function serving(dir: string) {
  const port = await freePort();
  appendFileSync(join(dir, 'lf.yaml'), `publicUrl: http://127.0.0.1:${port}\n`);
  return served(dir, ['--port', String(port)]);
}

/** The fake's webhooks: those on rows, by the table each is scoped to, and
 *  those on a base's schema, by the base. */
async function webhooksOf(fake: Fake): Promise<{ tables: string[]; schemas: string[]; all: Webhook[] }> {
  const all = (await fake.json('/admin/airtable/webhook/state')) as Webhook[];
  return {
    tables: all.filter((w) => w.dataTypes.includes('tableData')).map((w) => w.recordChangeScope ?? '').sort(),
    schemas: all.filter((w) => w.dataTypes.includes('tableMetadata')).map((w) => w.baseId).sort(),
    all,
  };
}

const deliver = (fake: Fake, change: Record<string, unknown>) => fake.json('/airtable/control/deliver', { baseId: 'appHIRE01', ...change }) as Promise<Deliveries>;

test('a listen on Expenses changes registers one webhook for that table and fires on a created record', async () => {
  const fake = await fakeChannels();
  try {
    const dir = await hiringProject(fake);
    writeFileSync(join(dir, 'movements/hiring.mvt'), EXPENSES);
    const checked = lfSync(dir, 'check');
    assert.equal(checked.code, 0, checked.out);
    const server = await serving(dir);
    try {
      await until(() => server.lines.filter((l) => /registered webhook ach\d+/.test(l)).length >= 2, server.lines);
      const registered = await webhooksOf(fake);
      assert.deepEqual(registered.tables, ['tblEXPN01'], 'one webhook, for the Expenses table alone');
      assert.deepEqual(registered.schemas, ['appHIRE01'], 'and one on the base\'s tables, which the listen narrows by name');
      const runs = () => server.lines.filter((l) => /^run \S+ hiring:review completed$/.test(l)).length;

      const created = await deliver(fake, { changeType: 'add', tableId: 'tblEXPN01', recordId: 'recTAXI', fields: { Item: 'Taxi' } });
      assert.deepEqual(created.deliveries.map((d) => d.status), [200]);
      await until(() => runs() === 1, server.lines);

      // An update of the same table is not a creation; a row made in another table reaches no webhook.
      await deliver(fake, { changeType: 'update', tableId: 'tblEXPN01', recordId: 'recTAXI', fields: { Item: 'Cab' }, previous: { Item: 'Taxi' } });
      const elsewhere = await deliver(fake, { changeType: 'add', tableId: 'tblROLE01', recordId: 'recENG', fields: { Title: 'Engineer' } });
      assert.deepEqual(elsewhere.deliveries, []);
      await deliver(fake, { changeType: 'add', tableId: 'tblEXPN01', recordId: 'recHOTEL', fields: { Item: 'Hotel' } });
      await until(() => runs() === 2, server.lines);
      assert.equal(runs(), 2, 'the update ran nothing');
    } finally {
      await server.stop();
    }
  } finally {
    await fake.stop();
  }
});

test('a table renamed into the filter is watched from the next re-resolution, and its earlier changes are not replayed', async () => {
  const fake = await fakeChannels();
  try {
    const dir = await hiringProject(fake);
    writeFileSync(join(dir, 'movements/hiring.mvt'), EXPENSES.replace('c:Changes WHERE c.Kind == "created"', 'c:Changes'));
    const server = await serving(dir);
    try {
      await until(() => server.lines.filter((l) => /registered webhook ach\d+/.test(l)).length >= 2, server.lines);
      assert.deepEqual((await webhooksOf(fake)).tables, ['tblEXPN01']);
      const runs = () => server.lines.filter((l) => /^run \S+ hiring:review completed$/.test(l)).length;

      // A role made while Roles is not an Expenses table: no webhook hears it.
      const before = await deliver(fake, { changeType: 'add', tableId: 'tblROLE01', recordId: 'recEARLY', fields: { Title: 'Early' } });
      assert.deepEqual(before.deliveries, []);

      // Roles is renamed Expenses: the base's schema webhook says so, and the
      // listen lists its tables again on that report alone, no clock moved.
      const renamed = (await fake.json('/airtable/control/rename-table', { baseId: 'appHIRE01', tableId: 'tblROLE01', name: 'Expenses' })) as Deliveries;
      assert.deepEqual(renamed.deliveries.map((d) => d.status), [200]);
      for (const deadline = Date.now() + 20_000; !(await webhooksOf(fake)).tables.includes('tblROLE01'); ) {
        if (Date.now() > deadline) throw new Error(`the renamed table was never watched; saw:\n${server.lines.join('\n')}`);
        await new Promise((done) => setTimeout(done, 100));
      }
      assert.deepEqual((await webhooksOf(fake)).tables, ['tblEXPN01', 'tblROLE01']);
      const listed = lfSync(dir, 'listens');
      assert.match(listed.out, /hiring:review .* watching 2 Tables, resolved \d+s ago/, listed.out);

      // Its change from before the rename is never replayed; its next one runs.
      assert.equal(runs(), 0, 'nothing ran for the role made before the rename');
      await deliver(fake, { changeType: 'add', tableId: 'tblROLE01', recordId: 'recLATE', fields: { Title: 'Late' } });
      await until(() => runs() === 1, server.lines);
      await new Promise((done) => setTimeout(done, 500));
      assert.equal(runs(), 1, 'only the change after the rename ran');
    } finally {
      await server.stop();
    }
  } finally {
    await fake.stop();
  }
});

test('a table renamed out of the filter is watched no more', async () => {
  const fake = await fakeChannels();
  try {
    const dir = await hiringProject(fake);
    writeFileSync(join(dir, 'movements/hiring.mvt'), EXPENSES.replace('c:Changes WHERE c.Kind == "created"', 'c:Changes'));
    const server = await serving(dir);
    try {
      await until(() => server.lines.filter((l) => /registered webhook ach\d+/.test(l)).length >= 2, server.lines);
      assert.deepEqual((await webhooksOf(fake)).tables, ['tblEXPN01']);
      const runs = () => server.lines.filter((l) => /^run \S+ hiring:review completed$/.test(l)).length;

      // Expenses is renamed Receipts: the base's schema webhook says so, and
      // the table's own webhook is removed as the listen lists its tables again.
      const renamed = (await fake.json('/airtable/control/rename-table', { baseId: 'appHIRE01', tableId: 'tblEXPN01', name: 'Receipts' })) as Deliveries;
      assert.deepEqual(renamed.deliveries.map((d) => d.status), [200]);
      for (const deadline = Date.now() + 20_000; (await webhooksOf(fake)).tables.length > 0; ) {
        if (Date.now() > deadline) throw new Error(`the renamed table was still watched; saw:\n${server.lines.join('\n')}`);
        await new Promise((done) => setTimeout(done, 100));
      }
      assert.deepEqual((await webhooksOf(fake)).schemas, ['appHIRE01'], 'the base is still narrowed by name, so its schema is still watched');

      // A row made in it now reaches no webhook, and nothing runs.
      const after = await deliver(fake, { changeType: 'add', tableId: 'tblEXPN01', recordId: 'recAFTER', fields: { Item: 'Lunch' } });
      assert.deepEqual(after.deliveries, []);
      await new Promise((done) => setTimeout(done, 500));
      assert.equal(runs(), 0);
    } finally {
      await server.stop();
    }
  } finally {
    await fake.stop();
  }
});

/** A Spending base beside Hiring, holding no Expenses table. */
const SPENDING = [
  { entity_type: 'base', id: 'appSPND01', data: { id: 'appSPND01', name: 'Spending' } },
  { entity_type: 'table:appSPND01', id: 'tblLEDG01', data: { id: 'tblLEDG01', name: 'Ledger', primaryFieldId: 'fldLItem', fields: [{ id: 'fldLItem', name: 'Item', type: 'singleLineText' }] } },
];

/** A listen on the Expenses tables of the Hiring and Finance bases. */
const HIRING_AND_FINANCE = EXPENSES.replace('b:Bases WHERE b.Name == "Hiring"', 'b:Bases WHERE b.Name IN ["Hiring", "Finance"]').replace('c:Changes WHERE c.Kind == "created"', 'c:Changes');

test('a base renamed into the filter with no matching table is watched for one, and a table made in it is watched at once', async () => {
  const fake = await fakeChannels();
  try {
    const dir = await hiringProject(fake);
    await fake.json('/admin/airtable/seed', { entities: SPENDING });
    writeFileSync(join(dir, 'movements/hiring.mvt'), HIRING_AND_FINANCE);
    // Airtable reports no base renamed: the listen lists its bases again on a clock.
    appendFileSync(join(dir, 'lf.yaml'), 'resolveEvery:\n  henry_airtable: 4s\n');
    const server = await serving(dir);
    try {
      await until(() => server.lines.filter((l) => /registered webhook ach\d+/.test(l)).length >= 2, server.lines);
      assert.deepEqual([(await webhooksOf(fake)).tables, (await webhooksOf(fake)).schemas], [['tblEXPN01'], ['appHIRE01']]);

      // Spending becomes Finance: the bases listed again hold it, with no
      // Expenses table, so the listen's tables are as they were, and its base
      // is watched for one.
      await fake.json('/airtable/control/rename-base', { baseId: 'appSPND01', name: 'Finance' });
      for (const deadline = Date.now() + 20_000; !(await webhooksOf(fake)).schemas.includes('appSPND01'); ) {
        if (Date.now() > deadline) throw new Error(`the renamed base's tables were never watched; saw:\n${server.lines.join('\n')}`);
        await new Promise((done) => setTimeout(done, 100));
      }
      assert.deepEqual((await webhooksOf(fake)).tables, ['tblEXPN01']);

      // An Expenses table made in it is reported by that webhook, and watched
      // on that report, well before the clock lists the bases again.
      const made = (await fake.json('/airtable/control/create-table', { baseId: 'appSPND01', table: { id: 'tblEXPN02', name: 'Expenses', primaryFieldId: 'fldEItem', fields: [{ id: 'fldEItem', name: 'Item', type: 'singleLineText' }] } })) as Deliveries;
      assert.deepEqual(made.deliveries.map((d) => d.status), [200]);
      for (const deadline = Date.now() + 2_500; !(await webhooksOf(fake)).tables.includes('tblEXPN02'); ) {
        if (Date.now() > deadline) throw new Error(`the table made in the renamed base was not watched on its report; saw:\n${server.lines.join('\n')}`);
        await new Promise((done) => setTimeout(done, 100));
      }
      const runs = () => server.lines.filter((l) => /^run \S+ hiring:review completed$/.test(l)).length;
      await deliver(fake, { baseId: 'appSPND01', changeType: 'add', tableId: 'tblEXPN02', recordId: 'recFIN01', fields: { Item: 'Audit' } });
      await until(() => runs() === 1, server.lines);
    } finally {
      await server.stop();
    }
  } finally {
    await fake.stop();
  }
});

test('the bases a listen\'s tables hang off count against listenScopeLimit, said as Bases', async () => {
  const fake = await fakeChannels();
  try {
    const dir = await hiringProject(fake);
    await fake.json('/admin/airtable/seed', { entities: SPENDING });
    await fake.json('/airtable/control/rename-base', { baseId: 'appSPND01', name: 'Finance' });
    writeFileSync(join(dir, 'movements/hiring.mvt'), HIRING_AND_FINANCE);
    // One Expenses table, within the limit; two bases it is looked for in, past it.
    appendFileSync(join(dir, 'lf.yaml'), 'listenScopeLimit: 1\n');
    const server = await serving(dir);
    try {
      const said = 'LISTEN_SCOPE_LIMIT: hiring:review matched more Bases than its limit of 1; it is suspended until its filter matches fewer';
      await until(() => server.lines.some((l) => l.includes(said)), server.lines);
      const listed = lfSync(dir, 'listens');
      assert.ok(listed.out.includes(said), listed.out);
      assert.deepEqual((await webhooksOf(fake)).tables, [], 'suspended: watched nowhere');
    } finally {
      await server.stop();
    }
  } finally {
    await fake.stop();
  }
});

/** The candidates' Stage listen at a connection positioned at Hiring. */
const STAGE = `import { \`@lf/airtable\` as airtable } from adapters
import { henry_airtable } from credentials

hiring = connect airtable using henry_airtable { base: "Hiring" }

function schedule_interview(c: <hiring-[:Change]->>) {
  write hiring-[:Interviews]-> {
    Candidate: coalesce(only(c-[:Record]->).Id, "unknown")
    From: coalesce(c.Old, "nothing")
    Changed: coalesce(c.Field, "nothing")
  }
}

listen to hiring-[t:Tables WHERE t.Name == "Candidates"]->-[c:Changes WHERE c.Field == "Stage" AND c.New == "Interview"]-> fire schedule_interview
`;

test('Stage becoming Interview fires; Stage becoming Rejected does not', async () => {
  const fake = await fakeChannels();
  try {
    const dir = await hiringProject(fake);
    writeFileSync(join(dir, 'movements/hiring.mvt'), STAGE);
    const checked = lfSync(dir, 'check');
    assert.equal(checked.code, 0, checked.out);
    const server = await serving(dir);
    try {
      await until(() => server.lines.filter((l) => /registered webhook ach\d+/.test(l)).length >= 2, server.lines);
      const registered = await webhooksOf(fake);
      assert.deepEqual([registered.tables, registered.schemas], [['tblCAND01'], ['appHIRE01']]);
      const interviews = () => server.lines.filter((l) => /^run \S+ hiring:schedule_interview completed$/.test(l)).length;

      // One update of Name and Stage is two changes: only Stage's runs it.
      await deliver(fake, { changeType: 'update', tableId: 'tblCAND01', recordId: 'recADA', fields: { Name: 'Ada', Stage: 'Interview' }, previous: { Name: 'Ada Lovelace', Stage: 'Applied' } });
      await until(() => interviews() === 1, server.lines);
      const written = JSON.stringify(await fake.json('/airtable/v0/appHIRE01/tblINTV01'));
      // The fake keeps a written row's cells by field id.
      assert.match(written, /"fldICand":"recADA"/, 'it read the row\'s id off the change\'s Record');
      assert.match(written, /"fldIFrom":"Applied"/, 'it read the Stage it was');
      assert.match(written, /"fldIChanged":"Stage"/, 'it read the field the change touched');

      // Stage becomes Rejected: the webhook is pinged, and nothing runs.
      const rejected = await deliver(fake, { changeType: 'update', tableId: 'tblCAND01', recordId: 'recBOB', fields: { Stage: 'Rejected' }, previous: { Stage: 'Applied' } });
      assert.deepEqual(rejected.deliveries.map((d) => d.status), [200]);
      await deliver(fake, { changeType: 'update', tableId: 'tblCAND01', recordId: 'recCY', fields: { Stage: 'Interview' }, previous: { Stage: 'Rejected' } });
      await until(() => interviews() === 2, server.lines);
      assert.equal(interviews(), 2, 'Rejected ran nothing');
    } finally {
      await server.stop();
    }
  } finally {
    await fake.stop();
  }
});

test('upgrade rewrites the 0.12 Airtable listen and its Record Change parameter', async () => {
  const fake = await fakeChannels();
  try {
    const dir = await hiringProject(fake);
    const file = join(dir, 'movements/hiring.mvt');
    const old = `import { \`@lf/airtable\` as airtable } from adapters
import { henry_airtable } from credentials

hiring = connect airtable using henry_airtable { base: "Hiring" }

function seen(change: <hiring-[:\`Record Change\` WHERE \`table\` == "tblCAND01"]->>) {
  return "seen"
}

listen to hiring { base: "appHIRE01", table: "tblCAND01", events: ["record.updated"], field: "Stage", becomes: "Interview" } fire seen
`;
    writeFileSync(file, old);
    const lfYaml = join(dir, 'lf.yaml');
    writeFileSync(lfYaml, readFileSync(lfYaml, 'utf8').replace(/^engine: .*$/m, 'engine: 0.12.13'));
    const upgraded = lfSync(dir, 'upgrade');
    assert.equal(upgraded.code, 0, upgraded.out);
    assert.equal(
      readFileSync(file, 'utf8'),
      old
        .replace('<hiring-[:`Record Change` WHERE `table` == "tblCAND01"]->>', '<hiring-[:Change]->>')
        .replace(
          'listen to hiring { base: "appHIRE01", table: "tblCAND01", events: ["record.updated"], field: "Stage", becomes: "Interview" }',
          'listen to hiring-[t:Tables WHERE t.Id == "tblCAND01"]->-[c:Changes WHERE c.Kind IN ["updated"] AND c.Field == "Stage" AND c.New == "Interview" AND c.Old != "Interview"]->',
        ),
    );
    const checked = lfSync(dir, 'check');
    assert.equal(checked.code, 0, checked.out);
  } finally {
    await fake.stop();
  }
});

test('upgrade holds the pin on an Airtable listen whose meaning changed, says how, and rewrites it with --all', async () => {
  const fake = await fakeChannels();
  try {
    const dir = await hiringProject(fake);
    const file = join(dir, 'movements/hiring.mvt');
    const old = `import { \`@lf/airtable\` as airtable } from adapters
import { henry_airtable } from credentials

hiring = connect airtable using henry_airtable { base: "Hiring" }

function any_change(change: <hiring-[:\`Record Change\`]->>) {
  return "changed"
}

function staged(change: <hiring-[:\`Record Change\`]->>) {
  return "staged"
}

listen to hiring { base: "appHIRE01", table: "tblCAND01" } fire any_change
listen to hiring { base: "appHIRE01", table: "tblCAND01", field: "Stage", becomes: "Interview" } fire staged
`;
    writeFileSync(file, old);
    const lfYaml = join(dir, 'lf.yaml');
    writeFileSync(lfYaml, readFileSync(lfYaml, 'utf8').replace(/^engine: .*$/m, 'engine: 0.12.13'));

    const held = lfSync(dir, 'upgrade');
    assert.equal(held.code, 1, held.out);
    assert.match(held.out, /fire any_change` \(a listen hearing updates with no `field` now runs once for each field an update touched, where 0\.12 ran it once per update\)/, held.out);
    assert.match(held.out, /fire staged` \(a `field` or `becomes` listen no longer runs on a newly created row, where 0\.12 counted every field of a created row as changed\)/, held.out);
    assert.equal(readFileSync(file, 'utf8'), old, 'nothing is rewritten while a meaning changed is unannounced');

    const upgraded = lfSync(dir, 'upgrade', '--all');
    assert.equal(upgraded.code, 0, upgraded.out);
    const rewritten = readFileSync(file, 'utf8');
    assert.match(rewritten, /listen to hiring-\[t:Tables WHERE t\.Id == "tblCAND01"\]->-\[:Changes\]-> fire any_change/);
    assert.match(rewritten, /listen to hiring-\[t:Tables WHERE t\.Id == "tblCAND01"\]->-\[c:Changes WHERE c\.Field == "Stage" AND c\.New == "Interview" AND c\.Old != "Interview"\]-> fire staged/);
    const checked = lfSync(dir, 'check');
    assert.equal(checked.code, 0, checked.out);
  } finally {
    await fake.stop();
  }
});

const DAY_MS = 24 * 60 * 60 * 1000;

test('a quiet webhook is refreshed a day before it lapses, and one that lapsed is registered anew', async () => {
  const fake = await fakeChannels();
  try {
    const dir = await hiringProject(fake);
    writeFileSync(join(dir, 'movements/hiring.mvt'), STAGE);
    const port = await freePort();
    appendFileSync(join(dir, 'lf.yaml'), `publicUrl: http://127.0.0.1:${port}\n`);
    const tableHook = async () => (await webhooksOf(fake)).all.find((w) => w.recordChangeScope === 'tblCAND01');
    // listen-fire's clock and the fake's moved on together: `days` past the registration.
    const serveAt = (days: number) => served(dir, ['--port', String(port)], days === 0 ? {} : { LF_CLOCK_AHEAD_MS: String(days * DAY_MS) });
    const advance = (days: number) => fake.json('/airtable/control/advance-clock', { ms: days * DAY_MS });

    // Registered, expiring in 7 days.
    let server = await serveAt(0);
    await until(() => server.lines.filter((l) => /registered webhook ach\d+/.test(l)).length >= 2, server.lines);
    await server.stop();
    const registered = await tableHook();
    assert.ok(registered !== undefined);

    // Six and a half days on, nothing delivered: refreshed, by the same webhook.
    await advance(6.5);
    server = await serveAt(6.5);
    try {
      await server.waitFor(new RegExp(`refreshed webhook ${registered.id}; it expires at `));
    } finally {
      await server.stop();
    }
    const kept = await tableHook();
    assert.equal(kept?.id, registered.id, 'no webhook registered anew');
    assert.ok(Date.parse(kept.expirationTime) - Date.parse(registered.expirationTime) > 6 * DAY_MS, 'its expiry moved on');

    // Eight days more with listen-fire down: it lapsed, so it is registered anew, and the new one delivers.
    await advance(8);
    server = await serveAt(14.5);
    try {
      await server.waitFor(new RegExp(`webhook ${registered.id} lapsed at .*; registered webhook ach\\d+`));
      const now = await tableHook();
      assert.notEqual(now?.id, registered.id);
      const delivered = await deliver(fake, { changeType: 'update', tableId: 'tblCAND01', recordId: 'recADA', fields: { Stage: 'Interview' }, previous: { Stage: 'Applied' } });
      assert.deepEqual(delivered.deliveries.map((d) => [d.webhookId, d.status]), [[now?.id, 200]]);
      await server.waitFor(/^run \S+ hiring:schedule_interview completed$/);
    } finally {
      await server.stop();
    }
  } finally {
    await fake.stop();
  }
});

// Airtable listens under listen-fire serve, against the fake Airtable
// (packages/fake-channels). A listen walks to the tables it hears by name —
// `at-[b:Bases WHERE b.Name == "Hiring"]->-[t:Tables WHERE t.Name ==
// "Expenses"]->-[c:Changes …]->` — and listen-fire registers one data webhook
// per base its tables are in, whatever number of them it watches, plus one
// schema webhook per base whose tables it narrows: the 2 webhooks per base
// Airtable lets an OAuth integration make, which the fake enforces.
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
import { DatabaseSync } from 'node:sqlite';
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

/** A Hiring base: candidates with a Stage select and an Owner (a
 *  collaborator, which Airtable sends as an object), the interviews a
 *  movement writes, and roles. */
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
        { id: 'fldOwner', name: 'Owner', type: 'singleCollaborator' },
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
  { entity_type: 'record:appHIRE01:tblCAND01', id: 'recADA', data: { id: 'recADA', fields: { Name: 'Ada Lovelace', Email: 'ada@example.com', Stage: 'Applied', Owner: { id: 'usrANN', email: 'ann@example.com', name: 'Ann' } } } },
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

/** The fake's webhooks: those on rows, by their base (none is scoped to one
 *  table), and those on a base's schema, by the base. */
async function webhooksOf(fake: Fake): Promise<{ data: string[]; schemas: string[]; all: Webhook[] }> {
  const all = (await fake.json('/admin/airtable/webhook/state')) as Webhook[];
  const data = all.filter((w) => w.dataTypes.includes('tableData'));
  assert.deepEqual(data.filter((w) => w.recordChangeScope !== undefined), [], 'a data webhook watches every table of its base');
  return {
    data: data.map((w) => w.baseId).sort(),
    schemas: all.filter((w) => w.dataTypes.includes('tableMetadata')).map((w) => w.baseId).sort(),
    all,
  };
}

/** Wait, up to `ms`, for the listen to be listed as watching `tables` Tables. */
async function watching(dir: string, tables: number, ms: number, lines: string[]): Promise<void> {
  const shown = new RegExp(`hiring:review .* watching ${tables} Tables?, resolved \\d+s ago`);
  for (const deadline = Date.now() + ms; !shown.test(lfSync(dir, 'listens').out); ) {
    if (Date.now() > deadline) throw new Error(`never watched ${tables} Tables: ${lfSync(dir, 'listens').out}\n${lines.join('\n')}`);
    await new Promise((done) => setTimeout(done, 100));
  }
}

const deliver = (fake: Fake, change: Record<string, unknown>) => fake.json('/airtable/control/deliver', { baseId: 'appHIRE01', ...change }) as Promise<Deliveries>;

test('a listen on Expenses changes registers one data webhook on its base and fires on a created record', async () => {
  const fake = await fakeChannels();
  try {
    const dir = await hiringProject(fake);
    // Walked to from the workspace, the table's changes are typed by its own
    // fields too: one it has reads, one it lacks is refused where it is written.
    const reading = (field: string) => EXPENSES.replace('c.Kind == "created"]->', `c.Kind == "created" AND exists(c.Current) AND c.Current.${field} != "skip"]->`);
    writeFileSync(join(dir, 'movements/hiring.mvt'), reading('Itm'));
    const misspelled = lfSync(dir, 'check');
    assert.equal(misspelled.code, 1, misspelled.out);
    assert.match(misspelled.out, /error MOV_UNKNOWN_PROPERTY .*Itm/);
    writeFileSync(join(dir, 'movements/hiring.mvt'), reading('Item'));
    const typed = lfSync(dir, 'check');
    assert.equal(typed.code, 0, typed.out);
    writeFileSync(join(dir, 'movements/hiring.mvt'), EXPENSES);
    const checked = lfSync(dir, 'check');
    assert.equal(checked.code, 0, checked.out);
    const server = await serving(dir);
    try {
      await until(() => server.lines.filter((l) => /registered webhook ach\d+/.test(l)).length >= 2, server.lines);
      const registered = await webhooksOf(fake);
      assert.deepEqual(registered.data, ['appHIRE01'], 'one webhook on the base\'s rows');
      assert.deepEqual(registered.schemas, ['appHIRE01'], 'and one on the base\'s tables, which the listen narrows by name');
      const runs = () => server.lines.filter((l) => /^run \S+ hiring:review completed$/.test(l)).length;

      const created = await deliver(fake, { changeType: 'add', tableId: 'tblEXPN01', recordId: 'recTAXI', fields: { Item: 'Taxi' } });
      assert.deepEqual(created.deliveries.map((d) => d.status), [200]);
      await until(() => runs() === 1, server.lines);

      // An update of the same table is not a creation; a row made in another
      // table of the base reaches its webhook, and is not the listen's.
      await deliver(fake, { changeType: 'update', tableId: 'tblEXPN01', recordId: 'recTAXI', fields: { Item: 'Cab' }, previous: { Item: 'Taxi' } });
      const elsewhere = await deliver(fake, { changeType: 'add', tableId: 'tblROLE01', recordId: 'recENG', fields: { Title: 'Engineer' } });
      assert.deepEqual(elsewhere.deliveries.map((d) => d.status), [200]);
      await deliver(fake, { changeType: 'add', tableId: 'tblEXPN01', recordId: 'recHOTEL', fields: { Item: 'Hotel' } });
      await until(() => runs() === 2, server.lines);
      assert.equal(runs(), 2, 'neither the update nor the role ran anything');
    } finally {
      await server.stop();
    }
  } finally {
    await fake.stop();
  }
});

// Airtable's ping names no change: the module reads its payloads from the
// cursor its webhook was at. Read again from the first delivery's cursor, the
// feed holds the second delivery's change too. A replay of the first judges
// the change the first delivery brought, and that alone.
test('listens replay of an Airtable delivery judges the change it brought, never a later delivery\'s', async () => {
  const fake = await fakeChannels();
  try {
    const dir = await hiringProject(fake);
    writeFileSync(join(dir, 'movements/hiring.mvt'), EXPENSES);
    const server = await serving(dir);
    try {
      await until(() => server.lines.filter((l) => /registered webhook ach\d+/.test(l)).length >= 2, server.lines);
      const runs = () => server.lines.filter((l) => /^run \S+ hiring:review completed$/.test(l)).length;
      await deliver(fake, { changeType: 'add', tableId: 'tblEXPN01', recordId: 'recTAXI', fields: { Item: 'Taxi' } });
      await until(() => runs() === 1, server.lines);
      await deliver(fake, { changeType: 'add', tableId: 'tblEXPN01', recordId: 'recHOTEL', fields: { Item: 'Hotel' } });
      await until(() => runs() === 2, server.lines);
    } finally {
      await server.stop();
    }
    const db = new DatabaseSync(join(dir, '.lf', 'state.db'));
    const [first, second] = (() => {
      try {
        return db.prepare("select id, request from delivery where source = 'webhook' order by received_at").all().map((row) => ({ id: String(row.id), request: JSON.parse(String(row.request)) as { arrivalIds: string[] } }));
      } finally {
        db.close();
      }
    })();
    assert.ok(first !== undefined && second !== undefined, 'both deliveries are kept');
    assert.equal(first.request.arrivalIds.length, 1, JSON.stringify(first.request));
    assert.match(first.request.arrivalIds[0]!, /recTAXI/);
    const completed = () => (JSON.parse(lfSync(dir, 'runs', '--json').out) as { runs: Array<{ movement: string; status: string }> }).runs.filter((r) => r.status === 'completed').length;
    assert.equal(completed(), 2);

    const again = lfSync(dir, 'listens', 'replay', 'hiring:review', '--delivery', first.id);
    assert.equal(again.code, 0, again.out);
    assert.match(again.out, /hiring:review: nothing replayed \(--force runs it again\)/);
    assert.equal(completed(), 2, 'the listen ran both changes before: nothing runs, the later one included');

    const forced = lfSync(dir, 'listens', 'replay', 'hiring:review', '--delivery', first.id, '--force');
    assert.equal(forced.code, 0, forced.out);
    assert.equal(forced.out.match(/hiring:review completed/g)?.length, 1, forced.out);
    assert.equal(completed(), 3, 'the first delivery\'s change runs again; the second delivery\'s does not');
  } finally {
    await fake.stop();
  }
});

test('a listen over three tables of one base registers one data webhook, fires on each, and runs nothing for a table it does not watch', async () => {
  const fake = await fakeChannels();
  try {
    const dir = await hiringProject(fake);
    writeFileSync(join(dir, 'movements/hiring.mvt'), EXPENSES.replace('t.Name == "Expenses"', 't.Name IN ["Candidates", "Roles", "Expenses"]').replace('c:Changes WHERE c.Kind == "created"', 'c:Changes'));
    const checked = lfSync(dir, 'check');
    assert.equal(checked.code, 0, checked.out);
    const server = await serving(dir);
    try {
      await until(() => server.lines.filter((l) => /registered webhook ach\d+/.test(l)).length >= 2, server.lines);
      await watching(dir, 3, 5_000, server.lines);
      const registered = await webhooksOf(fake);
      assert.deepEqual([registered.data, registered.schemas], [['appHIRE01'], ['appHIRE01']], 'two webhooks on the base, within what one OAuth integration may make');
      assert.ok(!server.lines.some((l) => /TOO_MANY_WEBHOOKS/.test(l)), server.lines.join('\n'));
      const runs = () => server.lines.filter((l) => /^run \S+ hiring:review completed$/.test(l)).length;

      const made = [
        { tableId: 'tblCAND01', recordId: 'recEVE', fields: { Name: 'Eve' } },
        { tableId: 'tblROLE01', recordId: 'recPM', fields: { Title: 'PM' } },
        { tableId: 'tblEXPN01', recordId: 'recLUNCH', fields: { Item: 'Lunch' } },
      ];
      for (const [i, row] of made.entries()) {
        const delivered = await deliver(fake, { changeType: 'add', ...row });
        assert.deepEqual(delivered.deliveries.map((d) => [d.webhookId, d.status]), [[registered.all.find((w) => w.dataTypes.includes('tableData'))?.id, 200]], 'through the one data webhook');
        await until(() => runs() === i + 1, server.lines);
      }

      // Interviews is in the base and not the listen's: its row is heard, and runs nothing.
      const unwatched = await deliver(fake, { changeType: 'add', tableId: 'tblINTV01', recordId: 'recINT', fields: { Candidate: 'Eve' } });
      assert.deepEqual(unwatched.deliveries.map((d) => d.status), [200]);
      await new Promise((done) => setTimeout(done, 500));
      assert.equal(runs(), 3, 'a table the listen does not watch ran nothing');
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
      const registered = (await webhooksOf(fake)).all.map((w) => w.id).sort();
      assert.deepEqual((await webhooksOf(fake)).data, ['appHIRE01']);
      const runs = () => server.lines.filter((l) => /^run \S+ hiring:review completed$/.test(l)).length;

      // A role made while Roles is not an Expenses table: the base's webhook
      // hears it, and it is not the listen's.
      const before = await deliver(fake, { changeType: 'add', tableId: 'tblROLE01', recordId: 'recEARLY', fields: { Title: 'Early' } });
      assert.deepEqual(before.deliveries.map((d) => d.status), [200]);

      // Roles is renamed Expenses: the base's schema webhook says so, and the
      // listen lists its tables again on that report alone, no clock moved.
      // Its base was watched already: no webhook is made or removed.
      const renamed = (await fake.json('/airtable/control/rename-table', { baseId: 'appHIRE01', tableId: 'tblROLE01', name: 'Expenses' })) as Deliveries;
      assert.deepEqual(renamed.deliveries.map((d) => d.status), [200]);
      await watching(dir, 2, 20_000, server.lines);
      assert.deepEqual((await webhooksOf(fake)).all.map((w) => w.id).sort(), registered, 'the same two webhooks');

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
      assert.deepEqual((await webhooksOf(fake)).data, ['appHIRE01']);
      const runs = () => server.lines.filter((l) => /^run \S+ hiring:review completed$/.test(l)).length;

      // Expenses is renamed Receipts: the base's schema webhook says so, and
      // with no table left to watch its data webhook is removed as the listen
      // lists its tables again.
      const renamed = (await fake.json('/airtable/control/rename-table', { baseId: 'appHIRE01', tableId: 'tblEXPN01', name: 'Receipts' })) as Deliveries;
      assert.deepEqual(renamed.deliveries.map((d) => d.status), [200]);
      for (const deadline = Date.now() + 20_000; (await webhooksOf(fake)).data.length > 0; ) {
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
      assert.deepEqual([(await webhooksOf(fake)).data, (await webhooksOf(fake)).schemas], [['appHIRE01'], ['appHIRE01']]);

      // Spending becomes Finance: the bases listed again hold it, with no
      // Expenses table, so the listen's tables are as they were, and its base
      // is watched for one: its schema, and its rows, as every base the
      // listen walked to is.
      await fake.json('/airtable/control/rename-base', { baseId: 'appSPND01', name: 'Finance' });
      for (const deadline = Date.now() + 20_000; !(await webhooksOf(fake)).schemas.includes('appSPND01'); ) {
        if (Date.now() > deadline) throw new Error(`the renamed base's tables were never watched; saw:\n${server.lines.join('\n')}`);
        await new Promise((done) => setTimeout(done, 100));
      }
      assert.deepEqual((await webhooksOf(fake)).data, ['appHIRE01', 'appSPND01']);
      await watching(dir, 1, 1_000, server.lines);

      // An Expenses table made in it is reported by that webhook, and watched
      // on that report, well before the clock lists the bases again.
      const made = (await fake.json('/airtable/control/create-table', { baseId: 'appSPND01', table: { id: 'tblEXPN02', name: 'Expenses', primaryFieldId: 'fldEItem', fields: [{ id: 'fldEItem', name: 'Item', type: 'singleLineText' }] } })) as Deliveries;
      assert.deepEqual(made.deliveries.map((d) => d.status), [200]);
      await watching(dir, 2, 2_500, server.lines);
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
      assert.deepEqual((await webhooksOf(fake)).data, [], 'suspended: watched nowhere');
    } finally {
      await server.stop();
    }
  } finally {
    await fake.stop();
  }
});

/** The candidates' Stage listen at a connection positioned at Hiring: the
 *  change compares the row before and after, and `Record` reads the row now. */
const STAGE = `import { \`@lf/airtable\` as airtable } from adapters
import { henry_airtable } from credentials

hiring = connect airtable using henry_airtable { base: "Hiring" }

function schedule_interview(c: <hiring-[:\`Candidates Change\`]->>) {
  write hiring-[:Interviews]-> {
    Candidate: coalesce(only(c-[:Record]->).Name, "gone")
    From: exists(c.Previous) ? coalesce(c.Previous.Stage, "nothing") : "nothing"
    Changed: exists(c.Current) ? coalesce(c.Current.Name, "nothing") : "nothing"
  }
}

listen to hiring-[t:Tables WHERE t.Name == "Candidates"]->-[c:Changes WHERE exists(c.Current) AND c.Current.Stage == "Interview" AND (NOT exists(c.Previous) OR c.Previous.Stage != "Interview")]-> fire schedule_interview
`;

test('Stage coming to be Interview fires once per edit, on an update or a row created at it; staying Interview or becoming Rejected does not', async () => {
  const fake = await fakeChannels();
  try {
    const dir = await hiringProject(fake);
    writeFileSync(join(dir, 'movements/hiring.mvt'), STAGE);
    const checked = lfSync(dir, 'check');
    assert.equal(checked.code, 0, checked.out);
    const misspelled = STAGE.replace('c.Current.Stage == "Interview"', 'c.Current.Stge == "Interview"');
    writeFileSync(join(dir, 'movements/hiring.mvt'), misspelled);
    const refused = lfSync(dir, 'check');
    assert.equal(refused.code, 1, refused.out);
    assert.match(refused.out, /error MOV_UNKNOWN_PROPERTY .*Stge/);
    writeFileSync(join(dir, 'movements/hiring.mvt'), STAGE);
    const server = await serving(dir);
    try {
      await until(() => server.lines.filter((l) => /registered webhook ach\d+/.test(l)).length >= 2, server.lines);
      const registered = await webhooksOf(fake);
      assert.deepEqual([registered.data, registered.schemas], [['appHIRE01'], ['appHIRE01']], 'positioned at Hiring: one webhook on its rows, one on its schema');
      const interviews = () => server.lines.filter((l) => /^run \S+ hiring:schedule_interview completed$/.test(l)).length;
      const written = async () => JSON.stringify(await fake.json('/airtable/v0/appHIRE01/tblINTV01'));

      // The row as it is now differs from what the edit left: `Record` reads it from Airtable.
      const renamed = await fetch(`${fake.url}/airtable/v0/appHIRE01/tblCAND01/recADA`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fields: { Name: 'Ada King' } }) });
      assert.equal(renamed.status, 200);
      // One edit of Name, Email and Stage is one change: it runs once.
      await deliver(fake, {
        changeType: 'update', tableId: 'tblCAND01', recordId: 'recADA',
        fields: { Name: 'Ada', Email: 'ada@new.example', Stage: 'Interview' },
        previous: { Name: 'Ada Lovelace', Email: 'ada@example.com', Stage: 'Applied' },
      });
      await until(() => interviews() === 1, server.lines);
      // The fake keeps a written row's cells by field id.
      assert.match(await written(), /"fldICand":"Ada King"/, 'it read the row as it is now off the change\'s Record');
      assert.match(await written(), /"fldIFrom":"Applied"/, 'it read the Stage the row had before the edit');
      assert.match(await written(), /"fldIChanged":"Ada"/, 'it read the Name the edit left');

      // Interview to Interview, and Applied to Rejected: the webhook is pinged, and nothing runs.
      const stayed = await deliver(fake, { changeType: 'update', tableId: 'tblCAND01', recordId: 'recADA', fields: { Email: 'ada@x.example' }, previous: { Email: 'ada@new.example' } });
      assert.deepEqual(stayed.deliveries.map((d) => d.status), [200]);
      const rejected = await deliver(fake, { changeType: 'update', tableId: 'tblCAND01', recordId: 'recBOB', fields: { Stage: 'Rejected' }, previous: { Stage: 'Applied' } });
      assert.deepEqual(rejected.deliveries.map((d) => d.status), [200]);
      // A row created at Interview came to be at it: no row before.
      await deliver(fake, { changeType: 'add', tableId: 'tblCAND01', recordId: 'recCY', fields: { Name: 'Cy', Stage: 'Interview' } });
      await until(() => interviews() === 2, server.lines);
      assert.match(await written(), /"fldIFrom":"nothing"/, 'a created row has no row before');
      assert.match(await written(), /"fldICand":"gone"/, 'a row the fake does not hold reads as none');
      assert.equal(interviews(), 2, 'staying at Interview and becoming Rejected ran nothing');
    } finally {
      await server.stop();
    }
  } finally {
    await fake.stop();
  }
});

/** Owner changing: what 0.12's `field: "Owner"` becomes. A collaborator
 *  arrives as an object; the module reads it as its email, so the row
 *  before and after compare by value. */
const OWNER = `import { \`@lf/airtable\` as airtable } from adapters
import { henry_airtable } from credentials

hiring = connect airtable using henry_airtable { base: "Hiring" }

function owner_changed(c: <hiring-[:\`Candidates Change\`]->>) {
  return c.Kind
}

listen to hiring-[t:Tables WHERE t.Name == "Candidates"]->-[c:Changes WHERE (exists(c.Current) AND exists(c.Previous) AND c.Current.Owner != c.Previous.Owner) OR (exists(c.Current) AND NOT exists(c.Previous) AND exists(c.Current.Owner)) OR (NOT exists(c.Current) AND exists(c.Previous) AND exists(c.Previous.Owner))]-> fire owner_changed
`;

test('an update that leaves a collaborator unchanged does not fire Owner changing; one that changes it does', async () => {
  const fake = await fakeChannels();
  try {
    const dir = await hiringProject(fake);
    writeFileSync(join(dir, 'movements/hiring.mvt'), OWNER);
    const checked = lfSync(dir, 'check');
    assert.equal(checked.code, 0, checked.out);
    const server = await serving(dir);
    try {
      await until(() => server.lines.filter((l) => /registered webhook ach\d+/.test(l)).length >= 2, server.lines);
      const runs = () => server.lines.filter((l) => /^run \S+ hiring:owner_changed completed$/.test(l)).length;
      // Stage changes; Owner rides along unchanged, an object in the row before and after.
      const unchanged = await deliver(fake, { changeType: 'update', tableId: 'tblCAND01', recordId: 'recADA', fields: { Stage: 'Interview' }, previous: { Stage: 'Applied' } });
      assert.deepEqual(unchanged.deliveries.map((d) => d.status), [200]);
      await deliver(fake, {
        changeType: 'update', tableId: 'tblCAND01', recordId: 'recADA',
        fields: { Owner: { id: 'usrBO', email: 'bo@example.com', name: 'Bo' } },
        previous: { Owner: { id: 'usrANN', email: 'ann@example.com', name: 'Ann' } },
      });
      await until(() => runs() === 1, server.lines);
      await new Promise((done) => setTimeout(done, 500));
      assert.equal(runs(), 1, 'the update that left Owner as it was ran nothing');
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
        .replace('<hiring-[:`Record Change` WHERE `table` == "tblCAND01"]->>', '<hiring-[:`Candidates Change`]->>')
        .replace(
          'listen to hiring { base: "appHIRE01", table: "tblCAND01", events: ["record.updated"], field: "Stage", becomes: "Interview" }',
          'listen to hiring-[t:Tables WHERE t.Id == "tblCAND01"]->-[c:Changes WHERE c.Kind IN ["updated"] AND exists(c.Current) AND c.Current.Stage == "Interview" AND (NOT exists(c.Previous) OR c.Previous.Stage != "Interview")]->',
        ),
    );
    const checked = lfSync(dir, 'check');
    assert.equal(checked.code, 0, checked.out);
  } finally {
    await fake.stop();
  }
});

test('upgrade rewrites every 0.12 Airtable listen keeping its meaning, its field the table\'s own', async () => {
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

function moved(change: <hiring-[:\`Record Change\`]->>) {
  return "moved"
}

listen to hiring { base: "appHIRE01", table: "tblCAND01" } fire any_change
listen to hiring { base: "appHIRE01", table: "tblCAND01", field: "Stage", becomes: "Interview" } fire staged
listen to hiring { base: "appHIRE01", table: "tblCAND01", field: "Stage" } fire moved
`;
    writeFileSync(file, old);
    const lfYaml = join(dir, 'lf.yaml');
    writeFileSync(lfYaml, readFileSync(lfYaml, 'utf8').replace(/^engine: .*$/m, 'engine: 0.12.13'));

    const upgraded = lfSync(dir, 'upgrade');
    assert.equal(upgraded.code, 0, upgraded.out);
    const rewritten = readFileSync(file, 'utf8');
    assert.equal(rewritten.match(/<hiring-\[:`Candidates Change`\]->>/g)?.length, 3, rewritten);
    assert.match(rewritten, /listen to hiring-\[t:Tables WHERE t\.Id == "tblCAND01"\]->-\[:Changes\]-> fire any_change/);
    assert.ok(rewritten.includes('listen to hiring-[t:Tables WHERE t.Id == "tblCAND01"]->-[c:Changes WHERE exists(c.Current) AND c.Current.Stage == "Interview" AND (NOT exists(c.Previous) OR c.Previous.Stage != "Interview")]-> fire staged'), rewritten);
    assert.ok(rewritten.includes('listen to hiring-[t:Tables WHERE t.Id == "tblCAND01"]->-[c:Changes WHERE (exists(c.Current) AND exists(c.Previous) AND c.Current.Stage != c.Previous.Stage) OR (exists(c.Current) AND NOT exists(c.Previous) AND exists(c.Current.Stage)) OR (NOT exists(c.Current) AND exists(c.Previous) AND exists(c.Previous.Stage))]-> fire moved'), rewritten);
    const checked = lfSync(dir, 'check');
    assert.equal(checked.code, 0, checked.out);

    // A field the table does not have has no rewrite: the pin holds, and the listen is told why.
    writeFileSync(file, old.replace('field: "Stage" } fire moved', 'field: "Stge" } fire moved'));
    writeFileSync(lfYaml, readFileSync(lfYaml, 'utf8').replace(/^engine: .*$/m, 'engine: 0.12.13'));
    const held = lfSync(dir, 'upgrade');
    assert.equal(held.code, 1, held.out);
    assert.match(held.out, /there is no rewrite: Candidates has no field `Stge`/);

    // A field on a listen naming no table is checked against every table's
    // row, which has no Stage: no rewrite, and the listen is left as written.
    const untabled = old.replace('base: "appHIRE01", table: "tblCAND01", field: "Stage" } fire moved', 'base: "appHIRE01", field: "Stage" } fire moved');
    writeFileSync(file, untabled);
    writeFileSync(lfYaml, readFileSync(lfYaml, 'utf8').replace(/^engine: .*$/m, 'engine: 0.12.13'));
    const unnarrowed = lfSync(dir, 'upgrade');
    assert.equal(unnarrowed.code, 1, unnarrowed.out);
    assert.match(unnarrowed.out, /there is no rewrite: Row has no field `Stage` \(its fields: `Id`\), and its table is not narrowed/);
    assert.match(readFileSync(file, 'utf8'), /listen to hiring \{ base: "appHIRE01", field: "Stage" \} fire moved/);
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
    const tableHook = async () => (await webhooksOf(fake)).all.find((w) => w.dataTypes.includes('tableData'));
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
      // Airtable keeps a lapsed webhook 7 days: the one at this door is removed, not left to count against the base.
      assert.ok(!(await webhooksOf(fake)).all.some((w) => w.id === registered.id), 'the lapsed webhook is deleted');
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

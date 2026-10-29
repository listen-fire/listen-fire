// Airtable webhooks under listen-fire serve, against the fake Airtable
// (packages/fake-channels): a webhook watches one base and table, so two
// listens on two tables of one connection register two webhooks, each with
// its own scope, door and secret. A change reaches only its table's webhook
// and runs only that table's listen; the field-change listen (`field: "Stage",
// becomes: "Interview"`) runs only when Stage becomes Interview, and reads
// the fields the change touched and the Stage it was; removing a listen
// removes only its webhook. The movement's signature names the table, so the
// event's `Record` and `Old Record` edges land on it: the Stage it was is the
// Stage enum, and a typo of one of its values is refused at check.

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';

import { lf as lfSync, served } from './example';
import { lf, ok } from './interactive';

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
];

const HEAD = `import { \`@lf/airtable\` as airtable } from adapters
import { henry_airtable } from credentials

hiring = connect airtable using henry_airtable { base: "Hiring" }

function schedule_interview(change: <hiring-[:\`Record Change\` WHERE \`table\` == "tblCAND01"]->>) {
  if (change-[:\`Old Record\`]->.Stage == "Applied") {
    write hiring-[:Interviews]-> {
      Candidate: change.record
      From: change-[:\`Old Record\`]->.Stage
      Changed: Text.join(change.\`Changed Fields\`, ", ")
    }
  }
}

listen to hiring { base: "appHIRE01", table: "tblCAND01", events: ["record.updated"], field: "Stage", becomes: "Interview" } fire schedule_interview
`;

const ROLES = `
function role_changed(change: <hiring-[:\`Record Change\`]->>) {
  return "seen"
}

listen to hiring { base: "appHIRE01", table: "tblROLE01" } fire role_changed
`;

interface Webhook {
  id: string;
  baseId: string;
  notificationUrl: string;
  recordChangeScope?: string;
  expirationTime: string;
}

interface Deliveries {
  deliveries: Array<{ webhookId: string; targetUrl: string; status: number }>;
}

/** A project connected to the fake Airtable as `henry_airtable`, seeded with
 *  the Hiring base. */
async function hiringProject(fake: Fake): Promise<string> {
  await fake.json('/admin/airtable/seed', { entities: HIRING });
  const dir = join(mkdtempSync(join(tmpdir(), 'lf-airtable-webhooks-')), 'hiring');
  assert.equal(lfSync(join(dir, '..'), 'init', 'hiring').code, 0);
  await ok(
    lf(dir, ['connect', '@lf/airtable', '--yes', '--base-url', `${fake.url}/airtable`, '--oauth-authorize-url', `${fake.url}/oauth/authorize`, '--oauth-token-url', `${fake.url}/oauth/token`], {
      answers: ['lf-airtable-app', 'lf-airtable-secret', '8978'],
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
  return dir;
}

test('two tables of one connection each have a webhook of their own, and Stage becoming Interview runs its listen', async () => {
  const fake = await fakeChannels();
  try {
    const dir = await hiringProject(fake);
    const movement = join(dir, 'movements/hiring.mvt');
    writeFileSync(movement, HEAD + ROLES);
    const checked = lfSync(dir, 'check');
    assert.equal(checked.code, 0, checked.out);
    // The Stage it was is the Stage enum: a typo of one of its values is refused.
    writeFileSync(movement, (HEAD + ROLES).replace('== "Applied"', '== "Aplied"'));
    const typo = lfSync(dir, 'check');
    assert.equal(typo.code, 1, typo.out);
    assert.match(typo.out, /MOV_ENUM_UNKNOWN_VALUE "Aplied" isn't a value of enum \(Applied \| Interview \| Rejected\)/);
    writeFileSync(movement, HEAD + ROLES);

    const port = await freePort();
    const publicUrl = `http://127.0.0.1:${port}`;
    appendFileSync(join(dir, 'lf.yaml'), `publicUrl: ${publicUrl}\n`);
    const door = (key: string) => `${publicUrl}/api/public/webhook-sync/airtable/henry_airtable/${key}`;
    const webhooks = async () => (await fake.json('/admin/airtable/webhook/state')) as Webhook[];
    const deliver = async (change: Record<string, unknown>) => (await fake.json('/airtable/control/deliver', { baseId: 'appHIRE01', ...change })) as Deliveries;

    const serving = await served(dir, ['--port', String(port)]);
    try {
      // Two webhooks, one per table, each scoped to its table at its own door.
      await serving.waitFor(/^airtable \(base appHIRE01, table tblCAND01\): registered webhook ach\d+ for record\.updated at /);
      await serving.waitFor(/^airtable \(base appHIRE01, table tblROLE01\): registered webhook ach\d+ for /);
      const registered = await webhooks();
      assert.deepEqual(
        registered.map((w) => [w.baseId, w.recordChangeScope, w.notificationUrl]).sort(),
        [
          ['appHIRE01', 'tblCAND01', door('appHIRE01.tblCAND01')],
          ['appHIRE01', 'tblROLE01', door('appHIRE01.tblROLE01')],
        ],
      );
      const seen = (pattern: RegExp) => serving.lines.filter((l) => pattern.test(l)).length;
      const interviews = /^run \S+ hiring:schedule_interview completed$/;
      const roles = /^run \S+ hiring:role_changed completed$/;

      // Stage becomes Interview: only the candidates' webhook is pinged, and its listen runs.
      const toInterview = await deliver({ changeType: 'update', tableId: 'tblCAND01', recordId: 'recADA', fields: { Name: 'Ada', Stage: 'Interview' }, previous: { Stage: 'Applied' } });
      assert.deepEqual(toInterview.deliveries.map((d) => [d.targetUrl, d.status]), [[door('appHIRE01.tblCAND01'), 200]]);
      await until(() => seen(interviews) === 1, serving.lines);
      const written = JSON.stringify(await fake.json('/airtable/v0/appHIRE01/tblINTV01'));
      // The fake keeps a written row's cells by field id.
      assert.match(written, /"fldICand":"recADA"/);
      assert.match(written, /"fldIChanged":"Name, Stage"/, 'it read the fields the change touched');
      assert.match(written, /"fldIFrom":"Applied"/, 'it read the Stage it was');

      // Stage becomes Rejected: the webhook is pinged, and nothing runs.
      const toRejected = await deliver({ changeType: 'update', tableId: 'tblCAND01', recordId: 'recBOB', fields: { Stage: 'Rejected' }, previous: { Stage: 'Applied' } });
      assert.deepEqual(toRejected.deliveries.map((d) => d.status), [200]);

      // A role's change reaches only the roles' webhook, and runs only its listen.
      const role = await deliver({ changeType: 'add', tableId: 'tblROLE01', recordId: 'recENG', fields: { Title: 'Engineer' } });
      assert.deepEqual(role.deliveries.map((d) => [d.targetUrl, d.status]), [[door('appHIRE01.tblROLE01'), 200]]);
      await until(() => seen(roles) === 1, serving.lines);
      assert.equal(seen(interviews), 1, 'Rejected ran nothing, and the role ran no interview');

      // The roles' listen removed under the running listen-fire serve: only its webhook goes.
      writeFileSync(movement, HEAD);
      await serving.waitFor(/^airtable \(base appHIRE01, table tblROLE01\): no listen needs its webhook any more; removed webhook ach\d+$/);
      assert.deepEqual((await webhooks()).map((w) => w.recordChangeScope), ['tblCAND01']);
      assert.equal(seen(/tblCAND01\): registered webhook/), 1, 'the candidates\' webhook was left as it is');

      // And still delivers.
      await deliver({ changeType: 'update', tableId: 'tblCAND01', recordId: 'recCY', fields: { Stage: 'Interview' }, previous: { Stage: 'Rejected' } });
      await until(() => seen(interviews) === 2, serving.lines);
    } finally {
      await serving.stop();
    }
  } finally {
    await fake.stop();
  }
});

// The event is narrowed only by the address its movement's signature names
// (the platform's rule): a listen's `field` and `becomes` are held to the table
// the signature names, and refused where the signature names none.
test('listen-fire check holds a field-change listen to the table its movement\'s signature names', async () => {
  const fake = await fakeChannels();
  try {
    const dir = await hiringProject(fake);
    const movement = join(dir, 'movements/hiring.mvt');
    const reading = HEAD.replace('Candidate: change.record', 'Candidate: change-[:Record]->.Name');
    const check = (source: string) => (writeFileSync(movement, source), lfSync(dir, 'check'));

    const clean = check(reading);
    assert.equal(clean.code, 0, clean.out);

    const notAChoice = check(reading.replace('becomes: "Interview"', 'becomes: "Interviewing"'));
    assert.equal(notAChoice.code, 1, notAChoice.out);
    assert.match(notAChoice.out, /MOV_ENUM_UNKNOWN_VALUE "Interviewing" isn't a value of enum \(Applied \| Interview \| Rejected\)/);

    const notAField = check(reading.replace('field: "Stage"', 'field: "Stagez"'));
    assert.equal(notAField.code, 1, notAField.out);
    assert.match(notAField.out, /MOV_LISTEN_BAD_CONFIG 'Stagez' is not a field of what this listener watches — its fields: .*Name.*Stage.*did you mean 'Stage'/);

    const misspelledRead = check(reading.replace('->.Name', '->.Nmae'));
    assert.equal(misspelledRead.code, 1, misspelledRead.out);
    assert.match(misspelledRead.out, /MOV_UNKNOWN_PROPERTY .*has no field 'Nmae'.*did you mean 'Name'/);

    const unaddressed = check(reading.replace('<hiring-[:`Record Change` WHERE `table` == "tblCAND01"]->>', '<hiring-[:`Record Change`]->>'));
    assert.equal(unaddressed.code, 1, unaddressed.out);
    assert.ok(
      unaddressed.out.includes("MOV_LISTEN_BAD_CONFIG 'field' can't be checked: 'schedule_interview''s parameter names no table") &&
        unaddressed.out.includes('function schedule_interview(change: <hiring-[e:`Record Change` WHERE e.table == "tblCAND01"]->>)'),
      unaddressed.out,
    );
    assert.ok(unaddressed.out.includes('MOV_UNDESCRIBED_POSITION') && unaddressed.out.includes('<hiring-[e:`Record Change` WHERE e.table == "…"]->>'), unaddressed.out);
  } finally {
    await fake.stop();
  }
});

// A listen that names no base takes it from its connection's position
// (`connect airtable … { base: "Hiring" }`), the base's name resolved to its id
// by walking the connection, as the platform resolves a listen's address.
test('a listen that names no base is scoped to the base its connection is positioned at', async () => {
  const fake = await fakeChannels();
  try {
    const dir = await hiringProject(fake);
    writeFileSync(join(dir, 'movements/hiring.mvt'), HEAD.replace('{ base: "appHIRE01", table: "tblCAND01"', '{ table: "tblCAND01"'));
    const checked = lfSync(dir, 'check');
    assert.equal(checked.code, 0, checked.out);
    const port = await freePort();
    const publicUrl = `http://127.0.0.1:${port}`;
    appendFileSync(join(dir, 'lf.yaml'), `publicUrl: ${publicUrl}\n`);
    const serving = await served(dir, ['--port', String(port)]);
    try {
      await serving.waitFor(/^airtable \(base appHIRE01, table tblCAND01\): registered webhook ach\d+ for record\.updated at /);
      const registered = (await fake.json('/admin/airtable/webhook/state')) as Webhook[];
      assert.deepEqual(registered.map((w) => [w.baseId, w.recordChangeScope]), [['appHIRE01', 'tblCAND01']]);
      await fake.json('/airtable/control/deliver', { baseId: 'appHIRE01', changeType: 'update', tableId: 'tblCAND01', recordId: 'recADA', fields: { Stage: 'Interview' }, previous: { Stage: 'Applied' } });
      await serving.waitFor(/^run \S+ hiring:schedule_interview completed$/);
    } finally {
      await serving.stop();
    }
  } finally {
    await fake.stop();
  }
});

// A change carries only the cells it touched; the webhook asks Airtable for
// every other cell too, so the event's `Record` is the whole row, and its id
// reads as `Id`.
test('a change to Stage reads the row\'s Name, Email and Id from its Record', async () => {
  const fake = await fakeChannels();
  try {
    const dir = await hiringProject(fake);
    const whole = HEAD.replace('Candidate: change.record', 'Candidate: change-[:Record]->.Name')
      .replace('From: change-[:`Old Record`]->.Stage', 'From: change-[:Record]->.Email')
      .replace('Changed: Text.join(change.`Changed Fields`, ", ")', 'Changed: change-[:Record]->.Id');
    writeFileSync(join(dir, 'movements/hiring.mvt'), whole);
    const checked = lfSync(dir, 'check');
    assert.equal(checked.code, 0, checked.out);
    const port = await freePort();
    appendFileSync(join(dir, 'lf.yaml'), `publicUrl: http://127.0.0.1:${port}\n`);
    const serving = await served(dir, ['--port', String(port)]);
    try {
      await serving.waitFor(/^airtable \(base appHIRE01, table tblCAND01\): registered webhook ach\d+ for /);
      await fake.json('/airtable/control/deliver', { baseId: 'appHIRE01', changeType: 'update', tableId: 'tblCAND01', recordId: 'recADA', fields: { Stage: 'Interview' }, previous: { Stage: 'Applied' } });
      await serving.waitFor(/^run \S+ hiring:schedule_interview completed$/);
      const written = JSON.stringify(await fake.json('/airtable/v0/appHIRE01/tblINTV01'));
      assert.match(written, /"fldICand":"Ada Lovelace"/, 'it read the Name the change did not touch');
      assert.match(written, /"fldIFrom":"ada@example.com"/, 'it read the Email the change did not touch');
      assert.match(written, /"fldIChanged":"recADA"/, 'it read the row\'s id');
    } finally {
      await serving.stop();
    }
  } finally {
    await fake.stop();
  }
});

const DAY_MS = 24 * 60 * 60 * 1000;

test('a quiet webhook is refreshed a day before it lapses, and one that lapsed is registered anew', async () => {
  const fake = await fakeChannels();
  try {
    const dir = await hiringProject(fake);
    writeFileSync(join(dir, 'movements/hiring.mvt'), HEAD);
    const port = await freePort();
    const publicUrl = `http://127.0.0.1:${port}`;
    appendFileSync(join(dir, 'lf.yaml'), `publicUrl: ${publicUrl}\n`);
    const webhooks = async () => (await fake.json('/admin/airtable/webhook/state')) as Webhook[];
    // listen-fire's clock and the fake's moved on together: `days` past the registration.
    const serveAt = (days: number) => served(dir, ['--port', String(port)], days === 0 ? {} : { LF_CLOCK_AHEAD_MS: String(days * DAY_MS) });
    const advance = (days: number) => fake.json('/airtable/control/advance-clock', { ms: days * DAY_MS });

    // Registered, expiring in 7 days.
    let serving = await serveAt(0);
    await serving.waitFor(/^airtable \(base appHIRE01, table tblCAND01\): registered webhook ach\d+ for /);
    await serving.stop();
    const [registered] = await webhooks();
    assert.ok(registered !== undefined);

    // Six and a half days on, nothing delivered: refreshed, by the same webhook.
    await advance(6.5);
    serving = await serveAt(6.5);
    try {
      const refreshed = await serving.waitFor(/refreshed webhook ach\d+; it expires at /);
      assert.match(refreshed, new RegExp(`airtable \\(base appHIRE01, table tblCAND01\\): refreshed webhook ${registered.id};`));
    } finally {
      await serving.stop();
    }
    const [kept] = await webhooks();
    assert.equal(kept?.id, registered.id, 'no webhook registered anew');
    assert.ok(Date.parse(kept.expirationTime) - Date.parse(registered.expirationTime) > 6 * DAY_MS, 'its expiry moved on');

    // Eight days more with listen-fire down: it lapsed, so it is registered anew, and the new one delivers.
    await advance(8);
    serving = await serveAt(14.5);
    try {
      const lapsed = await serving.waitFor(/lapsed at .*; registered webhook ach\d+ for record\.updated at /);
      assert.match(lapsed, new RegExp(`webhook ${registered.id} lapsed at `));
      const now = await webhooks();
      assert.equal(now.length, 1, 'the lapsed webhook is removed');
      assert.notEqual(now[0]?.id, registered.id);
      const delivered = (await fake.json('/airtable/control/deliver', { baseId: 'appHIRE01', changeType: 'update', tableId: 'tblCAND01', recordId: 'recADA', fields: { Stage: 'Interview' }, previous: { Stage: 'Applied' } })) as Deliveries;
      assert.deepEqual(delivered.deliveries.map((d) => [d.webhookId, d.status]), [[now[0]?.id, 200]]);
      await serving.waitFor(/^run \S+ hiring:schedule_interview completed$/);
    } finally {
      await serving.stop();
    }
  } finally {
    await fake.stop();
  }
});

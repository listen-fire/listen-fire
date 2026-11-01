// A record's `List Entries` under listen-fire: an organisation on two Affinity lists
// (the fake Affinity in modules/affinity/__test__/real_engine, serving a
// Master Deals List and a Portfolio list), read through a hop whose WHERE
// pins one list. `listen-fire check` types the hop by that list's own columns, and
// `listen-fire run` returns the Deals entry's `Deal Created` without reading a column
// off the Portfolio entry. A listen on the Deals list's entries' `Changes`
// runs on each change of one column, through the one webhook `listen-fire
// serve` registers for the connection. A wait on an organization's `Changes`
// is answered by its own next change, never by a person's of the same id.

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { fakeAffinity, type Fake } from './affinity_fixture';
import { freePort, until } from './attio_fixture';
import { lf, served } from './example';

const REPO = resolve(__dirname, '../../../..');
const AFFINITY = join(REPO, 'modules/affinity');


const MOVEMENT = (hopWhere: string) => `import { affinity } from adapters
import { Affinity } from credentials

crm = connect affinity using Affinity

function \`Deal Date\` (run: <manual-[:Invocations]->>) {
  dates = crm-[o:\`Organization\` WHERE o.\`Name\` == run.Text]->-[le:\`List Entries\` WHERE ${hopWhere}]-> {
    return le.\`Deal Created\`
  }
  return dates
}
listen to manual-[:Invocations]-> fire \`Deal Date\`
`;

const SIGNING_KEY = 'affinity-signing-key';

function project(fake: Fake, hopWhere: string, movement = MOVEMENT(hopWhere), lfYaml = ''): string {
  const dir = mkdtempSync(join(tmpdir(), 'lf-affinity-lists-'));
  writeFileSync(join(dir, 'lf.yaml'), `engine: 0.13.0\nmovements: movements\nexternals: externals\n${lfYaml}`);
  mkdirSync(join(dir, 'externals/affinity'), { recursive: true });
  writeFileSync(join(dir, 'externals/affinity/lf-external.yaml'), `name: affinity\nkind: adapter\nprotocol: 2\nmodule: ${AFFINITY}\n`);
  mkdirSync(join(dir, '.lf'));
  writeFileSync(join(dir, '.lf/secrets.yaml'), `Affinity:\n  module: affinity\n  credential: affinity\n  apiKey: test-key\n  baseUrl: ${fake.url}\n  webhook_secret: ${SIGNING_KEY}\n`);
  chmodSync(join(dir, '.lf/secrets.yaml'), 0o600);
  mkdirSync(join(dir, 'movements'));
  writeFileSync(join(dir, 'movements/deal_date.mvt'), movement);
  return dir;
}

test("a List Entries hop pinned to one list checks against that list's columns and returns its entry's value", async () => {
  const fake = await fakeAffinity(mkdtempSync(join(tmpdir(), 'lf-affinity-fake-')));
  try {
    for (const hopWhere of ['le.`listName` == "Master Deals List"', 'le.`Status` != "Lost" AND le.`listName` == "Master Deals List"']) {
      const dir = project(fake, hopWhere);
      const checked = lf(dir, 'check');
      assert.equal(checked.code, 0, checked.out);
      const ran = lf(dir, 'run', 'Deal Date', '--text', 'Veltha');
      assert.equal(ran.code, 0, ran.out);
      assert.match(ran.out, /deal_date:Deal Date completed/, ran.out);
      assert.match(ran.out, /returned \["2026-05-01[^"]*"\]/, ran.out);
      // One entry's columns read, ever: the Deals entry's, never the Portfolio entry's.
      const entriesRead = new Set(fake.requests().flatMap((r) => /list_entry_id=(\d+)/.exec(r)?.[1] ?? []));
      assert.equal(entriesRead.size, 1, fake.requests().join('\n'));
    }
  } finally {
    await fake.stop();
  }
});

// A WHERE is evaluated over the lists themselves: one that only the run can
// answer (the invocation's text) pins none, and one the lists answer pins the
// list it leaves, however it is spelled.
test('a List Entries hop with no list pinned still reads only what every list has', async () => {
  const fake = await fakeAffinity(mkdtempSync(join(tmpdir(), 'lf-affinity-fake-')));
  try {
    const checked = lf(project(fake, 'le.`listName` != run.Text'), 'check');
    assert.equal(checked.code, 1, checked.out);
    assert.match(checked.out, /MOV_UNKNOWN_PROPERTY crm\.Organization List Entry has no field 'Deal Created'/);

    const deals = lf(project(fake, 'le.`listName` != "Portfolio"'), 'check');
    assert.equal(deals.code, 0, deals.out);
  } finally {
    await fake.stop();
  }
});

// Each Status change of a Deals entry runs `moved`, which answers the column
// it was told changed and the entry's Status as Affinity holds it now.
const MOVED = `import { affinity } from adapters
import { Affinity } from credentials

crm = connect affinity using Affinity

function moved(c: <crm-[:\`List Entry Change — Master Deals List\`]->>) {
  said = c-[e:\`List Entry\`]-> {
    return "\${c.Kind} \${c.Field}: \${e.Status}"
  }
  return said
}

listen to crm-[:\`List Entry — Master Deals List\`]->-[c:Changes WHERE c.Field == "Status"]-> fire moved
`;

/** One Affinity delivery, signed with the account's key as Affinity signs it. */
async function deliver(url: string, type: string, body: Record<string, unknown>): Promise<{ status: number; text: string }> {
  const raw = JSON.stringify({ type, body, sent_at: Math.floor(Date.now() / 1000) });
  const answer = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-affinity-webhook-signature': createHmac('sha256', SIGNING_KEY).update(raw).digest('hex') },
    body: raw,
  });
  return { status: answer.status, text: await answer.text() };
}

test("a listen on the Deals list's entries runs on each Status change, naming the new status, and on no other change", async () => {
  const fake = await fakeAffinity(mkdtempSync(join(tmpdir(), 'lf-affinity-fake-')));
  try {
    const port = await freePort();
    const dir = project(fake, '', MOVED, `publicUrl: http://127.0.0.1:${port}\n`);
    const checked = lf(dir, 'check');
    assert.equal(checked.code, 0, checked.out);
    // A column the Deals list does not have is refused where it is written.
    writeFileSync(join(dir, 'movements/deal_date.mvt'), MOVED.replace('c.Field == "Status"', 'c.Field == "Stauts"'));
    const refused = lf(dir, 'check');
    assert.notEqual(refused.code, 0, refused.out);
    assert.match(refused.out, /MOV_ENUM_UNKNOWN_VALUE[\s\S]*"Stauts"/);
    writeFileSync(join(dir, 'movements/deal_date.mvt'), MOVED);

    // The Deals entry of the seeded company, and its Status value.
    const api = async (path: string, init?: RequestInit) => (await fetch(`${fake.url}${path}`, init)).json() as Promise<unknown>;
    const { organizations } = (await api('/organizations?term=Veltha')) as { organizations: Array<{ id: number; name: string; list_entries: Array<{ id: number; list_id: number }> }> };
    const org = organizations.find((o) => o.name === 'Veltha')!;
    const entry = org.list_entries.find((e) => e.list_id === 10)!;
    const values = (await api(`/field-values?list_entry_id=${entry.id}`)) as Array<{ id: number; field_id: number; value: unknown }>;
    const status = values.find((v) => v.field_id === 310)!;
    const set = (row: { id: number }, value: string) => api(`/field-values/${row.id}`, { method: 'PUT', body: JSON.stringify({ value }) });
    const changeOf = (row: { id: number; field_id: number }, value: string) => ({ ...row, value, entity_type: 1, entity_id: org.id, list_entry_id: entry.id });

    const serving = await served(dir, ['--port', String(port)]);
    try {
      const registered = await serving.waitFor(/registered webhook \S+ for the arrivals on Changes at /);
      const url = registered.replace(/^.* at /, '');
      const webhooks = (await api('/webhooks')) as Array<{ webhook_url: string; subscriptions: string[] }>;
      assert.deepEqual(webhooks.map((w) => w.webhook_url), [url]);
      assert.ok(webhooks[0]!.subscriptions.includes('field_value.updated'), JSON.stringify(webhooks));
      const runs = () => serving.lines.filter((l) => /^run \S+ deal_date:moved completed$/.test(l)).length;

      await set(status, 'Diligence');
      assert.equal((await deliver(url, 'field_value.updated', changeOf(status, 'Diligence'))).status, 200);
      await until(() => runs() === 1, serving.lines);

      // The same change again, another column of the entry, the company's own
      // update, and a note: none of them is a Status change of a Deals entry.
      assert.ok((await deliver(url, 'field_value.updated', changeOf(status, 'Diligence'))).status < 300);
      const source = values.find((v) => v.field_id === 311)!;
      await set(source, 'Inbound');
      await deliver(url, 'field_value.updated', changeOf(source, 'Inbound'));
      await deliver(url, 'organization.updated', { id: org.id, name: 'Veltha', domain: 'veltha.example' });
      await deliver(url, 'note.created', { id: 1, content: 'met the founders' });
      // A forged delivery runs nothing either.
      const forged = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-affinity-webhook-signature': 'deadbeef' }, body: JSON.stringify({ type: 'field_value.updated', body: changeOf(status, 'Passed') }) });
      assert.equal(forged.status, 401);

      await set(status, 'Passed');
      await deliver(url, 'field_value.updated', changeOf(status, 'Passed'));
      await until(() => runs() === 2, serving.lines);
      await new Promise((done) => setTimeout(done, 500));
      assert.equal(runs(), 2, serving.lines.join('\n'));
    } finally {
      await serving.stop();
    }
    const listed = JSON.parse(lf(dir, 'runs', '--json').out) as { runs: Array<{ runId: string }> };
    const returned = listed.runs.map((r) => lf(dir, 'runs', 'show', r.runId).out);
    assert.ok(returned.some((out) => out.includes('updated Status: Diligence')), returned.join('\n'));
    assert.ok(returned.some((out) => out.includes('updated Status: Passed')), returned.join('\n'));
  } finally {
    await fake.stop();
  }
});

// An organization's creation waits for its next change. Affinity numbers
// organizations, persons and list entries apart, so a person may share the
// organization's id: the wait is keyed by the kind of record as well as its
// id, and the listen fires only on the record type it lands on.
const CHASED = `import { affinity } from adapters
import { Affinity } from credentials

crm = connect affinity using Affinity

function chased(c: <crm-[:OrganizationChange]->>) {
  said = c-[o:Organization]-> {
    next = await new o-[:Changes]->
    return "\${o.Name}: \${c.Kind}, then \${next.Kind}"
  }
  return said
}

listen to crm-[:Organization]->-[c:Changes WHERE c.Kind == "created"]-> fire chased
`;

test('a wait on an organization’s Changes is not answered by a person’s change of the same id, nor does a person’s creation fire its listen; the organization’s next change answers it', async () => {
  const fake = await fakeAffinity(mkdtempSync(join(tmpdir(), 'lf-affinity-fake-')), { twinPersons: true });
  try {
    const port = await freePort();
    const dir = project(fake, '', CHASED, `publicUrl: http://127.0.0.1:${port}\n`);
    const checked = lf(dir, 'check');
    assert.equal(checked.code, 0, checked.out);

    const api = async (path: string) => (await fetch(`${fake.url}${path}`)).json() as Promise<unknown>;
    const { organizations } = (await api('/organizations?term=Veltha')) as { organizations: Array<{ id: number; name: string }> };
    const org = organizations.find((o) => o.name === 'Veltha')!;

    const serving = await served(dir, ['--port', String(port)]);
    try {
      const url = (await serving.waitFor(/registered webhook \S+ for the arrivals on Changes at /)).replace(/^.* at /, '');
      const runs = (state: string) => serving.lines.filter((l) => new RegExp(`^(run|resumed) \\S+ deal_date:chased ${state}$`).test(l)).length;

      assert.equal((await deliver(url, 'organization.created', { id: org.id, name: 'Veltha', domain: 'veltha.example' })).status, 200);
      await until(() => runs('parked') === 1, serving.lines);

      // The person with the organization's id: its creation passes the
      // WHERE but is a person's change, and its update is not the
      // organization's.
      assert.ok((await deliver(url, 'person.created', { id: org.id, first_name: 'Ada', last_name: 'Veltha' })).status < 300);
      assert.ok((await deliver(url, 'person.updated', { id: org.id, first_name: 'Ada', last_name: 'Veltha-Lind' })).status < 300);
      await new Promise((done) => setTimeout(done, 1000));
      assert.equal(runs('parked'), 1, serving.lines.join('\n'));
      assert.equal(runs('completed'), 0, serving.lines.join('\n'));

      assert.equal((await deliver(url, 'organization.updated', { id: org.id, name: 'Veltha', domain: 'veltha.io' })).status, 200);
      await until(() => runs('completed') === 1, serving.lines);
      await new Promise((done) => setTimeout(done, 500));
      assert.equal(runs('parked'), 1, serving.lines.join('\n'));
    } finally {
      await serving.stop();
    }
    const listed = JSON.parse(lf(dir, 'runs', '--json').out) as { runs: Array<{ runId: string }> };
    assert.equal(listed.runs.length, 1, JSON.stringify(listed));
    assert.match(lf(dir, 'runs', 'show', listed.runs[0]!.runId).out, /Veltha: created, then updated/);
  } finally {
    await fake.stop();
  }
});

test('upgrade rewrites a 0.12 listen on an organization’s events onto its Changes, and holds the pin on one it cannot', async () => {
  const fake = await fakeAffinity(mkdtempSync(join(tmpdir(), 'lf-affinity-fake-')));
  try {
    const old = (events: string) => `import { affinity } from adapters
import { Affinity } from credentials

crm = connect affinity using Affinity

function welcomed(o: <crm-[:Organization]->>) {
  return "welcome"
}

listen to crm { events: ${events} } fire welcomed
`;
    const dir = project(fake, '', old('["organization.created", "organization.deleted"]'));
    const file = join(dir, 'movements/deal_date.mvt');
    const lfYaml = join(dir, 'lf.yaml');
    const pinned = () => writeFileSync(lfYaml, readFileSync(lfYaml, 'utf8').replace(/^engine: .*$/m, 'engine: 0.12.13'));
    const rewritten = (kinds: string) =>
      old('')
        .replace('<crm-[:Organization]->>', '<crm-[:OrganizationChange]->>')
        .replace('listen to crm { events:  }', `listen to crm-[:Organization]->-[c:Changes WHERE c.Kind IN ${kinds}]->`);
    pinned();
    const upgraded = lf(dir, 'upgrade');
    assert.equal(upgraded.code, 0, upgraded.out);
    assert.equal(readFileSync(file, 'utf8'), rewritten('["created", "deleted"]'));
    const checked = lf(dir, 'check');
    assert.equal(checked.code, 0, checked.out);

    // An organization's `updated` change is also each field value set or
    // cleared on it, which 0.12 heard only as field_value events: the
    // rewrite hears more, says so, and only --all applies it.
    const updated = old('["organization.created", "organization.updated"]');
    writeFileSync(file, updated);
    pinned();
    const told = lf(dir, 'upgrade');
    assert.equal(told.code, 1, told.out);
    assert.ok(
      told.out.includes('(`Kind == "updated"` also hears each field value set or cleared on the organization, which 0.12 heard only as field_value events: add `AND c.Field == null` to hear the organization\'s own updates alone)'),
      told.out,
    );
    assert.equal(readFileSync(file, 'utf8'), updated);
    const applied = lf(dir, 'upgrade', '--all');
    assert.equal(applied.code, 0, applied.out);
    assert.equal(readFileSync(file, 'utf8'), rewritten('["created", "updated"]'));
    // The note's remedy checks.
    writeFileSync(file, rewritten('["created", "updated"]').replace('c.Kind IN ["created", "updated"]', 'c.Kind IN ["created", "updated"] AND c.Field == null'));
    const narrowed = lf(dir, 'check');
    assert.equal(narrowed.code, 0, narrowed.out);

    // A field value's event names no one record type; an organization's and
    // a person's arrive on two edges, as every event a listen naming none
    // heard does: none has a rewrite, and the pin holds.
    const noEvents = old('[]').replace('listen to crm { events: [] }', 'listen to crm');
    for (const [source, said] of [
      [old('["field_value.updated"]'), /MOV_LISTEN_SETTINGS_RETIRED/],
      [old('["organization.created", "person.created"]'), /its events arrive on `-\[:Organization\]->-\[:Changes\]->` and `-\[:Person\]->-\[:Changes\]->`, so write one listen for each/],
      [noEvents, /its events arrive on `-\[:Organization\]->-\[:Changes\]->` and `-\[:Person\]->-\[:Changes\]->` and `-\[:Opportunity\]->-\[:Changes\]->`/],
    ] as const) {
      writeFileSync(file, source);
      pinned();
      const held = lf(dir, 'upgrade');
      assert.equal(held.code, 1, held.out);
      assert.match(held.out, said);
      assert.equal(readFileSync(file, 'utf8'), source);
    }
  } finally {
    await fake.stop();
  }
});

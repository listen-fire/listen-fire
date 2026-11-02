// What an Affinity change carries, and what else arrives, under `listen-fire
// serve` against the fake Affinity (modules/affinity/__test__/real_engine).
// A field value's change holds its value: the new one on a set or a change
// (`Current`), the one removed on a clear (`Previous`), each typed by the
// record's own field, and `Field Change` says which. A field the record type
// does not name is unknown, so a filter on it is reported, never wrongly
// passed. An opportunity list's columns are its entries' fields.

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { affinityProject, deliverAffinity as deliver, fakeAffinity, type Fake } from './affinity_fixture';
import { freePort, until } from './attio_fixture';
import { lf, served, type Served } from './example';

const HEAD = `import { affinity } from adapters
import { Affinity } from credentials

crm = connect affinity using Affinity
`;

const api = async (fake: Fake, path: string) => (await fetch(`${fake.url}${path}`)).json() as Promise<unknown>;

async function veltha(fake: Fake): Promise<{ id: number; list_entries: Array<{ id: number; list_id: number }> }> {
  const { organizations } = (await api(fake, '/organizations?term=Veltha')) as { organizations: Array<{ id: number; name: string; list_entries: Array<{ id: number; list_id: number }> }> };
  return organizations.find((o) => o.name === 'Veltha')!;
}

/** `listen-fire serve` on the project, each registered webhook's URL by the edge it is for. */
async function serving(dir: string, port: number, edges: string[]): Promise<{ server: Served; urls: Map<string, string> }> {
  const server = await served(dir, ['--port', String(port)]);
  const urls = new Map<string, string>();
  for (const edge of edges) {
    const line = await server.waitFor(new RegExp(`registered webhook \\S+ for the arrivals on ${edge} at `));
    urls.set(edge, line.replace(/^.* at /, ''));
  }
  return { server, urls };
}

const completed = (server: Served, fn: string) => server.lines.filter((l) => new RegExp(`^run \\S+ deal_date:${fn} completed$`).test(l)).length;
const unjudged = (server: Served, fn: string) => server.lines.filter((l) => l.includes(`deal_date:${fn}: an arrival on`) && l.includes('cannot be judged')).length;

function returned(dir: string): string[] {
  const listed = JSON.parse(lf(dir, 'runs', '--json').out) as { runs: Array<{ runId: string }> };
  return listed.runs.map((r) => lf(dir, 'runs', 'show', r.runId, '--json').out);
}

const VALUES = `${HEAD}
function passed(c: <crm-[:\`List Entry Change — Master Deals List\`]->>) {
  if (exists(c.Current)) {
    return "\${c.\`Field Change\`}: \${c.Current.Status}"
  }
  return "nothing"
}

function dropped(c: <crm-[:\`List Entry Change — Master Deals List\`]->>) {
  if (exists(c.Previous)) {
    return "cleared, was \${c.Previous.Status}"
  }
  return "nothing"
}

function left(c: <crm-[:\`List Entry Change — Master Deals List\`]->>) {
  return "left diligence"
}

listen to crm-[:\`List Entry — Master Deals List\`]->-[c:Changes WHERE exists(c.Current) AND c.Current.Status == "Passed"]-> fire passed
listen to crm-[:\`List Entry — Master Deals List\`]->-[c:Changes WHERE c.\`Field Change\` == "cleared" AND exists(c.Previous) AND c.Previous.Status == "Passed"]-> fire dropped
listen to crm-[:\`List Entry — Master Deals List\`]->-[c:Changes WHERE exists(c.Previous) AND c.Previous.Status == "Diligence"]-> fire left
`;

test('a field value’s change holds the value set or changed, and the value cleared, typed by the field; the value a change replaced is unknown', async () => {
  const fake = await fakeAffinity(mkdtempSync(join(tmpdir(), 'lf-affinity-fake-')));
  try {
    const port = await freePort();
    const dir = affinityProject(fake, VALUES, `publicUrl: http://127.0.0.1:${port}\n`);
    const checked = lf(dir, 'check');
    assert.equal(checked.code, 0, checked.out);
    // The value is the list's own Status: a field the list lacks is refused where it is read.
    writeFileSync(join(dir, 'movements/deal_date.mvt'), VALUES.replace('c.Current.Status == "Passed"', 'c.Current.Stauts == "Passed"'));
    const refused = lf(dir, 'check');
    assert.notEqual(refused.code, 0, refused.out);
    assert.match(refused.out, /Stauts/);
    writeFileSync(join(dir, 'movements/deal_date.mvt'), VALUES);

    const org = await veltha(fake);
    const entry = org.list_entries.find((e) => e.list_id === 10)!;
    const status = (value: string, id = 9100) => ({ id, field_id: 310, entity_type: 1, entity_id: org.id, list_entry_id: entry.id, value });

    const { server, urls } = await serving(dir, port, ['Changes']);
    try {
      const url = urls.get('Changes')!;
      assert.equal((await deliver(url, 'field_value.updated', status('Diligence'))).status, 200);
      // Affinity sends no earlier value with a change: the listen on Previous says it cannot judge it.
      await until(() => unjudged(server, 'left') === 1, server.lines);
      assert.equal((await deliver(url, 'field_value.updated', status('Passed'))).status, 200);
      await until(() => completed(server, 'passed') === 1, server.lines);
      assert.equal((await deliver(url, 'field_value.deleted', status('Passed'))).status, 200);
      await until(() => completed(server, 'dropped') === 1, server.lines);
      assert.equal((await deliver(url, 'field_value.created', status('Passed', 9101))).status, 200);
      await until(() => completed(server, 'passed') === 2, server.lines);
      await new Promise((done) => setTimeout(done, 500));
      assert.equal(completed(server, 'passed'), 2, server.lines.join('\n'));
      assert.equal(completed(server, 'dropped'), 1, server.lines.join('\n'));
      assert.equal(completed(server, 'left'), 0, server.lines.join('\n'));
    } finally {
      await server.stop();
    }
    const said = returned(dir).join('\n');
    assert.match(said, /changed: Passed/);
    assert.match(said, /set: Passed/);
    assert.match(said, /cleared, was Passed/);
  } finally {
    await fake.stop();
  }
});

const OWN = `${HEAD}
function own(c: <crm-[:OrganizationChange]->>) {
  return "own update"
}

function ownByHow(c: <crm-[:OrganizationChange]->>) {
  return "own update"
}

listen to crm-[:Organization]->-[c:Changes WHERE c.Kind == "updated" AND c.Field == null]-> fire own
listen to crm-[:Organization]->-[c:Changes WHERE c.Kind == "updated" AND c.\`Field Change\` == null]-> fire ownByHow
`;

test('a field value whose field the organization does not name is reported by a listen on Field, never taken as no field', async () => {
  const fake = await fakeAffinity(mkdtempSync(join(tmpdir(), 'lf-affinity-fake-')));
  try {
    const port = await freePort();
    const dir = affinityProject(fake, OWN, `publicUrl: http://127.0.0.1:${port}\n`);
    const checked = lf(dir, 'check');
    assert.equal(checked.code, 0, checked.out);
    const org = await veltha(fake);
    const { server, urls } = await serving(dir, port, ['Changes']);
    try {
      const url = urls.get('Changes')!;
      // A field this connection cannot see.
      assert.equal((await deliver(url, 'field_value.updated', { id: 9200, field_id: 99999, entity_type: 1, entity_id: org.id, list_entry_id: null, value: 'x' })).status, 200);
      await until(() => unjudged(server, 'own') === 1, server.lines);
      assert.equal((await deliver(url, 'organization.updated', { id: org.id, name: 'Veltha', domain: 'veltha.io' })).status, 200);
      await until(() => completed(server, 'own') === 1 && completed(server, 'ownByHow') === 1, server.lines);
      await new Promise((done) => setTimeout(done, 500));
      assert.equal(completed(server, 'own'), 1, server.lines.join('\n'));
      assert.equal(completed(server, 'ownByHow'), 1, server.lines.join('\n'));
      assert.equal(unjudged(server, 'ownByHow'), 0, server.lines.join('\n'));
    } finally {
      await server.stop();
    }
  } finally {
    await fake.stop();
  }
});

const STAGED = `${HEAD}
function staged(c: <crm-[:\`List Entry Change — Deals\`]->>) {
  said = c-[e:\`List Entry\`]-> {
    return "\${c.Field}: \${e.\`Deal Stage\`}"
  }
  return said
}

listen to crm-[:\`List Entry — Deals\`]->-[c:Changes WHERE c.Field == "Deal Stage"]-> fire staged
`;

test("an opportunity list's column is its entries' field: a listen on its changes runs and reads it", async () => {
  const fake = await fakeAffinity(mkdtempSync(join(tmpdir(), 'lf-affinity-fake-')), { opportunityList: true });
  try {
    const port = await freePort();
    const dir = affinityProject(fake, STAGED, `publicUrl: http://127.0.0.1:${port}\n`);
    const checked = lf(dir, 'check');
    assert.equal(checked.code, 0, checked.out);
    // A name that is no column of the list is refused where it is written.
    writeFileSync(join(dir, 'movements/deal_date.mvt'), STAGED.replace('c.Field == "Deal Stage"', 'c.Field == "Stage"'));
    const unlisted = lf(dir, 'check');
    assert.notEqual(unlisted.code, 0, unlisted.out);
    assert.match(unlisted.out, /error MOV_ENUM_UNKNOWN_VALUE[^\n]*"Stage"/);
    writeFileSync(join(dir, 'movements/deal_date.mvt'), STAGED);
    const [entry] = (await api(fake, '/lists/12/list-entries')) as Array<{ id: number; entity_id: number }>;
    const { server, urls } = await serving(dir, port, ['Changes']);
    try {
      const url = urls.get('Changes')!;
      const delivered = await deliver(url, 'field_value.updated', { id: 9300, field_id: 340, entity_type: 8, entity_id: entry!.entity_id, list_entry_id: entry!.id, value: 'Sourced' });
      assert.equal(delivered.status, 200, delivered.text);
      await until(() => completed(server, 'staged') === 1, server.lines);
    } finally {
      await server.stop();
    }
    assert.match(returned(dir).join('\n'), /Deal Stage: Sourced/);
  } finally {
    await fake.stop();
  }
});

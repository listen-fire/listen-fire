// `@lf/attio`'s listens, end to end against the fake Attio: a record's changes
// arrive on its `Changes`, one record type per object, through the one webhook
// `listen-fire serve` registers for the connection. A Deals listen narrowed to
// Stage changes runs on each Stage change and on nothing else, a company's
// change included; `listen-fire check` refuses an attribute deals do not have.
// A Deals listen on Name changes is not fired by a company's Name change,
// which passes its WHERE but lands on another record type.
// A run reaches the deal its Stage change carries at delivery: a change of that
// deal in the same delivery answers its wait, the Stage change itself never
// does, and one delivered later does too. A record the run walks to that its
// trigger did not carry (the deal's company) counts from the walk: a change of
// it delivered with the Stage change does not answer the wait, a later one does.

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { attioProject, createRecord, deliver, fakeChannels, records, until, updateRecord, valueOf, webhooks, type Fake } from './attio_fixture';
import { lf as lfSync, served } from './example';

const REPO = resolve(__dirname, '../../../..');
process.env.LF_MODULES_DIR ??= join(REPO, 'modules');

const HEAD = `import { \`@lf/attio\` as attio } from adapters
import { henry_attio } from credentials

crm = connect attio using henry_attio
`;

// Each Stage change notes the deal's stage on the company named after it, and
// the workspace member who changed it.
const STAGES = `${HEAD}
function moved(c: <crm-[:DealChange]->>) {
  c-[d:Deal]-> {
    write crm-[:Companies]-> {
      unique by (Name)
      Name: d.Name
      Description: "\${d.Name} is now \${d.Stage} (\${c.Kind} \${c.Field} by \${@actor_id})"
    }
  }
}

listen to crm-[:Deals]->-[c:Changes WHERE c.Field == "Stage"]-> fire moved
`;

// A Stage change waits for its deal's next change, and notes both.
const CHASE = `${HEAD}
function chase(c: <crm-[:DealChange]->>) {
  c-[d:Deal]-> {
    next = await new d-[:Changes]->
    write crm-[:Companies]-> {
      unique by (Name)
      Name: d.Name
      Description: "after \${c.Field}, \${next.Field}"
    }
  }
}

listen to crm-[:Deals]->-[c:Changes WHERE c.Field == "Stage"]-> fire chase
`;

// A Stage change waits for the next change of its deal's company, and notes both.
const CHASE_COMPANY = `${HEAD}
function chase(c: <crm-[:DealChange]->>) {
  c-[d:Deal]-> {
    d-[co:Company]-> {
      next = await new co-[:Changes]->
      write crm-[:Companies]-> {
        unique by (Name)
        Name: "\${d.Name} watch"
        Description: "after \${c.Field}, \${next.Field}"
      }
    }
  }
}

listen to crm-[:Deals]->-[c:Changes WHERE c.Field == "Stage"]-> fire chase
`;

// Each Name change of a deal is noted by name.
const NAMED = `${HEAD}
function named(c: <crm-[:DealChange]->>) {
  return c.Field
}

listen to crm-[:Deals]->-[c:Changes WHERE c.Field == "Name"]-> fire named
`;

const stageOf = (deal: { id: { record_id: string } }) => ({ event_type: 'record.updated', id: { object_id: 'deals', record_id: deal.id.record_id, attribute_id: 'stage' } });
const valueChangeOf = (deal: { id: { record_id: string } }) => ({ event_type: 'record.updated', id: { object_id: 'deals', record_id: deal.id.record_id, attribute_id: 'value' } });
const description = async (fake: Fake, name: string) => valueOf((await records(fake, 'companies')).find((c) => valueOf(c, 'name') === name), 'description');

test('a Deals listen on Stage runs on each Stage change naming the new stage, and on no other change, a company’s included', async () => {
  const fake = await fakeChannels();
  try {
    const { dir, port } = await attioProject(fake, 'attio-stages');
    writeFileSync(join(dir, 'movements/stages.mvt'), STAGES);
    const checked = lfSync(dir, 'check');
    assert.equal(checked.code, 0, checked.out);

    // An attribute deals do not have is refused where it is written.
    writeFileSync(join(dir, 'movements/typo.mvt'), STAGES.replace('c.Field == "Stage"', 'c.Field == "Stag"').replace('function moved', 'function typo').replace('fire moved', 'fire typo'));
    const refused = lfSync(dir, 'check');
    assert.notEqual(refused.code, 0, refused.out);
    assert.match(refused.out, /MOV_ENUM_UNKNOWN_VALUE[\s\S]*"Stag"/);
    writeFileSync(join(dir, 'movements/typo.mvt'), '');
    writeFileSync(join(dir, 'movements/named.mvt'), NAMED);
    assert.equal(lfSync(dir, 'check').code, 0);

    const serving = await served(dir, ['--port', String(port)]);
    try {
      await serving.waitFor(/^attio \(Changes, edge-[0-9a-f]+\): registered webhook fake-webhook-\d+ for the arrivals on Changes at /);
      const [webhook] = await webhooks(fake);
      assert.deepEqual(webhook?.subscriptions.map((s) => s.event_type), ['record.created', 'record.updated', 'record.deleted']);
      const runs = () => serving.lines.filter((l) => /^run \S+ stages:moved completed$/.test(l)).length;
      const named = () => serving.lines.filter((l) => /^run \S+ named:named completed$/.test(l)).length;

      const osprey = await createRecord(fake, 'deals', { name: 'Osprey', stage: 'Sourced' });
      const acme = await createRecord(fake, 'companies', { name: 'Acme' });
      await updateRecord(fake, 'deals', osprey.id.record_id, { stage: 'Diligence' });
      assert.deepEqual((await deliver(fake, stageOf(osprey))).map((d) => d.status), [200]);
      await until(() => runs() === 1, serving.lines);
      assert.equal(await description(fake, 'Osprey'), 'Osprey is now Diligence (updated Stage by fake-member-1)');

      // The same change again, another attribute of the deal, a company's
      // change, the deal created: none of them is a Stage change of a deal.
      await deliver(fake, stageOf(osprey));
      await updateRecord(fake, 'deals', osprey.id.record_id, { value: 5000 });
      await deliver(fake, valueChangeOf(osprey));
      await updateRecord(fake, 'companies', acme.id.record_id, { name: 'Acme Ltd' });
      await deliver(fake, { event_type: 'record.updated', id: { object_id: 'companies', record_id: acme.id.record_id, attribute_id: 'name' } });
      await deliver(fake, { event_type: 'record.created', id: { object_id: 'deals', record_id: osprey.id.record_id } });

      // The next Stage change runs it again, naming the stage it moved to.
      await updateRecord(fake, 'deals', osprey.id.record_id, { stage: 'Passed' });
      await deliver(fake, stageOf(osprey));
      await until(() => runs() === 2, serving.lines);
      assert.equal(await description(fake, 'Osprey'), 'Osprey is now Passed (updated Stage by fake-member-1)');
      await new Promise((done) => setTimeout(done, 500));
      assert.equal(runs(), 2, serving.lines.join('\n'));
      // The company's Name change above passed the Name listen's WHERE, and
      // ran nothing: it is a company's change, not a deal's.
      assert.equal(named(), 0, serving.lines.join('\n'));
      await updateRecord(fake, 'deals', osprey.id.record_id, { name: 'Osprey Labs' });
      await deliver(fake, { event_type: 'record.updated', id: { object_id: 'deals', record_id: osprey.id.record_id, attribute_id: 'name' } });
      await until(() => named() === 1, serving.lines);
    } finally {
      await serving.stop();
    }
  } finally {
    await fake.stop();
  }
});

/** `listen-fire serve` of `program` as movements/chase.mvt, with the Attio webhook registered. */
async function chasing(fake: Fake, name: string, program: string, body: (runs: (state: string) => number, lines: string[]) => Promise<void>): Promise<void> {
  const { dir, port } = await attioProject(fake, name);
  writeFileSync(join(dir, 'movements/chase.mvt'), program);
  const checked = lfSync(dir, 'check');
  assert.equal(checked.code, 0, checked.out);
  const serving = await served(dir, ['--port', String(port)]);
  try {
    await serving.waitFor(/^attio \(Changes, edge-[0-9a-f]+\): registered webhook fake-webhook-\d+ for the arrivals on Changes at /);
    await body((state) => serving.lines.filter((l) => new RegExp(`^(run|resumed) \\S+ chase:chase ${state}$`).test(l)).length, serving.lines);
  } finally {
    await serving.stop();
  }
}

const changeOf = (object: string, recordId: string, attribute: string) => ({ event_type: 'record.updated', id: { object_id: object, record_id: recordId, attribute_id: attribute } });

test('a change of the deal delivered with the Stage change answers the wait on the deal the Stage change carries', async () => {
  const fake = await fakeChannels();
  try {
    await chasing(fake, 'attio-chase-carried', CHASE, async (runs, lines) => {
      const kestrel = await createRecord(fake, 'deals', { name: 'Kestrel', stage: 'Sourced' });
      await updateRecord(fake, 'deals', kestrel.id.record_id, { stage: 'Diligence', value: 100 });
      const change = (attribute: string) => changeOf('deals', kestrel.id.record_id, attribute);

      assert.deepEqual((await deliver(fake, change('stage'), change('value'))).map((d) => d.status), [200]);
      await until(() => runs('completed') === 1, lines);
      assert.equal(await description(fake, 'Kestrel'), 'after Stage, Value');
    });
  } finally {
    await fake.stop();
  }
});

test('the Stage change never answers the run it started; the deal’s next change, delivered later, does', async () => {
  const fake = await fakeChannels();
  try {
    await chasing(fake, 'attio-chase-later', CHASE, async (runs, lines) => {
      const kestrel = await createRecord(fake, 'deals', { name: 'Kestrel', stage: 'Sourced' });
      await updateRecord(fake, 'deals', kestrel.id.record_id, { stage: 'Diligence' });
      const change = (attribute: string) => changeOf('deals', kestrel.id.record_id, attribute);

      assert.deepEqual((await deliver(fake, change('stage'))).map((d) => d.status), [200]);
      await until(() => runs('parked') === 1, lines);
      await new Promise((done) => setTimeout(done, 300));
      assert.equal(runs('completed'), 0, lines.join('\n'));

      assert.deepEqual((await deliver(fake, change('name'))).map((d) => d.status), [200]);
      await until(() => runs('completed') === 1, lines);
      assert.equal(await description(fake, 'Kestrel'), 'after Stage, Name');
    });
  } finally {
    await fake.stop();
  }
});

test('a change of the deal’s company delivered with the Stage change does not answer the wait on the company the run walks to; one delivered after does', async () => {
  const fake = await fakeChannels();
  try {
    await chasing(fake, 'attio-chase-walked', CHASE_COMPANY, async (runs, lines) => {
      const acme = await createRecord(fake, 'companies', { name: 'Acme' });
      const kestrel = await createRecord(fake, 'deals', { name: 'Kestrel', stage: 'Sourced', associated_company: [{ target_object: 'companies', target_record_id: acme.id.record_id }] });
      await updateRecord(fake, 'deals', kestrel.id.record_id, { stage: 'Diligence' });

      const stage = changeOf('deals', kestrel.id.record_id, 'stage');
      assert.deepEqual((await deliver(fake, stage, changeOf('companies', acme.id.record_id, 'domains'))).map((d) => d.status), [200]);
      await until(() => runs('parked') === 1, lines);
      await new Promise((done) => setTimeout(done, 300));
      assert.equal(runs('completed'), 0, lines.join('\n'));

      await updateRecord(fake, 'companies', acme.id.record_id, { name: 'Acme Ltd' });
      assert.deepEqual((await deliver(fake, changeOf('companies', acme.id.record_id, 'name'))).map((d) => d.status), [200]);
      await until(() => runs('completed') === 1, lines);
      assert.equal(await description(fake, 'Kestrel watch'), 'after Stage, Name');
    });
  } finally {
    await fake.stop();
  }
});

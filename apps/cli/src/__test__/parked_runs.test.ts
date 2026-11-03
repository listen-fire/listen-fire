// A parked run through the real `listen-fire` entry point: `listen-fire resume`
// with no run steps only what is due, a dry run rehearses past a wait, and
// `listen-fire cancel` settles a parked run, or asks the process stepping it to.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { companies, externalPort, lf, project, served } from './example';

/** The company the run writes first: the acme external numbers companies in
 *  the order they are created, and nothing creates one before the run. */
const RUNS_RECORD = 'company-1';

function runIdOf(out: string, movement: string): string {
  const id = new RegExp(`^run (\\S+) ${movement} parked`, 'm').exec(out)?.[1];
  assert.ok(id !== undefined, out);
  return id;
}

function stateOf<T>(dir: string, read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(join(dir, '.lf', 'state.db'));
  try {
    return read(db);
  } finally {
    db.close();
  }
}

test('listen-fire resume with no run steps only what is due: the timeout arm beside an approval stays parked until its day comes', async () => {
  const dir = project('race');
  const fired = lf(dir, 'run', '--event', 'events/company_created.json');
  assert.match(fired.out, /race:approve parked/);
  const resumed = lf(dir, 'resume');
  assert.equal(resumed.code, 0, resumed.out);
  assert.match(resumed.out, /nothing due: 1 parked run/);
  assert.deepEqual(companies(dir), ['Decide Vireo Robotics'], 'the timeout arm did not fire');

  const serving = await served(dir);
  try {
    const crm = `http://127.0.0.1:${externalPort(dir)}`;
    const approved = await fetch(`${crm}/dev/approvals`, { method: 'POST', body: JSON.stringify({ company: RUNS_RECORD, decision: 'yes' }) });
    assert.equal(approved.status, 200, await approved.clone().text());
    await serving.waitFor(/race:approve completed/);
  } finally {
    await serving.stop();
  }
  assert.deepEqual(companies(dir).slice(1), ['Approved yes']);
});

test('listen-fire run --dry-run rehearses past a wait: a refresh of a rehearsed record moves nothing, and what follows the wait is captured too', () => {
  const dir = project('rehearsal');
  // The external reads a record by its id, so a refresh asks it.
  const server = join(dir, 'externals/acme_crm/server.mjs');
  const source = readFileSync(server, 'utf8');
  const anchor = '  createRecord: async ({ recordType, fields: written, mutationContext }) => {\n';
  assert.ok(source.includes(anchor), 'the example external changed; update this test patch');
  writeFileSync(
    server,
    source.replace(anchor, `  readRecord: ({ externalId }) => readState().companies.find((c) => c.externalId === externalId)?.fields ?? null,\n${anchor}`),
  );

  // A rehearsal waits on nothing: the sleep is passed in the one segment.
  const fired = lf(dir, 'run', 'rehearse', '--dry-run');
  assert.equal(fired.code, 0, fired.out);
  assert.match(fired.out, /rehearsal:rehearse completed/);
  assert.match(fired.out, /\(not committed\): \{"Name":"Rehearsed"\}/);
  assert.match(fired.out, /\(not committed\): \{"Name":"After Rehearsed"\}/);
  assert.equal(fired.out.match(/rehearsal:rehearse/g)?.length, 1, fired.out);
  assert.deepEqual(companies(dir), [], 'a rehearsal writes nothing, before its wait or after');
});

test('listen-fire run --dry-run rehearses an await on an edge: it opens no wait, binds the empty landing, and what follows the await is captured in the same segment', () => {
  const dir = project('await');
  const fired = lf(dir, 'run', 'rehearse', '--text', 'Vireo Robotics', '--dry-run');
  assert.equal(fired.code, 0, fired.out);
  assert.match(fired.out, /await:rehearse completed/);
  assert.doesNotMatch(fired.out, /parked/);
  assert.match(fired.out, /\(not committed\): .*"Name":"Discuss Vireo Robotics"/);
  assert.match(fired.out, /\(not committed\): .*"Name":"Answered/);
  assert.equal(fired.out.match(/await:rehearse/g)?.length, 1, fired.out);
  assert.deepEqual(companies(dir), [], 'a rehearsal writes nothing, before its await or after');
  assert.equal(stateOf(dir, (db) => db.prepare('select count(*) as n from wait_row').get() as { n: number }).n, 0, 'a rehearsal opens no wait');
});

test('listen-fire cancel: a parked run is settled failed with the reason, and its wait goes with it', () => {
  const dir = project('approvals');
  const runId = runIdOf(lf(dir, 'run', '--event', 'events/company_created.json').out, 'approvals:decide');
  const waits = (where = '') => stateOf(dir, (db) => (db.prepare(`select count(*) as n from wait_row where run_id = ? ${where}`).get(runId) as { n: number }).n);
  // Its trigger company, which the CRM does not hold, opened a wait too, without a key; the run never parks on it.
  assert.equal(waits('and address is not null'), 1, 'the run waits on its decision');
  const cancelled = lf(dir, 'cancel', runId, '--reason', 'no longer needed');
  assert.equal(cancelled.code, 0, cancelled.out);
  assert.match(cancelled.out, new RegExp(`run ${runId} cancelled`));
  assert.match(lf(dir, 'runs').out, new RegExp(`${runId} .* approvals:decide failed`));
  // The write it made before it parked stays on the failed run: it was made.
  const outcome = stateOf(dir, (db) => {
    const row = db.prepare('select outcome from run where id = ?').get(runId) as { outcome: string } | undefined;
    return JSON.parse(row?.outcome ?? 'null') as { error: string; writes: number; writeRecords: Array<{ action: string; committed: boolean }> };
  });
  assert.deepEqual([outcome.error, outcome.writes, outcome.writeRecords.map((w) => [w.action, w.committed])], ['no longer needed', 1, [['create', true]]]);
  assert.equal(waits(), 0, 'a cancelled run waits on nothing');
  const twice = lf(dir, 'cancel', runId);
  assert.equal(twice.code, 1, twice.out);
  assert.match(twice.out, /is failed; there is nothing to cancel/);
});

/** Another listen-fire process stepping the run, as the state file records it: the
 *  run's lease, held until `release` is called. */
function holdLease(dir: string, runId: string): { release(): void } {
  const db = new DatabaseSync(join(dir, '.lf', 'state.db'));
  const held = db.prepare("update run set lease_token = 'another-lf', lease_until = '2999-01-01T00:00:00.000Z' where id = ? and lease_token is null").run(runId);
  assert.equal(held.changes, 1, 'the run was free to lease');
  return {
    release() {
      db.prepare("update run set lease_token = null, lease_until = null where id = ? and lease_token = 'another-lf'").run(runId);
      db.close();
    },
  };
}

test('listen-fire cancel of a run another process is stepping: the request is recorded for its holder, and the run settles failed the next time it is entered', async () => {
  const dir = project('approvals');
  const runId = runIdOf(lf(dir, 'run', '--event', 'events/company_created.json').out, 'approvals:decide');
  const lease = holdLease(dir, runId);
  try {
    const requested = lf(dir, 'cancel', runId);
    assert.equal(requested.code, 0, requested.out);
    assert.match(requested.out, /cancel requested; another listen-fire process is stepping it/);
    assert.equal(stateOf(dir, (db) => (db.prepare('select status from run where id = ?').get(runId) as { status: string } | undefined)?.status), 'parked', 'the holder settles it, not the canceller');
  } finally {
    lease.release();
  }
  // The decision arrives and wakes the run: entered now, it settles failed
  // before anything after the wait writes.
  const serving = await served(dir);
  try {
    const crm = `http://127.0.0.1:${externalPort(dir)}`;
    const approved = await fetch(`${crm}/dev/approvals`, { method: 'POST', body: JSON.stringify({ company: RUNS_RECORD, decision: 'yes' }) });
    assert.equal(approved.status, 200, await approved.clone().text());
    const status = () => stateOf(dir, (db) => (db.prepare('select status from run where id = ?').get(runId) as { status: string } | undefined)?.status);
    for (let waited = 0; status() !== 'failed' && waited < 10_000; waited += 100) await sleep(100);
  } finally {
    await serving.stop();
  }
  assert.match(lf(dir, 'runs').out, new RegExp(`${runId} .* approvals:decide failed`));
  assert.deepEqual(companies(dir), ['Decide Vireo Robotics'], 'nothing after the wait wrote');
});

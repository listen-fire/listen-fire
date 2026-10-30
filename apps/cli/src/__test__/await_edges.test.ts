// Waits on a record's edges, end to end: `listen-fire serve` runs the example
// project's movements against the acme external, whose companies have a
// comment thread (`Comments`, listed oldest first and announced) and
// approvals (`Approvals`, announced only). A wait opens when its record
// enters the run, reads the arrivals logged since, and parks until one lands.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { companies, externalPort, lf, project, served, type Served } from './example';

/** The CRM's dev routes and the host's door, for one serving project. */
function crmOf(dir: string, serving: Served) {
  const crm = `http://127.0.0.1:${externalPort(dir)}`;
  const post = async (route: string, body: unknown) => {
    const response = await fetch(`${crm}${route}`, { method: 'POST', body: JSON.stringify(body) });
    assert.equal(response.status, 200, `${route}: ${await response.clone().text()}`);
    return (await response.json()) as Record<string, unknown>;
  };
  return { post, door: `http://127.0.0.1:${serving.port}/api/public/adapter/acme_crm` };
}

/** The record each test's run waits on, by the id the acme external will
 *  give it. This leans on two facts: the external numbers companies
 *  `company-<n>` in the order they are created, starting afresh in each
 *  test's own project; and each test creates exactly one company itself
 *  (`/dev/companies`, company-1, which fires the listen) before the run's
 *  own write creates the next (company-2). A test that creates another
 *  company first, or a run that writes twice before its wait, moves it. */
const RUNS_RECORD = 'company-2';

/** One count off the project's state file. */
function counted(dir: string, sql: string, ...params: string[]): number {
  const db = new DatabaseSync(join(dir, '.lf', 'state.db'));
  try {
    return (db.prepare(sql).get(...params) as { n: number }).n;
  } finally {
    db.close();
  }
}

/** The `wake_await` rows the project's state file holds (queued or dead). */
const wakeRows = (dir: string) => counted(dir, "select count(*) as n from work where kind = 'wake_await'");

/** The waits on `key` that are parked: at an address whose leaf is kept.
 *  A logged arrival wakes exactly these (docs/contracts/store-slot.md,
 *  `waits.log`). */
const parkedWaits = (dir: string, key: string) =>
  counted(dir, 'select count(*) as n from wait_row w join leaf l on l.run_id = w.run_id and l.address = w.address where w.key = ?', key);

/** The arrivals logged on `key`. */
const arrivalsOn = (dir: string, key: string) => counted(dir, 'select count(*) as n from arrival where key = ?', key);

/** Lines matching `pattern` so far. */
const count = (serving: Served, pattern: RegExp) => serving.lines.filter((line) => pattern.test(line)).length;

test('await takes a comment already on the thread at once', async () => {
  const dir = project('await');
  const serving = await served(dir);
  try {
    const { post } = crmOf(dir, serving);
    await post('/dev/comments', { company: RUNS_RECORD, text: 'already here' });
    await post('/dev/companies', { Name: 'Osprey' });
    await serving.waitFor(/run .* await:discuss completed/);
    assert.equal(count(serving, /await:discuss parked/), 0, serving.lines.join('\n'));
    assert.deepEqual(companies(dir), ['Osprey', 'Discuss Osprey', 'Answered already here']);
  } finally {
    await serving.stop();
  }
});

test('await new ignores the comment already there and resumes on the next one', async () => {
  const dir = project('await_new');
  const serving = await served(dir);
  try {
    const { post } = crmOf(dir, serving);
    await post('/dev/comments', { company: RUNS_RECORD, text: 'old' });
    await post('/dev/companies', { Name: 'Osprey' });
    await serving.waitFor(/run .* await_new:discuss parked/);
    assert.deepEqual(companies(dir), ['Osprey', 'Discuss Osprey']);
    await post('/dev/comments', { company: RUNS_RECORD, text: 'new' });
    await serving.waitFor(/resumed .* await_new:discuss completed/);
    assert.deepEqual(companies(dir), ['Osprey', 'Discuss Osprey', 'Answered new']);
  } finally {
    await serving.stop();
  }
});

test('a comment pushed during the write is taken by the wait', async () => {
  const dir = project('await_new');
  const serving = await served(dir);
  try {
    const { post } = crmOf(dir, serving);
    // Reported while the run's write is in flight: after the mark the write
    // took, before the write answered and the wait opened.
    await post('/dev/comment-on-next-write', { text: 'early' });
    await post('/dev/companies', { Name: 'Osprey' });
    await serving.waitFor(/run .* await_new:discuss completed/);
    assert.equal(count(serving, /await_new:discuss parked/), 0, serving.lines.join('\n'));
    assert.deepEqual(companies(dir), ['Osprey', 'Discuss Osprey', 'Answered early']);
  } finally {
    await serving.stop();
  }
});

test('two approvals in one wake resume the run once, binding the first', async () => {
  const dir = project('approvals');
  const serving = await served(dir);
  try {
    const { post } = crmOf(dir, serving);
    await post('/dev/companies', { Name: 'Osprey' });
    await serving.waitFor(/run .* approvals:decide parked/);
    const pushed = await post('/dev/approvals', { company: RUNS_RECORD, decision: 'yes', also: 'no' });
    assert.deepEqual(pushed.arrived, { status: 202, body: { accepted: 2 } });
    await serving.waitFor(/resumed .* approvals:decide completed/);
    // Long enough for a second wake to have run, had one been queued.
    await sleep(1500);
    assert.equal(count(serving, /resumed .* approvals:decide/), 1, serving.lines.join('\n'));
    assert.deepEqual(companies(dir), ['Osprey', 'Decide Osprey', 'Decided yes']);
  } finally {
    await serving.stop();
  }
});

test('a deleted company settles its wait empty and the code after it runs zero times', async () => {
  const dir = project('approvals');
  const serving = await served(dir);
  try {
    const { post } = crmOf(dir, serving);
    await post('/dev/companies', { Name: 'Osprey' });
    await serving.waitFor(/run .* approvals:decide parked/);
    await post('/dev/companies/delete', { company: RUNS_RECORD });
    await serving.waitFor(/resumed .* approvals:decide completed/);
    assert.equal(count(serving, /approvals:decide failed/), 0, serving.lines.join('\n'));
    // The write after the wait is unguarded: it ran zero times.
    assert.deepEqual(companies(dir), ['Osprey', 'Decide Osprey']);
  } finally {
    await serving.stop();
  }
});

test('an approval after the sleep won wakes nothing', async () => {
  const dir = project('approvals_race');
  const serving = await served(dir);
  try {
    const { post } = crmOf(dir, serving);
    await post('/dev/companies', { Name: 'Osprey' });
    await serving.waitFor(/run .* approvals_race:decide parked/);
    const approvals = `approvals:${RUNS_RECORD}`;
    assert.equal(parkedWaits(dir, approvals), 1, 'the approval arm waits');
    // The second's timer comes due and the drain settles the race on it.
    await sleep(1500);
    await serving.waitFor(/resumed .* approvals_race:decide completed/);
    assert.deepEqual(companies(dir), ['Osprey', 'Decide Osprey', 'Timed out']);
    // The race withdrew the arm that lost: no wait on the record is parked,
    // so a log on it answers no wait and queues no wake.
    assert.equal(parkedWaits(dir, approvals), 0);
    const before = serving.lines.length;
    const pushed = await post('/dev/approvals', { company: RUNS_RECORD, decision: 'yes' });
    assert.deepEqual(pushed.arrived, { status: 202, body: { accepted: 1 } });
    assert.equal(arrivalsOn(dir, approvals), 1, 'the delivery logged the approval');
    assert.equal(wakeRows(dir), 0);
    await sleep(1500);
    assert.equal(wakeRows(dir), 0);
    assert.deepEqual(serving.lines.slice(before).filter((line) => /approvals_race:decide|failed|error/i.test(line)), []);
    assert.deepEqual(companies(dir), ['Osprey', 'Decide Osprey', 'Timed out']);
  } finally {
    await serving.stop();
  }
});

test('the wake door refuses keys, naming adapter protocol 2.5', async () => {
  const dir = project('await');
  const serving = await served(dir);
  try {
    const { door } = crmOf(dir, serving);
    const response = await fetch(`${door}/wake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer dev-acme-token' },
      body: JSON.stringify({ keys: ['thread:company-1'] }),
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: string; issues: Array<{ path: string; message: string }> };
    assert.equal(body.error, 'bad_request');
    assert.equal(body.issues[0]?.path, 'keys');
    assert.match(body.issues[0]?.message ?? '', /adapter protocol 2\.5/);
    assert.match(body.issues[0]?.message ?? '', /`arrivals`/);
  } finally {
    await serving.stop();
  }
});

test('a rehearsal opens no wait and binds the empty landing', () => {
  const dir = project('await');
  const run = lf(dir, 'run', '--dry-run', '--event', 'events/company_created.json');
  assert.equal(run.code, 0, run.out);
  assert.match(run.out, /await:discuss completed/);
  assert.doesNotMatch(run.out, /parked/);
  assert.deepEqual(companies(dir), []);
});

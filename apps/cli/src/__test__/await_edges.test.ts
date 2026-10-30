// Waits on a record's edges, end to end: `listen-fire serve` runs the example
// project's movements against the acme external, whose companies have a
// comment thread (`Comments`, listed oldest first and announced) and
// approvals (`Approvals`, announced only). A wait opens when its record
// enters the run, reads the arrivals logged since, and parks until one lands.

import { test } from 'node:test';
import assert from 'node:assert/strict';
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

/** `/dev/companies` makes company-1 and fires the listen; the run's own
 *  write is then company-2, the record its wait is on. */
const RUNS_RECORD = 'company-2';

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
    // The second's timer comes due and the drain settles the race on it.
    await sleep(1500);
    await serving.waitFor(/resumed .* approvals_race:decide completed/);
    assert.deepEqual(companies(dir), ['Osprey', 'Decide Osprey', 'Timed out']);
    const before = serving.lines.length;
    const pushed = await post('/dev/approvals', { company: RUNS_RECORD, decision: 'yes' });
    assert.deepEqual(pushed.arrived, { status: 202, body: { accepted: 1 } });
    await sleep(1500);
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

// The loop breaker, end to end: a run's writes cause arrivals that fire more
// runs. The acme CRM, once `/dev/echo-writes` is on, reports each write it
// takes back as an arrival, as a hosted CRM's webhook would. A two-way sync's
// echo runs once more, writes nothing (the CRM reads a record back, so a
// write that changes nothing is never sent) and its chain ends. Two programs
// that feed each other run until their chain is `loopDepth` runs long; the
// listen whose arrival would start the next is paused, by name, until
// `listen-fire listens resume`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { externalPort, lf, lfCommand, project, served, type Served } from './example';
import { withStoreModule } from './store_module/project';

// A workspace-built listen-fire finds its bundled modules beside its own
// (canonical) path; a worktree's listen-fire may be the main checkout's, so the
// modules and serve-module this tree holds are named.
const REPO = resolve(__dirname, '../../../..');
process.env.LF_MODULES_DIR ??= join(REPO, 'modules');
process.env.LF_SERVE_MODULE ??= join(REPO, 'apps/cli/node_modules/.bin/serve-module');

/** A change made in the CRM `listen-fire serve` started, through its dev
 *  routes: its port is read once, as a command that opens the project
 *  (`listen-fire listens`) starts a CRM of its own over the port file. */
function crmOf(dir: string): (route: string, body: unknown) => Promise<Record<string, unknown>> {
  const port = externalPort(dir);
  return async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { method: 'POST', body: JSON.stringify(body) });
    assert.equal(response.status, 200, `${route}: ${await response.clone().text()}`);
    return (await response.json()) as Record<string, unknown>;
  };
}

/** A push to the host's wake door, as the acme CRM makes one. */
async function wake(serving: Served, arrival: unknown): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${serving.port}/api/public/adapter/acme_crm/wake`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer dev-acme-token' },
    body: JSON.stringify({ arrivals: [arrival] }),
  });
  assert.equal(response.status, 202, await response.clone().text());
}

interface Run {
  runId: string;
  movement: string;
  status: string;
  startedAt: string;
}

/** The runs listen-fire holds, oldest first. */
function runsOf(dir: string): Run[] {
  const run = spawnSync(...lfCommand(['runs', '--json']), { cwd: dir, encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  return (JSON.parse(run.stdout) as { runs: Run[] }).runs.reverse();
}

interface Shown {
  chain: string[];
  writeRecords: Array<{ recordType: string; recordId: string; action: string; values: Record<string, unknown> }>;
}

function shown(dir: string, runId: string): Shown {
  const run = lf(dir, 'runs', 'show', runId, '--json');
  assert.equal(run.code, 0, run.out);
  return (JSON.parse(run.out) as { run: Shown }).run;
}

/** The writes the CRM took, in order. */
function crmWrites(dir: string): Array<{ method: string; recordType: string; externalId: string }> {
  return (JSON.parse(readFileSync(join(dir, '.lf/externals/acme_crm/state.json'), 'utf8')) as { writes: [] }).writes;
}

/** Resolves once `holds` is true, checked every 100ms, or rejects after `ms`. */
async function until(holds: () => boolean, what: string, ms = 60_000): Promise<void> {
  const by = Date.now() + ms;
  while (!holds()) {
    if (Date.now() > by) assert.fail(`not ${what} in ${ms}ms`);
    await sleep(100);
  }
}

const settled = (runs: Run[]) => runs.every((run) => run.status === 'completed' || run.status === 'failed');

/** The `listen-fire listens` line of `named`. */
function listensLine(dir: string, named: string): string {
  const listed = lf(dir, 'listens');
  assert.equal(listed.code, 0, listed.out);
  return listed.out.split('\n').find((line) => line.startsWith(`${named} — `)) ?? assert.fail(listed.out);
}

test('a two-way sync converges: its echo runs once more, writes nothing, and the chain ends', async () => {
  const dir = project('loop_breaker_sync');
  const serving = await served(dir);
  const crm = crmOf(dir);
  try {
    await crm('/dev/echo-writes', { on: true });
    await crm('/dev/companies', { Name: 'Osprey' });
    await until(() => runsOf(dir).length === 2 && settled(runsOf(dir)), 'two runs settled');
    // Long enough for a third run's arrival to have come, had the second sent a write.
    await sleep(1_500);
    const [first, second, ...more] = runsOf(dir);
    assert.deepEqual(more, [], serving.lines.join('\n'));
    assert.deepEqual(
      shown(dir, first!.runId).writeRecords.map((w) => [w.action, w.recordId, w.values.Name]),
      [['update', 'company-1', 'Osprey Ltd']],
    );
    assert.deepEqual(shown(dir, first!.runId).chain, [], 'a person made the company: a chain of its own');
    // The echo of the first run's write: the same write would change nothing, so it is not sent.
    assert.deepEqual(shown(dir, second!.runId).writeRecords.map((w) => [w.action, w.recordId]), [['noop', 'company-1']]);
    assert.deepEqual(shown(dir, second!.runId).chain, [first!.runId], 'its arrival was the first run’s write');
    assert.deepEqual(crmWrites(dir), [{ method: 'updateRecord', recordType: 'Company', externalId: 'company-1' }]);
    assert.match(listensLine(dir, 'companies:sync'), / — ok$/);
  } finally {
    await serving.stop();
  }
});

test('a loop across two programs pauses the listen at the depth limit and names the chain', async () => {
  const dir = project('loop_breaker_loop');
  const serving = await served(dir);
  const crm = crmOf(dir);
  try {
    await crm('/dev/echo-writes', { on: true });
    await crm('/dev/companies', { Name: 'Acme' });
    const paused = await serving.waitFor(/LISTEN_LOOP: companies:note_it is paused/, 60_000);
    await until(() => settled(runsOf(dir)), 'the chain settled');
    await sleep(1_000);
    // Ten runs: a note for each company, a company for each note, five times round.
    const runs = runsOf(dir);
    assert.deepEqual(
      runs.map((run) => run.movement),
      ['note_it', 'bump', 'note_it', 'bump', 'note_it', 'bump', 'note_it', 'bump', 'note_it', 'bump'],
      serving.lines.join('\n'),
    );
    // Each run's chain is the runs before it, each one's write the next one's arrival.
    runs.forEach((run, i) => assert.deepEqual(shown(dir, run.runId).chain, runs.slice(0, i).map((r) => r.runId), `run ${i + 1}`));
    const chain = runs.map((run) => run.runId).join(', ');
    assert.ok(
      paused.endsWith(
        `LISTEN_LOOP: companies:note_it is paused: this arrival would start run 11 of a chain of writes and arrivals (${chain}); \`listen-fire listens resume companies:note_it\` once the loop is broken`,
      ),
      paused,
    );
    assert.match(listensLine(dir, 'companies:note_it'), / — paused: LISTEN_LOOP: companies:note_it is paused: this arrival would start run 11 /);
    assert.match(listensLine(dir, 'companies:note_it'), /; 1 arrival held and not run$/, 'the arrival that paused it is counted');
    assert.match(listensLine(dir, 'companies:bump'), / — ok$/);

    // While it is paused, an arrival is counted and said, and runs nothing.
    await crm('/dev/echo-writes', { on: false });
    const held = (await crm('/dev/companies', { Name: 'Heron' })).id as string;
    await serving.waitFor(new RegExp(`companies:note_it: the arrival ${held} on Company runs nothing, held: the listen is paused \\(LISTEN_LOOP\\)`));
    await sleep(500);
    assert.equal(runsOf(dir).length, 10);
    assert.match(listensLine(dir, 'companies:note_it'), /; 2 arrivals held and not run$/);
    // The provider sends the held arrival again: it is not counted twice.
    await wake(serving, { edge: 'Company', identity: held, landing: { recordId: held, recordType: 'Company', fields: { id: held, Name: 'Heron' } } });
    await serving.waitFor(new RegExp(`companies:note_it has taken the arrival ${held} on Company before: this delivery runs nothing`));
    assert.match(listensLine(dir, 'companies:note_it'), /; 2 arrivals held and not run$/);

    const resumed = lf(dir, 'listens', 'resume', 'companies:note_it');
    assert.equal(resumed.code, 0, resumed.out);
    assert.match(resumed.out, /companies:note_it: resumed; it fires again \(2 arrivals held while it was paused ran nothing and are not run now\)/);
    assert.match(listensLine(dir, 'companies:note_it'), / — ok$/, 'resuming clears the count');
    // The provider sends the arrival that paused it again, within the window
    // of the write that caused it: it was taken, so it pauses nothing.
    const lastWrite = crmWrites(dir).filter((w) => w.recordType === 'Company' && w.method === 'createRecord').at(-1)!;
    const pausing = lastWrite.externalId;
    await wake(serving, {
      edge: 'Company',
      identity: pausing,
      version: '0',
      landing: { recordId: pausing, recordType: 'Company', fields: { id: pausing, Name: 'Again', Version: '0' } },
      occurredAt: runs[9]!.startedAt,
    });
    await serving.waitFor(new RegExp(`companies:note_it has taken the arrival ${pausing} on Company before: this delivery runs nothing`));
    assert.match(listensLine(dir, 'companies:note_it'), / — ok$/, 'a redelivery does not pause the listen again');
    assert.equal(runsOf(dir).length, 10);
    await crm('/dev/companies', { Name: 'Kestrel' });
    await until(() => runsOf(dir).length === 11 && settled(runsOf(dir)), 'the resumed listen ran');
    const last = runsOf(dir)[10]!;
    assert.equal(last.movement, 'note_it');
    assert.deepEqual(shown(dir, last.runId).chain, [], 'a person made the company: a chain of its own');
  } finally {
    await serving.stop();
  }
});

test('a chain may be as many runs as lf.yaml’s loopDepth says', async () => {
  const dir = project('loop_breaker_loop');
  appendFileSync(join(dir, 'lf.yaml'), 'loopDepth: 3\n');
  const serving = await served(dir);
  const crm = crmOf(dir);
  try {
    await crm('/dev/echo-writes', { on: true });
    await crm('/dev/companies', { Name: 'Acme' });
    const paused = await serving.waitFor(/LISTEN_LOOP: companies:bump is paused/, 60_000);
    await until(() => settled(runsOf(dir)), 'the chain settled');
    await sleep(1_000);
    const runs = runsOf(dir);
    assert.deepEqual(runs.map((run) => run.movement), ['note_it', 'bump', 'note_it'], serving.lines.join('\n'));
    assert.match(paused, new RegExp(`would start run 4 of a chain of writes and arrivals \\(${runs.map((run) => run.runId).join(', ')}\\)`));
    assert.match(listensLine(dir, 'companies:bump'), / — paused: LISTEN_LOOP/);
    assert.match(listensLine(dir, 'companies:note_it'), / — ok$/);
  } finally {
    await serving.stop();
  }
});

test('a store that keeps no write ledger fails the delivery that asks it, so the loop breaker is never silently off', async () => {
  const dir = project('loop_breaker_loop');
  withStoreModule(dir, join(mkdtempSync(join(tmpdir(), 'lf-store-module-')), 'kept.db'), { without: ['writes.depth'] });
  const serving = await served(dir);
  const crm = crmOf(dir);
  try {
    await crm('/dev/companies', { Name: 'Acme' });
    await serving.waitFor(/what caused the arrival on Company for companies:note_it: .*writes\.depth is not implemented/, 30_000);
    assert.deepEqual(runsOf(dir), [], 'the arrival ran nothing and is tried again, not run as the start of a new chain');
  } finally {
    await serving.stop();
  }
});

test('a store that cannot keep a write fails the run that made it', async () => {
  const dir = project('loop_breaker_loop');
  withStoreModule(dir, join(mkdtempSync(join(tmpdir(), 'lf-store-module-')), 'kept.db'), { without: ['writes.record'] });
  const serving = await served(dir);
  const crm = crmOf(dir);
  try {
    await crm('/dev/companies', { Name: 'Acme' });
    await until(() => runsOf(dir).length === 1 && settled(runsOf(dir)), 'the run settled');
    const [run] = runsOf(dir);
    assert.equal(run!.status, 'failed', serving.lines.join('\n'));
    const failed = lf(dir, 'runs', 'show', run!.runId);
    assert.match(failed.out, /in the write ledger failed after the write was sent: .*writes\.record is not implemented/);
  } finally {
    await serving.stop();
  }
});

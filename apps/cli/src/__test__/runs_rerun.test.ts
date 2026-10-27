// `lf runs rerun <run-id>` through the real binary: a failed run runs again
// as its next attempt, with its own event and the movement as the project
// holds it now; a run whose latest attempt did not fail is refused by name;
// a failed attempt that already committed writes is refused unless --force;
// and two reruns at once run once.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lf, lfCommand } from './example';
import { rerunProject, type RerunShown, BOOM, FIXED, SLOW, WRITES_THEN_BOOM } from './runs_rerun_fixture';

function json<T>(dir: string, ...args: string[]): { code: number; doc: T } {
  const run = lf(dir, ...args, '--json');
  const line = run.out.split('\n').find((l) => l.startsWith('{'));
  assert.ok(line, `${args.join(' ')}: ${run.out}`);
  return { code: run.code, doc: JSON.parse(line) as T };
}

/** The run `lf run --event` started, failed. */
function failedRun(dir: string): string {
  const fired = json<{ runs: Array<{ runId: string; status: string }> }>(dir, 'run', '--event', 'events/company_created.json');
  assert.equal(fired.code, 1);
  const [run] = fired.doc.runs;
  assert.equal(run?.status, 'failed');
  return run!.runId;
}

const companies = (dir: string): string[] =>
  (JSON.parse(readFileSync(join(dir, '.lf/externals/acme_crm/state.json'), 'utf8')) as { companies: Array<{ fields: { Name: string } }> }).companies.map((c) => c.fields.Name);

test('a failed run reruns as its next attempt, with the movement fixed, and is not rerun again', () => {
  const dir = rerunProject(BOOM);
  const runId = failedRun(dir);

  writeFileSync(join(dir, 'movements/companies.mvt'), FIXED);
  const rerun = json<{ ok: boolean; attempt: number; runs: Array<{ runId: string; status: string; entry: string }> }>(dir, 'runs', 'rerun', runId);
  assert.equal(rerun.code, 0, JSON.stringify(rerun.doc));
  assert.equal(rerun.doc.attempt, 2);
  assert.deepEqual(rerun.doc.runs.map((r) => [r.runId, r.status, r.entry]), [[runId, 'completed', 'rerun']]);
  assert.deepEqual(companies(dir), ['Welcome Vireo Robotics']);

  const { doc } = json<RerunShown>(dir, 'runs', 'show', runId);
  assert.equal(doc.run.status, 'completed');
  assert.equal(doc.run.attempt, 2);
  assert.deepEqual(doc.run.attempts.map((a) => [a.attempt, a.status]), [[1, 'failed'], [2, 'completed']]);
  assert.match(String(doc.run.attempts[0]!.error), /boom/);
  assert.equal(doc.run.attempts[1]!.error, null);
  assert.equal(doc.run.attempts[1]!.writes, 1);
  for (const a of doc.run.attempts) assert.match(String(a.finishedAt), /^\d{4}-\d\d-\d\dT/);
  // One run, not two: the rerun is the run's own.
  assert.equal(json<{ runs: unknown[] }>(dir, 'runs').doc.runs.length, 1);

  const again = lf(dir, 'runs', 'rerun', runId);
  assert.equal(again.code, 1, again.out);
  assert.match(again.out, new RegExp(`run ${runId} succeeded on attempt 2; nothing to rerun`));
  assert.deepEqual(companies(dir), ['Welcome Vireo Robotics']);
});

test('a run that succeeded is not rerun, and an unknown run is named', () => {
  const dir = rerunProject(FIXED);
  const fired = json<{ runs: Array<{ runId: string; status: string }> }>(dir, 'run', '--event', 'events/company_created.json');
  const runId = fired.doc.runs[0]!.runId;
  assert.equal(fired.doc.runs[0]!.status, 'completed');
  const refused = json<{ ok: boolean; refused: string; status: string; attempt: number; error: string }>(dir, 'runs', 'rerun', runId);
  assert.equal(refused.code, 1);
  assert.deepEqual([refused.doc.ok, refused.doc.refused, refused.doc.status, refused.doc.attempt], [false, 'notFailed', 'completed', 1]);
  assert.equal(refused.doc.error, `run ${runId} succeeded on attempt 1; nothing to rerun`);
  const unknown = lf(dir, 'runs', 'rerun', 'no-such-run');
  assert.equal(unknown.code, 1);
  assert.match(unknown.out, /no run no-such-run/);
});

test('a failed attempt that committed writes is refused unless --force, and the refusal lists them', () => {
  const dir = rerunProject(WRITES_THEN_BOOM);
  const runId = failedRun(dir);
  assert.deepEqual(companies(dir), ['Welcome Vireo Robotics']);
  const shown = json<RerunShown>(dir, 'runs', 'show', runId).doc;
  assert.deepEqual(shown.run.writeRecords?.map((w) => [w.adapter, w.recordType, w.action, w.committed]), [['acme_crm', 'Company', 'create', true]]);

  writeFileSync(join(dir, 'movements/companies.mvt'), FIXED);
  const refused = json<{ refused: string; committedWrites: Array<{ adapter: string; recordType: string; recordId: string; action: string }> }>(dir, 'runs', 'rerun', runId);
  assert.equal(refused.code, 1);
  assert.equal(refused.doc.refused, 'committedWrites');
  assert.deepEqual(refused.doc.committedWrites.map((w) => [w.adapter, w.recordType, w.recordId, w.action]), [['acme_crm', 'Company', 'company-1', 'create']]);
  const text = lf(dir, 'runs', 'rerun', runId);
  assert.equal(text.code, 1);
  assert.match(text.out, /attempt 1 committed 1 write\(s\) before it failed/);
  assert.match(text.out, /acme_crm Company company-1: create/);
  assert.match(text.out, /--force/);
  assert.deepEqual(companies(dir), ['Welcome Vireo Robotics']);

  const forced = json<{ attempt: number; runs: Array<{ status: string }> }>(dir, 'runs', 'rerun', runId, '--force');
  assert.equal(forced.code, 0, JSON.stringify(forced.doc));
  assert.equal(forced.doc.attempt, 2);
  assert.equal(forced.doc.runs[0]?.status, 'completed');
  // From the start: the operator chose to make the write again.
  assert.deepEqual(companies(dir), ['Welcome Vireo Robotics', 'Welcome Vireo Robotics']);
});

test('a rerun whose attempt fails again is recorded as that attempt, and exits non-zero', () => {
  const dir = rerunProject(BOOM);
  const runId = failedRun(dir);
  const rerun = json<{ attempt: number; runs: Array<{ status: string; error: string }> }>(dir, 'runs', 'rerun', runId);
  assert.equal(rerun.code, 1);
  assert.equal(rerun.doc.attempt, 2);
  assert.equal(rerun.doc.runs[0]?.status, 'failed');
  const { doc } = json<RerunShown>(dir, 'runs', 'show', runId);
  assert.deepEqual(doc.run.attempts.map((a) => [a.attempt, a.status]), [[1, 'failed'], [2, 'failed']]);
  // Failed again, with nothing written: it can be rerun once more.
  writeFileSync(join(dir, 'movements/companies.mvt'), FIXED);
  assert.equal(json<{ attempt: number }>(dir, 'runs', 'rerun', runId).doc.attempt, 3);
});

function started(dir: string, ...args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(...lfCommand(args), { cwd: dir, env: { ...process.env, NODE_NO_WARNINGS: '1' } });
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (out += chunk));
    child.on('exit', (code) => resolve({ code: code ?? -1, out }));
  });
}

test('two reruns at once: one runs, the other is refused', async () => {
  const dir = rerunProject(BOOM);
  const runId = failedRun(dir);
  // The fixed movement's write takes seconds, so the two overlap.
  writeFileSync(join(dir, 'movements/companies.mvt'), SLOW);
  const both = await Promise.all([started(dir, 'runs', 'rerun', runId), started(dir, 'runs', 'rerun', runId)]);
  const ran = both.filter((r) => r.code === 0);
  const refused = both.filter((r) => r.code !== 0);
  assert.equal(ran.length, 1, both.map((r) => r.out).join('\n---\n'));
  assert.equal(refused.length, 1);
  assert.match(refused[0]!.out, new RegExp(`run ${runId} (is held by another lf process|is running on attempt 2; only a failed run is rerun|succeeded on attempt 2; nothing to rerun)`));
  const { doc } = json<RerunShown>(dir, 'runs', 'show', runId);
  assert.deepEqual(doc.run.attempts.map((a) => [a.attempt, a.status]), [[1, 'failed'], [2, 'completed']]);
  assert.deepEqual(companies(dir), ['slow Vireo Robotics']);
});

test('lf deliveries replay points at lf runs rerun for a failed run', () => {
  const help = lf(rerunProject(FIXED), '--help');
  assert.match(help.out, /lf runs rerun <run-id> \[--force\]/);
  assert.match(help.out, /a failed run: lf runs rerun/);
});

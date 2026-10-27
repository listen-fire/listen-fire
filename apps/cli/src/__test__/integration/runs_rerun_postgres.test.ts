// `lf runs rerun` over a Postgres store: a failed run that committed a write
// is refused, then rerun with --force as attempt 2 of the same run, kept on
// its one `trigger_run` row. Needs a Postgres (pg.ts) and psql.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lfCommand } from '../example';
import { FIXED, rerunProject, type RerunShown, WRITES_THEN_BOOM } from '../runs_rerun_fixture';
import { freshTeam, POSTGRES_URL, psql } from './pg';

test('a failed run with a committed write is refused, then rerun with --force as its next attempt', () => {
  const { team, clear } = freshTeam();
  const dir = rerunProject(WRITES_THEN_BOOM);
  const lf = (...args: string[]) => {
    const run = spawnSync(...lfCommand([...args, '--json', '--store', POSTGRES_URL, '--team', team]), { cwd: dir, encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } });
    return { code: run.status, doc: JSON.parse(run.stdout.split('\n').find((l) => l.startsWith('{')) ?? 'null') as Record<string, unknown> };
  };
  try {
    const fired = lf('run', '--event', 'events/company_created.json');
    assert.equal(fired.code, 1);
    const runId = (fired.doc.runs as Array<{ runId: string }>)[0]!.runId;

    writeFileSync(join(dir, 'movements/companies.mvt'), FIXED);
    const refused = lf('runs', 'rerun', runId);
    assert.equal(refused.code, 1);
    assert.equal(refused.doc.refused, 'committedWrites');
    assert.deepEqual((refused.doc.committedWrites as Array<{ action: string }>).map((w) => w.action), ['create']);

    const forced = lf('runs', 'rerun', runId, '--force');
    assert.equal(forced.code, 0, JSON.stringify(forced.doc));
    assert.equal(forced.doc.attempt, 2);
    const shown = lf('runs', 'show', runId).doc as unknown as RerunShown;
    assert.deepEqual(shown.run.attempts.map((a) => [a.attempt, a.status, a.writes]), [[1, 'failed', 1], [2, 'completed', 1]]);
    assert.deepEqual(psql(`select count(*), max(attempt) from lf.trigger_run where team_id = '${team}'`), [['1', '2']]);

    const again = lf('runs', 'rerun', runId);
    assert.equal(again.code, 1);
    assert.equal(again.doc.error, `run ${runId} succeeded on attempt 2; nothing to rerun`);
  } finally {
    clear();
  }
});

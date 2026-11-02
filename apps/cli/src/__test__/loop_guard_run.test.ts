// The loop guard slot is retired: a project whose lf.yaml still names a guard
// runs as before, through `listen-fire run` on the example project
// (examples/lf-acme), with one notice naming the guard, and the guard is
// never started or called.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { lf, project } from './example';
import { fillGuardSlot } from './loop_guard_module/project';

test('listen-fire run with a loop guard named: one notice that it is retired, and the guard never called', () => {
  const dir = project();
  const calls = join(dir, 'guard-calls.jsonl');
  fillGuardSlot(dir, calls);

  const run = lf(dir, 'run', '--event', 'events/company_created.json');
  assert.equal(run.code, 0, run.out);
  assert.match(run.out, /companies:welcome parked — 1 write\(s\)/);
  const notices = run.out.split('\n').filter((line) => line.includes('core.loopGuard'));
  assert.deepEqual(notices, [
    "listen-fire: lf.yaml's core.loopGuard names acme_guard, but the loop guard slot is retired: listen-fire starts no guard, and its loop breaker (lf.yaml's loopWindow and loopDepth) replaces it. Remove core.loopGuard from lf.yaml.",
  ]);
  assert.ok(!existsSync(calls), 'the guard was called');

  const runId = /^run (\S+) /m.exec(run.out)?.[1];
  assert.ok(runId !== undefined, run.out);
  const shown = JSON.parse(lf(dir, 'runs', 'show', runId, '--json').out) as { run: { writes: number } };
  assert.equal(shown.run.writes, 1);
});

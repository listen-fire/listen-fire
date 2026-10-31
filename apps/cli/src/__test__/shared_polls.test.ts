// Shared polls in listen-fire: a listen on a traversal of a polled edge
// (`listen to f-[n:Notes WHERE …]-> fire a`) is polled once per connection,
// edge, filter the module takes and scope, however many listens share it.
// Each arrival a poll returns is judged against every listen on that poll and
// runs each one its filter takes, once per identity and version. The interval
// is the edge's `pollEverySeconds`, unless lf.yaml's `pollEvery` names the
// connection's.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { lf, lfCommand } from './example';
import { boards, edgePolls, feed, feedProject, polls } from './feed';

// A workspace-built listen-fire finds its bundled modules beside its own
// (canonical) path; a worktree's listen-fire may be the main checkout's, so the
// modules and serve-module this tree holds are named.
const REPO = resolve(__dirname, '../../../..');
process.env.LF_MODULES_DIR ??= join(REPO, 'modules');
process.env.LF_SERVE_MODULE ??= join(REPO, 'apps/cli/node_modules/.bin/serve-module');

/** The feed project whose only file holds `listens`, each firing a function
 *  that fails naming the listen's letter and the note it was fired with. */
function notesProject(listens: string[], options: { takes?: boolean } = {}): string {
  const dir = feedProject();
  if (options.takes === true) writeFileSync(join(dir, 'externals/feed/takes'), '');
  const fired = ['a', 'b'].map((letter) => `function ${letter}(n: <f-[:Notes]->>) {\n  fail("${letter} saw \${n.Title}")\n}\n`).join('\n');
  writeFileSync(join(dir, 'movements/notes.mvt'), `import { feed } from adapters\n\nf = connect feed\n\n${fired}\n${listens.join('\n')}\n`);
  return dir;
}

function lfAt(dir: string, args: string[], aheadMs = 0): { code: number; out: string } {
  const run = spawnSync(...lfCommand(args), { cwd: dir, encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1', LF_CLOCK_AHEAD_MS: String(aheadMs) } });
  return { code: run.status ?? -1, out: `${run.stdout}${run.stderr}` };
}

function lfAsync(dir: string, args: string[]): Promise<string> {
  return new Promise((done) => {
    const child = spawn(...lfCommand(args), { cwd: dir, env: { ...process.env, NODE_NO_WARNINGS: '1' } });
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (out += chunk));
    child.on('close', () => done(out));
  });
}

/** What the runs of `letter`'s function saw, as a drain's output says. */
function saw(out: string, letter: string): string[] {
  return [...out.matchAll(new RegExp(`MOVENG_ERROR: ${letter} saw (\\S+)`, 'g'))].map((said) => said[1]);
}

/** How many runs of `letter`'s function the project holds. */
function runsOf(dir: string, letter: string): number {
  return lf(dir, 'runs').out.split('\n').filter((line) => line.includes(`notes:${letter} `)).length;
}

const A_IS_A = 'listen to f-[n:Notes WHERE n.Title == "a"]-> fire a';

test('two listens on one connection and edge share one poll; each fires on its own filter', () => {
  const dir = notesProject([A_IS_A, 'listen to f-[n:Notes WHERE n.Title CONTAINS "b"]-> fire b']);
  feed(dir, [{ id: 'n1', title: 'a', at: 1 }]);
  const check = lf(dir, 'check');
  assert.equal(check.code, 0, check.out);
  // The first poll only arms: a note already there fires nothing.
  const armed = lfAt(dir, ['drain', '--until-idle']);
  assert.match(armed.out, /armed; it fires on changes from now/);
  assert.deepEqual(edgePolls(dir), [{ edge: 'Notes' }]);
  assert.deepEqual([runsOf(dir, 'a'), runsOf(dir, 'b')], [0, 0]);
  // Not due again inside the edge's minute.
  lfAt(dir, ['drain', '--until-idle']);
  assert.equal(edgePolls(dir).length, 1);
  feed(dir, [
    { id: 'n1', title: 'a', at: 1 },
    { id: 'n2', title: 'a', at: 2 },
    { id: 'n3', title: 'bee', at: 3 },
    { id: 'n4', title: 'c', at: 4 },
  ]);
  const drained = lfAt(dir, ['drain', '--until-idle'], 61_000);
  // One poll for both listens, from where the first one ended.
  assert.deepEqual(edgePolls(dir), [{ edge: 'Notes' }, { edge: 'Notes', cursor: 1 }]);
  assert.deepEqual(saw(drained.out, 'a'), ['a']);
  assert.deepEqual(saw(drained.out, 'b'), ['bee']);
  assert.deepEqual([runsOf(dir, 'a'), runsOf(dir, 'b')], [1, 1]);
  // The settings form's poll was never asked.
  assert.deepEqual(polls(dir), []);
});

test('two listens with different taken filters poll twice', () => {
  const dir = notesProject([A_IS_A, 'listen to f-[n:Notes WHERE n.Title == "b"]-> fire b'], { takes: true });
  const check = lf(dir, 'check');
  assert.equal(check.code, 0, check.out);
  lfAt(dir, ['drain', '--until-idle']);
  const armed = edgePolls(dir) as Array<{ edge: string; filter?: unknown }>;
  assert.equal(armed.length, 2, JSON.stringify(armed));
  // Each poll is handed its own listen's filter, which the feed applies.
  const titles = armed.map((p) => (p.filter as { right?: { value?: unknown } } | undefined)?.right?.value).sort();
  assert.deepEqual(titles, ['a', 'b']);
  feed(dir, [
    { id: 'n1', title: 'First', at: 1 },
    { id: 'n2', title: 'Second', at: 2 },
    { id: 'n3', title: 'a', at: 3 },
    { id: 'n4', title: 'b', at: 4 },
  ]);
  const drained = lfAt(dir, ['drain', '--until-idle'], 61_000);
  assert.equal(edgePolls(dir).length, 4);
  assert.deepEqual(saw(drained.out, 'a'), ['a']);
  assert.deepEqual(saw(drained.out, 'b'), ['b']);
  assert.deepEqual([runsOf(dir, 'a'), runsOf(dir, 'b')], [1, 1]);
});

test('a note edited so that it newly matches fires once; the same version seen twice fires nothing more', () => {
  const dir = notesProject(['listen to f-[n:Notes WHERE n.Title == "Ready"]-> fire a']);
  feed(dir, [{ id: 'n1', title: 'Draft', at: 1 }]);
  lfAt(dir, ['drain', '--until-idle']);
  // Edited into the filter: a new version, so a new arrival, and it fires.
  feed(dir, [{ id: 'n1', title: 'Ready', at: 2, edited: 1 }]);
  const edited = lfAt(dir, ['drain', '--until-idle'], 61_000);
  assert.deepEqual(saw(edited.out, 'a'), ['Ready']);
  // Handed the same version again: a repeat, and nothing runs.
  writeFileSync(join(dir, 'externals/feed/replay'), '');
  const again = lfAt(dir, ['drain', '--until-idle'], 122_000);
  assert.match(again.out, /notes:a has run the arrival n1 on Notes before/);
  assert.deepEqual(saw(again.out, 'a'), []);
  assert.equal(runsOf(dir, 'a'), 1);
  assert.equal(edgePolls(dir).length, 3);
});

test('the operator\'s pollEvery for a connection is its interval, over the edge\'s', () => {
  const dir = notesProject([A_IS_A]);
  lfAt(dir, ['drain', '--until-idle']);
  // Two seconds on is inside the edge's minute: not polled.
  lfAt(dir, ['drain', '--until-idle'], 2_000);
  assert.equal(edgePolls(dir).length, 1);
  // The feed's connection names no credential, so lf.yaml names it by its module.
  appendFileSync(join(dir, 'lf.yaml'), '\npollEvery:\n  feed: 1s\n');
  lfAt(dir, ['drain', '--until-idle'], 61_000);
  assert.equal(edgePolls(dir).length, 2);
  lfAt(dir, ['drain', '--until-idle'], 63_000);
  assert.equal(edgePolls(dir).length, 3);
  // A duration that is none is refused, naming where.
  appendFileSync(join(dir, 'lf.yaml'), '  other: soon\n');
  const refused = lf(dir, 'check');
  assert.notEqual(refused.code, 0);
  assert.match(refused.out, /pollEvery\.other: a duration/);
});

test('two drains at once poll an edge once', async () => {
  const dir = notesProject([A_IS_A, 'listen to f-[n:Notes WHERE n.Title CONTAINS "b"]-> fire b']);
  await Promise.all([lfAsync(dir, ['drain', '--until-idle']), lfAsync(dir, ['drain', '--until-idle'])]);
  assert.deepEqual(edgePolls(dir), [{ edge: 'Notes' }]);
});

test('listen-fire run --poll polls a listen\'s edge at once, once for every listen sharing it', () => {
  const dir = notesProject([A_IS_A, 'listen to f-[n:Notes WHERE n.Title CONTAINS "b"]-> fire b']);
  // The first poll only arms, as the settings form's does.
  const armed = lfAt(dir, ['run', '--poll', 'a']);
  assert.equal(armed.code, 0, armed.out);
  assert.match(armed.out, /armed; it fires on changes from now/);
  assert.deepEqual(edgePolls(dir), [{ edge: 'Notes' }]);
  feed(dir, [
    { id: 'n3', title: 'a', at: 3 },
    { id: 'n4', title: 'bee', at: 4 },
  ]);
  // Polled at once, inside the edge's minute; the poll is b's too.
  // Each listen's function fails naming what it saw, so the command fails too.
  const polled = lfAt(dir, ['run', '--poll', 'a']);
  assert.deepEqual(edgePolls(dir), [{ edge: 'Notes' }, { edge: 'Notes', cursor: 2 }]);
  assert.deepEqual(saw(polled.out, 'a'), ['a']);
  assert.deepEqual(saw(polled.out, 'b'), ['bee']);
  assert.deepEqual([runsOf(dir, 'a'), runsOf(dir, 'b')], [1, 1]);
  const none = lfAt(dir, ['run', '--poll', 'nope']);
  assert.notEqual(none.code, 0);
  assert.match(none.out, /no listen on a polled source fires 'nope'/);
});

test('a poll first made by run --poll is polled by the drains after it', () => {
  const dir = notesProject([A_IS_A]);
  const armed = lfAt(dir, ['run', '--poll', 'a']);
  assert.match(armed.out, /armed/);
  assert.equal(edgePolls(dir).length, 1);
  feed(dir, [{ id: 'n3', title: 'a', at: 3 }]);
  const first = lfAt(dir, ['drain', '--until-idle'], 61_000);
  assert.deepEqual(saw(first.out, 'a'), ['a']);
  feed(dir, [
    { id: 'n3', title: 'a', at: 3 },
    { id: 'n4', title: 'a', at: 4 },
  ]);
  const second = lfAt(dir, ['drain', '--until-idle'], 200_000);
  assert.deepEqual(saw(second.out, 'a'), ['a']);
  assert.deepEqual(edgePolls(dir), [{ edge: 'Notes' }, { edge: 'Notes', cursor: 2 }, { edge: 'Notes', cursor: 3 }]);
  assert.equal(runsOf(dir, 'a'), 2);
});

test('an edge without a cursor lists all of it again: what the arming poll saw is not fired by the next', () => {
  const dir = notesProject(['listen to f-[n:Notes WHERE n.Title CONTAINS "a"]-> fire a']);
  writeFileSync(join(dir, 'externals/feed/nocursor'), '');
  feed(dir, [
    { id: 'n1', title: 'a1', at: 1 },
    { id: 'n2', title: 'b', at: 2 },
  ]);
  const armed = lfAt(dir, ['drain', '--until-idle']);
  assert.match(armed.out, /armed; it fires on changes from now/);
  assert.equal(runsOf(dir, 'a'), 0);
  feed(dir, [
    { id: 'n1', title: 'a1', at: 1 },
    { id: 'n2', title: 'b', at: 2 },
    { id: 'n3', title: 'a3', at: 3 },
  ]);
  const drained = lfAt(dir, ['drain', '--until-idle'], 61_000);
  // Handed the whole listing again, no cursor: only the new note runs.
  assert.deepEqual(edgePolls(dir), [{ edge: 'Notes' }, { edge: 'Notes' }]);
  assert.deepEqual(saw(drained.out, 'a'), ['a3']);
  assert.equal(runsOf(dir, 'a'), 1);
});

test('an edge with a cursor keeps no receipts for what its arming poll saw: its cursor holds the backlog back', () => {
  const dir = notesProject(['listen to f-[n:Notes WHERE n.Title CONTAINS "a"]-> fire a']);
  feed(dir, [{ id: 'n1', title: 'a1', at: 1 }]);
  lfAt(dir, ['drain', '--until-idle']);
  assert.equal(runsOf(dir, 'a'), 0);
  // The provider forgets the cursor and lists n1 again: with no receipt for it, it runs.
  writeFileSync(join(dir, 'externals/feed/replay'), '');
  const drained = lfAt(dir, ['drain', '--until-idle'], 61_000);
  assert.deepEqual(saw(drained.out, 'a'), ['a1']);
});

/** The feed project whose one file holds `listen`, firing `discuss`, whose
 *  body is `body`. */
function awaitingProject(listen: string, body: string): string {
  const dir = feedProject();
  writeFileSync(join(dir, 'movements/notes.mvt'), `import { feed } from adapters\n\nf = connect feed\n\nfunction discuss(n: <f-[:Notes]->>) {\n${body}}\n\n${listen}\n`);
  return dir;
}

/** What the runs of `discuss` said they heard, as a drain's output says. */
function heard(out: string): string[] {
  return [...out.matchAll(/MOVENG_ERROR: (\S+ heard \S+)/g)].map((said) => said[1]);
}

test("one poll's page: a comment on a note answers the await new of the run the note starts", () => {
  const dir = awaitingProject('listen to f-[:Notes]-> fire discuss', '  c = await new n-[:Comments]->\n  fail("${n.Title} heard ${c.Text}")\n');
  const check = lf(dir, 'check');
  assert.equal(check.code, 0, check.out);
  lfAt(dir, ['drain', '--until-idle']);
  // One page: the note, and a comment on it carried with it.
  feed(dir, [
    { id: 'n1', title: 'First', at: 1 },
    { id: 'n2', title: 'Second', at: 2 },
    { id: 'n3', title: 'Third', at: 3, comments: [{ id: 'c1', text: 'hello' }] },
  ]);
  const drained = lfAt(dir, ['drain', '--until-idle'], 61_000);
  assert.deepEqual(heard(drained.out), ['Third heard hello'], drained.out);
  assert.doesNotMatch(lf(dir, 'runs').out, /parked/);
  // The poll is kept as a delivery its run names.
  assert.match(lf(dir, 'deliveries').out, / poll inline 0 event\(s\) 1 run\(s\)/);
});

test("a note on a board does not answer its own run's await new on its board's Notes; the next note there does", () => {
  const dir = feedProject();
  writeFileSync(join(dir, 'externals/feed/siblings'), '');
  boards(dir, [{ id: 'b1', name: 'Ops' }]);
  feed(dir, []);
  writeFileSync(
    join(dir, 'movements/notes.mvt'),
    'import { feed } from adapters\n\nf = connect feed\n\nfunction discuss(n: <f-[:Notes]->>) {\n  s = await new n-[:Notes]->\n  fail("${n.Title} heard ${s.Title}")\n}\n\nlisten to f-[b:Boards WHERE b.Name == "Ops"]->-[n:Notes]-> fire discuss\n',
  );
  const check = lf(dir, 'check');
  assert.equal(check.code, 0, check.out);
  lfAt(dir, ['drain', '--until-idle']);
  feed(dir, [{ id: 'n2', title: 'Second', at: 2, board: 'b1' }]);
  const first = lfAt(dir, ['drain', '--until-idle'], 61_000);
  // The note's own arrival on b1's Notes is no answer: its run waits.
  assert.deepEqual(heard(first.out), [], first.out);
  assert.match(lf(dir, 'runs').out, /notes:discuss parked/);
  feed(dir, [
    { id: 'n2', title: 'Second', at: 2, board: 'b1' },
    { id: 'n3', title: 'Third', at: 3, board: 'b1' },
  ]);
  const next = lfAt(dir, ['drain', '--until-idle'], 122_000);
  // n3 starts a run of its own, which waits in turn; n2's run takes n3.
  assert.deepEqual(heard(next.out), ['Second heard Third'], next.out);
});

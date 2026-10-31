// A listen whose earlier hop filters what its last edge hangs off
// (`listen to f-[b:Boards WHERE b.Name == "Ops"]->-[n:Notes]-> fire a`) is
// watched on the boards that match: listen-fire lists them through the engine,
// polls each one's notes, and lists them again as the module declares — every
// `relistEverySeconds`, or on each arrival on `Boards` when it declares
// `parentChanges: pushed`. Over lf.yaml's `listenScopeLimit` the listen is
// suspended, by name. `listen-fire listens` says where each listen stands.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { lf, lfCommand } from './example';
import { type Board, type Note, boardLists, boards, edgePolls, feed, feedProject } from './feed';

// A workspace-built listen-fire finds its bundled modules beside its own
// (canonical) path; a worktree's listen-fire may be the main checkout's, so the
// modules and serve-module this tree holds are named.
const REPO = resolve(__dirname, '../../../..');
process.env.LF_MODULES_DIR ??= join(REPO, 'modules');
process.env.LF_SERVE_MODULE ??= join(REPO, 'apps/cli/node_modules/.bin/serve-module');

const OPS_NOTES = 'listen to f-[b:Boards WHERE b.Name == "Ops"]->-[n:Notes]-> fire a';

/** The feed project holding `held` boards, its one file the `listens`, each
 *  firing a function that fails naming what it saw. `pushed`: the feed
 *  reports its boards' changes, polled every second, as are their notes. */
function boardsProject(listens: string[], held: Board[], options: { pushed?: boolean; limit?: number } = {}): string {
  const dir = feedProject();
  if (options.pushed === true) {
    writeFileSync(join(dir, 'externals/feed/pushedboards'), '');
    writeFileSync(join(dir, 'externals/feed/fast'), '');
  }
  if (options.limit !== undefined) appendFileSync(join(dir, 'lf.yaml'), `listenScopeLimit: ${options.limit}\n`);
  const fired = 'function a(n: <f-[:Notes]->>) {\n  fail("a saw ${n.Title}")\n}\n\nfunction changed(b: <f-[:Boards]->>) {\n  fail("board ${b.Name}")\n}\n';
  writeFileSync(join(dir, 'movements/notes.mvt'), `import { feed } from adapters\n\nf = connect feed\n\n${fired}\n${listens.join('\n')}\n`);
  boards(dir, held);
  feed(dir, []);
  return dir;
}

function lfAt(dir: string, args: string[], aheadMs = 0): { code: number; out: string } {
  const run = spawnSync(...lfCommand(args), { cwd: dir, encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1', LF_CLOCK_AHEAD_MS: String(aheadMs) } });
  return { code: run.status ?? -1, out: `${run.stdout}${run.stderr}` };
}

/** The notes `a` was fired with, as a drain's output says. */
function saw(out: string): string[] {
  return [...out.matchAll(/MOVENG_ERROR: a saw (\S+)/g)].map((said) => said[1]);
}

/** The line `listen-fire listens` shows for the listen that fires `movement`. */
function listensLine(dir: string, movement = 'a'): string {
  const listed = lf(dir, 'listens');
  assert.equal(listed.code, 0, listed.out);
  return listed.out.split('\n').find((line) => line.startsWith(`notes:${movement} `)) ?? assert.fail(listed.out);
}

/** The boards each poll of a board's notes was made for. */
function polledBoards(dir: string): string[] {
  return (edgePolls(dir) as Array<{ edge: string; scope?: string }>).filter((p) => p.edge === 'Notes').map((p) => p.scope ?? '(none)');
}

const note = (id: string, board: string, at: number): Note => ({ id, title: id, at, board });

test('a listen with a filter on a board watches the boards that match, re-resolved on schedule', () => {
  const dir = boardsProject([OPS_NOTES], [
    { id: 'b1', name: 'Ops' },
    { id: 'b2', name: 'Dev' },
  ]);
  const check = lf(dir, 'check');
  assert.equal(check.code, 0, check.out);
  const opened = lfAt(dir, ['drain', '--until-idle']);
  assert.equal(boardLists(dir), 1, opened.out);
  assert.deepEqual(polledBoards(dir), ['b1'], 'only the board that matches is polled');
  assert.match(
    listensLine(dir),
    /^notes:a — f-\[b:Boards WHERE b\.Name == "Ops"\]->-\[n:Notes\]-> — resolved, arrival — watching 1 Board, resolved \d+s ago — ok; can't be protected from loops: feed names no record its arrivals are about$/,
  );
  boards(dir, [
    { id: 'b1', name: 'Ops' },
    { id: 'b2', name: 'Ops' },
  ]);
  // Not listed again inside its five minutes: still one board.
  lfAt(dir, ['drain', '--until-idle']);
  assert.equal(boardLists(dir), 1);
  assert.match(listensLine(dir), /watching 1 Board,/);
  assert.ok(!polledBoards(dir).includes('b2'));
  const relisted = lfAt(dir, ['drain', '--until-idle'], 300_000);
  assert.equal(boardLists(dir), 2, relisted.out);
  assert.match(listensLine(dir), /watching 2 Boards,/);
  lfAt(dir, ['drain', '--until-idle'], 361_000);
  assert.ok(polledBoards(dir).includes('b2'), 'the board that came to match is polled from then');
});

test('a board renamed out keeps firing until the next re-resolution, then stops; its cursor starts fresh if it returns', () => {
  const dir = boardsProject([OPS_NOTES], [{ id: 'b1', name: 'Ops' }]);
  const check = lf(dir, 'check');
  assert.equal(check.code, 0, check.out);
  const armed = lfAt(dir, ['drain', '--until-idle']);
  assert.match(armed.out, /armed; it fires on changes from now/);
  feed(dir, [note('n3', 'b1', 3)]);
  boards(dir, [{ id: 'b1', name: 'Dev' }]);
  // Renamed out, but not yet listed again: its notes still fire.
  const before = lfAt(dir, ['drain', '--until-idle'], 61_000);
  assert.deepEqual(saw(before.out), ['n3']);
  const relisted = lfAt(dir, ['drain', '--until-idle'], 301_000);
  assert.match(listensLine(dir), /watching 0 Boards,/, relisted.out);
  feed(dir, [note('n3', 'b1', 3), note('n4', 'b1', 4)]);
  const out = lfAt(dir, ['drain', '--until-idle'], 400_000);
  assert.deepEqual(saw(out.out), [], 'a board no longer watched fires nothing');
  // It comes back, with a note added while it was out.
  boards(dir, [{ id: 'b1', name: 'Ops' }]);
  feed(dir, [note('n3', 'b1', 3), note('n4', 'b1', 4), note('n5', 'b1', 5)]);
  const back = lfAt(dir, ['drain', '--until-idle'], 700_000);
  assert.match(listensLine(dir), /watching 1 Board,/, back.out);
  const rearmed = lfAt(dir, ['drain', '--until-idle'], 800_000);
  assert.match(back.out + rearmed.out, /armed; it fires on changes from now/, 'its cursor was forgotten: it arms afresh');
  assert.deepEqual([...saw(back.out), ...saw(rearmed.out)], [], 'what changed while it was out is never replayed');
  feed(dir, [note('n3', 'b1', 3), note('n4', 'b1', 4), note('n5', 'b1', 5), note('n6', 'b1', 6)]);
  const after = lfAt(dir, ['drain', '--until-idle'], 900_000);
  assert.deepEqual(saw(after.out), ['n6']);
});

test('a listen whose filter matches more boards than the limit is suspended by name', () => {
  const dir = boardsProject(
    [OPS_NOTES],
    [
      { id: 'b1', name: 'Ops' },
      { id: 'b2', name: 'Ops' },
    ],
    { limit: 1 },
  );
  const check = lf(dir, 'check');
  assert.equal(check.code, 0, check.out);
  const limit = 'LISTEN_SCOPE_LIMIT: notes:a matched 2 Boards, over the limit of 1; it is suspended until its filter matches fewer';
  const opened = lfAt(dir, ['drain', '--until-idle']);
  assert.ok(opened.out.includes(`listen-fire: ${limit}`), opened.out);
  assert.ok(listensLine(dir).endsWith(` — watching 0 Boards, resolved ${/resolved (\d+s ago)/.exec(listensLine(dir))?.[1]} — ${limit}; can't be protected from loops: feed names no record its arrivals are about`), listensLine(dir));
  lfAt(dir, ['drain', '--until-idle'], 61_000);
  assert.deepEqual(polledBoards(dir), [], 'a suspended listen is polled nowhere');
});

test('a listen with filters only on its last hop never re-resolves', () => {
  const dir = boardsProject(['listen to f-[n:Notes WHERE n.Title == "x"]-> fire a'], [{ id: 'b1', name: 'Ops' }]);
  const check = lf(dir, 'check');
  assert.equal(check.code, 0, check.out);
  lfAt(dir, ['drain', '--until-idle']);
  lfAt(dir, ['drain', '--until-idle'], 301_000);
  lfAt(dir, ['drain', '--until-idle'], 601_000);
  assert.equal(boardLists(dir), 0, 'nothing is ever listed for it');
  assert.match(listensLine(dir), /^notes:a — f-\[n:Notes WHERE n\.Title == "x"\]-> — arrival — watching all of f — ok/);
});

test('a module that reports its boards changing re-resolves on each report, never on a clock', () => {
  const dir = boardsProject(
    [OPS_NOTES, 'listen to f-[:Boards]-> fire changed'],
    [
      { id: 'b1', name: 'Ops', at: 1 },
      { id: 'b2', name: 'Dev', at: 1 },
    ],
    { pushed: true },
  );
  const check = lf(dir, 'check');
  assert.equal(check.code, 0, check.out);
  lfAt(dir, ['drain', '--until-idle']);
  assert.equal(boardLists(dir), 1);
  assert.match(listensLine(dir), /watching 1 Board,/);
  boards(dir, [
    { id: 'b1', name: 'Ops', at: 1 },
    { id: 'b2', name: 'Ops', at: 2 },
  ]);
  // Its boards' next poll reports the rename: listed again at once, five minutes or not.
  const reported = lfAt(dir, ['drain', '--until-idle'], 2_000);
  assert.match(reported.out, /board Ops/, 'the rename arrived on Boards');
  assert.equal(boardLists(dir), 2, reported.out);
  assert.match(listensLine(dir), /watching 2 Boards,/);
});

test('a file declaring any names of its own resolves its listens as it would without them', () => {
  const dir = boardsProject([OPS_NOTES], [
    { id: 'b1', name: 'Ops' },
    { id: 'b2', name: 'Dev' },
  ]);
  // The names listen-fire's read of the boards was once written under.
  appendFileSync(join(dir, 'movements/notes.mvt'), '\nnode __LfListenRead {\n  at: <text>\n}\n\nfunction __lf_listen_heads(read: <__LfListenRead>) {\n  return 1\n}\n');
  const check = lf(dir, 'check');
  assert.equal(check.code, 0, check.out);
  const opened = lfAt(dir, ['drain', '--until-idle']);
  assert.ok(!opened.out.includes('LISTEN_RESOLVE_FAILED'), opened.out);
  assert.deepEqual(polledBoards(dir), ['b1'], 'only the board that matches is polled');
  assert.match(listensLine(dir), / — watching 1 Board, resolved \d+s ago — ok;/);
});

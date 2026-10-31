// A listen whose earlier hop filters what its last edge hangs off
// (`listen to f-[b:Boards WHERE b.Name == "Ops"]->-[n:Notes]-> fire a`) is
// watched on the boards that match: listen-fire lists them through the engine,
// polls each one's notes, and lists them again as the module declares — every
// `relistEverySeconds`, or on each arrival on `Boards` when it declares
// `parentChanges: pushed` (listen-fire polls `Boards` itself for it) — and as
// it opens when the filter was edited. Over lf.yaml's `listenScopeLimit` the
// listen is suspended, by name. The store keeps the boards, and every process
// watches what it keeps. `listen-fire listens` says where each listen stands.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
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
 *  reports its boards' changes, polled every second, as are their notes.
 *  `fast`: the notes are polled every second. `still`: the boards declare no
 *  cadence and report nothing. `keyless`: a note names no board. */
function boardsProject(listens: string[], held: Board[], options: { pushed?: boolean; fast?: boolean; still?: boolean; keyless?: boolean; limit?: number } = {}): string {
  const dir = feedProject();
  const flag = (name: string) => writeFileSync(join(dir, 'externals/feed', name), '');
  if (options.pushed === true) flag('pushedboards');
  if (options.pushed === true || options.fast === true) flag('fast');
  if (options.still === true) flag('staticboards');
  if (options.keyless === true) flag('nokey');
  if (options.limit !== undefined) appendFileSync(join(dir, 'lf.yaml'), `listenScopeLimit: ${options.limit}\n`);
  writeListens(dir, listens);
  boards(dir, held);
  feed(dir, []);
  return dir;
}

/** The project's one file, its listens `listens`. */
function writeListens(dir: string, listens: string[]): void {
  const fired = 'function a(n: <f-[:Notes]->>) {\n  fail("a saw ${n.Title}")\n}\n\nfunction changed(b: <f-[:Boards]->>) {\n  fail("board ${b.Name}")\n}\n';
  writeFileSync(join(dir, 'movements/notes.mvt'), `import { feed } from adapters\n\nf = connect feed\n\n${fired}\n${listens.join('\n')}\n`);
}

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

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

test('a listen whose filter matches more boards than the limit is suspended by name, and watches again once it matches fewer', () => {
  const dir = boardsProject(
    [OPS_NOTES],
    [
      { id: 'b1', name: 'Ops' },
      { id: 'b2', name: 'Ops' },
      { id: 'b3', name: 'Ops' },
    ],
    { limit: 1 },
  );
  const check = lf(dir, 'check');
  assert.equal(check.code, 0, check.out);
  const limit = 'LISTEN_SCOPE_LIMIT: notes:a matched more Boards than its limit of 1; it is suspended until its filter matches fewer';
  const opened = lfAt(dir, ['drain', '--until-idle']);
  assert.ok(opened.out.includes(`listen-fire: ${limit}`), opened.out);
  assert.ok(listensLine(dir).endsWith(` — watching 0 Boards, resolved ${/resolved (\d+s ago)/.exec(listensLine(dir))?.[1]} — ${limit}; can't be protected from loops: feed names no record its arrivals are about`), listensLine(dir));
  lfAt(dir, ['drain', '--until-idle'], 61_000);
  assert.deepEqual(polledBoards(dir), [], 'a suspended listen is polled nowhere');
  // Renamed down to one: watched again from its next listing.
  boards(dir, [
    { id: 'b1', name: 'Ops' },
    { id: 'b2', name: 'Dev' },
    { id: 'b3', name: 'Dev' },
  ]);
  const back = lfAt(dir, ['drain', '--until-idle'], 301_000);
  assert.ok(back.out.includes('listen-fire: notes:a watches 1 Board again'), back.out);
  assert.match(listensLine(dir), / — watching 1 Board, resolved \d+s ago — ok;/);
  assert.deepEqual(polledBoards(dir), ['b1'], 'polled from then');
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
    [OPS_NOTES],
    [
      { id: 'b1', name: 'Ops', at: 1 },
      { id: 'b2', name: 'Dev', at: 1 },
    ],
    { pushed: true },
  );
  const check = lf(dir, 'check');
  assert.equal(check.code, 0, check.out);
  const opened = lfAt(dir, ['drain', '--until-idle']);
  assert.equal(boardLists(dir), 1, opened.out);
  assert.match(listensLine(dir), /watching 1 Board,/);
  assert.ok(edgePollsOf(dir, 'Boards') >= 1, 'listen-fire polls the boards itself, no listen on them asked');
  assert.ok(!opened.out.includes('resolved at open only'), opened.out);
  boards(dir, [
    { id: 'b1', name: 'Ops', at: 1 },
    { id: 'b2', name: 'Ops', at: 2 },
  ]);
  // Its boards' next poll reports the rename: listed again at once, five minutes or not.
  const reported = lfAt(dir, ['drain', '--until-idle'], 2_000);
  assert.equal(boardLists(dir), 2, reported.out);
  assert.match(listensLine(dir), /watching 2 Boards,/);
  assert.doesNotMatch(reported.out, /board Ops/, 'a report on the boards fires nothing of its own');
});

test('a listen whose boards declare no cadence and report nothing is resolved at open only, said once', () => {
  const dir = boardsProject([OPS_NOTES], [{ id: 'b1', name: 'Ops' }], { still: true });
  const check = lf(dir, 'check');
  assert.equal(check.code, 0, check.out);
  const opened = lfAt(dir, ['drain', '--until-idle']);
  const said = "listen-fire: notes:a is resolved at open only: no hop it resolves declares relistEverySeconds or parentChanges: pushed, so the Boards it watches are listed again only when listen-fire opens; lf.yaml's `resolveEvery: { feed: <duration> }` lists them on a clock";
  assert.equal(opened.out.split(said).length - 1, 1, opened.out);
  assert.match(listensLine(dir), / — watching 1 Board, resolved at open only \(\d+s ago\) — ok;/);
  appendFileSync(join(dir, 'lf.yaml'), 'resolveEvery:\n  feed: 5m\n');
  const timed = lfAt(dir, ['drain', '--until-idle']);
  assert.ok(!timed.out.includes('resolved at open only'), timed.out);
  assert.match(listensLine(dir), / — watching 1 Board, resolved \d+s ago — ok;/);
});

test('a note that names no board is under the board its poll was made for', () => {
  const dir = boardsProject([OPS_NOTES], [{ id: 'b1', name: 'Ops' }], { keyless: true });
  const check = lf(dir, 'check');
  assert.equal(check.code, 0, check.out);
  lfAt(dir, ['drain', '--until-idle']);
  feed(dir, [note('n3', 'b1', 3)]);
  const out = lfAt(dir, ['drain', '--until-idle'], 61_000);
  assert.deepEqual(saw(out.out), ['n3'], out.out);
});

// An edited listen is another listen: its plan names it, and what was kept
// of the one before is not its own.
test('an edited filter is listed again as listen-fire opens, its schedule or not', () => {
  const dir = boardsProject([OPS_NOTES], [
    { id: 'b1', name: 'Ops' },
    { id: 'b2', name: 'Dev' },
  ]);
  const check = lf(dir, 'check');
  assert.equal(check.code, 0, check.out);
  lfAt(dir, ['drain', '--until-idle']);
  assert.deepEqual(polledBoards(dir), ['b1']);
  writeListens(dir, ['listen to f-[b:Boards WHERE b.Name == "Dev"]->-[n:Notes]-> fire a']);
  const edited = lfAt(dir, ['drain', '--until-idle'], 61_000);
  assert.equal(boardLists(dir), 2, edited.out);
  assert.match(listensLine(dir), /^notes:a — f-\[b:Boards WHERE b\.Name == "Dev"\]->-\[n:Notes\]-> — resolved, arrival — watching 1 Board, resolved \d+s ago — ok;/);
  assert.deepEqual(polledBoards(dir).slice(1), ['b2'], 'the board the new filter matches, from then');
});

test('a failed listing keeps the boards it had, and when they were listed', () => {
  const dir = boardsProject([OPS_NOTES], [{ id: 'b1', name: 'Ops' }]);
  const check = lf(dir, 'check');
  assert.equal(check.code, 0, check.out);
  lfAt(dir, ['drain', '--until-idle']);
  sleep(4_000);
  writeFileSync(join(dir, 'externals/feed/boards.json'), 'not json');
  const failed = lfAt(dir, ['drain', '--until-idle'], 301_000);
  assert.match(failed.out, /LISTEN_RESOLVE_FAILED: notes:a could not list the Boards it watches/);
  const line = listensLine(dir);
  assert.match(line, / — watching 1 Board, resolved \d+s ago — LISTEN_RESOLVE_FAILED/);
  assert.ok(Number(/resolved (\d+)s ago/.exec(line)?.[1]) >= 4, `dated by the listing it kept, not the failure: ${line}`);
});

test('two processes opening at once list a listen once', async () => {
  const dir = boardsProject([OPS_NOTES], [{ id: 'b1', name: 'Ops' }]);
  const check = lf(dir, 'check');
  assert.equal(check.code, 0, check.out);
  const [command, args] = lfCommand(['drain', '--until-idle']);
  const both = [0, 1].map(
    () =>
      new Promise<string>((done) => {
        const child = spawn(command, args, { cwd: dir, env: { ...process.env, NODE_NO_WARNINGS: '1' } });
        let out = '';
        child.stdout.on('data', (chunk) => (out += chunk));
        child.stderr.on('data', (chunk) => (out += chunk));
        child.on('close', () => done(out));
      }),
  );
  const outs = await Promise.all(both);
  assert.equal(boardLists(dir), 1, outs.join('\n---\n'));
  assert.match(listensLine(dir), /watching 1 Board,/);
});

test('a worker that did not list a listen polls by the boards another listed', async () => {
  const dir = boardsProject(
    [OPS_NOTES],
    [
      { id: 'b1', name: 'Ops' },
      { id: 'b2', name: 'Dev' },
    ],
    { fast: true },
  );
  const check = lf(dir, 'check');
  assert.equal(check.code, 0, check.out);
  lfAt(dir, ['drain', '--until-idle']);
  // A worker that polls, and lists nothing on a clock.
  const [command, args] = lfCommand(['drain', '--kinds', 'poll_edge', '--max-seconds', '30']);
  const poller = spawn(command, args, { cwd: dir, env: { ...process.env, NODE_NO_WARNINGS: '1' } });
  let polled = '';
  poller.stdout.on('data', (chunk) => (polled += chunk));
  poller.stderr.on('data', (chunk) => (polled += chunk));
  const stopped = new Promise((done) => poller.on('close', done));
  try {
    await waitFor(() => polledBoards(dir).length >= 2, () => `the worker never polled: ${polled}`);
    boards(dir, [
      { id: 'b1', name: 'Ops' },
      { id: 'b2', name: 'Ops' },
    ]);
    // Another worker lists it on its clock.
    const listed = lfAt(dir, ['drain', '--until-idle', '--kinds', 'resolve_listen'], 301_000);
    assert.equal(boardLists(dir), 2, listed.out);
    await waitFor(() => polledBoards(dir).includes('b2'), () => `the polling worker kept to the boards it opened with: ${polled}`);
  } finally {
    poller.kill();
    await stopped;
  }
});

/** Wait up to 15 seconds for `ready`. */
async function waitFor(ready: () => boolean, why: () => string): Promise<void> {
  const until = Date.now() + 15_000;
  while (!ready()) {
    if (Date.now() > until) assert.fail(why());
    await new Promise((done) => setTimeout(done, 200));
  }
}

/** How many polls of `edge` were made. */
function edgePollsOf(dir: string, edge: string): number {
  return (edgePolls(dir) as Array<{ edge: string }>).filter((p) => p.edge === edge).length;
}

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

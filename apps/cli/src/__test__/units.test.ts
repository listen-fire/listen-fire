// The run host's units in listen-fire: `manual` (an invocation on its
// `Invocations`, fired by `listen-fire run <movement>`) and `cron` (ticks on its
// `Ticks`, polled by `listen-fire serve` and `listen-fire drain`, one clock per
// schedule and zone however many listens share it), in scope with no import —
// and `listen-fire init`'s starter, which needs nothing else.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { lf, lfCommand, served } from './example';

// A workspace-built listen-fire finds its bundled modules beside its own
// (canonical) path; a worktree's listen-fire may be the main checkout's.
const REPO = resolve(__dirname, '../../../..');
process.env.LF_MODULES_DIR ??= join(REPO, 'modules');
process.env.LF_SERVE_MODULE ??= join(REPO, 'apps/cli/node_modules/.bin/serve-module');

function initialised(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lf-units-'));
  assert.equal(lf(dir, 'init', dir).code, 0);
  return dir;
}

/** A function failing with the tick it is fired with, and a listen firing it on `where`. */
const ticking = (name: string, where: string) =>
  [`function ${name}(t: <cron-[:Ticks]->>) {`, `  fail("tick \${t.\`Fired at\`} on \${t.\`Schedule\`} in \${t.Zone}")`, '}', `listen to cron-[t:Ticks WHERE ${where}]-> fire ${name}`, ''].join('\n');

const TICK = ticking('tock', 't.Schedule == "* * * * *"');

function ticks(dir: string, fired = 'tick:tock'): number {
  return lf(dir, 'runs').out.split('\n').filter((l) => l.includes(fired)).length;
}

/** How far ahead to set the clock so it reads hh:mm:20 next, mm ≡ 3 (mod 5):
 *  a window measured from there in whole minutes holds a known count of
 *  minute starts, none of them a multiple of five at its end. */
function atMinuteThreeOfFive(): number {
  return (200_000 - (Date.now() % 300_000) + 300_000) % 300_000;
}

test('listen-fire init → check → run works with nothing installed', () => {
  const dir = initialised();
  const check = lf(dir, 'check');
  assert.equal(check.code, 0, check.out);
  const run = lf(dir, 'run', 'hello');
  assert.equal(run.code, 0, run.out);
  assert.match(run.out, /hello:hello completed/);
});

test('listen-fire run <movement> hands the movement a manual invocation; a movement no manual listen fires is refused', () => {
  const dir = initialised();
  writeFileSync(
    join(dir, 'movements/hello.mvt'),
    'function hello(run: <manual-[:Invocations]->>) {\n  fail("by ${run.`Run by (name)`} at ${run.`Fired at`}")\n}\nlisten to manual-[:Invocations]-> fire hello\n',
  );
  assert.match(spawnLf(dir, ['run', 'hello']), /MOVENG_ERROR: by Ada at \d{4}-\d\d-\d\dT/);
  const missing = lf(dir, 'run', 'nope');
  assert.equal(missing.code, 1);
  assert.match(missing.out, /no listen fires 'nope' on manual/);
});

test('listen-fire run <movement> --text gives the manual Invocation its Text; an event file takes no --text', () => {
  const dir = initialised();
  writeFileSync(join(dir, 'movements/echo.mvt'), 'function echo(run: <manual-[:Invocations]->>) {\n  return "Text: ${run.Text}"\n}\nlisten to manual-[:Invocations]-> fire echo\n');
  const run = lf(dir, 'run', 'echo', '--text', 'Acme Robotics');
  assert.equal(run.code, 0, run.out);
  assert.match(run.out, /echo:echo completed/);
  assert.match(run.out, /returned "Text: Acme Robotics"/);
  const refused = lf(dir, 'run', '--event', 'nope.json', '--text', 'x');
  assert.equal(refused.code, 2, refused.out);
  assert.match(refused.out, /--text gives a manual run its text/);
});

test('listen-fire run <movement> says when the invocation does not match its listen\'s WHERE, and --dry-run rehearses only what a run would run', () => {
  const dir = initialised();
  writeFileSync(join(dir, 'movements/echo.mvt'), 'function echo(run: <manual-[:Invocations]->>) {\n  return "Text: ${run.Text}"\n}\nlisten to manual-[i:Invocations WHERE i.Text == "go"]-> fire echo\n');
  const check = lf(dir, 'check');
  assert.equal(check.code, 0, check.out);
  for (const dry of [[], ['--dry-run']]) {
    const skipped = lf(dir, 'run', 'echo', '--text', 'stop', ...dry);
    assert.equal(skipped.code, 0, skipped.out);
    assert.match(skipped.out, /echo:echo: the invocation does not match the WHERE of hop 1: it runs nothing/, dry.join());
    assert.doesNotMatch(skipped.out, /returned/, dry.join());
    assert.match(lf(dir, 'run', 'echo', '--text', 'go', ...dry).out, /returned "Text: go"/, dry.join());
  }
});

test('listen-fire run <movement> with no --text: the manual Invocation\'s Text is the empty string, never absent', () => {
  const dir = initialised();
  writeFileSync(
    join(dir, 'movements/echo.mvt'),
    'function echo(run: <manual-[:Invocations]->>) {\n  if (run.Text == "") { return "empty: [${run.Text}]" }\n  return "given: [${run.Text}]"\n}\nlisten to manual-[:Invocations]-> fire echo\n',
  );
  const check = lf(dir, 'check');
  assert.equal(check.code, 0, check.out);
  const run = lf(dir, 'run', 'echo');
  assert.equal(run.code, 0, run.out);
  assert.match(run.out, /returned "empty: \[\]"/);
  assert.match(lf(dir, 'run', 'echo', '--text', 'hi').out, /returned "given: \[hi\]"/);
});

test('a cron backlog missed while no worker ran fires once on the next drain, with its poll interval\'s own tick, never twice', () => {
  const dir = initialised();
  writeFileSync(join(dir, 'movements/tick.mvt'), TICK);
  const at = atMinuteThreeOfFive();
  // A listen's first drain owes nothing from before it.
  assert.equal(spawnLf(dir, ['drain', '--until-idle'], at).includes('armed'), true);
  assert.equal(ticks(dir), 0);
  // Ten minutes on, nine occurrences older than the minute's poll interval were
  // missed: the latest of them fires once, then the interval's own occurrence.
  const drained = spawnLf(dir, ['drain', '--until-idle'], at + 600_000);
  assert.match(drained, /tick:tock failed/);
  assert.match(drained, /MOVENG_ERROR: tick \S+:00\.000Z on \* \* \* \* \* in UTC/);
  assert.equal(ticks(dir), 2);
  spawnLf(dir, ['drain', '--until-idle'], at + 600_000);
  spawnLf(dir, ['resume'], at + 600_000);
  assert.equal(ticks(dir), 2);
  // The next occurrence is the next tick.
  spawnLf(dir, ['drain', '--until-idle'], at + 660_000);
  assert.equal(ticks(dir), 3);
});

test('a cron listen polled every five minutes fires each of a minutely schedule\'s five ticks; after downtime, one catch-up tick', () => {
  const dir = initialised();
  appendFileSync(join(dir, 'lf.yaml'), '\npollEvery:\n  cron: 5m\n');
  writeFileSync(join(dir, 'movements/tick.mvt'), TICK);
  const at = atMinuteThreeOfFive();
  assert.match(spawnLf(dir, ['drain', '--until-idle'], at), /armed/);
  const five = spawnLf(dir, ['drain', '--until-idle'], at + 300_000);
  assert.equal(five.match(/tick:tock failed/g)?.length, 5, five);
  assert.equal(ticks(dir), 5);
  // An hour with nothing polling: of what is older than five minutes, the
  // latest fires once; the last five minutes fire as a poll's would.
  const caughtUp = spawnLf(dir, ['drain', '--until-idle'], at + 300_000 + 3_600_000);
  assert.equal(caughtUp.match(/tick:tock failed/g)?.length, 6, caughtUp);
  assert.equal(ticks(dir), 11);
});

test('listen-fire serve fires a cron listen when its schedule comes due', async () => {
  const dir = initialised();
  writeFileSync(join(dir, 'movements/tick.mvt'), TICK);
  const at = atMinuteThreeOfFive();
  assert.match(spawnLf(dir, ['drain', '--until-idle'], at), /armed/);
  // A minute on, the schedule has come due once.
  const server = await served(dir, [], { LF_CLOCK_AHEAD_MS: String(at + 60_000) });
  try {
    await server.waitFor(/^run \S+ tick:tock failed — MOVENG_ERROR: tick /);
  } finally {
    await server.stop();
  }
  assert.equal(ticks(dir), 1);
});

test('listen-fire serve fires a schedule within about a second of its time, not on the next minute\'s poll', async () => {
  const dir = initialised();
  writeFileSync(join(dir, 'movements/tick.mvt'), TICK);
  // The clock reads 15 seconds before a minute's start.
  const ahead = (45_000 - (Date.now() % 60_000) + 60_000) % 60_000;
  const armedAt = Date.now() + ahead;
  assert.match(spawnLf(dir, ['drain', '--until-idle'], ahead), /armed/);
  const server = await served(dir, [], { LF_CLOCK_AHEAD_MS: String(ahead) });
  try {
    const line = await server.waitFor(/^run \S+ tick:tock failed — MOVENG_ERROR: tick /, 30_000);
    const seenAt = Date.now() + ahead;
    const tick = Date.parse(/tick (\S+) on/.exec(line)?.[1] ?? '');
    assert.equal(tick, armedAt - (armedAt % 60_000) + 60_000, `the next minute's start: ${line}`);
    // Polled once a minute, it would have run 45 seconds after the tick.
    assert.ok(seenAt - tick < 2_500, `ran ${seenAt - tick}ms after its tick`);
  } finally {
    await server.stop();
  }
  assert.equal(ticks(dir), 1);
});

test('a cron listen on one schedule ticks once per occurrence; two listens on one schedule and zone share a clock', () => {
  const dir = initialised();
  const zoned = 't.Schedule == "*/5 * * * *" AND t.Zone == "Europe/London"';
  writeFileSync(join(dir, 'movements/tick.mvt'), ticking('tock', zoned));
  writeFileSync(join(dir, 'movements/tack.mvt'), ticking('tack', zoned));
  // Another zone is another clock, though the schedule is the same.
  writeFileSync(join(dir, 'movements/tuck.mvt'), ticking('tuck', 't.Schedule == "*/5 * * * *" AND t.Zone == "Asia/Tokyo"'));
  const check = lf(dir, 'check');
  assert.equal(check.code, 0, check.out);
  const at = atMinuteThreeOfFive();
  const armed = spawnLf(dir, ['drain', '--until-idle'], at);
  // One poll arms both listens sharing a clock; the other zone's arms on its own.
  assert.equal(armed.match(/armed; it fires on changes from now/g)?.length, 2, armed);
  assert.match(armed, /cron: (tack:tack, tick:tock|tick:tock, tack:tack) armed/);
  // An hour on, twelve occurrences were missed, none in the last minute's
  // poll interval: the latest fires once on each listen.
  const drained = spawnLf(dir, ['drain', '--until-idle'], at + 3_600_000);
  assert.match(drained, /MOVENG_ERROR: tick \S+:\d[05]:00\.000Z on \*\/5 \* \* \* \* in Europe\/London/);
  assert.match(drained, /MOVENG_ERROR: tick \S+ on \*\/5 \* \* \* \* in Asia\/Tokyo/);
  assert.deepEqual([ticks(dir, 'tick:tock'), ticks(dir, 'tack:tack'), ticks(dir, 'tuck:tuck')], [1, 1, 1]);
  // The same instant, polled again, owes nothing.
  spawnLf(dir, ['drain', '--until-idle'], at + 3_600_000);
  assert.deepEqual([ticks(dir, 'tick:tock'), ticks(dir, 'tack:tack')], [1, 1]);
});

test('a cron listen on schedules IN two values fires on either', () => {
  const dir = initialised();
  // The two never fall on one instant, which would fire once.
  writeFileSync(join(dir, 'movements/tick.mvt'), ticking('tock', 't.Schedule IN ["*/5 * * * *", "2-59/5 * * * *"]'));
  const check = lf(dir, 'check');
  assert.equal(check.code, 0, check.out);
  const at = atMinuteThreeOfFive();
  assert.match(spawnLf(dir, ['drain', '--until-idle'], at), /armed/);
  const drained = spawnLf(dir, ['drain', '--until-idle'], at + 3_600_000);
  assert.match(drained, /on \*\/5 \* \* \* \* in UTC/);
  assert.match(drained, /on 2-59\/5 \* \* \* \* in UTC/);
  assert.equal(ticks(dir), 2);
});

test('a cron listen naming one instant in two spellings fires once; a zone written as an offset ticks', () => {
  const dir = initialised();
  writeFileSync(
    join(dir, 'movements/tick.mvt'),
    ticking('tock', 't.Schedule IN ["*/5 * * * *", "0-59/5 * * * *"] AND t.Zone IN ["UTC", "Etc/UTC", "+00:00"]'),
  );
  const check = lf(dir, 'check');
  assert.equal(check.code, 0, check.out);
  const at = atMinuteThreeOfFive();
  assert.match(spawnLf(dir, ['drain', '--until-idle'], at), /armed/);
  const drained = spawnLf(dir, ['drain', '--until-idle'], at + 3_600_000);
  assert.doesNotMatch(drained, /fires nothing/);
  assert.equal(ticks(dir), 1, drained);
});

test('a schedule cron cannot parse is refused at check time by its owner', () => {
  const dir = initialised();
  writeFileSync(join(dir, 'movements/tick.mvt'), ticking('tock', 't.Schedule == "every monday"'));
  const check = lf(dir, 'check');
  assert.equal(check.code, 1, check.out);
  assert.match(check.out, /MOV_OWNED_VALUE_INVALID .*"every monday" is not a Cron/);
  writeFileSync(join(dir, 'movements/tick.mvt'), ticking('tock', 't.Schedule == "* * * * *" AND t.Zone == "Mars/Olympus"'));
  const zone = lf(dir, 'check');
  assert.equal(zone.code, 1, zone.out);
  assert.match(zone.out, /MOV_OWNED_VALUE_INVALID .*"Mars\/Olympus" is not a Zone/);
  // Nothing to narrow it by is a listen that would range over every tick.
  writeFileSync(join(dir, 'movements/tick.mvt'), ['function tock(t: <cron-[:Ticks]->>) {', '  return t.Schedule', '}', 'listen to cron-[:Ticks]-> fire tock', ''].join('\n'));
  const unbounded = lf(dir, 'check');
  assert.equal(unbounded.code, 1, unbounded.out);
  assert.match(unbounded.out, /MOV_UNBOUNDED_EDGE/);
});

/** `listen-fire <args>` in `dir` as Ada, its clock `aheadMs` ahead. */
function spawnLf(dir: string, args: string[], aheadMs = 0): string {
  const env = { ...process.env, LF_USER: 'Ada', LF_CLOCK_AHEAD_MS: String(aheadMs) };
  const run = spawnSync(...lfCommand(args), { cwd: dir, encoding: 'utf8', env });
  return `${run.stdout}${run.stderr}`;
}

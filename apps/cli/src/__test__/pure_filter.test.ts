// A listen's filter, and a wait's WHERE, calling a pure plugin (a host
// function): `team.isMember(m.`User Email`)`. listen-fire asks the module
// that serves it once per sender and keeps the answer, until the module says
// its answers changed (`plugins.invalidate`, adapter protocol 2.10). While
// the module is out of reach, what it would judge waits, in the order it
// came, and is judged again once the module answers. Driven through
// `listen-fire serve` against two fake modules (pure_filter_module): `talk`,
// whose messages carry the sender's email as a claim, and `team`, whose
// members are a file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { createInterface } from 'node:readline';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { parse, stringify } from 'yaml';
import { until } from './attio_fixture';
import { lf, lfCommand, project, served, type Served } from './example';

const REPO = resolve(__dirname, '../../../..');
const MODULE_KIT = join(REPO, 'packages/module-kit');
process.env.LF_SERVE_MODULE ??= join(REPO, 'apps/cli/node_modules/.bin/serve-module');

/** How often the host judges again what waits for its host, here. */
const RETRY_MS = '400';

const HEADER = `import { \`@lf-platform/team\` as team } from plugins
import { talk } from adapters
import { talk_key } from credentials

c = connect talk using talk_key
`;

/** The example project holding both modules, `movement` its one file and
 *  `members` the team. */
function teamProject(movement: string, members: string[]): string {
  const dir = project();
  const talk = join(dir, 'externals/talk');
  mkdirSync(talk, { recursive: true });
  copyFileSync(resolve(__dirname, 'pure_filter_module/serve.mjs'), join(talk, 'serve.mjs'));
  writeFileSync(
    join(talk, 'lf-external.yaml'),
    'name: talk\nkind: adapter\nprotocol: 2\ncommand: [node, serve.mjs]\nauth: { kind: bearer, field: token }\nwebhook:\n  signature: hmac-sha256\n  header: x-listen-fire-signature\n  secretField: webhook_secret\n',
  );
  const team = join(dir, 'externals/team');
  mkdirSync(team, { recursive: true });
  copyFileSync(resolve(__dirname, 'pure_filter_module/team.ts'), join(team, 'team.ts'));
  writeFileSync(join(team, 'lf-external.yaml'), stringify({ name: 'team', kind: 'plugin', module: './team.ts', env: { LF_TEST_MODULE_KIT: MODULE_KIT } }));
  writeFileSync(join(team, 'members.json'), JSON.stringify(members));
  const secretsPath = join(dir, '.lf/secrets.yaml');
  const secrets = parse(readFileSync(secretsPath, 'utf8')) as Record<string, unknown>;
  secrets.talk_key = { external: 'talk', token: 'dev-talk-token', webhook_secret: 'dev-talk-webhook-secret' };
  writeFileSync(secretsPath, stringify(secrets), { mode: 0o600 });
  rmSync(join(dir, 'movements'), { recursive: true });
  mkdirSync(join(dir, 'movements'));
  writeFileSync(join(dir, 'movements/team.mvt'), `${HEADER}\n${movement}`);
  return dir;
}

const HEARD = `function heard(m: <c-[:Messages]->>) {
  return m.Id
}

listen to c-[m:Messages WHERE m.Name != "bot" AND team.isMember(m.\`User Email\`)]-> fire heard
`;

/** What the team module is asked, and when it said its answers changed. */
function asked(dir: string): Array<{ email?: string; invalidated?: string }> {
  const log = join(dir, 'externals/team/asked.jsonl');
  return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { email?: string }) : [];
}

const setDown = (dir: string, down: boolean) => (down ? writeFileSync(join(dir, 'externals/team/down'), '') : rmSync(join(dir, 'externals/team/down'), { force: true }));

/** A push of `arrivals` to the host's wake door, as the module makes one. */
async function push(serving: Served, arrivals: unknown[]): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${serving.port}/api/public/adapter/talk/wake`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer dev-talk-token' },
    body: JSON.stringify({ arrivals }),
  });
  assert.equal(response.status, 202, await response.clone().text());
}

const message = (id: string, name: string, email: string) => ({
  edge: 'Messages',
  identity: id,
  landing: { recordId: id, recordType: 'Message', fields: { Id: id, Name: name, 'User Email': email } },
});

const reply = (to: string, id: string, email: string) => ({
  edge: 'Replies',
  key: `replies:${to}`,
  identity: id,
  landing: { recordId: id, recordType: 'Message', fields: { Id: id, Name: 'reply', 'User Email': email } },
});

interface Listed {
  runId: string;
  movement: string;
  status: string;
}

/** The runs of `fn`, oldest first. */
function runsOf(dir: string, fn: string): Listed[] {
  const listed = JSON.parse(lf(dir, 'runs', '--json').out) as { runs: Listed[] };
  return listed.runs.filter((run) => run.movement === fn).reverse();
}

/** What each completed run of `fn` returned, oldest first. */
function returnedBy(dir: string, fn: string): unknown[] {
  return runsOf(dir, fn)
    .filter((run) => run.status === 'completed')
    .map((run) => (JSON.parse(lf(dir, 'runs', 'show', run.runId, '--json').out) as { run: { returned: { value: unknown } } }).run.returned.value);
}

/** What the store keeps of the arrivals no listen could judge. */
function unjudged(dir: string): Array<{ arrival: string; reason: string; waiting: number }> {
  const db = new DatabaseSync(join(dir, '.lf', 'state.db'));
  try {
    return db.prepare('select arrival, reason, waiting from arrival_unjudged order by noted_at, arrival').all() as Array<{ arrival: string; reason: string; waiting: number }>;
  } finally {
    db.close();
  }
}

/** Every fact kept of the arrivals no listen could judge, each listen's
 *  attempts as well, in the order the store reads them. */
function facts(dir: string): Array<{ movement: string; arrival: string; attempt: number; reason: string; waiting: number }> {
  const db = new DatabaseSync(join(dir, '.lf', 'state.db'));
  try {
    return db.prepare('select movement, arrival, attempt, reason, waiting from arrival_unjudged order by noted_at, kept_order').all() as Array<{
      movement: string;
      arrival: string;
      attempt: number;
      reason: string;
      waiting: number;
    }>;
  } finally {
    db.close();
  }
}

/** The work rows that judge again what a listen waits on, by key. */
function judgeRows(dir: string): string[] {
  const db = new DatabaseSync(join(dir, '.lf', 'state.db'));
  try {
    return (db.prepare("select key from work where kind = 'judge_waiting' order by key").all() as Array<{ key: string }>).map((row) => row.key);
  } finally {
    db.close();
  }
}

/** `listen-fire drain` until stopped, its output collected. A drain that
 *  runs until stopped ends at once on a signal, leaving the modules it
 *  started: they are stopped with it, as its process group. */
function draining(dir: string, env: Record<string, string>): { lines: string[]; stop(): Promise<void> } {
  const worker = spawn(...lfCommand(['drain']), { cwd: dir, env: { ...process.env, NODE_NO_WARNINGS: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const lines: string[] = [];
  for (const output of [worker.stdout!, worker.stderr!]) createInterface({ input: output }).on('line', (line) => lines.push(line));
  const exited = new Promise<void>((done) => worker.once('exit', () => done()));
  return {
    lines,
    stop: async () => {
      process.kill(-worker.pid!, 'SIGTERM');
      await exited;
    },
  };
}

/** A delivery to talk's webhook, signed as talk's connection signs one. */
async function deliver(serving: Served, arrivals: unknown[]): Promise<void> {
  const body = JSON.stringify({ arrivals });
  const response = await fetch(`http://127.0.0.1:${serving.port}/hooks/talk/talk_key`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-listen-fire-signature': createHmac('sha256', 'dev-talk-webhook-secret').update(body).digest('hex') },
    body,
  });
  assert.ok(response.ok, await response.clone().text());
}

const LANDED_LONG_ENOUGH = 1_500;

test('a listen that calls a pure plugin checks', () => {
  const checked = lf(teamProject(HEARD, ['ann@acme.com']), 'check');
  assert.equal(checked.code, 0, checked.out);
});

test('a member runs once, a stranger keeps nothing, an unreachable host keeps arrivals waiting in order, and an invalidation is read at once', async () => {
  const dir = teamProject(HEARD, ['ann@acme.com', 'bob@acme.com']);
  const serving = await served(dir, [], { LF_UNJUDGED_RETRY_MS: RETRY_MS });
  try {
    // A member: one run. Again: the kept answer, no question asked.
    await push(serving, [message('m1', 'ann', 'ann@acme.com')]);
    await until(() => returnedBy(dir, 'heard').length === 1, serving.lines);
    await push(serving, [message('m2', 'ann', 'ann@acme.com')]);
    await until(() => returnedBy(dir, 'heard').length === 2, serving.lines);
    assert.deepEqual(asked(dir), [{ email: 'ann@acme.com' }], 'a kept answer asks no plugin');

    // A stranger: no run, and nothing kept for the listen.
    await push(serving, [message('m3', 'eve', 'eve@evil.com')]);
    await until(() => asked(dir).length === 2, serving.lines);
    await sleep(LANDED_LONG_ENOUGH);
    assert.deepEqual(returnedBy(dir, 'heard'), ['m1', 'm2']);
    assert.deepEqual(unjudged(dir), []);

    // The module out of reach: the first new sender waits for it, and what
    // comes after waits behind it, ann's kept answer or not.
    setDown(dir, true);
    await push(serving, [message('m4', 'bob', 'bob@acme.com')]);
    await push(serving, [message('m5', 'ann', 'ann@acme.com')]);
    await push(serving, [message('m6', 'bob', 'bob@acme.com')]);
    await until(() => unjudged(dir).length === 3, serving.lines);
    const kept = unjudged(dir);
    assert.deepEqual(
      kept.map(({ arrival, waiting }) => [arrival, waiting]),
      [
        ['Messages::m4:', 1],
        ['Messages::m5:', 1],
        ['Messages::m6:', 1],
      ],
    );
    assert.match(kept[0]!.reason, /the host could not answer @lf-platform\/team\//);
    assert.equal(kept[1]!.reason, 'waiting behind an earlier arrival');
    await sleep(LANDED_LONG_ENOUGH);
    assert.deepEqual(returnedBy(dir, 'heard'), ['m1', 'm2'], 'nothing runs while the host is out of reach');

    // Back: the retry judges them in the order they came, each once.
    setDown(dir, false);
    await until(() => returnedBy(dir, 'heard').length === 5, serving.lines);
    assert.deepEqual(returnedBy(dir, 'heard'), ['m1', 'm2', 'm4', 'm5', 'm6']);
    assert.deepEqual(
      unjudged(dir).map(({ waiting }) => waiting),
      [0, 0, 0],
      'judged, none waits',
    );
    await sleep(LANDED_LONG_ENOUGH);
    assert.equal(returnedBy(dir, 'heard').length, 5, 'a retry runs each once');

    // Ann leaves: the module says its answers changed, and her next
    // message is refused without waiting for an age to pass.
    writeFileSync(join(dir, 'externals/team/members.json'), JSON.stringify(['bob@acme.com']));
    await until(() => asked(dir).some((line) => line.invalidated === 'is-member'), serving.lines);
    await push(serving, [message('m7', 'ann', 'ann@acme.com')]);
    await until(() => asked(dir).filter((line) => line.email === 'ann@acme.com').length === 2, serving.lines);
    await sleep(LANDED_LONG_ENOUGH);
    assert.deepEqual(returnedBy(dir, 'heard'), ['m1', 'm2', 'm4', 'm5', 'm6']);
  } finally {
    await serving.stop();
  }
});

test("a module's own error leaves its arrival unjudged, and holds nothing behind it", async () => {
  const dir = teamProject(HEARD, ['ann@acme.com']);
  const serving = await served(dir, [], { LF_UNJUDGED_RETRY_MS: RETRY_MS });
  try {
    await push(serving, [message('m1', 'broken', 'broken@acme.com')]);
    await until(() => unjudged(dir).length === 1, serving.lines);
    const [kept] = unjudged(dir);
    assert.equal(kept!.waiting, 0);
    assert.match(kept!.reason, /answered an error .*the directory refused this address/);
    await push(serving, [message('m2', 'ann', 'ann@acme.com')]);
    await until(() => returnedBy(dir, 'heard').length === 1, serving.lines);
    assert.deepEqual(returnedBy(dir, 'heard'), ['m2']);
  } finally {
    await serving.stop();
  }
});

const BOTH = `function heard(m: <c-[:Messages]->>) {
  return m.Id
}

function echoed(m: <c-[:Messages]->>) {
  return m.Id
}

listen to c-[m:Messages WHERE m.Name != "bot" AND team.isMember(m.\`User Email\`)]-> fire heard
listen to c-[m:Messages WHERE team.isMember(m.\`User Email\`)]-> fire echoed
`;

test('behind serve --doors-only, a drain judges again what each listen waits on, each listen on a row of its own', async () => {
  const dir = teamProject(BOTH, ['ann@acme.com', 'bob@acme.com']);
  const env = { LF_UNJUDGED_RETRY_MS: RETRY_MS };
  const doors = await served(dir, ['--doors-only'], env);
  const worker = draining(dir, env);
  const seen = () => [...doors.lines, ...worker.lines];
  try {
    await push(doors, [message('m1', 'ann', 'ann@acme.com')]);
    await until(() => returnedBy(dir, 'heard').length === 1 && returnedBy(dir, 'echoed').length === 1, seen());

    // Bob is not asked yet: his message waits for the module, and ann's
    // after it waits behind it, for each listen.
    setDown(dir, true);
    await push(doors, [message('m2', 'bob', 'bob@acme.com')]);
    await push(doors, [message('m3', 'ann', 'ann@acme.com')]);
    await until(() => unjudged(dir).length === 4, seen());
    assert.ok(unjudged(dir).every(({ waiting }) => waiting === 1));
    assert.equal(judgeRows(dir).length, 2, 'each listen is judged again on a row of its own');

    setDown(dir, false);
    await until(() => returnedBy(dir, 'heard').length === 3 && returnedBy(dir, 'echoed').length === 3, seen());
    assert.deepEqual(returnedBy(dir, 'heard'), ['m1', 'm2', 'm3']);
    assert.deepEqual(returnedBy(dir, 'echoed'), ['m1', 'm2', 'm3']);
    assert.ok(unjudged(dir).every(({ waiting }) => waiting === 0), 'judged, none waits');
    await until(() => judgeRows(dir).length === 0, seen());
  } finally {
    await worker.stop();
    await doors.stop();
  }
});

test('a delivery its module cannot read again waits while the module is out of reach, and is let go once it refuses', async () => {
  const dir = teamProject(HEARD, ['ann@acme.com', 'bob@acme.com']);
  const serving = await served(dir, [], { LF_UNJUDGED_RETRY_MS: RETRY_MS });
  const talk = (file: string, there: boolean) => (there ? writeFileSync(join(dir, 'externals/talk', file), '') : rmSync(join(dir, 'externals/talk', file), { force: true }));
  try {
    setDown(dir, true);
    await deliver(serving, [message('m1', 'bob', 'bob@acme.com')]);
    await push(serving, [message('m2', 'ann', 'ann@acme.com')]);
    await until(() => unjudged(dir).length === 2, serving.lines);

    // The team answers again, but talk cannot be reached to read m1's request again: it still waits.
    talk('down', true);
    setDown(dir, false);
    await serving.waitFor(/the arrival Messages::m1: still waits: .*talk/);
    assert.deepEqual(returnedBy(dir, 'heard'), [], 'nothing runs past it');

    // Talk refuses to read it: it is let go, said with the reason, and the one behind it runs.
    talk('down', false);
    talk('refuse', true);
    await until(() => returnedBy(dir, 'heard').length === 1, serving.lines);
    assert.deepEqual(returnedBy(dir, 'heard'), ['m2']);
    const m1 = facts(dir).filter(({ arrival }) => arrival === 'Messages::m1:');
    assert.deepEqual(
      m1.map(({ attempt, waiting }) => [attempt, waiting]),
      [
        [0, 0],
        [1, 0],
      ],
    );
    assert.match(m1[1]!.reason, /talk no longer reads this request/);
  } finally {
    await serving.stop();
  }
});

const WAITER = `function waiter(m: <c-[:Messages]->>) {
  r = await m-[x:Replies WHERE team.isMember(x.\`User Email\`)]->
  return r.Id
}

listen to c-[m:Messages WHERE m.Name == "asker"]-> fire waiter
`;

test('a wait stays parked while the host is unreachable, and its retry wakes it once the host answers', async () => {
  const dir = teamProject(WAITER, ['carol@acme.com']);
  const serving = await served(dir, [], { LF_UNJUDGED_RETRY_MS: RETRY_MS });
  try {
    await push(serving, [message('q1', 'asker', 'asker@acme.com')]);
    await serving.waitFor(/team:waiter parked/);

    // a_wait_stays_parked_while_the_host_is_unreachable
    setDown(dir, true);
    await push(serving, [reply('q1', 'r1', 'carol@acme.com')]);
    await sleep(LANDED_LONG_ENOUGH);
    assert.deepEqual(
      runsOf(dir, 'waiter').map((run) => run.status),
      ['parked'],
      serving.lines.join('\n'),
    );

    // a_waits_retry_wakes_it_once_the_host_answers
    setDown(dir, false);
    await until(() => returnedBy(dir, 'waiter').length === 1, serving.lines);
    assert.deepEqual(returnedBy(dir, 'waiter'), ['r1']);
    assert.deepEqual(asked(dir), [{ email: 'carol@acme.com' }], 'asked once the host answered, through the kept answers');
  } finally {
    await serving.stop();
  }
});

test("a module's own error answering a wait's WHERE fails the run", async () => {
  const dir = teamProject(WAITER, ['carol@acme.com']);
  const serving = await served(dir, [], { LF_UNJUDGED_RETRY_MS: RETRY_MS });
  try {
    await push(serving, [message('q1', 'asker', 'asker@acme.com')]);
    await serving.waitFor(/team:waiter parked/);
    await push(serving, [reply('q1', 'r1', 'broken@acme.com')]);
    await until(() => runsOf(dir, 'waiter').some((run) => run.status === 'failed'), serving.lines);
    const [failed] = runsOf(dir, 'waiter');
    assert.match(lf(dir, 'runs', 'show', failed!.runId).out, /the directory refused this address/);
  } finally {
    await serving.stop();
  }
});

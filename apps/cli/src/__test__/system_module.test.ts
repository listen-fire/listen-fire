// `@lf/system` end to end: the host as an ordinary module. It polls
// listen-fire's records door for facts about runs and waits and reports
// them on its `Events` edge, which a listen narrows by `Kind`
// (docs/contracts/system-events.md). A program is never told about its own
// listen's failures (`notFor`), and failure handlers failing on each other's
// failures are a chain the loop breaker caps.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { until } from './attio_fixture';
import { RELEASE_RE } from './release';
import { externalPort, lf, lfCommand, project, served, type Served } from './example';
import { lf as lfAsked, ok } from './interactive';
import { HEADER, botMessages, deliver, eventCallback, parkedRun, seedSlack, slackWorld } from './slack_world';

const REPO = resolve(__dirname, '../../../..');
process.env.LF_MODULES_DIR ??= join(REPO, 'modules');
process.env.LF_SERVE_MODULE ??= join(REPO, 'apps/cli/node_modules/.bin/serve-module');

const SYSTEM = 'import { `@lf/system` as system } from adapters\n\nsys = connect system\n';

/** `@lf/system` connected in `dir`, polled every second with no settle lag. */
async function withSystem(dir: string, lfYaml = ''): Promise<void> {
  await ok(lfAsked(dir, ['connect', '@lf/system', '--yes']));
  appendFileSync(join(dir, 'externals/system/lf-external.yaml'), '\nenv:\n  SYSTEM_SETTLE_SECONDS: "0"\n');
  appendFileSync(join(dir, 'lf.yaml'), `\npollEvery:\n  system: 1s\n${lfYaml}`);
}

/** A fresh project whose `breaks` fails each time it is run. */
async function systemProject(lfYaml = ''): Promise<string> {
  const dir = join(mkdtempSync(join(tmpdir(), 'lf-system-')), 'ops');
  assert.equal(lf(join(dir, '..'), 'init', 'ops').code, 0);
  await withSystem(dir, lfYaml);
  writeFileSync(join(dir, 'movements/ops.mvt'), 'function breaks(run: <manual-[:Invocations]->>) {\n  fail("broken on purpose")\n}\nlisten to manual-[:Invocations]-> fire breaks\n');
  return dir;
}

/** A handler in its own file that fails saying what it was told. */
const reporter = (name: string, where: string) =>
  `${SYSTEM}\nfunction ${name}(e: <sys-[:Events]->>) {\n  fail("${name} saw \${e.Kind} of \${e.Automation}")\n}\nlisten to sys-[e:Events WHERE ${where}]-> fire ${name}\n`;

/** `listen-fire drain --until-idle`, judging what is due `aheadMs` from now. */
function drain(dir: string, aheadMs: number): string {
  const run = spawnSync(...lfCommand(['drain', '--until-idle']), { cwd: dir, encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1', LF_CLOCK_AHEAD_MS: String(aheadMs) } });
  return `${run.stdout}${run.stderr}`;
}

/** What each run of `name` was told, as a drain's output says. */
const saw = (out: string, name: string): string[] => [...out.matchAll(new RegExp(`MOVENG_ERROR: ${name} saw ([^\\n]+?)(?:\\s*$|\\n)`, 'gm'))].map((said) => said[1]);

/** How many of `serving`'s runs of the Slack movement `fn` completed. */
const ran = (serving: Served, fn: string) => serving.lines.filter((line) => new RegExp(`^run \\S+ slack:${fn} completed$`).test(line)).length;

function query<T>(dir: string, sql: string): T[] {
  const db = new DatabaseSync(join(dir, '.lf', 'state.db'));
  try {
    return db.prepare(sql).all().map((row) => ({ ...row })) as T[];
  } finally {
    db.close();
  }
}

test('a Run Failed listen runs when another movement fails, never for its own failure', async () => {
  const dir = await systemProject();
  writeFileSync(join(dir, 'movements/report.mvt'), reporter('report', 'e.Kind == "Run Failed"'));
  const checked = lf(dir, 'check');
  assert.equal(checked.code, 0, checked.out);
  // The first poll only arms: nothing that failed before is reported.
  assert.match(drain(dir, 0), /armed; it fires on changes from now/);
  const broke = lf(dir, 'run', 'breaks');
  assert.match(broke.out, /broken on purpose/);

  const told = drain(dir, 5_000);
  assert.deepEqual(saw(told, 'report'), ['Run Failed of breaks'], told);
  // report's own failure is found by the next poll, and is not report's to hear.
  const again = drain(dir, 10_000);
  assert.deepEqual(saw(again, 'report'), [], again);
  const runs = query<{ movement: string; status: string }>(dir, 'select movement, status from run order by started_at');
  assert.deepEqual(runs, [
    { movement: 'breaks', status: 'failed' },
    { movement: 'report', status: 'failed' },
  ]);
});

test('failure handlers failing on each other’s failures are a chain the loop breaker pauses at loopDepth', async () => {
  const dir = await systemProject('loopDepth: 2\n');
  writeFileSync(join(dir, 'movements/a.mvt'), reporter('a', 'e.Kind == "Run Failed"'));
  writeFileSync(join(dir, 'movements/b.mvt'), reporter('b', 'e.Kind IN ["Run Failed", "Run Paused"]'));
  assert.equal(lf(dir, 'check').code, 0);
  drain(dir, 0);
  lf(dir, 'run', 'breaks');
  // breaks failed: a and b each run once, a chain of breaks. Each is told
  // of the other's failure, never its own: that would be the third run of a
  // chain (breaks, a or b, …), so both listens pause, whichever poll finds
  // the other's failure first.
  const told = drain(dir, 5_000) + drain(dir, 10_000);
  assert.deepEqual([saw(told, 'a'), saw(told, 'b')], [['Run Failed of breaks'], ['Run Failed of breaks']], told);
  assert.match(told, /LISTEN_LOOP: a:a is paused: this arrival would start run 3 of a chain of writes and arrivals \(\S+, \S+\)/);
  assert.match(told, /LISTEN_LOOP: b:b is paused: this arrival would start run 3/);
  const listens = lf(dir, 'listens');
  assert.match(listens.out, /a:a .*paused/);
  assert.match(listens.out, /b:b .*paused/);
  // The chain: a's and b's runs are breaks' next.
  const breaks = query<{ id: string }>(dir, "select id from run where movement = 'breaks'")[0]?.id;
  const chains = query<{ input: string }>(dir, "select input from run where movement in ('a', 'b')").map((r) => (JSON.parse(r.input) as { chain?: string[] }).chain);
  assert.deepEqual(chains, [[breaks], [breaks]]);
});

const PRESS = `${HEADER}
function decide(run: <manual-[:Invocations]->>) {
  general = only(chat-[ch:Channels WHERE ch.Name == "general"]->)
  if (general == null) { fail("no #general channel") }
  msg = write general-[:Messages]-> { Message: "Pursue?", Buttons: [{ Text: "Pursue", Value: "pursue" }] }
  press = await msg-[:Interactions]->
  write general-[:Messages]-> { Message: "chose" }
}

listen to manual-[:Invocations]-> fire decide
`;

test('a wait whose message is deleted is reported to a Wait Lost Its Record listen, with its Edge and Record Id', async () => {
  const world = await slackWorld(PRESS);
  await withSystem(world.dir);
  writeFileSync(
    join(world.dir, 'movements/lost.mvt'),
    `${SYSTEM}\nfunction lost(e: <sys-[:Events]->>) {\n  fail("lost saw \${e.Kind} on \${e.Adapter} \${e.Edge} \${e.\`Record Id\`} of \${e.Automation} in \${e.\`Run Id\`}")\n}\nlisten to sys-[e:Events WHERE e.Kind == "Wait Lost Its Record"]-> fire lost\n`,
  );
  const serving = await served(world.dir);
  try {
    await serving.waitFor(/armed; it fires on changes from now/, 20_000);
    parkedRun(world.dir, 'decide');
    const [posted] = await botMessages(world.channels);
    assert.ok(posted);
    const deleted = await deliver(serving, eventCallback({ type: 'message', subtype: 'message_deleted', hidden: true, channel: posted.channel, ts: `${Date.now() / 1000}`, deleted_ts: posted.ts }), 'application/json');
    assert.ok(deleted.status >= 200 && deleted.status < 300, deleted.body);
    const line = await serving.waitFor(/lost saw Wait Lost Its Record/, 30_000);
    const [wait] = query<{ run_id: string; record_id: string }>(world.dir, 'select run_id, record_id from wait_row where stranded_at is not null');
    assert.ok(wait !== undefined && wait.record_id !== null && wait.record_id !== '', 'the wait keeps the record it waits on');
    assert.ok(line.includes(`lost saw Wait Lost Its Record on slack Interactions ${wait.record_id} of decide in ${wait.run_id}`), line);
  } finally {
    await serving.stop();
    await world.close();
  }
});

test("a listen-started run's wait on its own trigger's record names that record when the record is deleted", async () => {
  // The wait is opened by the delivery that starts the run, before the run
  // reaches its `await`; the run's own open then names the record.
  const dir = project('await_delivered');
  await withSystem(dir);
  writeFileSync(
    join(dir, 'movements/lost.mvt'),
    `${SYSTEM}\nfunction lost(e: <sys-[:Events]->>) {\n  fail("lost saw \${e.Kind} on \${e.Adapter} \${e.Edge} \${e.\`Record Id\`} in \${e.\`Run Id\`}")\n}\nlisten to sys-[e:Events WHERE e.Kind == "Wait Lost Its Record"]-> fire lost\n`,
  );
  const serving = await served(dir);
  try {
    await serving.waitFor(/armed; it fires on changes from now/, 20_000);
    const crm = `http://127.0.0.1:${externalPort(dir)}`;
    const post = async (route: string, body: unknown) => {
      const response = await fetch(`${crm}${route}`, { method: 'POST', body: JSON.stringify(body) });
      assert.equal(response.status, 200, `${route}: ${await response.clone().text()}`);
    };
    await post('/dev/companies', { Name: 'Osprey' });
    await serving.waitFor(/run .* companies:discuss parked/, 20_000);
    await post('/dev/companies/delete', { company: 'company-1' });
    const line = await serving.waitFor(/lost saw Wait Lost Its Record/, 30_000);
    const [wait] = query<{ run_id: string; record_id: string }>(dir, 'select run_id, record_id from wait_row where stranded_at is not null');
    assert.equal(wait?.record_id, 'company-1', 'the wait the delivery opened names the record once its run awaits');
    assert.ok(line.includes(`lost saw Wait Lost Its Record on acme_crm Comments company-1 in ${wait.run_id}`), line);
  } finally {
    await serving.stop();
  }
});

const ASKED = `${HEADER}
function asked(m: <chat-[:Message]->>) {
  return "asked \${m.Message}"
}

function every(m: <chat-[:Message]->>) {
  return "every \${m.Message}"
}

listen to chat-[:Channels]->-[m:Messages WHERE m.\`Mentions App\` == true]-> fire asked
listen to chat-[:Channels]->-[:Messages]-> fire every
`;

test('in a Slack outage of auth.test the message is taken; the listen reading Mentions App is reported once as Arrival Not Judged, the other runs', async () => {
  const world = await slackWorld(ASKED);
  await withSystem(world.dir);
  writeFileSync(
    join(world.dir, 'movements/noted.mvt'),
    `${SYSTEM}\nfunction noted(e: <sys-[:Events]->>) {\n  fail("noted saw \${e.Kind} of \${e.Automation} on \${e.Edge} \${e.\`Record Id\`} listen \${e.Listen} delivery \${e.\`Delivery Id\`} arrival \${e.\`Arrival Id\`}: \${e.Reason}")\n}\nlisten to sys-[e:Events WHERE e.Kind == "Arrival Not Judged"]-> fire noted\n`,
  );
  await seedSlack(world.channels, [{ entity_type: 'channel', id: 'C0DEALS', data: { id: 'C0DEALS', name: 'deals', is_private: false, is_member: true } }]);
  const serving = await served(world.dir);
  try {
    await serving.waitFor(/armed; it fires on changes from now/, 20_000);
    await fetch(`${world.channels.url}/slack/control/outage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ methods: ['auth.test'] }) });
    const ts = (Date.now() / 1000).toFixed(6);
    const message = { type: 'message', channel: 'C0DEALS', user: 'U001', text: 'hi <@UBOT>', ts };
    const delivered = await deliver(serving, eventCallback(message), 'application/json');
    assert.ok(delivered.status >= 200 && delivered.status < 300, delivered.body);
    await until(() => ran(serving, 'every') === 1, serving.lines);
    const line = await serving.waitFor(/noted saw Arrival Not Judged/, 30_000);

    const facts = query<{ pipeline: string; arrival: string; delivery_id: string; adapter: string; record_id: string; landing: string; reason: string }>(
      world.dir,
      'select pipeline, arrival, delivery_id, adapter, record_id, landing, reason from arrival_unjudged',
    );
    assert.equal(facts.length, 1, JSON.stringify(facts));
    const [fact] = facts;
    assert.match(fact.pipeline, /^listen:slack:asked:[0-9a-f]{8}$/);
    // What landed is kept as its module reported it, with the module it came
    // from: what a module knows its own landings by.
    assert.equal(fact.adapter, 'slack');
    const landing = JSON.parse(fact.landing) as { recordId: string; recordType: string; fields: Record<string, unknown> };
    assert.equal(landing.recordId, fact.record_id);
    assert.equal(landing.recordType, 'Message');
    assert.match(JSON.stringify(landing.fields), /hi <@UBOT>/);
    assert.equal(fact.reason, "slack could not read Mentions App of the arrival on Messages, which this listen's filter reads");
    const kept = query<{ id: string }>(world.dir, `select id from delivery where id = '${fact.delivery_id}'`);
    assert.equal(kept.length, 1, 'the delivery it names is kept, for a replay');
    assert.ok(
      line.includes(`noted saw Arrival Not Judged of asked on Messages ${fact.record_id} listen ${fact.pipeline} delivery ${fact.delivery_id} arrival ${fact.arrival}: ${fact.reason}`),
      line,
    );

    // The same message delivered again (a resend under another event id), and
    // more polls: still one fact and one event.
    const again = await deliver(serving, eventCallback(message), 'application/json');
    assert.ok(again.status >= 200 && again.status < 300, again.body);
    await new Promise((settle) => setTimeout(settle, 3_500));
    assert.equal(query(world.dir, 'select 1 from arrival_unjudged').length, 1);
    assert.equal(serving.lines.filter((said) => said.includes('noted saw Arrival Not Judged')).length, 1, serving.lines.join('\n'));
    assert.equal(ran(serving, 'asked'), 0, serving.lines.join('\n'));
  } finally {
    await serving.stop();
    await world.close();
  }
});

test('`listen to sys {}` from 0.12 is rewritten to e.Kind == "Run Failed", and a listen naming two kinds to e.Kind IN [...]', async () => {
  const dir = await systemProject();
  const file = join(dir, 'movements/report.mvt');
  const old = (listen: string) => `${SYSTEM}\nfunction report(e: <sys-[:\`Run Failed\`]->>) {\n  return e.Reason\n}\n${listen}\n`;
  const now = (where: string) => `${SYSTEM}\nfunction report(e: <sys-[:Events]->>) {\n  return e.Reason\n}\nlisten to sys-[e:Events WHERE ${where}]-> fire report\n`;
  for (const [listen, where] of [
    ['listen to sys {} fire report', 'e.Kind == "Run Failed"'],
    ['listen to sys { events: ["Run Failed", "Wait Lost Its Record"] } fire report', 'e.Kind IN ["Run Failed", "Wait Lost Its Record"]'],
  ]) {
    writeFileSync(file, old(listen));
    const yaml = join(dir, 'lf.yaml');
    writeFileSync(yaml, readFileSync(yaml, 'utf8').replace(/^engine: .*$/m, 'engine: 0.12.13'));
    const upgraded = lf(dir, 'upgrade');
    assert.equal(upgraded.code, 0, upgraded.out);
    assert.equal(readFileSync(file, 'utf8'), now(where));
    assert.match(upgraded.out, new RegExp(String.raw`lf\.yaml: engine: ${RELEASE_RE} \(was 0\.12\.13\)`));
    const checked = lf(dir, 'check');
    assert.equal(checked.code, 0, checked.out);
  }
});

test('nothing in movement-checker or movement-engine names the system module', () => {
  const named = /@lf\/system|Wait Lost Its Record|Run Failed|run_failed|SYSTEM_ADAPTER_TYPE/;
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'target' || entry === 'wasm') continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(rs|ts)$/.test(entry) && named.test(readFileSync(path, 'utf8'))) offenders.push(path);
    }
  };
  for (const root of ['crates/movement-checker', 'crates/movement-engine', 'packages/movement-engine']) walk(join(REPO, root));
  assert.deepEqual(offenders, []);
});

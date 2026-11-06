// `Actor`, the record `lf` offers on what lands (docs/contracts/actor-field.md):
// described in the catalog for a module that reports who acted, against a fake
// module (actors_module) that knows nothing of it. The language learns nothing:
// a filter and a run read an ordinary field that may be absent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { parse, stringify } from 'yaml';
import { until } from './attio_fixture';
import { lf, project, served, type Served } from './example';
import { HEADER as SLACK_HEADER, deliver, eventCallback, seedSlack, slackWorld } from './slack_world';

const REPO = resolve(__dirname, '../../../..');
process.env.LF_MODULES_DIR ??= join(REPO, 'modules');
process.env.LF_SERVE_MODULE ??= join(REPO, 'apps/cli/node_modules/.bin/serve-module');

interface Config {
  lists?: string[];
  ownActorField?: boolean;
  candidates?: Array<{ identity: Record<string, unknown>; source: string }>;
  candidatesFail?: boolean;
}

const HEADER = `import { people } from adapters
import { people_key } from credentials

c = connect people using people_key
`;

/** The example project holding the fake module, and `movement` as its one file. */
function peopleProject(movement: string, config: Config = { lists: ['getActorCandidates'] }): string {
  const dir = project();
  const folder = join(dir, 'externals/people');
  mkdirSync(folder);
  copyFileSync(resolve(__dirname, 'actors_module/serve.mjs'), join(folder, 'serve.mjs'));
  writeFileSync(join(folder, 'config.json'), JSON.stringify(config));
  writeFileSync(
    join(folder, 'lf-external.yaml'),
    'name: people\nkind: adapter\nprotocol: 2\ncommand: [node, serve.mjs]\nauth: { kind: bearer, field: token }\nwebhook:\n  signature: hmac-sha256\n  header: x-listen-fire-signature\n  secretField: webhook_secret\n',
  );
  const secretsPath = join(dir, '.lf/secrets.yaml');
  const secrets = parse(readFileSync(secretsPath, 'utf8')) as Record<string, unknown>;
  secrets.people_key = { external: 'people', token: 'dev-people-token', webhook_secret: 'dev-people-webhook-secret' };
  writeFileSync(secretsPath, stringify(secrets), { mode: 0o600 });
  rmSync(join(dir, 'movements'), { recursive: true });
  mkdirSync(join(dir, 'movements'));
  writeFileSync(join(dir, 'movements/people.mvt'), `${HEADER}\n${movement}`);
  return dir;
}

const ON_EMAIL = `function f(m: <c-[:Messages]->>) {
  return m.Actor?.Email
}

listen to c-[m:Messages WHERE m.Actor?.Email == "a@x.com"]-> fire f
`;

test('a module that reports who acted offers Actor on what lands, to a filter and to a run', () => {
  const checked = lf(peopleProject(ON_EMAIL), 'check');
  assert.equal(checked.code, 0, checked.out);
});

test('a module listing only extractActor offers it too', () => {
  const checked = lf(peopleProject(ON_EMAIL, { lists: ['extractActor'] }), 'check');
  assert.equal(checked.code, 0, checked.out);
});

test('Actor may be absent: reading on without `?.` is refused', () => {
  const checked = lf(peopleProject('function f(m: <c-[:Messages]->>) {\n  return m.Actor.Email\n}\n\nlisten to c-[:Messages]-> fire f\n'), 'check');
  assert.notEqual(checked.code, 0, checked.out);
  assert.match(checked.out, /MOV_ABSENT_REQUIRED/);
});

test('Actor reads no field it does not have', () => {
  const checked = lf(peopleProject('function f(m: <c-[:Messages]->>) {\n  return m.Actor?.Member\n}\n\nlisten to c-[:Messages]-> fire f\n'), 'check');
  assert.notEqual(checked.code, 0, checked.out);
  assert.match(checked.out, /MOV_UNKNOWN_PROPERTY/);
});

test('a module that reports nobody offers no Actor', () => {
  const checked = lf(peopleProject(ON_EMAIL, { lists: [] }), 'check');
  assert.notEqual(checked.code, 0, checked.out);
  assert.match(checked.out, /MOV_UNKNOWN_PROPERTY/);
});

test('a schedule has nobody acting: a tick has no Actor', () => {
  const checked = lf(peopleProject('function f(t: <cron-[:Ticks]->>) {\n  return t.Actor?.Email\n}\n\nlisten to cron-[t:Ticks WHERE t.Schedule == "0 9 * * *"]-> fire f\n'), 'check');
  assert.notEqual(checked.code, 0, checked.out);
  assert.match(checked.out, /MOV_UNKNOWN_PROPERTY/);
});

test('a manual run has a caller: an invocation offers Actor', () => {
  const checked = lf(peopleProject('function f(m: <manual-[:Invocations]->>) {\n  return m.Actor?.Email\n}\n\nlisten to manual-[m:Invocations]-> fire f\n'), 'check');
  assert.equal(checked.code, 0, checked.out);
});

test('a module with its own field named Actor on what lands is refused, naming the module and the record type', () => {
  const checked = lf(peopleProject('function f(m: <c-[:Messages]->>) {\n  return m.Text\n}\n\nlisten to c-[:Messages]-> fire f\n', { lists: ['getActorCandidates'], ownActorField: true }), 'check');
  assert.notEqual(checked.code, 0, checked.out);
  assert.match(checked.out, /"people".*'Message'.*'Actor'/);
});

// ── Written at the door ─────────────────────────────────────────────────────

/** A push to the host's wake door, as the module makes one. */
async function wake(serving: Served, arrivals: unknown[]): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${serving.port}/api/public/adapter/people/wake`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer dev-people-token' },
    body: JSON.stringify({ arrivals }),
  });
  assert.equal(response.status, 202, await response.clone().text());
}

const message = (id: string, actor?: Record<string, unknown>) => ({
  edge: 'Messages',
  identity: id,
  landing: { recordId: id, recordType: 'Message', fields: { Id: id, Text: 'hi' } },
  ...(actor === undefined ? {} : { actor }),
});

/** What each run of `function` returned, as `runs show --json` reads it. */
function returnedBy(dir: string, fn: string): unknown[] {
  const listed = JSON.parse(lf(dir, 'runs', '--json').out) as { runs: Array<{ runId: string; movement: string }> };
  const ofFunction = listed.runs.filter((run) => run.movement === fn);
  return ofFunction.map((run) => (JSON.parse(lf(dir, 'runs', 'show', run.runId, '--json').out) as { run: { returned: { value: unknown } } }).run.returned.value);
}

const completed = (serving: Served, fn: string) => serving.lines.filter((line) => new RegExp(`(run|resumed) .* people:${fn} completed`).test(line)).length;

async function ran(serving: Served, fn: string, times = 1): Promise<void> {
  await until(() => completed(serving, fn) >= times, serving.lines);
}

/** How many times the module was asked who acted. */
function lookups(dir: string): number {
  const log = join(dir, 'externals/people/calls.jsonl');
  return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').length : 0;
}

/** A listen on `Messages`, with a filter or none, firing a function that returns `read`. */
const listening = (fn: string, where: string | null, read: string) =>
  `function ${fn}(m: <c-[:Messages]->>) {\n  return ${read}\n}\n\nlisten to c-[m:Messages${where === null ? '' : ` WHERE ${where}`}]-> fire ${fn}\n`;

const LANDED_LONG_ENOUGH = 1_500;

test('a mixed case address fires a filter on Email and on Domain; a run reads Proven', async () => {
  const dir = peopleProject(`${listening('byEmail', 'm.Actor?.Email == "a@x.com"', 'm.Actor?.Proven')}\n${listening('byDomain', 'm.Actor?.Domain == "x.com"', 'm.Actor?.Email')}`);
  const serving = await served(dir);
  try {
    await wake(serving, [message('m1', { identifier: 'U1', scheme: 'email', email: 'A@X.com', proven: true })]);
    await ran(serving, 'byEmail');
    await ran(serving, 'byDomain');
    assert.deepEqual(returnedBy(dir, 'byEmail'), [true]);
    assert.deepEqual(returnedBy(dir, 'byDomain'), ['a@x.com']);
    assert.equal(lookups(dir), 0, 'an address the door named costs no call');
  } finally {
    await serving.stop();
  }
});

test('a domain that only starts the same does not fire a filter on Domain', async () => {
  const dir = peopleProject(listening('byDomain', 'm.Actor?.Domain == "x.com"', 'm.Id'));
  const serving = await served(dir);
  try {
    await wake(serving, [message('m1', { identifier: 'a@x.com.evil.com', scheme: 'email', email: 'a@x.com.evil.com' })]);
    await sleep(LANDED_LONG_ENOUGH);
    assert.equal(completed(serving, 'byDomain'), 0, serving.lines.join('\n'));
  } finally {
    await serving.stop();
  }
});

test('an arrival naming nobody fires no filter on Actor, and a listen with no such filter reads null', async () => {
  const dir = peopleProject(`${listening('byEmail', 'm.Actor?.Email == "a@x.com"', 'm.Id')}\n${listening('every', null, 'm.Actor?.Email')}`);
  const serving = await served(dir);
  try {
    await wake(serving, [message('m1')]);
    await ran(serving, 'every');
    await sleep(LANDED_LONG_ENOUGH);
    assert.equal(completed(serving, 'byEmail'), 0, serving.lines.join('\n'));
    assert.deepEqual(returnedBy(dir, 'every'), [null]);
    assert.equal(lookups(dir), 0);
  } finally {
    await serving.stop();
  }
});

test('an opaque identity is looked up: the first originator gives the address, the door the rest', async () => {
  const dir = peopleProject(listening('byEmail', 'm.Actor?.Email == "a@x.com"', 'm.Actor?.Id'), {
    lists: ['getActorCandidates'],
    candidates: [
      { identity: { identifier: 'relay', scheme: 'email', email: 'relay@x.com' }, source: 'relay' },
      { identity: { identifier: 'someone', scheme: 'email', email: 'A@X.com' }, source: 'originator' },
    ],
  });
  const serving = await served(dir);
  try {
    await wake(serving, [message('m1', { identifier: 'U1', scheme: 'opaque' })]);
    await ran(serving, 'byEmail');
    assert.deepEqual(returnedBy(dir, 'byEmail'), ['U1']);
    assert.equal(lookups(dir), 1);
  } finally {
    await serving.stop();
  }
});

test('a lookup that fails: the filter is not judged and no run starts, a listen with no such filter reads Id alone, and a replay judges it', async () => {
  const dir = peopleProject(`${listening('byEmail', 'm.Actor?.Email == "a@x.com"', 'm.Actor?.Email')}\n${listening('every', null, 'm.Actor?.Id')}\n${listening('everyEmail', null, 'm.Actor?.Email')}`, {
    lists: ['getActorCandidates'],
    candidatesFail: true,
  });
  const serving = await served(dir);
  try {
    await wake(serving, [message('m1', { identifier: 'U1', scheme: 'opaque' })]);
    await ran(serving, 'every');
    await ran(serving, 'everyEmail');
    await serving.waitFor(/people:byEmail: an arrival on Messages cannot be judged \(people could not read Actor of the arrival on Messages, which this listen's filter reads\): it runs nothing/);
    assert.equal(completed(serving, 'byEmail'), 0, serving.lines.join('\n'));
    assert.deepEqual(returnedBy(dir, 'every'), ['U1']);
    assert.deepEqual(returnedBy(dir, 'everyEmail'), [null]);
    const db = new DatabaseSync(join(dir, '.lf', 'state.db'));
    const facts = db.prepare('select delivery_id as deliveryId, reason from arrival_unjudged').all() as Array<{ deliveryId: string; reason: string }>;
    db.close();
    assert.equal(facts.length, 1, JSON.stringify(facts));
    assert.match(facts[0]!.reason, /people could not read Actor/);
    await serving.stop();

    // The directory is back: the delivery is put through the listen again, and asks again.
    writeFileSync(join(dir, 'externals/people/config.json'), JSON.stringify({ lists: ['getActorCandidates'], candidates: [{ identity: { identifier: 'someone', scheme: 'email', email: 'a@x.com' }, source: 'originator' }] }));
    const replayed = lf(dir, 'listens', 'replay', 'people:byEmail', '--delivery', facts[0]!.deliveryId);
    assert.equal(replayed.code, 0, replayed.out);
    assert.deepEqual(returnedBy(dir, 'byEmail'), ['a@x.com']);
  } finally {
    await serving.stop();
  }
});

test('a project whose text never says who acted costs no lookup', async () => {
  const dir = peopleProject(listening('every', null, 'm.Id'), { lists: ['getActorCandidates'], candidatesFail: true });
  const serving = await served(dir);
  try {
    await wake(serving, [message('m1', { identifier: 'U1', scheme: 'opaque' })]);
    await ran(serving, 'every');
    assert.equal(lookups(dir), 0);
  } finally {
    await serving.stop();
  }
});

test('a polled arrival says who acted as a pushed one does', () => {
  const dir = peopleProject('function f(n: <c-[:Notes]->>) {\n  return n.Actor?.Email\n}\n\nlisten to c-[n:Notes WHERE n.Actor?.Email == "a@x.com"]-> fire f\n');
  const armed = lf(dir, 'run', '--poll', 'f');
  assert.match(armed.out, /armed; it fires on changes from now/, armed.out);
  writeFileSync(
    join(dir, 'externals/people/polled.json'),
    JSON.stringify([
      { edge: 'Notes', identity: 'n1', landing: { recordId: 'n1', recordType: 'Note', fields: { Id: 'n1' } }, actor: { identifier: 'U1', scheme: 'email', email: 'A@X.com' } },
      { edge: 'Notes', identity: 'n2', landing: { recordId: 'n2', recordType: 'Note', fields: { Id: 'n2' } }, actor: { identifier: 'U2', scheme: 'email', email: 'b@x.com' } },
    ]),
  );
  const polled = lf(dir, 'run', '--poll', 'f');
  assert.equal(polled.code, 0, polled.out);
  assert.deepEqual(returnedBy(dir, 'f'), ['a@x.com']);
});

test('a wait reads who acted on what landed', async () => {
  const dir = peopleProject('function f(m: <c-[:Messages]->>) {\n  reply = await m-[:Replies]->\n  return reply.Actor?.Email\n}\n\nlisten to c-[:Messages]-> fire f\n');
  const serving = await served(dir);
  try {
    await wake(serving, [message('m1')]);
    await serving.waitFor(/people:f parked/);
    await wake(serving, [{ edge: 'Replies', key: 'replies:m1', identity: 'r1', landing: { recordId: 'r1', recordType: 'Message', fields: { Id: 'r1' } }, actor: { identifier: 'U2', scheme: 'email', email: 'B@X.com' } }]);
    await ran(serving, 'f');
    assert.deepEqual(returnedBy(dir, 'f'), ['b@x.com']);
  } finally {
    await serving.stop();
  }
});

test('runs show prints who acted on what landed', async () => {
  const dir = peopleProject(listening('every', null, 'm.Id'));
  const serving = await served(dir);
  try {
    await wake(serving, [message('m1', { identifier: 'U1', scheme: 'email', email: 'A@X.com', label: 'Ann', proven: true })]);
    await ran(serving, 'every');
    const listed = JSON.parse(lf(dir, 'runs', '--json').out) as { runs: Array<{ runId: string }> };
    const shown = lf(dir, 'runs', 'show', listed.runs[0]!.runId);
    assert.equal(shown.code, 0, shown.out);
    assert.match(shown.out, /Actor/);
    assert.match(shown.out, /a@x\.com/);
    assert.match(shown.out, /x\.com/);
  } finally {
    await serving.stop();
  }
});

test('@lf/slack: a member is looked up by users.info, and a run reads Actor through a module that never heard of it', async () => {
  const world = await slackWorld(`${SLACK_HEADER}
function fromAda(m: <chat-[:Message]->>) {
  return m.Actor?.Email
}

function every(m: <chat-[:Message]->>) {
  return m.Actor?.Id
}

listen to chat-[:Channels]->-[m:Messages WHERE m.Actor?.Email == "ada@acme.test"]-> fire fromAda
listen to chat-[:Channels]->-[:Messages]-> fire every
`);
  try {
    await seedSlack(world.channels, [
      { entity_type: 'channel', id: 'C0DEALS', data: { id: 'C0DEALS', name: 'deals', is_private: false, is_member: true } },
      { entity_type: 'user', id: 'U001', data: { id: 'U001', profile: { email: 'Ada@Acme.test' } } },
      { entity_type: 'user', id: 'U002', data: { id: 'U002', profile: { email: 'bob@acme.test' } } },
    ]);
    const serving = await served(world.dir);
    try {
      const say = async (user: string, at: number) => {
        const delivered = await deliver(serving, eventCallback({ type: 'message', channel: 'C0DEALS', user, text: 'hi', ts: (Date.now() / 1000 + at).toFixed(6) }), 'application/json');
        assert.ok(delivered.status >= 200 && delivered.status < 300, delivered.body);
      };
      await say('U002', 0);
      await say('U001', 1);
      await until(() => serving.lines.filter((line) => /slack:every completed/.test(line)).length === 2, serving.lines);
      await until(() => serving.lines.some((line) => /slack:fromAda completed/.test(line)), serving.lines);
      assert.deepEqual(returnedBy(world.dir, 'fromAda'), ['ada@acme.test']);
      assert.deepEqual([...returnedBy(world.dir, 'every')].sort(), ['U001', 'U002']);
    } finally {
      await serving.stop();
    }
  } finally {
    await world.close();
  }
});

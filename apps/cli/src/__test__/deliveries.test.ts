// The delivery receipt through the real binary: `listen-fire serve` keeps a signed
// webhook once however often it is sent, `listen-fire deliveries` lists, shows and
// replays it, a replay no listen takes is said so, `--ephemeral` keeps
// nothing, and the drain forgets a settled delivery after `retainDays`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { lf, lfCommand, served } from './example';
import { wakeModuleProject } from './wake_module/project';
import { COMPLETING, type DeliveryDoc, post, receiptProject, signedWebhook, UPDATES_ONLY } from './deliveries_fixture';

/** The webhook, taken by `listen-fire run --webhook` (a delivery of source cli). */
function runWebhook(dir: string, ...flags: string[]): { code: number; out: string } {
  const { signature } = signedWebhook(dir);
  return lf(dir, 'run', ...flags, '--webhook', 'acme_crm', '--body', 'events/webhook_body.json', '--header', `x-listen-fire-signature:${signature}`);
}

/** A command's `--json` document, from its standard output alone. */
function json<T>(dir: string, ...args: string[]): T {
  const run = spawnSync(...lfCommand([...args, '--json']), { cwd: dir, encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } });
  assert.equal(run.status, 0, `${args.join(' ')}: ${run.stdout}${run.stderr}`);
  return JSON.parse(run.stdout) as T;
}

const deliveriesOf = (dir: string): DeliveryDoc[] => json<{ deliveries: DeliveryDoc[] }>(dir, 'deliveries').deliveries;
const runsOf = (dir: string): Array<{ runId: string }> => json<{ runs: Array<{ runId: string }> }>(dir, 'runs').runs;

async function until<T>(what: string, look: () => T | undefined, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = look();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`${what}: not within ${ms}ms`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

test('listen-fire serve takes a signed webhook twice, runs it once, and replays it', async () => {
  const dir = receiptProject();
  const serving = await served(dir);
  let firstId: string;
  try {
    const first = await post(serving.port, dir, 'd-1');
    assert.equal(first.status, 202);
    assert.equal(first.answer.runs.length, 1);
    const second = await post(serving.port, dir, 'd-1');
    assert.equal(second.status, 202);
    assert.deepEqual(second.answer, { runs: [], duplicate: true });

    const runs = runsOf(dir);
    assert.equal(runs.length, 1);
    const [original] = deliveriesOf(dir);
    assert.ok(original);
    firstId = original.id;
    assert.equal(original.externalId, 'd-1');
    assert.deepEqual(original.runs.map((r) => r.id), [runs[0]!.runId]);
    const shown = lf(dir, 'runs', 'show', runs[0]!.runId);
    assert.match(shown.out, new RegExp(`"deliveryId": "${firstId}"`));

    const replayed = lf(dir, 'deliveries', 'replay', firstId);
    assert.equal(replayed.code, 0, replayed.out);
    assert.match(replayed.out, new RegExp(`^delivery \\S+ replays ${firstId}: 1 event\\(s\\) queued; listen-fire serve or listen-fire drain runs them`));
    // The serve's one-second drain tick takes the queued row.
    await until('the replay to run', () => (runsOf(dir).length === 2 ? true : undefined));
  } finally {
    await serving.stop();
  }

  const [newer, older] = deliveriesOf(dir);
  assert.ok(newer && older);
  assert.equal(older.id, firstId);
  assert.equal(newer.replayOf, firstId);
  assert.equal(newer.externalId, null);
  assert.equal(newer.source, 'cli');
  assert.equal(newer.runs.length, 1);
  assert.equal(older.runs.length, 1);
  const line = lf(dir, 'deliveries').out.split('\n')[0]!;
  assert.match(line, new RegExp(`^${newer.id} \\S+ \\S+ cli replay of ${firstId} 1 event\\(s\\) 1 run\\(s\\)$`));
});

test('a delivery no listen takes is kept and listed with no runs', async () => {
  const dir = receiptProject(UPDATES_ONLY);
  const serving = await served(dir);
  try {
    const taken = await post(serving.port, dir);
    assert.equal(taken.status, 202);
    assert.deepEqual(taken.answer.runs, []);
  } finally {
    await serving.stop();
  }
  const [only, ...rest] = deliveriesOf(dir);
  assert.ok(only);
  assert.deepEqual(rest, []);
  assert.equal(only.eventCount, 1);
  assert.deepEqual(only.runs, []);
  assert.deepEqual(runsOf(dir), []);
  assert.match(lf(dir, 'deliveries').out, / hook inline 1 event\(s\) 0 run\(s\)\n$/);
});

test('replaying a delivery no listen takes any more keeps it and says so', () => {
  const dir = receiptProject();
  const taken = runWebhook(dir);
  assert.equal(taken.code, 0, taken.out);
  const [original] = deliveriesOf(dir);
  assert.ok(original);
  assert.equal(original.runs.length, 1);

  rmSync(join(dir, 'movements/companies.mvt'));
  const replayed = json<{ deliveryId: string; replayOf: string }>(dir, 'deliveries', 'replay', original.id);
  assert.equal(replayed.replayOf, original.id);

  const drained = lf(dir, 'drain', '--until-idle');
  assert.equal(drained.code, 0, drained.out);
  assert.ok(
    drained.out.includes(`delivery ${replayed.deliveryId}: no listen takes its acme_crm event; it is kept and ran nothing`),
    drained.out,
  );
  const shown = json<{ delivery: DeliveryDoc }>(dir, 'deliveries', 'show', replayed.deliveryId).delivery;
  assert.deepEqual(shown.runs, []);
  assert.equal(shown.replayOf, original.id);
  assert.equal(shown.events?.length, 1);
  assert.equal(shown.events?.[0]?.external, 'acme_crm');
  // The original is untouched, and still names its run.
  assert.equal(json<{ delivery: DeliveryDoc }>(dir, 'deliveries', 'show', original.id).delivery.runs.length, 1);
});

test("an ephemeral webhook's receipt goes with its session", () => {
  const dir = receiptProject();
  const taken = runWebhook(dir, '--ephemeral');
  assert.equal(taken.code, 0, taken.out);
  assert.match(taken.out, /companies:welcome parked/);
  assert.equal(lf(dir, 'deliveries').out, '');
  assert.deepEqual(deliveriesOf(dir), []);
});

test('deliveries.retainDays forgets a settled delivery after its days', () => {
  const dir = receiptProject(COMPLETING);
  writeFileSync(join(dir, 'lf.yaml'), `${readFileSync(join(dir, 'lf.yaml'), 'utf8')}deliveries: { retainDays: 3 }\n`);
  const taken = runWebhook(dir);
  assert.equal(taken.code, 0, taken.out);
  assert.match(taken.out, /companies:welcome completed/);
  assert.equal(deliveriesOf(dir).length, 1);

  // LF_CLOCK_AHEAD_MS moves what is due, not the sweep's cut-off, so the row is aged in the state file.
  const ageTo = (days: number) => {
    const at = new Date(Date.now() - days * 86_400_000).toISOString();
    const aged = spawnSync('sqlite3', [join(dir, '.lf/state.db'), `update delivery set received_at = '${at}'`], { encoding: 'utf8' });
    assert.equal(aged.status, 0, aged.stderr);
  };
  ageTo(2);
  assert.equal(lf(dir, 'drain', '--until-idle').code, 0);
  assert.equal(deliveriesOf(dir).length, 1, 'inside its days it is kept');
  ageTo(4);
  assert.equal(lf(dir, 'drain', '--until-idle').code, 0);
  assert.deepEqual(deliveriesOf(dir), []);
  assert.equal(runsOf(dir).length, 1, 'the run it started outlives its receipt');

  writeFileSync(join(dir, 'lf.yaml'), readFileSync(join(dir, 'lf.yaml'), 'utf8').replace('retainDays: 3', 'retainDays: 0'));
  const refused = lf(dir, 'deliveries');
  assert.equal(refused.code, 1);
  assert.match(refused.out, /lf\.yaml: deliveries\.retainDays: a whole number of days, at least 1 \(default 14\)/);
});

test("replaying a delivery wakes the project's wake module at once", async () => {
  const dir = receiptProject();
  const woken: string[] = [];
  const worker = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      woken.push((JSON.parse(Buffer.concat(chunks).toString('utf8')) as { kind: string }).kind);
      response.end();
    });
  });
  await new Promise<void>((done) => worker.listen(0, '127.0.0.1', done));
  const bound = worker.address();
  assert.ok(bound !== null && typeof bound !== 'string');
  try {
    cpSync(join(wakeModuleProject(), 'externals/acme_wake'), join(dir, 'externals/acme_wake'), { recursive: true });
    const config = readFileSync(join(dir, 'lf.yaml'), 'utf8');
    assert.doesNotMatch(config, /^core:/m);
    writeFileSync(join(dir, 'lf.yaml'), `${config}core:\n  wake: acme_wake\n`);
    const env = { ...process.env, NODE_NO_WARNINGS: '1', LF_SECRET__ACME_WAKE__EXTERNAL: 'acme_wake', LF_SECRET__ACME_WAKE__TARGET: `http://127.0.0.1:${bound.port}/start` };
    // Asynchronous: the worker endpoint is this process, and the wake module
    // delivers to it before it answers listen-fire.
    const lfWithWake = async (...args: string[]) => {
      const [binary, argv] = lfCommand(args);
      return promisify(execFile)(binary, argv, { cwd: dir, encoding: 'utf8', env }).then((done) => ({ status: 0, ...done }));
    };

    const { signature } = signedWebhook(dir);
    const taken = await lfWithWake('run', '--webhook', 'acme_crm', '--body', 'events/webhook_body.json', '--header', `x-listen-fire-signature:${signature}`);
    assert.equal(taken.status, 0, `${taken.stdout}${taken.stderr}`);
    const [original] = deliveriesOf(dir);
    assert.ok(original);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const before = woken.length;

    const replayed = await lfWithWake('deliveries', 'replay', original.id);
    assert.equal(replayed.status, 0, `${replayed.stdout}${replayed.stderr}`);
    assert.doesNotMatch(replayed.stderr, /wake slot was not told/, replayed.stderr);
    await until('the wake module to be told', () => (woken.length > before ? true : undefined));
    assert.equal(woken[before], 'fire_event');
  } finally {
    worker.close();
  }
});

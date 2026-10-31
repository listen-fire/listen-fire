// A listen on a traversal, end to end: `listen to crm-[c:Company WHERE …]->
// fire welcome` in the example project, fired by the arrivals the acme
// external pushes to `listen-fire serve` (adapter protocol 2.6). Each company
// created in the CRM is reported as an arrival on its root `Company` edge,
// beside the `company.created` event the settings form of listen hears.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { companies, externalPort, lf, lfCommand, project, served, type Served } from './example';

// A workspace-built listen-fire finds its bundled modules beside its own
// (canonical) path; a worktree's listen-fire may be the main checkout's, so the
// modules and serve-module this tree holds are named.
const REPO = resolve(__dirname, '../../../..');
process.env.LF_MODULES_DIR ??= join(REPO, 'modules');
process.env.LF_SERVE_MODULE ??= join(REPO, 'apps/cli/node_modules/.bin/serve-module');

/** The CRM's dev routes, and a push to the host's wake door as the CRM
 *  makes one, for one serving project. */
function crmOf(dir: string, serving: Served) {
  const post = async (route: string, body: unknown) => {
    const response = await fetch(`http://127.0.0.1:${externalPort(dir)}${route}`, { method: 'POST', body: JSON.stringify(body) });
    assert.equal(response.status, 200, `${route}: ${await response.clone().text()}`);
    return (await response.json()) as Record<string, unknown>;
  };
  const wake = async (body: unknown) => {
    const response = await fetch(`http://127.0.0.1:${serving.port}/api/public/adapter/acme_crm/wake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer dev-acme-token' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as unknown };
  };
  return { post, wake };
}

/** The runs listen-fire holds, newest first, as `runs --json` lists them. */
function runsOf(dir: string): Array<{ runId: string }> {
  const run = spawnSync(...lfCommand(['runs', '--json']), { cwd: dir, encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  return (JSON.parse(run.stdout) as { runs: Array<{ runId: string }> }).runs;
}

/** The arrival the CRM reports for the company `id` named `name`. */
const companyArrival = (id: string, name: string) => ({
  edge: 'Company',
  identity: id,
  landing: { recordId: id, recordType: 'Company', fields: { id, Name: name } },
});

/** The pipeline a run was fired for, as `runs show` prints its event. */
function pipelineOf(dir: string, runId: string): string {
  const shown = lf(dir, 'runs', 'show', runId);
  assert.equal(shown.code, 0, shown.out);
  return /"pipelineInputId": "([^"]+)"/.exec(shown.out)?.[1] ?? assert.fail(shown.out);
}

/** Resolves once `holds` is true, checked every 100ms, or rejects after `ms`. */
async function until(holds: () => boolean, what: string, ms = 20_000): Promise<void> {
  const by = Date.now() + ms;
  while (!holds()) {
    if (Date.now() > by) assert.fail(`not ${what} in ${ms}ms`);
    await sleep(100);
  }
}

/** The example project with the CRM's comments not listenable: a listen
 *  ending on them does not check. */
function withUnlistenableComments(dir: string): void {
  const server = join(dir, 'externals/acme_crm/server.mjs');
  const source = readFileSync(server, 'utf8');
  const listenable = "listenable: true,\n      identity: 'Id',";
  assert.ok(source.includes(listenable), 'the comments reference is listenable');
  writeFileSync(server, source.replace(listenable, "identity: 'Id',"));
}

/** A listen on the comments, which the example's comments do not allow once unlistenable. */
const ON_COMMENTS = '\nfunction note(k: <crm-[:Comment]->>) {\n  return k.Text\n}\n\nlisten to crm-[:Company]->-[:Comments]-> fire note\n';

test('a pushed arrival fires a listen on the edge it landed on, its parameter bound to the landing', async () => {
  const dir = project('listen_arrivals');
  const serving = await served(dir);
  try {
    const { post } = crmOf(dir, serving);
    const created = await post('/dev/companies', { Name: 'Osprey' });
    assert.deepEqual(created.arrived, { status: 202, body: { accepted: 1 } });
    await serving.waitFor(/run .* companies:welcome completed/);
    assert.deepEqual(companies(dir), ['Osprey', 'Welcome Osprey']);
    // The company's `company.created` event reaches no listen in the
    // settings form, and never this one.
    const runs = runsOf(dir);
    assert.equal(runs.length, 1, serving.lines.join('\n'));
    const shown = lf(dir, 'runs', 'show', runs[0]!.runId);
    assert.equal(shown.code, 0, shown.out);
    assert.match(shown.out, /"triggerType": "arrival"/);
    assert.match(shown.out, /"edge": "Company"/);
    assert.match(shown.out, /"Name": "Osprey"/);
    // Without LF_LOG=debug an arrival the WHERE refuses runs nothing and says nothing.
    await post('/dev/companies', { Name: 'Ignored' });
    await post('/dev/companies', { Name: 'Heron' });
    await until(() => companies(dir).includes('Welcome Heron'), 'Heron welcomed');
    await sleep(500);
    assert.equal(runsOf(dir).length, 2, serving.lines.join('\n'));
    // Nor that no listen on a busy edge takes it: only an addressed edge (the inbox) says so by default.
    assert.deepEqual(serving.lines.filter((line) => /does not match the WHERE|matches the WHERE of no listen/.test(line)), []);
  } finally {
    await serving.stop();
  }
});

test('the same arrival delivered twice runs the listen once', async () => {
  const dir = project('listen_arrivals');
  const serving = await served(dir);
  try {
    const { post, wake } = crmOf(dir, serving);
    await post('/dev/companies', { Name: 'Osprey' });
    await serving.waitFor(/run .* companies:welcome completed/);
    // The CRM sends company-1's arrival again, as a provider re-sends one.
    assert.deepEqual(await wake({ arrivals: [companyArrival('company-1', 'Osprey')] }), { status: 202, body: { accepted: 1 } });
    await serving.waitFor(/companies:welcome has run the arrival company-1 on Company before: this delivery runs nothing/);
    assert.equal(runsOf(dir).length, 1);
    assert.deepEqual(companies(dir), ['Osprey', 'Welcome Osprey']);
  } finally {
    await serving.stop();
  }
});

test('an arrival the WHERE does not match runs nothing and, under LF_LOG=debug, says nothing is owed', async () => {
  const dir = project('listen_arrivals');
  const serving = await served(dir, [], { LF_LOG: 'debug' });
  try {
    const { post } = crmOf(dir, serving);
    await post('/dev/companies', { Name: 'Ignored' });
    await serving.waitFor(/companies:welcome: the arrival company-1 on Company does not match the WHERE of hop 1: nothing is owed, and it runs nothing/);
    await serving.waitFor(/the arrival company-1 on Company matches the WHERE of no listen on it: it runs nothing/);
    // Long enough for a run to have started, had one been fired.
    await sleep(1500);
    assert.deepEqual(runsOf(dir), []);
    assert.deepEqual(companies(dir), ['Ignored']);
  } finally {
    await serving.stop();
  }
});

test('a landing that names no record binds the fired parameter to the fields it carries', async () => {
  const dir = project('listen_arrivals');
  const serving = await served(dir);
  try {
    const { wake } = crmOf(dir, serving);
    const landing = { recordType: 'Company', fields: { id: 'company-9', Name: 'Kestrel' } };
    assert.deepEqual(await wake({ arrivals: [{ edge: 'Company', identity: 'company-9', landing }] }), { status: 202, body: { accepted: 1 } });
    await serving.waitFor(/run .* companies:welcome completed/);
    assert.deepEqual(companies(dir), ['Welcome Kestrel']);
  } finally {
    await serving.stop();
  }
});

test('two listens in one file firing one function each run once for an arrival both take; notFor skips only the one it names, silently', async () => {
  const dir = project('listen_arrivals');
  const file = join(dir, 'movements/companies.mvt');
  const source = readFileSync(file, 'utf8');
  writeFileSync(file, `${source}listen to crm-[c:Company WHERE c.Name != "Other"]-> fire welcome\n`);
  const serving = await served(dir, [], { LF_LOG: 'debug' });
  try {
    const { post, wake } = crmOf(dir, serving);
    await post('/dev/companies', { Name: 'Osprey' });
    await until(() => runsOf(dir).length === 2, 'two runs');
    const pipelines = runsOf(dir).map((run) => pipelineOf(dir, run.runId));
    assert.equal(new Set(pipelines).size, 2, pipelines.join(', '));
    for (const pipeline of pipelines) assert.match(pipeline, /^listen:companies:welcome:[0-9a-f]{8}$/);
    await until(() => companies(dir).filter((name) => name === 'Welcome Osprey').length === 2, 'Osprey welcomed twice');
    // An arrival not for the first runs only the second, and nothing is said of the first.
    const notFor = pipelines[0]!;
    assert.deepEqual(await wake({ arrivals: [{ ...companyArrival('company-2', 'Heron'), notFor }] }), { status: 202, body: { accepted: 1 } });
    await until(() => runsOf(dir).length === 3, 'a third run');
    await sleep(1500);
    const runs = runsOf(dir);
    assert.equal(runs.length, 3, serving.lines.join('\n'));
    assert.equal(pipelineOf(dir, runs[0]!.runId), pipelines[1]);
    assert.deepEqual(serving.lines.filter((line) => /does not match the WHERE|company-2 .*before/.test(line)), []);
  } finally {
    await serving.stop();
  }
});

/** The line every refusal of a project that does not check ends with. */
const RUN_CHECK = /^run `listen-fire check`, and fix its errors: listen-fire serves a project only once it checks$/m;

test('serve refuses a project whose listen on a traversal does not check, naming it', async () => {
  const dir = project('listen_arrivals');
  withUnlistenableComments(dir);
  const file = join(dir, 'movements/companies.mvt');
  writeFileSync(file, readFileSync(file, 'utf8') + ON_COMMENTS);
  const refused = await served(dir).then(
    () => assert.fail('served'),
    (error: Error) => error.message,
  );
  assert.match(refused, /companies\.mvt:\d+:\d+ error MOV_LISTEN_EDGE_NOT_LISTENABLE /);
  assert.match(refused, /companies\.mvt:\d+:1 the listen that fires note does not check, so nothing would fire it$/m);
  assert.match(refused, RUN_CHECK);
});

/** A function whose body reads a name nothing binds: an ordinary check error, in no listen. */
const BROKEN = 'function broken(run: <manual-[:Invocations]->>) {\n  return nowhere.Name\n}\n\nlisten to manual-[:Invocations]-> fire broken\n';

test('a project with a check error in a function is not served, drained or handed a webhook, and says to run check', async () => {
  const dir = project();
  writeFileSync(join(dir, 'movements/broken.mvt'), BROKEN);
  const refused = await served(dir).then(
    () => assert.fail('served'),
    (error: Error) => error.message,
  );
  assert.match(refused, /broken\.mvt:2:\d+ error MOV_\w+ /);
  assert.match(refused, RUN_CHECK);
  for (const args of [['drain', '--until-idle'], ['run', '--webhook', 'acme_crm', '--body', 'events/webhook_body.json'], ['resume']]) {
    const command = lf(dir, ...args);
    assert.notEqual(command.code, 0, `${args.join(' ')}: ${command.out}`);
    assert.match(command.out, /broken\.mvt:2:\d+ error MOV_\w+ /, args.join(' '));
    assert.match(command.out, RUN_CHECK, args.join(' '));
  }
  assert.deepEqual(companies(dir), [], 'nothing ran');
});

test('a run of a function, an event or a named run opens a project whose listen on a traversal does not check', () => {
  const dir = project();
  withUnlistenableComments(dir);
  writeFileSync(join(dir, 'movements/notes.mvt'), `import { acme_crm } from adapters\nimport { acme } from credentials\n\ncrm = connect acme_crm using acme\n${ON_COMMENTS}`);
  writeFileSync(join(dir, 'movements/hello.mvt'), 'function hello(run: <manual-[:Invocations]->>) {\n  return "hi"\n}\n\nlisten to manual-[:Invocations]-> fire hello\n');
  const hello = lf(dir, 'run', 'hello');
  assert.equal(hello.code, 0, hello.out);
  assert.match(hello.out, /hello:hello completed/);
  // The other file's listen in the settings form is read: the event fires it.
  const run = lf(dir, 'run', '--event', 'events/company_created.json');
  assert.equal(run.code, 0, run.out);
  assert.match(run.out, /companies:welcome parked — 1 write\(s\)/);
  assert.deepEqual(companies(dir), ['Welcome Vireo Robotics']);
  const runId = /^run (\S+) /m.exec(run.out)?.[1] ?? assert.fail(run.out);
  const resumed = lf(dir, 'resume', runId);
  assert.equal(resumed.code, 0, resumed.out);
  assert.match(resumed.out, /companies:welcome completed/);
  // Resuming every due run routes the queued deliveries too: refused.
  const every = lf(dir, 'resume');
  assert.notEqual(every.code, 0, every.out);
  assert.match(every.out, /notes\.mvt:\d+:1 the listen that fires note does not check, so nothing would fire it$/m);
});

test('an edit that adds a listen on a traversal that does not check is refused, and the running files keep serving', async () => {
  const dir = project('listen_arrivals');
  withUnlistenableComments(dir);
  const serving = await served(dir);
  try {
    const file = join(dir, 'movements/companies.mvt');
    writeFileSync(file, readFileSync(file, 'utf8') + ON_COMMENTS);
    await serving.waitFor(/kept the files listen-fire has; the new ones do not check/);
    await serving.waitFor(/MOV_LISTEN_EDGE_NOT_LISTENABLE/);
    await serving.waitFor(/companies\.mvt:\d+:1 the listen that fires note does not check, so nothing would fire it$/);
    await serving.waitFor(RUN_CHECK);
    const { post } = crmOf(dir, serving);
    await post('/dev/companies', { Name: 'Osprey' });
    await serving.waitFor(/run .* companies:welcome completed/);
    assert.deepEqual(companies(dir), ['Osprey', 'Welcome Osprey']);
  } finally {
    await serving.stop();
  }
});

test('a 2.6 module stating minor 6 is read; one stating 7 is refused by name', () => {
  const dir = project('listen_arrivals');
  const read = lf(dir, 'check');
  assert.equal(read.code, 0, read.out);
  const server = join(dir, 'externals/acme_crm/server.mjs');
  const source = readFileSync(server, 'utf8');
  assert.ok(source.includes('protocolMinor: 6,'), 'the CRM states minor 6');
  writeFileSync(server, source.replace('protocolMinor: 6,', 'protocolMinor: 7,'));
  const refused = lf(dir, 'check');
  assert.equal(refused.code, 1, refused.out);
  assert.match(
    refused.out,
    /external "acme_crm" speaks adapter protocol 2\.7; this listen-fire \(\d+\.\d+\.\d+[^)]*\) speaks 2\.0–2\.6\. Upgrade listen-fire to a release that speaks 2\.7/,
  );
});

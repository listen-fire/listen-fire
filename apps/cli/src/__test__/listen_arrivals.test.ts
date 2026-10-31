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

test('an arrival the WHERE does not match runs nothing and says nothing is owed', async () => {
  const dir = project('listen_arrivals');
  const serving = await served(dir);
  try {
    const { post } = crmOf(dir, serving);
    await post('/dev/companies', { Name: 'Ignored' });
    await serving.waitFor(/companies:welcome: the arrival company-1 on Company does not match the WHERE of hop 1: nothing is owed, and it runs nothing/);
    // Long enough for a run to have started, had one been fired.
    await sleep(1500);
    assert.deepEqual(runsOf(dir), []);
    assert.deepEqual(companies(dir), ['Ignored']);
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

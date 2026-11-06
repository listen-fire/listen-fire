// Externals through the hosted product's own adapter path: a file a movement
// makes crosses to an external as a URL the document store's local backend
// serves; a dry run captures its writes instead of making them; a run that
// calls an external too often is stopped at the segment's call ceiling; an
// external stating a minor of the adapter protocol newer than listen-fire speaks is
// refused by name; an external's comment reaches the host as an arrival.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { companies, externalPort, lf, lfCommand, project, served } from './example';

const STATE = '.lf/externals/acme_crm/state.json';

/** The example with one movement in place of its own: it writes a FILE(). */
function reportProject(): string {
  const dir = project();
  rmSync(join(dir, 'movements/companies.mvt'));
  writeFileSync(
    join(dir, 'movements/reports.mvt'),
    `import { acme_crm } from adapters
import { acme } from credentials

crm = connect acme_crm using acme

function report(company: <crm-[:Company]->>) {
  write crm-[:Company]-> { Name: "Report ${'$'}{company.Name}", Report: File.from("Hello ${'$'}{company.Name}", "text") }
}

listen to crm-[:Company]-> fire report
`,
  );
  return dir;
}

test('a FILE() written to an external crosses as a URL the local document store serves', () => {
  const dir = reportProject();
  const run = lf(dir, 'run', '--event', 'events/company_created.json');
  assert.equal(run.code, 0, run.out);
  const state = JSON.parse(readFileSync(join(dir, STATE), 'utf8')) as {
    companies: Array<{ fields: { Name: string; Report: { text: string; contentType: string } } }>;
  };
  assert.equal(state.companies[0]?.fields.Name, 'Report Vireo Robotics');
  assert.deepEqual(
    { text: state.companies[0]?.fields.Report.text, contentType: state.companies[0]?.fields.Report.contentType },
    { text: 'Hello Vireo Robotics', contentType: 'text/plain' },
  );
});

test('listen-fire run --dry-run captures the writes and makes none', () => {
  const dir = project();
  writeFileSync(
    join(dir, 'movements/by_hand.mvt'),
    `import { acme_crm } from adapters
import { acme } from credentials

crm = connect acme_crm using acme

function welcome_by_hand(go: <manual-[:Invocations]->>) {
  write crm-[:Company]-> { Name: "Welcome ${'$'}{go.Text}" }
}

listen to manual-[:Invocations]-> fire welcome_by_hand
`,
  );
  const run = lf(dir, 'run', 'welcome_by_hand', '--text', 'Vireo Robotics', '--dry-run');
  assert.equal(run.code, 0, run.out);
  assert.match(run.out, /^ {2}create acme_crm Company \S+ \(not committed\): \{"Name":"Welcome Vireo Robotics"\}$/m);
  assert.ok(!existsSync(join(dir, STATE)) || companies(dir).length === 0, 'nothing reached the external');
});

test('a run past the call ceiling is stopped, naming the knob', () => {
  const dir = project();
  const run = spawnSync(...lfCommand(['run', '--event', 'events/company_created.json']), {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1', REMOTE_ADAPTER_MAX_CALLS_PER_RUN: '1' },
  });
  const out = `${run.stdout}${run.stderr}`;
  assert.equal(run.status, 1, out);
  assert.match(out, /call ceiling reached.*REMOTE_ADAPTER_MAX_CALLS_PER_RUN/);
});

test('listen-fire check refuses an external stating a newer protocol minor, naming its package and the range listen-fire speaks', () => {
  const dir = project();
  const folder = join(dir, 'externals/acme_crm');
  copyFileSync(resolve(__dirname, 'manifest_module/serve.mjs'), join(folder, 'serve.mjs'));
  writeFileSync(join(folder, 'manifest.json'), JSON.stringify({ protocolVersion: 2, protocolMinor: 99, adapterType: 'acme_crm' }));
  writeFileSync(join(folder, 'package.json'), JSON.stringify({ name: '@acme/crm', version: '9.9.9' }));
  writeFileSync(join(folder, 'lf-external.yaml'), 'name: acme_crm\nkind: adapter\ncommand: [node, serve.mjs]\n');
  const check = lf(dir, 'check');
  assert.equal(check.code, 1, check.out);
  assert.match(
    check.out,
    /external "acme_crm" \(@acme\/crm 9\.9\.9\) speaks adapter protocol 2\.99; this listen-fire \(\d+\.\d+\.\d+[^)]*\) speaks 2\.0–2\.9\. Upgrade listen-fire to a release that speaks 2\.99 \(the protocol's Changes list names it\), or use a @acme\/crm that speaks 2\.9 or lower\./,
  );
});

test("the external's comment reaches listen-fire serve as an arrival, logged in its state", async () => {
  const dir = project();
  const serving = await served(dir);
  try {
    const crm = `http://127.0.0.1:${externalPort(dir)}`;
    const commented = await fetch(`${crm}/dev/comments`, { method: 'POST', body: JSON.stringify({ company: 'company-7', text: 'hello' }) });
    const answer = (await commented.json()) as { id: string; arrived: { status: number; body: unknown } };
    assert.deepEqual(answer.arrived, { status: 202, body: { accepted: 1 } });
  } finally {
    await serving.stop();
  }
  const logged = spawnSync('sqlite3', [join(dir, '.lf/state.db'), "select adapter_type, edge, key, identity, landing from arrival"], { encoding: 'utf8' });
  assert.equal(logged.status, 0, logged.stderr);
  assert.equal(
    logged.stdout.trim(),
    'acme_crm|Comments|thread:company-7|comment-1|{"recordId":"comment-1","recordType":"Comment","fields":{"Id":"comment-1","Text":"hello"}}',
  );
});

// A construction's position args reach the catalog and the module as under the
// hosted product: `connect notes using X { space: "alpha" }` is described in
// that space (positioned_module), a field only another space has is refused at
// check, and a run's writes carry the space they were constructed with.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stringify, parse } from 'yaml';
import { lf, project } from './example';

function notesProject(body: string): string {
  const dir = project();
  const folder = join(dir, 'externals/notes');
  mkdirSync(folder);
  copyFileSync(resolve(__dirname, 'positioned_module/serve.mjs'), join(folder, 'serve.mjs'));
  writeFileSync(join(folder, 'lf-external.yaml'), 'name: notes\nkind: adapter\ncommand: [node, serve.mjs]\n');
  const secretsPath = join(dir, '.lf/secrets.yaml');
  const secrets = parse(readFileSync(secretsPath, 'utf8')) as Record<string, unknown>;
  secrets.team_notes = { module: 'notes', credential: 'workspace', workspace: 'team' };
  writeFileSync(secretsPath, stringify(secrets), { mode: 0o600 });
  rmSync(join(dir, 'movements/companies.mvt'));
  writeFileSync(
    join(dir, 'movements/notes.mvt'),
    `import { acme_crm, notes } from adapters
import { acme, team_notes } from credentials

crm = connect acme_crm using acme
alpha = connect notes using team_notes { space: "alpha" }
beta = connect notes using team_notes { space: "beta" }

function note(company: <crm-[:Company]->>) {
${body}
}

listen to crm { events: ["company.created"] } fire note
`,
  );
  return dir;
}

function calls(dir: string): Array<{ method: string; space?: string; fields?: Record<string, unknown> }> {
  return readFileSync(join(dir, 'externals/notes/calls.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

test('each position of one connection is described in its own space, and a run writes in the space it constructed', () => {
  const dir = notesProject('  write alpha-[:Note]-> { Title: company.Name }\n  write beta-[:Note]-> { Heading: company.Name }');
  const check = lf(dir, 'check');
  assert.equal(check.code, 0, check.out);
  assert.deepEqual(
    calls(dir).filter((c) => c.method === 'describe').map((c) => c.space).sort(),
    ['alpha', 'beta'],
  );
  const run = lf(dir, 'run', '--event', 'events/company_created.json');
  assert.equal(run.code, 0, run.out);
  assert.deepEqual(
    calls(dir).filter((c) => c.method === 'createRecord').map((c) => `${c.space} ${JSON.stringify(c.fields)}`),
    ['alpha {"Title":"Vireo Robotics"}', 'beta {"Heading":"Vireo Robotics"}'],
  );
});

test('a field only another position has is refused at check', () => {
  const dir = notesProject('  write beta-[:Note]-> { Title: company.Name }');
  const check = lf(dir, 'check');
  assert.equal(check.code, 1, check.out);
  assert.match(check.out, /MOV_WRITE_UNKNOWN_FIELD/);
});

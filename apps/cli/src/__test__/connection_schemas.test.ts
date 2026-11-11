// Each connection of one module is typed by its own describe: two connections
// of a module whose schema depends on the credential (describing_module) each
// check against their own type, a field only the other has is refused, and a
// run sends each connection its own credential. A credential no file imports
// is not described.

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
  copyFileSync(resolve(__dirname, 'describing_module/serve.mjs'), join(folder, 'serve.mjs'));
  writeFileSync(join(folder, 'lf-external.yaml'), 'name: notes\nkind: adapter\ncommand: [node, serve.mjs]\n');
  const secretsPath = join(dir, '.lf/secrets.yaml');
  const secrets = parse(readFileSync(secretsPath, 'utf8')) as Record<string, unknown>;
  secrets.alpha_notes = { module: 'notes', credential: 'workspace', workspace: 'alpha' };
  secrets.beta_notes = { module: 'notes', credential: 'workspace', workspace: 'beta' };
  // Bound to the module but imported by no file: never described, so the
  // workspace it names, which the module refuses, fails nothing.
  secrets.gone_notes = { module: 'notes', credential: 'workspace', workspace: 'gone' };
  writeFileSync(secretsPath, stringify(secrets), { mode: 0o600 });
  rmSync(join(dir, 'movements/companies.mvt'));
  writeFileSync(
    join(dir, 'movements/notes.mvt'),
    `import { acme_crm, notes } from adapters
import { acme, alpha_notes, beta_notes } from credentials

crm = connect acme_crm using acme
alpha = connect notes using alpha_notes
beta = connect notes using beta_notes

function note(company: <crm-[:Company]->>) {
${body}
}

listen to crm-[:Company]-> fire note
`,
  );
  return dir;
}

function calls(dir: string): Array<{ method: string; workspace?: string; fields?: Record<string, unknown> }> {
  return readFileSync(join(dir, 'externals/notes/calls.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

test('two connections of one module check against their own schemas, and a run sends each its own credential', () => {
  const dir = notesProject('  write alpha-[:Note]-> { Title: company.Name }\n  write beta-[:Note]-> { Heading: company.Name }');
  const check = lf(dir, 'check');
  assert.equal(check.code, 0, check.out);
  assert.deepEqual(
    calls(dir).filter((c) => c.method === 'describe').map((c) => c.workspace).sort(),
    ['alpha', 'beta'],
  );
  const run = lf(dir, 'run', '--event', 'events/company_created.json');
  assert.equal(run.code, 0, run.out);
  assert.deepEqual(
    calls(dir).filter((c) => c.method === 'createRecord').map((c) => `${c.workspace} ${JSON.stringify(c.fields)}`),
    ['alpha {"Title":"Vireo Robotics"}', 'beta {"Heading":"Vireo Robotics"}'],
  );
});

test('a field only another connection of the same module has is refused at check', () => {
  const dir = notesProject('  write beta-[:Note]-> { Title: company.Name }');
  const check = lf(dir, 'check');
  assert.equal(check.code, 1, check.out);
  assert.match(check.out, /MOV_WRITE_UNKNOWN_FIELD/);
  assert.match(check.out, /Title/);
});

test('catalog describes the credential no file imports; one the module refuses is named with why, hides no other, and exits 1; check still asks nothing of it', () => {
  const dir = notesProject('  write alpha-[:Note]-> { Title: company.Name }');
  const catalog = lf(dir, 'catalog');
  assert.equal(catalog.code, 1, catalog.out);
  for (const name of ['acme', 'alpha_notes', 'beta_notes']) assert.match(catalog.out, new RegExp(`^connection ${name}: `, 'm'));
  assert.match(catalog.out, /\n\nconnection gone_notes: could not be described: .*gone/);
  assert.equal(catalog.out.match(/^connection gone_notes: /gm)?.length, 1, 'named once, with why, and not described');
  const json = lf(dir, 'catalog', '--json');
  assert.equal(json.code, 1, json.out);
  assert.match(json.out, /"alpha_notes":\{/, 'the snapshot holds the connections that were described');
  assert.match(json.out, /^connection gone_notes: could not be described: /m, 'and the one that was not is named on the error output');
  assert.equal(lf(dir, 'check').code, 0, 'a check asks nothing of a credential no file names');

  const secretsPath = join(dir, '.lf/secrets.yaml');
  const secrets = parse(readFileSync(secretsPath, 'utf8')) as Record<string, unknown>;
  secrets.gone_notes = { module: 'notes', credential: 'workspace', workspace: 'beta' };
  writeFileSync(secretsPath, stringify(secrets), { mode: 0o600 });
  const held = lf(dir, 'catalog');
  assert.equal(held.code, 0, held.out);
  for (const name of ['acme', 'alpha_notes', 'beta_notes', 'gone_notes']) assert.match(held.out, new RegExp(`^connection ${name}: `, 'm'));
  assert.match(held.out, /^connection gone_notes: .*\n(.*\n)+?.*-\[:Note\]-> Note \[w\]: Heading$/m, 'a connection no file names is typed by its own describe');
});

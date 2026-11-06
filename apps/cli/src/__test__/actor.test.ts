// `Actor`, the record `lf` offers on what lands (docs/contracts/actor-field.md):
// described in the catalog for a module that reports who acted, against a fake
// module (actors_module) that knows nothing of it. The language learns nothing:
// a filter and a run read an ordinary field that may be absent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse, stringify } from 'yaml';
import { lf, project } from './example';

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

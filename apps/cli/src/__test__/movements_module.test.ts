// The movements slot filled by a module lf does not build in: the test
// module (movements_module/serve.ts) reached at its url, its own `tenant`
// setting in the environment (the bootstrap rule), and no movements folder on
// disk. The real `lf` reads the project's files from it by name, every
// request carrying the tenant, and one command reads each file once.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lf } from './interactive';
import { serveMovementsModule, type MovementsModule } from './movements_module/serve';

const ENV = { LF_SECRET__ACME_MOVEMENTS__EXTERNAL: 'acme_movements', LF_SECRET__ACME_MOVEMENTS__TENANT: 't1' };

const GREET = 'export function greet(name: <text>) {\n  return "Hello, ${name}!"\n}\n';

/** `lf init`'s starter, as `lf init` writes it. */
async function starter(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'lf-movements-starter-'));
  const init = await lf(dir, ['init']).done;
  assert.equal(init.code, 0, init.out);
  return readFileSync(join(dir, 'movements/hello.mvt'), 'utf8');
}

/** The starter, greeting through `lib/greet.mvt`. */
async function hello(): Promise<string> {
  const text = await starter();
  const greeting = 'return "Hello, ${run.`Run by (name)`}!"';
  assert.ok(text.includes(greeting), "lf init's starter changed; update this test");
  return `import { greet } from "lib/greet"\n${text.replace(greeting, 'return greet(run.`Run by (name)`)')}`;
}

/** A project whose movements slot is filled by `module`, with no movements folder. */
function project(module: MovementsModule): string {
  const dir = mkdtempSync(join(tmpdir(), 'lf-movements-module-'));
  writeFileSync(join(dir, 'lf.yaml'), 'engine: 0.12.0\ncore:\n  movements: acme_movements\n');
  mkdirSync(join(dir, 'externals/acme_movements'), { recursive: true });
  writeFileSync(
    join(dir, 'externals/acme_movements/lf-external.yaml'),
    `name: acme_movements\nkind: core\nslot: movements\nurl: ${module.url}\nsettings:\n  - { name: tenant }\n`,
  );
  return dir;
}

test('check and run read through the module, the tenant on every request, each file read once', async () => {
  const module = await serveMovementsModule({ listen: 0, files: { 'hello.mvt': await hello(), 'lib/greet.mvt': GREET } });
  try {
    const dir = project(module);
    const checked = await lf(dir, ['check'], { env: ENV }).done;
    assert.equal(checked.code, 0, checked.out);
    assert.match(checked.out, /2 file\(s\), 0 error\(s\)/);
    assert.deepEqual(
      module.calls.filter((call) => call.startsWith('movements.')),
      ['movements.list', 'movements.read hello.mvt', 'movements.read lib/greet.mvt', 'movements.list'],
      'the second scan of one open is one list',
    );
    assert.equal(existsSync(join(dir, 'movements')), false, 'nothing is read from or written to a movements folder');
    const run = await lf(dir, ['run', 'hello'], { env: ENV }).done;
    assert.equal(run.code, 0, run.out);
    assert.match(run.out, /Hello, /);
    assert.ok(module.tenants.length > 0);
    assert.deepEqual(new Set(module.tenants), new Set(['t1']), 'every request carries the tenant');
  } finally {
    await module.close();
  }
});

test('a movements module whose own settings neither the environment nor the secrets file holds is refused as the project loads', async () => {
  const module = await serveMovementsModule({ listen: 0, files: { 'lib/greet.mvt': GREET } });
  try {
    const dir = project(module);
    const refused = await lf(dir, ['check']).done;
    assert.notEqual(refused.code, 0, refused.out);
    assert.match(refused.out, /core\.movements: acme_movements: the movements module's own settings come from LF_SECRET__… or the secrets file, not from the secrets slot/);
    assert.deepEqual(module.calls, [], 'the module is never asked');
  } finally {
    await module.close();
  }
});

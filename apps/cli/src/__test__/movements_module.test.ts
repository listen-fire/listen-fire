// The movements slot filled by a module lf does not build in: the test
// module (movements_module/serve.ts) reached at its url, its own `tenant`
// setting in the environment (the bootstrap rule), and no movements folder on
// disk. The real `lf` reads the project's files from it by name, every
// request carrying the tenant, and one command reads each file once.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXAMPLE, project as exampleProject, served } from './example';
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

/** Resolves once `ready` holds, checked every 50ms; rejects after `ms`. */
async function until(ready: () => boolean, what: string, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`not ${what} in ${ms}ms`);
    await new Promise((done) => setTimeout(done, 50));
  }
}

test('lf serve asks only list while nothing changes, and reads only the file that did', async () => {
  const module = await serveMovementsModule({ listen: 0, files: { 'hello.mvt': await hello(), 'lib/greet.mvt': GREET } });
  const asked = () => module.calls.filter((call) => call.startsWith('movements.'));
  const open = ['movements.list', 'movements.read hello.mvt', 'movements.read lib/greet.mvt', 'movements.list'];
  try {
    const server = await served(project(module), [], { ...ENV, LF_MOVEMENTS_REFRESH_MS: '0' });
    try {
      await until(() => asked().length >= open.length + 3, 'three refreshes');
      assert.deepEqual(asked().slice(0, open.length), open, 'the open reads each file once');
      assert.deepEqual(new Set(asked().slice(open.length)), new Set(['movements.list']), 'nothing changed: only list');

      const before = asked().length;
      module.put('hello.mvt', (await hello()).replace('return greet(run.`Run by (name)`)', 'return greet("again")'));
      await server.waitFor(/^movements: hello\.mvt changed$/);
      assert.deepEqual(
        asked().slice(before).filter((call) => call.startsWith('movements.read')),
        ['movements.read hello.mvt'],
        'only the file whose version moved is read',
      );
    } finally {
      await server.stop();
    }
  } finally {
    await module.close();
  }
});

// ── Writes ───────────────────────────────────────────────────────────────────

/** `upgrade.test.ts`'s movement in a retired spelling. */
const OLD = `import { acme_crm } from adapters
import { acme } from credentials

crm = acme_crm(credentials: acme)

# A company created in the CRM is welcomed at once — then followed up.
movement welcome(company: <crm-[:Company]->>) {
  write crm-[:Company]-> { Name: Text.concat("Welcome ", UPPER(company.Name)) }
  await sleep(1h)
}

listen to crm { events: ["company.created"] } fire welcome
`;
const UPGRADED = OLD.replace('acme_crm(credentials: acme)', 'connect acme_crm using acme')
  .replace('movement welcome', 'function welcome')
  .replace('UPPER(company.Name)', 'Text.upper(company.Name)');

/** The example project (its CRM external and credentials), its movements folder
 *  gone, pinned to `engine` and its movements slot filled by `module`. */
function exampleOver(module: MovementsModule, engine: string): string {
  const dir = exampleProject();
  rmSync(join(dir, 'movements'), { recursive: true });
  writeFileSync(join(dir, 'lf.yaml'), `engine: ${engine}\ncore:\n  movements: acme_movements\n`);
  mkdirSync(join(dir, 'externals/acme_movements'), { recursive: true });
  writeFileSync(
    join(dir, 'externals/acme_movements/lf-external.yaml'),
    `name: acme_movements\nkind: core\nslot: movements\nurl: ${module.url}\nsettings:\n  - { name: tenant }\n`,
  );
  cpSync(join(EXAMPLE, 'externals/acme_crm'), join(dir, 'externals/acme_crm'), { recursive: true });
  return dir;
}

const read = (dir: string, file: string) => readFileSync(join(dir, file), 'utf8');

test('upgrade writes through the module, at the version it read, and the project then checks clean', async () => {
  const module = await serveMovementsModule({ listen: 0, files: { 'companies.mvt': OLD } });
  try {
    const dir = exampleOver(module, '0.11.0');
    const upgraded = await lf(dir, ['upgrade'], { env: ENV }).done;
    assert.equal(upgraded.code, 0, upgraded.out);
    assert.equal(module.held()['companies.mvt'], UPGRADED);
    assert.deepEqual(module.writes, [{ path: 'companies.mvt', expectedVersion: 'v1' }], 'the version the list answered');
    assert.match(read(dir, 'lf.yaml'), /^engine: 0\.12\.0(-[\w.]+)?$/m);
    assert.equal(existsSync(join(dir, 'movements')), false);
    const checked = await lf(dir, ['check'], { env: ENV }).done;
    assert.equal(checked.code, 0, checked.out);
  } finally {
    await module.close();
  }
});

test('a conflict holds the pin: a file changed since lf read it is not overwritten', async () => {
  const module = await serveMovementsModule({ listen: 0, files: { 'companies.mvt': OLD }, changeBeforeWrite: 'companies.mvt' });
  try {
    const dir = exampleOver(module, '0.11.0');
    const upgraded = await lf(dir, ['upgrade'], { env: ENV }).done;
    assert.equal(upgraded.code, 1, upgraded.out);
    assert.ok(upgraded.out.includes('movements/companies.mvt: changed since lf read it; nothing written (run `lf upgrade` again)'), upgraded.out);
    assert.match(upgraded.out, /engine: left at 0\.11\.0 until the 1 remaining diagnostic\(s\) are fixed/);
    assert.match(upgraded.out, /1 file\(s\), 0 rewritten, 1 left to change by hand/);
    assert.equal(module.held()['companies.mvt'], OLD);
    assert.match(read(dir, 'lf.yaml'), /^engine: 0\.11\.0$/m);
  } finally {
    await module.close();
  }
});

test('a read-only module refuses upgrade and init by name, writing nothing', async () => {
  const module = await serveMovementsModule({ listen: 0, files: { 'companies.mvt': OLD }, readOnly: 'the platform keeps them' });
  const refusal = "lf: acme_movements holds the project's movements read-only: the platform keeps them. Change them where they live.\n";
  try {
    const dir = exampleOver(module, '0.11.0');
    const pin = read(dir, 'lf.yaml');
    const upgraded = await lf(dir, ['upgrade'], { env: ENV }).done;
    assert.equal(upgraded.code, 2, upgraded.out);
    assert.equal(upgraded.out, refusal);
    assert.deepEqual(module.held(), { 'companies.mvt': OLD });
    assert.equal(read(dir, 'lf.yaml'), pin);

    // init in a project that already names the module, with no .gitignore and no hello.mvt to be made.
    const fresh = exampleOver(module, '0.12.0');
    rmSync(join(fresh, '.gitignore'), { force: true });
    const before = read(fresh, 'lf.yaml');
    const init = await lf(fresh, ['init'], { env: ENV }).done;
    assert.equal(init.code, 2, init.out);
    assert.equal(init.out, refusal);
    assert.equal(existsSync(join(fresh, '.gitignore')), false);
    assert.equal(existsSync(join(fresh, 'movements')), false);
    assert.equal(read(fresh, 'lf.yaml'), before);
    assert.deepEqual(module.held(), { 'companies.mvt': OLD });
  } finally {
    await module.close();
  }
});

test('init writes the starter through the module, only if nothing is there, and a second init changes nothing', async () => {
  const module = await serveMovementsModule({ listen: 0 });
  try {
    const dir = project(module);
    const first = await lf(dir, ['init'], { env: ENV }).done;
    assert.equal(first.code, 0, first.out);
    assert.match(first.out, /^made movements\/hello\.mvt/);
    assert.deepEqual(module.writes, [{ path: 'hello.mvt', expectedVersion: null }]);
    assert.equal(module.held()['hello.mvt'], await starter());
    assert.equal(existsSync(join(dir, 'movements')), false, 'nothing is written to a movements folder');

    const second = await lf(dir, ['init'], { env: ENV }).done;
    assert.equal(second.code, 0, second.out);
    assert.equal(second.out.trim(), 'already a project');
    assert.equal(module.held()['hello.mvt'], await starter());
  } finally {
    await module.close();
  }
});

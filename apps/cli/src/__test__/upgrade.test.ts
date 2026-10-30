// `listen-fire upgrade`, through the real binary entry point, on the example project
// (written in a retired spelling): `--check` shows the rewrite and writes
// nothing, `listen-fire upgrade` rewrites the file so `listen-fire check` is clean, and a second
// run changes nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lf, project } from './example';

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

test('listen-fire upgrade --check prints the rewrite; listen-fire upgrade makes it; a second run changes nothing', () => {
  const dir = project();
  const file = join(dir, 'movements', 'companies.mvt');
  writeFileSync(file, OLD);

  const checked = lf(dir, 'upgrade', '--check');
  assert.equal(checked.code, 1, checked.out);
  assert.match(checked.out, /^-crm = acme_crm\(credentials: acme\)$/m);
  assert.match(checked.out, /^\+crm = connect acme_crm using acme$/m);
  assert.match(checked.out, /1 file\(s\), 1 would be rewritten, 0 left to change by hand/);
  assert.equal(readFileSync(file, 'utf8'), OLD);

  const upgraded = lf(dir, 'upgrade');
  assert.equal(upgraded.code, 0, upgraded.out);
  assert.equal(
    readFileSync(file, 'utf8'),
    OLD.replace('acme_crm(credentials: acme)', 'connect acme_crm using acme')
      .replace('movement welcome', 'function welcome')
      .replace('UPPER(company.Name)', 'Text.upper(company.Name)'),
  );
  assert.equal(lf(dir, 'check').code, 0);

  const again = lf(dir, 'upgrade', '--check');
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, /1 file\(s\), 0 would be rewritten, 0 left to change by hand/);
});

test('listen-fire upgrade reports what it cannot rewrite, by file and line', () => {
  const dir = project();
  const file = join(dir, 'movements', 'companies.mvt');
  writeFileSync(file, OLD.replace('Name: Text.concat', 'Nme: Text.concat'));
  const { code, out } = lf(dir, 'upgrade');
  assert.equal(code, 1, out);
  assert.match(out, /^movements\/companies\.mvt:8:\d+ error MOV_WRITE_UNKNOWN_FIELD /m);
  assert.match(readFileSync(file, 'utf8'), /^crm = connect acme_crm using acme$/m);
});

const pinned = (dir: string, engine: string): void => {
  const file = join(dir, 'lf.yaml');
  writeFileSync(file, readFileSync(file, 'utf8').replace(/^engine: .*$/m, `engine: ${engine}`));
};

test('listen-fire upgrade moves an older pin to the current release once the project validates clean', () => {
  const dir = project();
  pinned(dir, '0.11.0');
  assert.match(lf(dir, 'check').out, /does not read/);

  const { code, out } = lf(dir, 'upgrade');
  assert.equal(code, 0, out);
  assert.match(out, /lf\.yaml: engine: 0\.13\.\d+(-[\w.]+)? \(was 0\.11\.0\)/);
  assert.match(readFileSync(join(dir, 'lf.yaml'), 'utf8'), /^engine: 0\.13\.\d+(-[\w.]+)?$/m);
  assert.equal(lf(dir, 'check').code, 0);
});

test('listen-fire upgrade leaves the pin where it was while fixes remain for the author, and says why', () => {
  const dir = project();
  pinned(dir, '0.11.0');
  const file = join(dir, 'movements', 'companies.mvt');
  writeFileSync(file, OLD.replace('Name: Text.concat', 'Nme: Text.concat'));

  const { code, out } = lf(dir, 'upgrade');
  assert.equal(code, 1, out);
  assert.match(out, /engine: left at 0\.11\.0 until the 2 remaining diagnostic\(s\) are fixed; run `listen-fire upgrade` again/);
  assert.match(readFileSync(join(dir, 'lf.yaml'), 'utf8'), /^engine: 0\.11\.0$/m);
  assert.match(readFileSync(file, 'utf8'), /^crm = connect acme_crm using acme$/m);
});

// A wait whose WHERE reads a field of a record the run holds: under 0.12 the
// field was read again at every check; from 0.13 it is read once, when the
// wait is reached. Nothing to rewrite, so the upgrade lists it and the pin moves.
const CAPTURING = `import { acme_crm } from adapters
import { acme } from credentials

crm = connect acme_crm using acme

function welcome(company: <crm-[:Company]->>) {
  named = await company-[c:Comments WHERE c.Text == company.Name]->
}

listen to crm { events: ["company.created"] } fire welcome
`;

test('listen-fire upgrade lists a wait whose run value is now captured, and still moves the pin', () => {
  const dir = project();
  pinned(dir, '0.12.13');
  const file = join(dir, 'movements', 'companies.mvt');
  writeFileSync(file, CAPTURING);

  const { code, out } = lf(dir, 'upgrade');
  assert.equal(code, 0, out);
  assert.match(
    out,
    /^movements\/companies\.mvt:7:17 warning MOV_AWAIT_VALUE_CAPTURED 'company\.Name' in this wait's WHERE is read once, when the wait is reached \(0\.13\); under 0\.12\.13 it was read again at every check, .* against `refresh\(company\)`$/m,
  );
  assert.match(out, /lf\.yaml: engine: 0\.13\.\d+(-[\w.]+)? \(was 0\.12\.13\)/);
  assert.match(out, /1 file\(s\), 0 rewritten, 0 left to change by hand/);
  assert.equal(readFileSync(file, 'utf8'), CAPTURING);
  assert.match(readFileSync(join(dir, 'lf.yaml'), 'utf8'), /^engine: 0\.13\.\d+(-[\w.]+)?$/m);

  const checked = lf(dir, 'check');
  assert.equal(checked.code, 0, checked.out);
  assert.doesNotMatch(checked.out, /MOV_AWAIT_VALUE_CAPTURED/);
});

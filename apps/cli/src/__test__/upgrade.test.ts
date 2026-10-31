// `listen-fire upgrade`, through the real binary entry point, on the example project
// (written in a retired spelling): `--check` shows the rewrite and writes
// nothing, `listen-fire upgrade` rewrites the file so `listen-fire check` is clean, and a second
// run changes nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    /^movements\/companies\.mvt:7:17 warning MOV_AWAIT_VALUE_CAPTURED 'company\.Name' in this wait's WHERE is read once, when the wait is reached \(0\.13\); under 0\.12\.13 it was read again at every check, .* against `refresh\(company\)` \(see handbook: reviews#captured-values\)$/m,
  );
  assert.match(out, /lf\.yaml: engine: 0\.13\.\d+(-[\w.]+)? \(was 0\.12\.13\)/);
  assert.match(out, /1 file\(s\), 0 rewritten, 0 left to change by hand/);
  assert.equal(readFileSync(file, 'utf8'), CAPTURING);
  assert.match(readFileSync(join(dir, 'lf.yaml'), 'utf8'), /^engine: 0\.13\.\d+(-[\w.]+)?$/m);

  const checked = lf(dir, 'check');
  assert.equal(checked.code, 0, checked.out);
  assert.doesNotMatch(checked.out, /MOV_AWAIT_VALUE_CAPTURED/);
});

// An existing 0.12 program upgraded to 0.13: `await first(x)` is rewritten
// to `await x`; a `callback(…)` has no rewrite, so it is listed by file and
// line and holds the pin until the author replaces it; a wait whose WHERE
// reads a run record's field is listed as a warning and holds nothing.
const WAITS_012 = `import { acme_crm } from adapters
import { acme } from credentials

crm = connect acme_crm using acme

function welcome(company: <crm-[:Company]->>) {
  c = await first(company-[x:Comments WHERE x.Text == company.Name]->)
}

listen to crm { events: ["company.created"] } fire welcome
`;

const CALLBACK_012 = `import { acme_crm } from adapters
import { acme } from credentials

crm = connect acme_crm using acme

function ask(company: <crm-[:Company]->>) {
  go = callback({ })
  write crm-[:Company]-> { Name: "Asked \${go.url}" }
}
`;

test('listen-fire upgrade on a 0.12 project with waits and callbacks', () => {
  const dir = project();
  pinned(dir, '0.12.13');
  const waits = join(dir, 'movements', 'companies.mvt');
  const asks = join(dir, 'movements', 'asks.mvt');
  writeFileSync(waits, WAITS_012);
  writeFileSync(asks, CALLBACK_012);

  const held = lf(dir, 'upgrade');
  assert.equal(held.code, 1, held.out);
  assert.equal(readFileSync(waits, 'utf8'), WAITS_012.replace('await first(company-[x:Comments WHERE x.Text == company.Name]->)', 'await company-[x:Comments WHERE x.Text == company.Name]->'));
  assert.match(held.out, /^movements\/asks\.mvt:7:8 error MOV_CALLBACK_RETIRED 'callback\(…\)' is retired in 0\.13\. For a form a person opens, connect `@lf\/forms`/m);
  assert.match(held.out, /^movements\/companies\.mvt:7:\d+ warning MOV_AWAIT_VALUE_CAPTURED 'company\.Name' in this wait's WHERE is read once/m);
  assert.match(held.out, /engine: left at 0\.12\.13 until the 1 remaining diagnostic\(s\) are fixed/);
  assert.match(held.out, /2 file\(s\), 1 rewritten, 1 left to change by hand/);
  assert.match(readFileSync(join(dir, 'lf.yaml'), 'utf8'), /^engine: 0\.12\.13$/m);

  rmSync(asks);
  const moved = lf(dir, 'upgrade');
  assert.equal(moved.code, 0, moved.out);
  assert.match(moved.out, /lf\.yaml: engine: 0\.13\.0 \(was 0\.12\.13\)/);
  assert.match(readFileSync(join(dir, 'lf.yaml'), 'utf8'), /^engine: 0\.13\.0$/m);

  const again = lf(dir, 'upgrade', '--check');
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, /1 file\(s\), 0 would be rewritten, 0 left to change by hand/);
});

// A wait no `sleep` races: from 0.13 a wait whose record is deleted never
// ends, where under 0.12 the code after it was skipped. Nothing to rewrite,
// so the upgrade lists it and the pin moves; one raced with a sleep is not told.
const UNRACED = `import { acme_crm } from adapters
import { acme } from credentials

crm = connect acme_crm using acme

function decide(company: <crm-[:Company]->>) {
  ask = write crm-[:Company]-> { Name: "Decide \${company.Name}" }
  a = await ask-[:Approvals]->
  write crm-[:Company]-> { Name: "Decided \${a.Decision}" }
}

listen to crm { events: ["company.created"] } fire decide
`;

test('upgrade lists an unraced await as a warning and still moves the pin', () => {
  const dir = project();
  pinned(dir, '0.12.13');
  const file = join(dir, 'movements', 'companies.mvt');
  writeFileSync(file, UNRACED);

  const { code, out } = lf(dir, 'upgrade');
  assert.equal(code, 0, out);
  assert.match(
    out,
    /^movements\/companies\.mvt:8:7 warning MOV_AWAIT_MAY_HANG 'await ask-\[:Approvals\]->' is not in a `race` with a `sleep`: from 0\.13 a wait whose record is deleted never ends \(under 0\.12\.13 the code after it was skipped\), so this run can wait forever\. Race it: `race\(\(\) => \{ return await ask-\[:Approvals\]-> \}, \(\) => \{ await sleep\(1d\) \}\)` — reviews#deleted-records$/m,
  );
  assert.match(out, /lf\.yaml: engine: 0\.13\.0 \(was 0\.12\.13\)/);
  assert.match(readFileSync(join(dir, 'lf.yaml'), 'utf8'), /^engine: 0\.13\.0$/m);
  assert.equal(readFileSync(file, 'utf8'), UNRACED);
  const checked = lf(dir, 'check');
  assert.equal(checked.code, 0, checked.out);
  assert.doesNotMatch(checked.out, /MOV_AWAIT_MAY_HANG/);

  const raced = project();
  pinned(raced, '0.12.13');
  writeFileSync(
    join(raced, 'movements', 'companies.mvt'),
    UNRACED.replace('  a = await ask-[:Approvals]->\n  write crm-[:Company]-> { Name: "Decided ${a.Decision}" }', '  r = race(() => { return await ask-[:Approvals]-> }, () => { await sleep(1d) })'),
  );
  const told = lf(raced, 'upgrade');
  assert.equal(told.code, 0, told.out);
  assert.doesNotMatch(told.out, /MOV_AWAIT_MAY_HANG/);
  assert.match(told.out, /lf\.yaml: engine: 0\.13\.0 \(was 0\.12\.13\)/);
});

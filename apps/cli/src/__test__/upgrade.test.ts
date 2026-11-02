// `listen-fire upgrade`, through the real binary entry point, on the example project
// (written in a retired spelling): `--check` shows the rewrite and writes
// nothing, `listen-fire upgrade` rewrites the file so `listen-fire check` is clean, and a second
// run changes nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fakeAffinity } from './affinity_fixture';
import { lf, project } from './example';
import { fakeChannels, gmailProject } from './gmail_fixture';
import { freePort, lf as lfAsked, ok } from './interactive';

const OLD = `import { acme_crm } from adapters
import { acme } from credentials

crm = acme_crm(credentials: acme)

# A company created in the CRM is welcomed at once — then followed up.
movement welcome(company: <crm-[:Company]->>) {
  write crm-[:Company]-> { Name: Text.concat("Welcome ", UPPER(company.Name)) }
  await sleep(1h)
}

listen to crm-[:Company]-> fire welcome
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

// A listen written as a traversal: a settings listen on acme, which maps no
// settings, would hold the pin (the last test here).
const asTraversal = (dir: string): void => {
  const file = join(dir, 'movements', 'companies.mvt');
  writeFileSync(file, readFileSync(file, 'utf8').replace('listen to crm { events: ["company.created"] } fire welcome', 'listen to crm-[:Company]-> fire welcome'));
};

test('listen-fire upgrade moves an older pin to the current release once the project validates clean', () => {
  const dir = project();
  pinned(dir, '0.11.0');
  asTraversal(dir);
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
// wait is reached. Nothing to rewrite, so the upgrade lists it and holds the
// pin until --all.
const CAPTURING = `import { acme_crm } from adapters
import { acme } from credentials

crm = connect acme_crm using acme

function welcome(company: <crm-[:Company]->>) {
  named = await company-[c:Comments WHERE c.Text == company.Name]->
}

listen to crm-[:Company]-> fire welcome
`;

test('listen-fire upgrade lists a wait whose run value is now captured, and holds the pin until --all', () => {
  const dir = project();
  pinned(dir, '0.12.13');
  const file = join(dir, 'movements', 'companies.mvt');
  writeFileSync(file, CAPTURING);

  const { code, out } = lf(dir, 'upgrade');
  assert.equal(code, 1, out);
  assert.match(
    out,
    /^movements\/companies\.mvt:7:17 warning MOV_AWAIT_VALUE_CAPTURED 'company\.Name' in this wait's WHERE is read once, when the wait is reached \(0\.13\); under 0\.12\.13 it was read again at every check, .* against `refresh\(company\)` \(see handbook: reviews#captured-values\)$/m,
  );
  assert.match(out, /^ {2}holds the pin: check it as the message says; `listen-fire upgrade --all` moves the pin once it is checked$/m);
  assert.match(out, /lf\.yaml: engine: left at 0\.12\.13 until the 2 warning\(s\) are checked/);
  assert.match(out, /1 file\(s\), 0 rewritten, 0 left to change by hand, 2 warning\(s\) to check/);
  assert.equal(readFileSync(file, 'utf8'), CAPTURING);
  assert.match(readFileSync(join(dir, 'lf.yaml'), 'utf8'), /^engine: 0\.12\.13$/m);

  const moved = lf(dir, 'upgrade', '--all');
  assert.equal(moved.code, 0, moved.out);
  assert.match(moved.out, /warning MOV_AWAIT_VALUE_CAPTURED/);
  assert.match(moved.out, /lf\.yaml: engine: 0\.13\.\d+(-[\w.]+)? \(was 0\.12\.13\)/);
  assert.match(readFileSync(join(dir, 'lf.yaml'), 'utf8'), /^engine: 0\.13\.\d+(-[\w.]+)?$/m);

  const checked = lf(dir, 'check');
  assert.equal(checked.code, 0, checked.out);
  assert.doesNotMatch(checked.out, /MOV_AWAIT_VALUE_CAPTURED/);
});

// An existing 0.12 program upgraded to 0.13: `await first(x)` is rewritten
// to `await x`; a `callback(…)` has no rewrite, so it is listed by file and
// line and holds the pin until the author replaces it; a wait whose WHERE
// reads a run record's field is listed as a warning and holds the pin until
// --all.
const WAITS_012 = `import { acme_crm } from adapters
import { acme } from credentials

crm = connect acme_crm using acme

function welcome(company: <crm-[:Company]->>) {
  c = await first(company-[x:Comments WHERE x.Text == company.Name]->)
}

listen to crm-[:Company]-> fire welcome
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
  const warned = lf(dir, 'upgrade');
  assert.equal(warned.code, 1, warned.out);
  assert.match(readFileSync(join(dir, 'lf.yaml'), 'utf8'), /^engine: 0\.12\.13$/m);
  const moved = lf(dir, 'upgrade', '--all');
  assert.equal(moved.code, 0, moved.out);
  assert.match(moved.out, /lf\.yaml: engine: 0\.13\.0 \(was 0\.12\.13\)/);
  assert.match(readFileSync(join(dir, 'lf.yaml'), 'utf8'), /^engine: 0\.13\.0$/m);

  const again = lf(dir, 'upgrade', '--check');
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, /1 file\(s\), 0 would be rewritten, 0 left to change by hand/);
});

// A wait no `sleep` races: from 0.13 a wait whose record is deleted never
// ends, where under 0.12 the code after it was skipped. Nothing to rewrite,
// so the upgrade lists it and holds the pin until --all; one raced with a sleep is not told.
const UNRACED = `import { acme_crm } from adapters
import { acme } from credentials

crm = connect acme_crm using acme

function decide(company: <crm-[:Company]->>) {
  ask = write crm-[:Company]-> { Name: "Decide \${company.Name}" }
  a = await ask-[:Approvals]->
  write crm-[:Company]-> { Name: "Decided \${a.Decision}" }
}

listen to crm-[:Company]-> fire decide
`;

test('upgrade lists an unraced await as a warning and holds the pin until --all', () => {
  const dir = project();
  pinned(dir, '0.12.13');
  const file = join(dir, 'movements', 'companies.mvt');
  writeFileSync(file, UNRACED);

  const { code, out } = lf(dir, 'upgrade');
  assert.equal(code, 1, out);
  assert.match(
    out,
    /^movements\/companies\.mvt:8:7 warning MOV_AWAIT_MAY_HANG 'await ask-\[:Approvals\]->' is not in a `race` with a `sleep`: from 0\.13 a wait whose record is deleted never ends \(under 0\.12\.13 the code after it was skipped\), so this run can wait forever\. Race it: `race\(\(\) => \{ return await ask-\[:Approvals\]-> \}, \(\) => \{ await sleep\(1d\) \}\)` — reviews#deleted-records$/m,
  );
  assert.match(out, /lf\.yaml: engine: left at 0\.12\.13 until the 1 warning\(s\) are checked/);
  assert.match(readFileSync(join(dir, 'lf.yaml'), 'utf8'), /^engine: 0\.12\.13$/m);
  assert.equal(readFileSync(file, 'utf8'), UNRACED);
  const moved = lf(dir, 'upgrade', '--all');
  assert.equal(moved.code, 0, moved.out);
  assert.match(moved.out, /lf\.yaml: engine: 0\.13\.0 \(was 0\.12\.13\)/);
  assert.match(readFileSync(join(dir, 'lf.yaml'), 'utf8'), /^engine: 0\.13\.0$/m);
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

// A 0.12 settings listen on a module that declares what its settings become
// (alerts_module): the upgrade rewrites the listen into the traversal and the
// fired function's parameter into the edge it lands on, the project checks
// clean on 0.13, and a second run changes nothing.
const ALERTS_012 = `import { alerts } from adapters

gh = connect alerts

# Mentions and assignments, triaged.
function triage(n: <gh-[:Notification]->>) {
  return n.Title
}

listen to gh { events: ["mention", "assign"] } fire triage
`;

test('listen-fire upgrade rewrites a 0.12 listen and its parameter, and a second run changes nothing', () => {
  const dir = project();
  pinned(dir, '0.12.13');
  const folder = join(dir, 'externals/alerts');
  mkdirSync(folder);
  copyFileSync(resolve(__dirname, 'alerts_module/serve.mjs'), join(folder, 'serve.mjs'));
  writeFileSync(join(folder, 'lf-external.yaml'), 'name: alerts\nkind: adapter\ncommand: [node, serve.mjs]\n');
  rmSync(join(dir, 'movements', 'companies.mvt'));
  const file = join(dir, 'movements', 'alerts.mvt');
  writeFileSync(file, ALERTS_012);

  const upgraded = lf(dir, 'upgrade');
  assert.equal(upgraded.code, 0, upgraded.out);
  assert.equal(
    readFileSync(file, 'utf8'),
    ALERTS_012.replace('<gh-[:Notification]->>', '<gh-[:Notifications]->>').replace(
      'listen to gh { events: ["mention", "assign"] } fire triage',
      'listen to gh-[n:Notifications WHERE n.Reason IN ["mention", "assign"]]-> fire triage',
    ),
  );
  assert.match(upgraded.out, /lf\.yaml: engine: 0\.13\.0 \(was 0\.12\.13\)/);

  const checked = lf(dir, 'check');
  assert.equal(checked.code, 0, checked.out);
  assert.doesNotMatch(checked.out, /MOV_LISTEN_SETTINGS_RETIRED/);

  const again = lf(dir, 'upgrade', '--check');
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, /1 file\(s\), 0 would be rewritten, 0 left to change by hand/);
});

test('listen-fire upgrade holds the pin on a settings listen it cannot rewrite, naming the traversal to write', () => {
  const dir = project();
  const companies = join(dir, 'movements', 'companies.mvt');
  const traversal = readFileSync(companies, 'utf8');
  const settings = traversal.replace('listen to crm-[:Company]-> fire welcome', 'listen to crm { events: ["company.created"] } fire welcome');
  assert.notEqual(settings, traversal, "the example's listen changed; update this test");
  writeFileSync(companies, settings);
  pinned(dir, '0.12.13');
  const { code, out } = lf(dir, 'upgrade');
  assert.equal(code, 1, out);
  assert.match(
    out,
    /^movements\/companies\.mvt:13:1 error MOV_LISTEN_SETTINGS_RETIRED `listen to crm \{ … \}` is retired in 0\.13: a listen is a traversal ending on the edge its events arrive on\. Write `listen to crm-\[:…\]-> fire welcome`$/m,
  );
  assert.match(out, /engine: left at 0\.12\.13 until the 1 remaining diagnostic\(s\) are fixed/);
});

/** The example project with `name.mvt` its only movement; `upgradesTo`
 *  pins it 0.12.13 first. */
function only012(name: string, source: string): { dir: string; file: string } {
  const dir = project();
  rmSync(join(dir, 'movements', 'companies.mvt'));
  const file = join(dir, 'movements', `${name}.mvt`);
  writeFileSync(file, source);
  return { dir, file };
}

/** `dir` upgraded to `expected`, which checks clean, and a second run changes nothing. */
function upgradesTo(dir: string, file: string, expected: string): void {
  pinned(dir, '0.12.13');
  const upgraded = lf(dir, 'upgrade');
  assert.equal(upgraded.code, 0, upgraded.out);
  assert.equal(readFileSync(file, 'utf8'), expected);
  assert.match(upgraded.out, /lf\.yaml: engine: 0\.13\.0 \(was 0\.12\.13\)/);
  const checked = lf(dir, 'check');
  assert.equal(checked.code, 0, checked.out);
  assert.doesNotMatch(checked.out, /MOV_LISTEN_SETTINGS_RETIRED/);
  assert.match(lf(dir, 'upgrade', '--check').out, /1 file\(s\), 0 would be rewritten, 0 left to change by hand/);
}

test('upgrade rewrites `listen to cron { schedule, timezone }` and `listen to manual fire f`', () => {
  const units = [
    'function tock(t: <cron-[:Tick]->>) {',
    '  return t.Schedule',
    '}',
    'function hello(run: <manual-[:Invocation]->>) {',
    '  return run.Text',
    '}',
    'listen to cron { schedule: "0 9 * * 1-5", timezone: "Europe/London" } fire tock',
    'listen to manual fire hello',
    '',
  ].join('\n');
  const { dir, file } = only012('units', units);
  upgradesTo(
    dir,
    file,
    units
      .replace('<cron-[:Tick]->>', '<cron-[:Ticks]->>')
      .replace('<manual-[:Invocation]->>', '<manual-[:Invocations]->>')
      .replace('listen to cron { schedule: "0 9 * * 1-5", timezone: "Europe/London" } fire tock', 'listen to cron-[t:Ticks WHERE t.Schedule == "0 9 * * 1-5" AND t.Zone == "Europe/London"]-> fire tock')
      .replace('listen to manual fire hello', 'listen to manual-[:Invocations]-> fire hello'),
  );
});

test('upgrade rewrites an email listen by its plus-suffix lowercased, one with no key to the box itself, and holds the pin on a key no address carries', async () => {
  const intake = (listen: string) =>
    ['import { email } from adapters', '', 'inbox = connect email', '', 'function deal(m: <inbox-[:Email]->>) {', '  return m.Subject', '}', listen, ''].join('\n');
  const { dir, file } = only012('intake', intake('listen to inbox { key: "deals" } fire deal'));
  await ok(lfAsked(dir, ['connect', '@lf/email', '--webhook-secret', 'mailgun-signing-key'], { answers: [''] }));
  const becomes = (where: string) => intake(`listen to inbox-[e:Emails WHERE ${where}]-> fire deal`).replace('<inbox-[:Email]->>', '<inbox-[:Emails]->>');
  upgradesTo(dir, file, becomes('e.Key == "deals"'));
  // 0.12 compared a key without case, and a key holds what a plus-suffix can.
  for (const [written, compared] of [
    ['Deals', 'deals'],
    ['deals_q3', 'deals_q3'],
  ]) {
    writeFileSync(file, intake(`listen to inbox { key: "${written}" } fire deal`));
    upgradesTo(dir, file, becomes(`e.Key == "${compared}"`));
  }
  // A listen with no key heard mail sent to the box itself: its key is "".
  writeFileSync(file, intake('listen to inbox {} fire deal'));
  upgradesTo(dir, file, becomes('e.Key == ""'));
  // A key no address carries has no rewrite: the pin holds, naming the field to bound.
  pinned(dir, '0.12.13');
  writeFileSync(file, intake('listen to inbox { key: "deals desk" } fire deal'));
  const held = lf(dir, 'upgrade');
  assert.equal(held.code, 1, held.out);
  assert.match(held.out, /MOV_LISTEN_SETTINGS_RETIRED .*Write `listen to inbox-\[e:Emails WHERE e\.Key == "…"\]-> fire deal` \(there is no rewrite: "deals desk" is not an InboxKey: it does not match /);
  assert.match(held.out, /engine: left at 0\.12\.13/);
});

test('upgrade rewrites a webhook listen’s payload as the type stated after its traversal', async () => {
  const payments = [
    'import { webhook } from adapters',
    'import { StripeHook } from credentials',
    '',
    'stripe = connect webhook using StripeHook',
    '',
    'node Payment {',
    '  id: <text>',
    '  amount: <number>',
    '}',
    '',
    'function paid(e: <Payment>) {',
    '  return e.amount',
    '}',
    'listen to stripe { payload: <Payment> } fire paid',
    '',
  ].join('\n');
  const { dir, file } = only012('payments', payments);
  await ok(lfAsked(dir, ['connect', '@lf/webhook', '--yes'], { answers: [] }));
  await ok(lfAsked(dir, ['credential', 'add', '--module', 'webhook', 'StripeHook'], { answers: ['none', '', '', '', ''] }));
  upgradesTo(dir, file, payments.replace('listen to stripe { payload: <Payment> } fire paid', 'listen to stripe-[:Requests]-><Payment> fire paid'));
});


/** A polled module installed in a project with a key for it, as a person adds one:
 *  `listen-fire connect`, then `credential add` answering the API key and no base URL. */
async function withKey(dir: string, module: string, key: string): Promise<void> {
  await ok(lfAsked(dir, ['connect', `@lf/${module}`, '--yes'], { answers: [] }));
  await ok(lfAsked(dir, ['credential', 'add', '--module', module, key], { answers: ['test-key', ''] }));
}

const polled = (system: string, key: string, parameter: string, listen: string) =>
  [
    `import { ${system} } from adapters`,
    `import { ${key} } from credentials`,
    '',
    `source = connect ${system} using ${key}`,
    '',
    `function triage(row: <source-[:${parameter}]->>) {`,
    '  return "seen"',
    '}',
    listen,
    '',
  ].join('\n');

test('upgrade rewrites a granola listen by its folder lowercased, and holds the pin for an `every` until --all', async () => {
  const old = polled('granola', 'granola_key', 'Meeting Note', 'listen to source { folder: "Deals", every: 10m } fire triage');
  const { dir, file } = only012('notes', old);
  await withKey(dir, 'granola', 'granola_key');
  pinned(dir, '0.12.13');

  // `every` is gone: the rewrite changes what the listen means, so only --all applies it.
  const held = lf(dir, 'upgrade');
  assert.equal(held.code, 1, held.out);
  assert.match(held.out, /Write `listen to source-\[n:Meetings WHERE n\.Folders CONTAINS "deals"\]-> fire triage` \(`every` is gone: the module sets the interval; set `pollEvery` for this connection in lf\.yaml\)/);
  assert.equal(readFileSync(file, 'utf8'), old);

  const upgraded = lf(dir, 'upgrade', '--all');
  assert.equal(upgraded.code, 0, upgraded.out);
  assert.equal(
    readFileSync(file, 'utf8'),
    old
      .replace('<source-[:Meeting Note]->>', '<source-[:Meetings]->>')
      .replace('listen to source { folder: "Deals", every: 10m } fire triage', 'listen to source-[n:Meetings WHERE n.Folders CONTAINS "deals"]-> fire triage'),
  );
  assert.equal(lf(dir, 'check').code, 0);
  assert.match(lf(dir, 'upgrade', '--check').out, /1 file\(s\), 0 would be rewritten, 0 left to change by hand/);
});

test('upgrade rewrites a dealroom listen: rounds, industries and locations each a comparison on the round', async () => {
  const old = polled('dealroom', 'dealroom_key', 'Funding Round', 'listen to source { rounds: ["SERIES A", "SEED"], industries: ["fintech"], hq_locations: ["Germany"] } fire triage');
  const { dir, file } = only012('rounds', old);
  await withKey(dir, 'dealroom', 'dealroom_key');
  upgradesTo(
    dir,
    file,
    old
      .replace('<source-[:Funding Round]->>', '<source-[:`Funding Rounds`]->>')
      .replace(
        'listen to source { rounds: ["SERIES A", "SEED"], industries: ["fintech"], hq_locations: ["Germany"] } fire triage',
        'listen to source-[r:`Funding Rounds` WHERE r.Round IN ["SERIES A", "SEED"] AND r.`Company Industries` CONTAINS "fintech" AND r.`Company Locations` CONTAINS "Germany"]-> fire triage',
      ),
  );

  // A listen that narrowed nothing heard every new round; naming its one
  // event is the same listen; several terms are Dealroom's to match any of.
  const retyped = (listen: string) => polled('dealroom', 'dealroom_key', 'Funding Round', listen).replace('<source-[:Funding Round]->>', '<source-[:`Funding Rounds`]->>');
  writeFileSync(file, polled('dealroom', 'dealroom_key', 'Funding Round', 'listen to source {} fire triage'));
  upgradesTo(dir, file, retyped('listen to source-[:`Funding Rounds`]-> fire triage'));
  writeFileSync(file, polled('dealroom', 'dealroom_key', 'Funding Round', 'listen to source { events: ["funding_round"], hq_locations: ["Europe", "US"] } fire triage'));
  upgradesTo(dir, file, retyped('listen to source-[r:`Funding Rounds` WHERE r.`Company Locations` CONTAINS "Europe" OR r.`Company Locations` CONTAINS "US"]-> fire triage'));
});

test('upgrade rewrites an evertrace listen onto the edge its event arrives on, and holds the pin on one naming both', async () => {
  const signals = polled('evertrace', 'evertrace_key', 'Signal', 'listen to source { search: "Stealth in Europe" } fire triage');
  const { dir, file } = only012('signals', signals);
  await withKey(dir, 'evertrace', 'evertrace_key');
  upgradesTo(
    dir,
    file,
    signals
      .replace('<source-[:Signal]->>', '<source-[:Signals]->>')
      .replace(
        'listen to source { search: "Stealth in Europe" } fire triage',
        'listen to source-[s:Signals WHERE s.`Saved Search` == "Stealth in Europe"]-> fire triage',
      ),
  );

  // A list entry is its own edge, with its own landing.
  const entries = polled('evertrace', 'evertrace_key', 'List Entry', 'listen to source { events: ["list_entry"], list: "Pipeline" } fire triage');
  writeFileSync(file, entries);
  upgradesTo(
    dir,
    file,
    entries
      .replace('<source-[:List Entry]->>', '<source-[:`List Entries`]->>')
      .replace(
        'listen to source { events: ["list_entry"], list: "Pipeline" } fire triage',
        'listen to source-[e:`List Entries` WHERE e.`List Name` == "Pipeline"]-> fire triage',
      ),
  );

  // Both events arrive on two edges: there is no one listen to rewrite it to.
  const both = polled('evertrace', 'evertrace_key', 'Signal', 'listen to source { events: ["signal", "list_entry"] } fire triage');
  writeFileSync(file, both);
  pinned(dir, '0.12.13');
  const held = lf(dir, 'upgrade');
  assert.equal(held.code, 1, held.out);
  assert.match(held.out, /MOV_LISTEN_SETTINGS_RETIRED .*there is no rewrite: its events arrive on `Signals` and `List Entries`, so write one listen for each/);
  assert.match(held.out, /engine: left at 0\.12\.13/);
  assert.equal(readFileSync(file, 'utf8'), both);
});

// ── The 0.13 docs' listens ───────────────────────────────────────────────────
//
// Every listen the migration guide's "Listens are traversals" shows as a 0.13
// form, with the parameter it gives the fired function, and every program in
// that section and in the handbook's listeners chapter, checked by
// `listen-fire check` against the real module it names: a doc that teaches a
// listen the checker refuses is caught here, not by a reader.

const REPO = resolve(__dirname, '../../../..');
const GUIDE = readFileSync(join(REPO, 'docs/language/migrating-to-0.13.md'), 'utf8');
const LISTENS_SECTION = GUIDE.slice(GUIDE.indexOf('## 8. Listens are traversals'), GUIDE.indexOf('## 9. '));
const LUNCH_POLL = readFileSync(join(__dirname, 'movements/lunch_poll/lunch_poll.mvt'), 'utf8');
const PROGRAM_FENCE = /^```\n(import \{[\s\S]*?)^```$/gm;

/** Each connection the guide's listens start at, by the module heading it is
 *  under: the lines that import and construct it in the probe's project. */
const CONNECTIONS: Record<string, Record<string, string>> = {
  cron: { cron: '' },
  manual: { manual: '' },
  '@lf/email': { inbox: 'import { `@lf/email` as email } from adapters\n\ninbox = connect email\n' },
  '@lf/webhook': {
    hooks: 'import { `@lf/webhook` as webhook } from adapters\nimport { hook_key } from credentials\n\nhooks = connect webhook using hook_key\n\nnode Payment {\n  id: <text>\n  amount: <number>\n}\n',
  },
  '@lf/github': { gh: 'import { `@lf/github` as github } from adapters\nimport { gh_key } from credentials\n\ngh = connect github using gh_key\n' },
  '@lf/gmail': { mail: 'import { `@lf/gmail` as gmail } from adapters\nimport { mail_key } from credentials\n\nmail = connect gmail using mail_key\n' },
  '@lf/granola': { notes: 'import { `@lf/granola` as granola } from adapters\nimport { notes_key } from credentials\n\nnotes = connect granola using notes_key\n' },
  '@lf/dealroom': { rounds: 'import { `@lf/dealroom` as dealroom } from adapters\nimport { rounds_key } from credentials\n\nrounds = connect dealroom using rounds_key\n' },
  '@lf/evertrace': { signals: 'import { `@lf/evertrace` as evertrace } from adapters\nimport { signals_key } from credentials\n\nsignals = connect evertrace using signals_key\n' },
  '@lf/stripe': { pay: 'import { `@lf/stripe` as stripe } from adapters\nimport { pay_account } from credentials\n\npay = connect stripe using pay_account\n' },
  '@lf/attio': { crm: 'import { `@lf/attio` as attio } from adapters\nimport { crm_attio } from credentials\n\ncrm = connect attio using crm_attio\n' },
  '@lf/affinity': { crm: 'import { affinity } from adapters\nimport { crm_affinity } from credentials\n\ncrm = connect affinity using crm_affinity\n' },
  '@lf/telegram': {
    tg: 'import { `@lf/telegram` as telegram } from adapters\nimport { tg_bot } from credentials\n\ntg = connect telegram using tg_bot\n',
    wa: 'import { `@lf/whatsapp` as whatsapp } from adapters\nimport { wa_number } from credentials\n\nwa = connect whatsapp using wa_number\n',
  },
  '@lf/airtable': { hiring: 'import { `@lf/airtable` as airtable } from adapters\nimport { team_airtable } from credentials\n\nhiring = connect airtable using team_airtable { base: "Hiring" }\n' },
  '@lf/slack': { chat: 'import { `@lf/slack` as slack } from adapters\nimport { team_slack } from credentials\n\nchat = connect slack using team_slack\n' },
  '@lf/system': { sys: 'import { `@lf/system` as system } from adapters\n\nsys = connect system\n' },
};

interface Example {
  where: string;
  source: string;
}

/** Each listen the section shows with its parameter, as a whole program. */
function guideListens(): Example[] {
  const examples: Example[] = [];
  for (const block of LISTENS_SECTION.split(/^#### /m).slice(1)) {
    const heading = /^`([^`]+)`/.exec(block)?.[1];
    assert.ok(heading !== undefined, block.slice(0, 80));
    const connections = CONNECTIONS[heading];
    assert.ok(connections !== undefined, `no connection for the guide's ${heading}`);
    const shown = [...block.matchAll(/(``|`)(listen to .+?)\1, parameter (``|`)(.+?)\3/g)];
    // Every 0.13 line is one the probe reads: none slips past the pattern.
    const thirteens = block.split('\n').filter((line) => line.startsWith('- 0.13'));
    assert.equal(shown.filter((m) => thirteens.some((line) => line.includes(m[0]))).length, thirteens.length, `${heading}: ${thirteens.join('\n')}`);
    for (const [, , listen, , parameter] of shown) {
      const instance = /^listen to (\w+)/.exec(listen)?.[1] ?? '';
      const fired = /fire (\w+)$/.exec(listen)?.[1];
      assert.ok(connections[instance] !== undefined && fired !== undefined, `${heading}: ${listen}`);
      examples.push({ where: `${heading}: ${listen}`, source: `${connections[instance]}\nfunction ${fired}(x: ${parameter}) {\n  return "seen"\n}\n\n${listen}\n` });
    }
  }
  return examples;
}

/** The whole programs the section and the listeners chapter show. */
function shownPrograms(): Example[] {
  const chapter: unknown = Reflect.get(require(join(REPO, 'packages/handbook/chapters/listeners.ts')), 'listeners');
  const content = String(Reflect.get(chapter as object, 'content'));
  const claims: unknown = Reflect.get(chapter as object, 'engineClaims');
  const probes = Array.isArray(claims) ? claims.map((claim: unknown) => String(Reflect.get(claim as object, 'probe'))) : [];
  return [
    ...[...LISTENS_SECTION.matchAll(PROGRAM_FENCE)].map((m, i) => ({ where: `guide program ${i + 1}`, source: m[1] })),
    ...[...content.matchAll(PROGRAM_FENCE)].map((m, i) => ({ where: `listeners chapter program ${i + 1}`, source: m[1] })),
    ...probes.map((probe, i) => ({ where: `listeners chapter probe ${i + 1}`, source: probe.replace(/\bacme\b/g, 'crm_attio') })),
  ];
}

/** A project with every module the guide's listens name connected: the ones
 *  that read their workspace (Slack, Airtable, Attio, Gmail) to fake-channels,
 *  Affinity to its own fake, the rest with test keys. */
async function listensProject(fake: { url: string }, affinity: { url: string }): Promise<string> {
  const F = fake.url;
  const seeded = await fetch(`${F}/admin/airtable/seed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      entities: [
        { entity_type: 'base', id: 'appOFFICE', data: { id: 'appOFFICE', name: 'Office' } },
        {
          entity_type: 'table:appOFFICE',
          id: 'tblLUNCH',
          data: {
            id: 'tblLUNCH',
            name: 'Lunch',
            primaryFieldId: 'fldPoll',
            fields: ['Poll', 'Person Id', 'Person', 'Answer'].map((name) => ({ id: `fld${name.replace(' ', '')}`, name, type: 'singleLineText' })),
          },
        },
        { entity_type: 'base', id: 'appHIRE01', data: { id: 'appHIRE01', name: 'Hiring' } },
        {
          entity_type: 'table:appHIRE01',
          id: 'tblCAND01',
          data: {
            id: 'tblCAND01',
            name: 'Candidates',
            primaryFieldId: 'fldCName',
            fields: [
              { id: 'fldCName', name: 'Name', type: 'singleLineText' },
              { id: 'fldStage', name: 'Stage', type: 'singleSelect', options: { choices: [{ id: 'selApplied', name: 'Applied' }, { id: 'selInterview', name: 'Interview' }] } },
            ],
          },
        },
      ],
    }),
  });
  assert.equal(seeded.status, 200, await seeded.text());

  const { dir } = await gmailProject(fake as Parameters<typeof gmailProject>[0], 'gmail', 'mail_key');
  await ok(lfAsked(dir, ['connect', '@lf/email', '--webhook-secret', 'mailgun-signing-key'], { answers: [''] }));
  await ok(lfAsked(dir, ['connect', '@lf/webhook', '--yes'], { answers: [] }));
  await ok(lfAsked(dir, ['credential', 'add', '--module', 'webhook', 'hook_key'], { answers: ['none', '', '', '', ''] }));
  for (const [module, key] of [
    ['github', 'gh_key'],
    ['granola', 'notes_key'],
    ['dealroom', 'rounds_key'],
    ['evertrace', 'signals_key'],
  ]) {
    await ok(lfAsked(dir, ['connect', `@lf/${module}`, '--yes'], { answers: [] }));
    await ok(lfAsked(dir, ['credential', 'add', '--module', module, key], { answers: ['test-key', ''] }));
  }
  await ok(lfAsked(dir, ['connect', '@lf/stripe', '--yes', '--base-url', F], { answers: [] }));
  await ok(lfAsked(dir, ['credential', 'add', '--module', 'stripe', 'pay_account'], { answers: ['rk_test_docs', 'whsec_docs'] }));
  await ok(lfAsked(dir, ['connect', '@lf/telegram', '--yes', '--webhook-secret', 'tok'], { answers: [] }));
  await ok(lfAsked(dir, ['credential', 'add', '--module', 'telegram', 'tg_bot', '--credential', 'telegram'], { answers: ['123:BOT', ''] }));
  await ok(lfAsked(dir, ['connect', '@lf/whatsapp', '--yes', '--webhook-secret', 'meta-app-secret'], { answers: [] }));
  await ok(lfAsked(dir, ['credential', 'add', '--module', 'whatsapp', 'wa_number', '--credential', 'whatsapp'], { answers: ['EAAtoken', 'PN-1', '', '', '', ''] }));
  await ok(lfAsked(dir, ['connect', '@lf/system', '--yes']));
  await ok(lfAsked(dir, ['connect', '@lf/slack', '--yes', '--webhook-secret', 'slack-signing-secret']));
  await ok(lfAsked(dir, ['credential', 'add', '--module', '@lf/slack', 'team_slack'], { answers: ['xoxb-test', '', '', `${F}/slack/`] }));
  await ok(lfAsked(dir, ['connect', '@lf/attio', '--yes']));
  await ok(lfAsked(dir, ['credential', 'add', '--module', '@lf/attio', 'crm_attio', '--credential', 'attio_token'], { answers: ['attio-test-token', `${F}/attio`] }));
  await ok(
    lfAsked(dir, ['connect', '@lf/airtable', '--yes', '--base-url', `${F}/airtable`, '--oauth-authorize-url', `${F}/oauth/authorize`, '--oauth-token-url', `${F}/oauth/token`, '--client-id', 'lf-airtable-app', '--client-secret', 'lf-airtable-secret', '--redirect-port', '0']),
  );
  const adding = lfAsked(dir, ['credential', 'add', '--module', '@lf/airtable', 'team_airtable', '--credential', 'airtable', '--headless', '--redirect-port', String(await freePort())], { answers: ['', ''] });
  const authorize = (await adding.line(/^\s+http:\/\/127\.0\.0\.1:\d+\/oauth\/authorize\?/)).trim();
  const location = (await fetch(authorize, { redirect: 'manual' })).headers.get('location');
  assert.ok(location !== null);
  await adding.line(/paste the URL your browser was sent back to/);
  adding.answer(location);
  await ok(adding);
  // Affinity installed as its own tests install it: from the module's folder, keyed to its fake.
  mkdirSync(join(dir, 'externals/affinity'), { recursive: true });
  writeFileSync(join(dir, 'externals/affinity/lf-external.yaml'), `name: affinity\nkind: adapter\nprotocol: 2\nmodule: ${join(REPO, 'modules/affinity')}\n`);
  const secrets = join(dir, '.lf/secrets.yaml');
  writeFileSync(secrets, `${readFileSync(secrets, 'utf8')}crm_affinity:\n  module: affinity\n  credential: affinity\n  apiKey: test-key\n  baseUrl: ${affinity.url}\n`);
  chmodSync(secrets, 0o600);
  rmSync(join(dir, 'movements'), { recursive: true, force: true });
  mkdirSync(join(dir, 'movements'));
  return dir;
}

test("migration guide's listen examples check clean", async () => {
  const listens = guideListens();
  assert.ok(listens.length >= 24, `${listens.length} listens`);
  const programs = shownPrograms();
  // The guide's lunch poll is the checked one, verbatim.
  assert.ok(programs.some((p) => p.source === LUNCH_POLL), 'the guide shows lunch_poll.mvt verbatim');

  const fake = await fakeChannels();
  const affinity = await fakeAffinity(mkdtempSync(join(tmpdir(), 'lf-docs-affinity-')));
  try {
    const dir = await listensProject(fake, affinity);
    const file = join(dir, 'movements', 'shown.mvt');
    const refused: string[] = [];
    for (const { where, source } of [...listens, ...programs]) {
      writeFileSync(file, source);
      const checked = lf(dir, 'check');
      if (checked.code !== 0) refused.push(`${where}\n${source}\n${checked.out}`);
    }
    assert.deepEqual(refused, []);
  } finally {
    await affinity.stop();
    await fake.stop();
  }
});

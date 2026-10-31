// `@lf/forms` end to end: a form is an ordinary module a program imports and
// connects. When a company arrives, the fixture (movements/forms/refund.mvt)
// writes a form whose `Fields` is the `Refund` node, writes "Open <Url>" to
// the fake CRM, and races `await form-[:Submissions]->` with a day's sleep.
// The link is the module's door under `listen-fire serve`: a GET describes the
// form, a POST answers it once, and the answer resumes the run typed by
// `Refund`. Nothing in the engine or the checker knows a form: the edge says
// its landing is typed by the node its write's `Fields` names.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { companies, externalPort, lf as lfSync, project, served, type Served } from './example';
import { lf, ok } from './interactive';

// A workspace-built listen-fire finds its bundled modules beside its own
// (canonical) path; a worktree's listen-fire may be the main checkout's, so the
// modules and serve-module this tree holds are named.
const REPO = resolve(__dirname, '../../../..');
process.env.LF_MODULES_DIR ??= join(REPO, 'modules');
process.env.LF_SERVE_MODULE ??= join(REPO, 'apps/cli/node_modules/.bin/serve-module');

interface World {
  dir: string;
  serving: Served;
  /** The form's link, once the run has written it to the CRM. */
  link: string;
}

/** The fixture's project with `@lf/forms` connected, served, and a company
 *  arrived, so the run has made its form and parked on its answer. */
async function parkedOnAForm(): Promise<World> {
  const dir = project('forms');
  assert.match(await ok(lf(dir, ['connect', '@lf/forms', '--yes'])), /installed @lf\/forms/);
  const serving = await served(dir);
  try {
    const crm = `http://127.0.0.1:${externalPort(dir)}`;
    const arrived = await fetch(`${crm}/dev/companies`, { method: 'POST', body: JSON.stringify({ Name: 'Osprey' }) });
    assert.equal(arrived.status, 200, await arrived.text());
    await serving.waitFor(/run .* refund:ask parked/);
    const opened = companies(dir).find((name) => name.startsWith('Open '));
    assert.ok(opened, `the run wrote the form's link: ${companies(dir).join(', ')}`);
    return { dir, serving, link: opened.slice('Open '.length) };
  } catch (error) {
    await serving.stop();
    throw error;
  }
}

async function get(link: string, accept: string): Promise<{ status: number; type: string; body: string }> {
  const response = await fetch(link, { headers: { accept } });
  return { status: response.status, type: response.headers.get('content-type') ?? '', body: await response.text() };
}

async function post(link: string, body: string, contentType = 'application/json'): Promise<{ status: number; body: string }> {
  const response = await fetch(link, { method: 'POST', headers: { 'content-type': contentType, accept: 'application/json' }, body });
  return { status: response.status, body: await response.text() };
}

test('GET as JSON describes the fields; as a browser it is a form that posts back', async () => {
  const { serving, link } = await parkedOnAForm();
  try {
    assert.match(link, new RegExp(`^http://127\\.0\\.0\\.1:${serving.port}/api/public/webhook-sync/forms/forms\\?form=[A-Za-z0-9_-]{24}$`));
    const described = await get(link, 'application/json');
    assert.equal(described.status, 200, described.body);
    assert.deepEqual(JSON.parse(described.body), {
      title: 'Approve the refund for Osprey?',
      fields: { Approve: { type: 'boolean', required: true }, Note: { type: 'text', required: false } },
    });
    const page = await get(link, 'text/html');
    assert.equal(page.status, 200, page.body);
    assert.match(page.type, /^text\/html/);
    assert.match(page.body, /<form method="post" action="">/);
    assert.match(page.body, /name="Approve" value="true"/);
    assert.match(page.body, /name="Note"/);
    const elsewhere = await get(link.replace(/form=[^&]+/, 'form=nope'), 'application/json');
    assert.equal(elsewhere.status, 404, elsewhere.body);
  } finally {
    await serving.stop();
  }
});

test('a post of the wrong type is refused naming the field and records nothing', async () => {
  const { dir, serving, link } = await parkedOnAForm();
  try {
    const refused = await post(link, JSON.stringify({ Approve: 'yes' }));
    assert.equal(refused.status, 400, refused.body);
    assert.deepEqual(JSON.parse(refused.body), { outcome: 'mismatch', message: "'Approve' must be true or false" });
    assert.match(refused.body, /'Approve' must be true or false/);
    const runs = await ok(lf(dir, ['runs']));
    assert.match(runs, /parked/, 'the run still waits');
    assert.ok(!companies(dir).some((name) => name.startsWith('Approved')), 'nothing was recorded');
  } finally {
    await serving.stop();
  }
});

test('a valid post resumes the run with typed values; a second post is answered', async () => {
  const { dir, serving, link } = await parkedOnAForm();
  try {
    const recorded = await post(link, JSON.stringify({ Approve: true, Note: 'ok' }));
    assert.equal(recorded.status, 200, recorded.body);
    assert.deepEqual(JSON.parse(recorded.body), { outcome: 'recorded' });
    await serving.waitFor(/resumed .* refund:ask completed/);
    assert.deepEqual(companies(dir).slice(-1), ['Approved true ok']);
    // The same answer sent again (its sender never heard back) is the same
    // delivery: the door acknowledges it as a repeat and nothing runs.
    const repeated = await post(link, JSON.stringify({ Approve: true, Note: 'ok' }));
    assert.equal(repeated.status, 200, repeated.body);
    assert.equal(JSON.parse(repeated.body).duplicate, true, repeated.body);
    const again = await post(link, 'Approve=false', 'application/x-www-form-urlencoded');
    assert.equal(again.status, 410, again.body);
    assert.deepEqual(JSON.parse(again.body), { outcome: 'answered' });
    assert.deepEqual(companies(dir).slice(-1), ['Approved true ok'], 'the second answer ran nothing');
  } finally {
    await serving.stop();
  }
});

test('listen-fire check types the answer by the node the write names', async () => {
  const dir = project('forms');
  assert.match(await ok(lf(dir, ['connect', '@lf/forms', '--yes'])), /installed @lf\/forms/);
  const fixture = readFileSync(join(dir, 'movements/refund.mvt'), 'utf8');
  const clean = lfSync(dir, 'check');
  assert.equal(clean.code, 0, clean.out);
  const awaited = fixture.slice(0, fixture.indexOf('  r = race(')) + '  s = await form-[:Submissions]->\n  if (s.Note == 1) { fail("no") }\n}\n\nlisten to crm {} fire ask\n';
  writeMovement(dir, awaited);
  const said = lfSync(dir, 'check');
  assert.equal(said.code, 1, said.out);
  assert.match(said.out, /MOV_COMPARE_TYPE_MISMATCH .*Can't compare a text to a number/);
  writeMovement(dir, fixture.replace('Fields: Refund', 'Fields: { Approve: true }'));
  const unshaped = lfSync(dir, 'check');
  assert.equal(unshaped.code, 1, unshaped.out);
  assert.match(unshaped.out, /MOV_ANSWER_SHAPE .*'Fields' names the answer's shape: a node declared in this file/);
});

function writeMovement(dir: string, source: string): void {
  writeFileSync(join(dir, 'movements/refund.mvt'), source);
}

// Ruling: a form is an ordinary adapter. The engine, the checker, the parser
// and the host never name it: no `@lf/forms`, no `forms` or `form` as a
// quoted name, and no `Forms`, `Form`, `Submissions` or `Submission` as a type
// or edge name in their code.
test('nothing in the engine or checker names forms', () => {
  const named = /@lf\/forms|["'`](forms|form)["'`]|["'`:](Forms|Form|Submissions|Submission)["'`\]]|-\[:?\w*:(Forms|Submissions)/;
  // Where the word means something else: a Unicode normalization form, and
  // the form a built-in's call is written in. Each is still there.
  const unrelated: Array<{ file: string; line: string }> = [
    { file: 'movement-engine/src/env_services.rs', line: '"form": form' },
    { file: 'movement-engine/src/env_services.rs', line: 'text("form")' },
    { file: 'movement-engine/src/extract/call.rs', line: 'shape.set("form", Js::str("call"))' },
    { file: 'movement-checker/src/families/calls.rs', line: "/// A built-in's `form`: how a call of it is read." },
  ];
  const excused = new Set<(typeof unrelated)[number]>();
  const read: string[] = [];
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith('.rs')) {
        read.push(path);
        readFileSync(path, 'utf8')
          .split('\n')
          .forEach((line, i) => {
            if (!named.test(line)) return;
            const excuse = unrelated.find((u) => path.endsWith(u.file) && line.includes(u.line));
            if (excuse) excused.add(excuse);
            else found.push(`${path}:${i + 1}: ${line.trim()}`);
          });
      }
    }
  };
  const crates = join(REPO, 'crates');
  for (const crate of readdirSync(crates)) {
    const src = join(crates, crate, 'src');
    if (statSync(join(crates, crate)).isDirectory() && readdirSync(join(crates, crate)).includes('src')) walk(src);
  }
  // The walk read the crates' code, the answer's shape among it.
  assert.ok(read.includes(join(crates, 'movement-checker/src/families/writes/answer_shape.rs')), `read ${read.length} files`);
  assert.ok(read.some((path) => path.startsWith(join(crates, 'lf/src'))) && read.some((path) => path.startsWith(join(crates, 'movement-engine/src'))));
  assert.deepEqual(found, []);
  assert.deepEqual(unrelated.filter((u) => !excused.has(u)), [], 'every excuse is still needed');
});

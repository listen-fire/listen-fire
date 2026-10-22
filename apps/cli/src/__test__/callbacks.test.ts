// Callbacks and cancel through the real `lf` entry point: a run mints a
// callback and awaits its call; the call arrives at `lf serve`'s door or from
// `lf call`, runs its body once, and resumes the run. `lf cancel` settles a
// parked run and closes its callbacks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { companies, externalPort, lf, project, served } from './example';

/** The callback the fixture's run wrote into the CRM: its id and its url. */
function minted(dir: string): { id: string; url: string } {
  const asked = companies(dir).filter((name) => name.startsWith('Asked ')).at(-1);
  const match = /^Asked (cb_\S+) at (\S+)$/.exec(asked ?? '');
  assert.ok(match?.[1] !== undefined && match[2] !== undefined, `no callback written: ${JSON.stringify(companies(dir))}`);
  return { id: match[1], url: match[2] };
}

function values(dir: string, name: string, body: unknown): string {
  const file = join(dir, name);
  writeFileSync(file, JSON.stringify(body));
  return file;
}

function runIdOf(out: string): string {
  const id = /^run (\S+) callback:approve parked/m.exec(out)?.[1];
  assert.ok(id !== undefined, out);
  return id;
}

test('lf call: a mismatch is refused and consumes nothing; the call runs its body once and resumes the run; a second call is closed', () => {
  const dir = project('callback');
  const fired = lf(dir, 'run', '--event', 'events/company_created.json');
  assert.equal(fired.code, 0, fired.out);
  const { id, url } = minted(dir);
  assert.equal(url, `http://127.0.0.1:4400/api/cb/${id}`, 'without publicUrl, under where lf serve listens by default');

  const wrong = lf(dir, 'call', id, '--body', values(dir, 'wrong.json', { nope: 1 }));
  assert.equal(wrong.code, 1, wrong.out);
  assert.match(wrong.out, /refused — 'nope' is not a parameter of this callback/);

  const called = lf(dir, 'call', id, '--body', values(dir, 'note.json', { note: 'ship it' }));
  assert.equal(called.code, 0, called.out);
  assert.match(called.out, /callback cb_\S+: recorded/);
  // One line for the run: the body's write and the continuation's, together.
  assert.deepEqual(called.out.split('\n').filter((l) => /callback:approve/.test(l)).map((l) => l.replace(/^(\w+) \S+ /, '$1 ')), [
    'called callback:approve completed — 2 write(s), 1 trace entry',
  ]);
  assert.deepEqual(companies(dir).slice(1), ['Body ship it', 'Approved ship it']);

  const again = lf(dir, 'call', id, '--body', join(dir, 'note.json'));
  assert.equal(again.code, 1, again.out);
  assert.match(again.out, /closed/);
  assert.deepEqual(companies(dir).slice(1), ['Body ship it', 'Approved ship it'], 'the body ran once');
});

test('lf serve: the callback door at POST /api/cb/<id> answers as the hosted door does, under lf.yaml\'s publicUrl', async () => {
  const dir = project('callback');
  writeFileSync(join(dir, 'lf.yaml'), `${readFileSync(join(dir, 'lf.yaml'), 'utf8')}\npublicUrl: https://lf.example.test/\n`);
  const serving = await served(dir);
  try {
    const crm = `http://127.0.0.1:${externalPort(dir)}`;
    await fetch(`${crm}/dev/companies`, { method: 'POST', body: JSON.stringify({ Name: 'Osprey' }) });
    await serving.waitFor(/run .* callback:approve parked/);
    const { id, url } = minted(dir);
    assert.equal(url, `https://lf.example.test/api/cb/${id}`);
    const door = `http://127.0.0.1:${serving.port}/api/cb/${id}`;
    const post = (body: string) => fetch(door, { method: 'POST', headers: { 'content-type': 'application/json' }, body });

    const unknown = await fetch(`http://127.0.0.1:${serving.port}/api/cb/cb_never-minted`, { method: 'POST' });
    assert.equal(unknown.status, 404);
    const notJson = await post('not json');
    assert.equal(notJson.status, 400);
    const mismatch = await post(JSON.stringify({ note: 'x', extra: 1 }));
    assert.equal(mismatch.status, 400);
    assert.equal(((await mismatch.json()) as { outcome: string }).outcome, 'mismatch');

    const recorded = await post(JSON.stringify({ note: 'from the door' }));
    assert.equal(recorded.status, 200);
    assert.deepEqual(await recorded.json(), { outcome: 'recorded', message: 'recorded; the run is carrying on' });
    await serving.waitFor(/called .* callback:approve completed/);
    assert.deepEqual(companies(dir).slice(2), ['Body from the door', 'Approved from the door']);

    const closed = await post(JSON.stringify({ note: 'again' }));
    assert.equal(closed.status, 410);
  } finally {
    await serving.stop();
  }
});

test('lf cancel: a parked run is settled failed with the reason, and its callback closes', () => {
  const dir = project('callback');
  const runId = runIdOf(lf(dir, 'run', '--event', 'events/company_created.json').out);
  const { id } = minted(dir);
  const cancelled = lf(dir, 'cancel', runId, '--reason', 'no longer needed');
  assert.equal(cancelled.code, 0, cancelled.out);
  assert.match(cancelled.out, new RegExp(`run ${runId} cancelled`));
  assert.match(lf(dir, 'runs').out, new RegExp(`${runId} .* callback:approve failed`));
  const db = new DatabaseSync(join(dir, '.lf', 'state.db'));
  try {
    const row = db.prepare('select outcome from run where id = ?').get(runId) as { outcome: string } | undefined;
    assert.deepEqual(JSON.parse(row?.outcome ?? 'null'), { error: 'no longer needed' });
  } finally {
    db.close();
  }
  const call = lf(dir, 'call', id, '--body', values(dir, 'note.json', { note: 'late' }));
  assert.equal(call.code, 1, call.out);
  assert.match(call.out, /closed/);
  const twice = lf(dir, 'cancel', runId);
  assert.equal(twice.code, 1, twice.out);
  assert.match(twice.out, /is failed; there is nothing to cancel/);
});

/** Another lf process stepping the run, as the state file records it: the
 *  run's lease, held until `release` is called. */
function holdLease(dir: string, runId: string): { release(): void } {
  const db = new DatabaseSync(join(dir, '.lf', 'state.db'));
  const held = db.prepare("update run set lease_token = 'another-lf', lease_until = '2999-01-01T00:00:00.000Z' where id = ? and lease_token is null").run(runId);
  assert.equal(held.changes, 1, 'the run was free to lease');
  return {
    release() {
      db.prepare("update run set lease_token = null, lease_until = null where id = ? and lease_token = 'another-lf'").run(runId);
      db.close();
    },
  };
}

function runStatus(dir: string, runId: string): string | undefined {
  const db = new DatabaseSync(join(dir, '.lf', 'state.db'));
  try {
    return (db.prepare('select status from run where id = ?').get(runId) as { status: string } | undefined)?.status;
  } finally {
    db.close();
  }
}

test('lf call while another lf process holds the run: the call is recorded, its body waits, and the next resume runs it', () => {
  const dir = project('callback');
  const runId = runIdOf(lf(dir, 'run', '--event', 'events/company_created.json').out);
  const { id } = minted(dir);
  const lease = holdLease(dir, runId);
  try {
    const called = lf(dir, 'call', id, '--body', values(dir, 'note.json', { note: 'later' }));
    assert.equal(called.code, 0, called.out);
    assert.match(called.out, /being stepped by another lf process/);
    assert.equal(companies(dir).length, 1, 'no body yet');
  } finally {
    lease.release();
  }
  const resumed = lf(dir, 'resume');
  assert.equal(resumed.code, 0, resumed.out);
  assert.deepEqual(companies(dir).slice(1), ['Body later', 'Approved later']);
});

test('lf cancel of a run another process is stepping: the request is recorded for its holder, and the next segment stops at its first statement', () => {
  const dir = project('callback');
  const runId = runIdOf(lf(dir, 'run', '--event', 'events/company_created.json').out);
  const lease = holdLease(dir, runId);
  try {
    const requested = lf(dir, 'cancel', runId);
    assert.equal(requested.code, 0, requested.out);
    assert.match(requested.out, /cancel requested; another lf process is stepping it/);
    assert.equal(runStatus(dir, runId), 'parked', 'the holder settles it, not the canceller');
  } finally {
    lease.release();
  }
  // A segment entered now (the callback's body) is stopped by the engine at
  // its first statement, before the body writes, and the run settles failed.
  const called = lf(dir, 'call', minted(dir).id, '--body', values(dir, 'note.json', { note: 'too late' }));
  assert.equal(called.code, 1, called.out);
  assert.match(called.out, /callback:approve failed — 0 write\(s\)/);
  assert.equal(companies(dir).length, 1, `the body wrote nothing: ${JSON.stringify(companies(dir))}`);
  assert.match(lf(dir, 'runs').out, new RegExp(`${runId} .* callback:approve failed`), called.out);
});

test('lf resume with no run steps only what is due: the timeout arm beside an approval stays parked until its day comes', () => {
  const dir = project('race');
  const fired = lf(dir, 'run', '--event', 'events/company_created.json');
  assert.match(fired.out, /race:approve parked/);
  const resumed = lf(dir, 'resume');
  assert.equal(resumed.code, 0, resumed.out);
  assert.match(resumed.out, /nothing due: 1 parked run/);
  assert.equal(companies(dir).length, 1, `the timeout arm did not fire: ${JSON.stringify(companies(dir))}`);

  const called = lf(dir, 'call', minted(dir).id);
  assert.equal(called.code, 0, called.out);
  assert.match(called.out, /race:approve completed/);
  assert.deepEqual(companies(dir).slice(1), ['Approved']);
});

test('lf serve: GET on a callback url renders the confirm page and fires nothing; its form post fires it, answered with a page', async () => {
  const dir = project('callback');
  const serving = await served(dir);
  try {
    const crm = `http://127.0.0.1:${externalPort(dir)}`;
    await fetch(`${crm}/dev/companies`, { method: 'POST', body: JSON.stringify({ Name: 'Osprey' }) });
    await serving.waitFor(/run .* callback:approve parked/);
    const { id } = minted(dir);
    const door = `http://127.0.0.1:${serving.port}/api/cb/${id}`;

    const unknown = await fetch(`http://127.0.0.1:${serving.port}/api/cb/cb_never-minted`);
    assert.equal(unknown.status, 404);
    assert.match(await unknown.text(), /This link is not valid/);

    const page = await fetch(`${door}?note=prefetched`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') ?? '', /text\/html/);
    const html = await page.text();
    assert.ok(html.includes(`<form method="post" action="/api/cb/${id}">`), html);
    assert.ok(html.includes('<input type="text" name="note" required>'), html);
    assert.equal(companies(dir).length, 2, 'opening the link fired nothing');

    const submitted = await fetch(door, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' },
      body: 'note=from+the+page',
    });
    assert.equal(submitted.status, 200);
    assert.match(await submitted.text(), /<h1>Done<\/h1>/);
    await serving.waitFor(/called .* callback:approve completed/);
    assert.deepEqual(companies(dir).slice(2), ['Body from the page', 'Approved from the page']);

    const closed = await fetch(door);
    assert.equal(closed.status, 410);
    assert.match(await closed.text(), /This action was closed/);
  } finally {
    await serving.stop();
  }
});

test('lf run --dry-run rehearses past a park: a refresh of a rehearsed record moves nothing, and the segment after the wait captures its writes too', () => {
  const dir = project('rehearsal');
  // The external reads a record by its id, so a refresh asks it.
  const server = join(dir, 'externals/acme_crm/server.mjs');
  const source = readFileSync(server, 'utf8');
  const anchor = '  getRelated: () => [],\n';
  assert.ok(source.includes(anchor), 'the example external changed; update this test patch');
  writeFileSync(
    server,
    source.replace(anchor, `${anchor}  readRecord: ({ externalId }) => readState().companies.find((c) => c.externalId === externalId)?.fields ?? null,\n`),
  );

  const fired = lf(dir, 'run', '--dry-run', '--event', 'events/company_created.json');
  assert.equal(fired.code, 0, fired.out);
  assert.match(fired.out, /rehearsal:rehearse parked/);
  const id = /"Name":"Asked (cb_[^"]+)"/.exec(fired.out)?.[1];
  assert.ok(id !== undefined, fired.out);

  const called = lf(dir, 'call', id);
  assert.equal(called.code, 0, called.out);
  assert.match(called.out, /rehearsal:rehearse completed/);
  assert.match(called.out, /dry run, not written: .*"Name":"After Rehearsed"/);
  assert.equal(called.out.match(/rehearsal:rehearse/g)?.length, 1, called.out);
  assert.deepEqual(companies(dir), [], 'a rehearsal writes nothing, before its park or after');
});

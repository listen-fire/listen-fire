// The "local Attio sync with listen-fire" walkthrough (examples/lf-attio/README.md),
// every step as a person types it, against the fake Attio in
// packages/fake-channels: its Attio API, its OAuth provider, and its control door
// that delivers Attio's signed webhooks to whatever listen-fire serve registered.
//
//   listen-fire init → listen-fire connect @lf/attio (pointed at the fake) → listen-fire credential add
//   --headless → the example's movement → listen-fire check → publicUrl →
//   listen-fire serve (registers the webhook for the connection's Changes) → a
//   signed delivery of a company created runs the movement, the same delivery
//   again runs nothing, the movement's own write coming back as a change to
//   Description runs nothing (the listen takes only creations and renames), a
//   rename runs it again, a forged delivery is refused →
//   listen-fire runs → restarts keep the webhook; under a running listen-fire serve the
//   webhook follows each refresh (the listen removed, back);
//   a listen removed while listen-fire is stopped is removed at the next start.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, renameSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createRecord, deliver, fakeChannels, freePort, records, until, updateRecord, valueOf, webhooks } from './attio_fixture';
import { lf as lfSync, served } from './example';
import { lf, ok } from './interactive';

const REPO = resolve(__dirname, '../../../..');
const EXAMPLE = join(REPO, 'examples/lf-attio');

const REGISTERED = /^attio \(Changes, edge-[0-9a-f]+\): registered webhook fake-webhook-\d+ for the arrivals on Changes at /;
const HELD = /^attio \(Changes, edge-[0-9a-f]+\): webhook fake-webhook-\d+ is registered for the arrivals on Changes at /;
const REMOVED = /^attio \(Changes, edge-[0-9a-f]+\): no listen needs its webhook any more; removed webhook fake-webhook-\d+$/;

test('the Attio walkthrough, end to end against the fake Attio', async () => {
  const fake = await fakeChannels();
  try {
    const F = fake.url;
    const dir = join(mkdtempSync(join(tmpdir(), 'lf-attio-')), 'attio-sync');

    // 1. A project.
    assert.equal(lfSync(join(dir, '..'), 'init', 'attio-sync').code, 0);

    // 2. The module, pointed at the fake. Attio issues each webhook's secret
    //    when listen-fire serve registers it, so none is asked for here.
    const connected = await ok(
      lf(dir, ['connect', '@lf/attio', '--yes', '--base-url', `${F}/attio`, '--oauth-authorize-url', `${F}/oauth/authorize`, '--oauth-token-url', `${F}/oauth/token`, '--client-id', 'lf-attio-app', '--client-secret', 'lf-attio-secret', '--redirect-port', '0']),
    );
    assert.match(connected, /installed @lf\/attio as externals\/attio/);
    assert.match(connected, /http:\/\/127\.0\.0\.1:<any port>\/callback/);
    assert.doesNotMatch(connected, /webhooks are signed with/);

    // 3. Henry signs in, headless: the browser's redirect pasted back.
    const signInPort = await freePort();
    const adding = lf(dir, ['credential', 'add', '--module', '@lf/attio', 'henry_attio', '--credential', 'attio', '--headless', '--redirect-port', String(signInPort)], { answers: ['', ''] });
    const authorize = (await adding.line(/^\s+http:\/\/127\.0\.0\.1:\d+\/oauth\/authorize\?/)).trim();
    assert.equal(new URL(authorize).searchParams.get('redirect_uri'), `http://127.0.0.1:${signInPort}/callback`);
    const consent = await fetch(authorize, { redirect: 'manual' });
    const location = consent.headers.get('location');
    assert.ok(location !== null, 'the fake provider redirects back with a code');
    await adding.line(/paste the URL your browser was sent back to/);
    adding.answer(location);
    assert.match(await ok(adding), /added henry_attio \(attio, credential attio\)/);

    // 4. The example's movement, checked against the fake's schema.
    cpSync(join(EXAMPLE, 'movements/sync.mvt'), join(dir, 'movements/sync.mvt'));
    const checked = lfSync(dir, 'check');
    assert.equal(checked.code, 0, checked.out);

    // 5. Where the fake reaches listen-fire serve.
    const port = await freePort();
    const publicUrl = `http://127.0.0.1:${port}`;
    appendFileSync(join(dir, 'lf.yaml'), `publicUrl: ${publicUrl}\n`);
    const doors = `${publicUrl}/api/public/webhook-sync/attio/henry_attio/edge-`;
    const named = async (name: string) => (await records(fake, 'companies')).find((c) => valueOf(c, 'name') === name);
    const stamped = (lines: string[]) => lines.filter((l) => /^run \S+ sync:stamp completed$/.test(l)).length;

    // 6. listen-fire serve registers the webhook for the connection's
    //    Changes, taking every record event, and a signed delivery runs the movement.
    let serving = await served(dir, ['--port', String(port)]);
    let door = '';
    try {
      await serving.waitFor(REGISTERED);
      const registered = await webhooks(fake);
      assert.equal(registered.length, 1);
      door = registered[0]!.target_url;
      assert.ok(door.startsWith(doors), door);
      assert.deepEqual(registered[0]?.subscriptions.map((s) => s.event_type), ['record.created', 'record.updated', 'record.deleted']);

      const northwind = await createRecord(fake, 'companies', { name: 'Northwind Labs' });
      const created = { event_type: 'record.created', id: { object_id: 'companies', record_id: northwind.id.record_id } };
      assert.deepEqual((await deliver(fake, created)).map((d) => [d.targetUrl, d.status]), [[door, 200]]);
      await until(() => stamped(serving.lines) === 1, serving.lines);
      assert.equal(valueOf(await named('Northwind Labs'), 'description'), 'Seen by lf');

      // The same delivery again, and the movement's own write coming back
      // as a change to Description: accepted, and neither runs it. A rename
      // does; the deliveries run in the order they came.
      assert.deepEqual((await deliver(fake, created)).map((d) => d.status), [200]);
      const echo = { event_type: 'record.updated', id: { object_id: 'companies', record_id: northwind.id.record_id, attribute_id: 'description' } };
      assert.deepEqual((await deliver(fake, echo)).map((d) => d.status), [200]);
      await updateRecord(fake, 'companies', northwind.id.record_id, { name: 'Northwind', description: 'Edited by Bob' });
      await deliver(fake, { event_type: 'record.updated', id: { object_id: 'companies', record_id: northwind.id.record_id, attribute_id: 'name' } });
      await until(() => stamped(serving.lines) === 2, serving.lines);
      assert.equal(valueOf(await named('Northwind'), 'description'), 'Seen by lf');
      await new Promise((done) => setTimeout(done, 500));
      assert.equal(stamped(serving.lines), 2, serving.lines.join('\n'));

      // A delivery not signed by the webhook's secret is refused.
      const forged = await fetch(door, { method: 'POST', headers: { 'content-type': 'application/json', 'attio-signature': 'f00d' }, body: JSON.stringify({ webhook_id: 'x', events: [] }) });
      assert.equal(forged.status, 401);
    } finally {
      await serving.stop();
    }

    // 7. The runs: the company created, and its rename.
    const runs = lfSync(dir, 'runs');
    assert.equal(runs.code, 0, runs.out);
    assert.equal(runs.out.split('\n').filter((l) => /sync:stamp completed/.test(l)).length, 2, runs.out);

    // A restart keeps the webhook it registered. Then the listen moves under
    // the running listen-fire serve, and its webhook follows each refresh.
    serving = await served(dir, ['--port', String(port)]);
    try {
      await serving.waitFor(HELD);
      assert.deepEqual((await webhooks(fake)).map((w) => w.target_url), [door]);
      const seen = (pattern: RegExp) => serving.lines.filter((l) => pattern.test(l)).length;
      const movement = join(dir, 'movements/sync.mvt');
      const off = join(dir, 'sync.mvt.off');

      // The listen removed: its webhook is removed.
      renameSync(movement, off);
      await serving.waitFor(REMOVED);
      assert.deepEqual(await webhooks(fake), []);

      // Back: a new webhook, its secret issued again, and a signed delivery runs.
      renameSync(off, movement);
      await until(() => seen(REGISTERED) === 1, serving.lines);
      const registered = await webhooks(fake);
      assert.equal(registered.length, 1);
      assert.equal(registered[0]?.target_url, door);
      const acme = await createRecord(fake, 'companies', { name: 'Acme Again' });
      const delivered = await deliver(fake, { event_type: 'record.created', id: { object_id: 'companies', record_id: acme.id.record_id } });
      assert.deepEqual(delivered.map((d) => d.status), [200]);
      await until(() => stamped(serving.lines) === 1, serving.lines);
    } finally {
      await serving.stop();
    }

    // The listen removed while listen-fire is stopped: the next start removes its webhook.
    renameSync(join(dir, 'movements/sync.mvt'), join(dir, 'sync.mvt.off'));
    serving = await served(dir, ['--port', String(port)]);
    try {
      await serving.waitFor(REMOVED);
      assert.deepEqual(await webhooks(fake), []);
    } finally {
      await serving.stop();
    }
  } finally {
    await fake.stop();
  }
});

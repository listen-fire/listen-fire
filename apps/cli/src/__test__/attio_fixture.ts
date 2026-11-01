// The fake Attio (packages/fake-channels) as the Attio tests drive it: its
// Attio API, its OAuth provider, its admin state, and its control door that
// delivers Attio's signed webhooks to whatever `listen-fire serve` registered.

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { lf as lfSync } from './example';
import { lf, ok } from './interactive';

export interface Fake {
  url: string;
  json(path: string, body?: unknown): Promise<unknown>;
  stop(): Promise<void>;
}

export interface Webhook {
  target_url: string;
  subscriptions: Array<{ event_type: string }>;
  id: { webhook_id: string };
}

export interface AttioRecord {
  id: { record_id: string };
  values: Record<string, Array<Record<string, unknown>> | undefined>;
}

/** One record event as Attio sends it, before the fake stamps the workspace and actor. */
export interface AttioEvent {
  event_type: string;
  id: { object_id: string; record_id: string; attribute_id?: string };
  actor?: { type: string; id: string };
}

/** The `@listen-fire/fake-channels` package on a free port, its state in a folder of its own. */
export async function fakeChannels(): Promise<Fake> {
  const cwd = mkdtempSync(join(tmpdir(), 'lf-attio-fake-'));
  const child: ChildProcess = spawn(process.execPath, [require.resolve('@listen-fire/fake-channels/bin/fake-channels.cjs')], {
    cwd,
    env: { ...process.env, FAKE_CHANNELS_PORT: '0' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const exited = new Promise<void>((done) => child.once('exit', () => done()));
  const url = await new Promise<string>((found, failed) => {
    createInterface({ input: child.stdout! }).on('line', (line) => {
      const port = /running on http:\/\/localhost:(\d+)/.exec(line)?.[1];
      if (port !== undefined) found(`http://127.0.0.1:${port}`);
    });
    void exited.then(() => failed(new Error('fake-channels exited before listening')));
  });
  const json = async (path: string, body?: unknown) => {
    const answer = await fetch(`${url}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(answer.status, 200, `${path}: ${await answer.clone().text()}`);
    return answer.json() as Promise<unknown>;
  };
  return { url, json, stop: async () => (child.kill('SIGTERM'), exited) };
}

/** A record made in the fake, as Attio answers it. */
export async function createRecord(fake: Fake, object: string, values: Record<string, unknown>): Promise<AttioRecord> {
  return ((await fake.json(`/attio/v2/objects/${object}/records`, { data: { values } })) as { data: AttioRecord }).data;
}

/** A record changed in the fake as a person changes it in Attio (no webhook follows on its own). */
export async function updateRecord(fake: Fake, object: string, recordId: string, values: Record<string, unknown>): Promise<void> {
  const answer = await fetch(`${fake.url}/attio/v2/objects/${object}/records/${recordId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data: { values } }),
  });
  assert.equal(answer.status, 200, await answer.clone().text());
}

/** One webhook delivery of `events`, signed, to every webhook the fake holds; each delivery's status. */
export async function deliver(fake: Fake, ...events: AttioEvent[]): Promise<Array<{ targetUrl: string; status: number }>> {
  return ((await fake.json('/attio/control/deliver', { events })) as { deliveries: Array<{ targetUrl: string; status: number }> }).deliveries;
}

export async function records(fake: Fake, object: string): Promise<AttioRecord[]> {
  return (await fake.json(`/admin/attio/record:${object}/state`)) as AttioRecord[];
}

export async function webhooks(fake: Fake): Promise<Webhook[]> {
  return (await fake.json('/admin/attio/webhook/state')) as Webhook[];
}

/** A record's first value of an attribute, as text. */
export function valueOf(record: AttioRecord | undefined, slug: string): unknown {
  return record?.values[slug]?.[0]?.['value'];
}

export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  await new Promise<void>((done) => server.close(() => done()));
  return address.port;
}

/** Wait, up to 20s, for `holds` to hold over the server's output. */
export async function until(holds: () => boolean, lines: string[]): Promise<void> {
  for (const deadline = Date.now() + 20_000; !holds(); ) {
    if (Date.now() > deadline) throw new Error(`timed out; saw:\n${lines.join('\n')}`);
    await new Promise((done) => setTimeout(done, 50));
  }
}

/** A project connecting `@lf/attio` to the fake with an access token
 *  (`henry_attio`), its `publicUrl` the free `port` to serve it on. */
export async function attioProject(fake: Fake, name: string): Promise<{ dir: string; port: number }> {
  const dir = join(mkdtempSync(join(tmpdir(), `lf-${name}-`)), name);
  assert.equal(lfSync(join(dir, '..'), 'init', name).code, 0);
  await ok(lf(dir, ['connect', '@lf/attio', '--yes']));
  const adding = lf(dir, ['credential', 'add', '--module', '@lf/attio', 'henry_attio', '--credential', 'attio_token'], { answers: ['attio-test-token', `${fake.url}/attio`] });
  assert.match(await ok(adding), /added henry_attio \(attio, credential attio_token\)/);
  const port = await freePort();
  appendFileSync(join(dir, 'lf.yaml'), `publicUrl: http://127.0.0.1:${port}\n`);
  return { dir, port };
}

// Every request the real `listen-fire` sends a slot module carries the release
// that sent it (`hostRelease`, adapter protocol 2.8), so a module serving
// runners of several releases (a platform's store, movements and secrets
// modules) tells their lines apart. Read off the wire: a proxy in front of a
// test module (movements, secrets) records each request's envelope as sent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SlotClient } from 'movement-engine/public/module-wire';
import { lf } from './interactive';
import { serveMovementsModule } from './movements_module/serve';
import { serveSecretsModule } from './secrets_module/serve';
import { RELEASE } from './release';

const ENV = { LF_SECRET__ACME_MOVEMENTS__EXTERNAL: 'acme_movements', LF_SECRET__ACME_MOVEMENTS__TENANT: 't1' };

interface SentRequest {
  method: unknown;
  hostRelease: unknown;
}

/** A proxy in front of `target` that records each request's envelope as sent. */
async function recordingProxy(target: string): Promise<{ port: number; sent: SentRequest[]; close: () => Promise<void> }> {
  const sent: SentRequest[] = [];
  const proxy = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString('utf8');
      const envelope: unknown = JSON.parse(body);
      sent.push({ method: Reflect.get(Object(envelope), 'method'), hostRelease: Reflect.get(Object(envelope), 'hostRelease') });
      const answer = await fetch(target, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      response.writeHead(answer.status, { 'content-type': 'application/json' });
      response.end(await answer.text());
    })();
  });
  await new Promise<void>((done) => proxy.listen(0, '127.0.0.1', done));
  const address = proxy.address();
  if (address === null || typeof address === 'string') throw new Error('the proxy listens on a port');
  return { port: address.port, sent, close: () => new Promise<void>((done) => proxy.close(() => done())) };
}

const named = (sent: SentRequest[], release: string): SentRequest[] => sent.filter((request) => request.hostRelease !== release);

test('every movements slot request carries the release of the listen-fire that sent it', async () => {
  const module = await serveMovementsModule({ listen: 0, files: { 'greet.mvt': 'export function greet(name: <text>) {\n  return "Hello, ${name}!"\n}\n' } });
  const proxy = await recordingProxy(module.url);
  try {
    const dir = mkdtempSync(join(tmpdir(), 'lf-slot-release-'));
    writeFileSync(join(dir, 'lf.yaml'), `engine: ${RELEASE}\ncore:\n  movements: acme_movements\n`);
    mkdirSync(join(dir, 'externals/acme_movements'), { recursive: true });
    writeFileSync(
      join(dir, 'externals/acme_movements/lf-external.yaml'),
      `name: acme_movements\nkind: core\nslot: movements\nurl: http://127.0.0.1:${proxy.port}/\nsettings:\n  - { name: tenant }\n`,
    );
    const checked = await lf(dir, ['check'], { env: ENV }).done;
    assert.equal(checked.code, 0, checked.out);
    const methods = new Set(proxy.sent.map((request) => request.method));
    for (const method of ['manifest', 'movements.list', 'movements.read']) assert.ok(methods.has(method), `listen-fire asked ${method}: ${[...methods].join(', ')}`);
    assert.deepEqual(named(proxy.sent, RELEASE), [], `every request names ${RELEASE}`);
  } finally {
    await proxy.close();
    await module.close();
  }
});

test('every secrets slot request carries the release of the listen-fire that sent it', async () => {
  const vault = await serveSecretsModule({ listen: 0, seed: {} });
  const proxy = await recordingProxy(vault.url);
  try {
    const dir = mkdtempSync(join(tmpdir(), 'lf-slot-release-'));
    writeFileSync(join(dir, 'lf.yaml'), `engine: ${RELEASE}\ncore:\n  secrets: acme_vault\n`);
    mkdirSync(join(dir, 'externals/acme_vault'), { recursive: true });
    writeFileSync(
      join(dir, 'externals/acme_vault/lf-external.yaml'),
      `name: acme_vault\nkind: core\nslot: secrets\nurl: http://127.0.0.1:${proxy.port}/\nsettings:\n  - { name: vault, label: the vault credentials are kept in }\n`,
    );
    mkdirSync(join(dir, '.lf'), { recursive: true });
    writeFileSync(join(dir, '.lf/secrets.yaml'), 'acme_vault:\n  module: acme_vault\n  vault: test\n', { mode: 0o600 });
    const listed = await lf(dir, ['credential', 'list', '--json']).done;
    assert.equal(listed.code, 0, listed.out);
    const methods = new Set(proxy.sent.map((request) => request.method));
    for (const method of ['manifest', 'secrets.list']) assert.ok(methods.has(method), `listen-fire asked ${method}: ${[...methods].join(', ')}`);
    assert.deepEqual(named(proxy.sent, RELEASE), [], `every request names ${RELEASE}`);
  } finally {
    await proxy.close();
    await vault.close();
  }
});

test('a TypeScript host states its release through SlotClient, and a client that sets none sends none', async () => {
  const vault = await serveSecretsModule({ listen: 0, seed: {} });
  const proxy = await recordingProxy(vault.url);
  try {
    const address = { baseUrl: `http://127.0.0.1:${proxy.port}/` };
    await new SlotClient(address, {}, '9.9.9').call('manifest');
    await new SlotClient(address).call('manifest');
    assert.deepEqual(
      proxy.sent.map((request) => request.hostRelease),
      ['9.9.9', undefined],
    );
  } finally {
    await proxy.close();
    await vault.close();
  }
});

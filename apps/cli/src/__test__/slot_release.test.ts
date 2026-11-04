// Every request the real `listen-fire` sends a slot module carries the release
// that sent it (`hostRelease`, adapter protocol 2.8), so a module serving
// runners of several releases (a platform's store, movements and secrets
// modules) tells their lines apart. Read off the wire: a proxy in front of the
// test movements module records each request's envelope as sent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lf } from './interactive';
import { serveMovementsModule } from './movements_module/serve';
import { RELEASE } from './release';

const ENV = { LF_SECRET__ACME_MOVEMENTS__EXTERNAL: 'acme_movements', LF_SECRET__ACME_MOVEMENTS__TENANT: 't1' };

async function bodyOf(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

test('every slot request carries the release of the listen-fire that sent it', async () => {
  const module = await serveMovementsModule({ listen: 0, files: { 'greet.mvt': 'export function greet(name: <text>) {\n  return "Hello, ${name}!"\n}\n' } });
  const sent: Array<{ method: unknown; hostRelease: unknown }> = [];
  const proxy = createServer((request, response) => {
    void (async () => {
      const body = await bodyOf(request);
      const envelope: unknown = JSON.parse(body);
      sent.push({ method: Reflect.get(Object(envelope), 'method'), hostRelease: Reflect.get(Object(envelope), 'hostRelease') });
      const answer = await fetch(module.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      response.writeHead(answer.status, { 'content-type': 'application/json' });
      response.end(await answer.text());
    })();
  });
  await new Promise<void>((done) => proxy.listen(0, '127.0.0.1', done));
  try {
    const dir = mkdtempSync(join(tmpdir(), 'lf-slot-release-'));
    writeFileSync(join(dir, 'lf.yaml'), `engine: ${RELEASE}\ncore:\n  movements: acme_movements\n`);
    mkdirSync(join(dir, 'externals/acme_movements'), { recursive: true });
    writeFileSync(
      join(dir, 'externals/acme_movements/lf-external.yaml'),
      `name: acme_movements\nkind: core\nslot: movements\nurl: http://127.0.0.1:${(proxy.address() as AddressInfo).port}/\nsettings:\n  - { name: tenant }\n`,
    );
    const checked = await lf(dir, ['check'], { env: ENV }).done;
    assert.equal(checked.code, 0, checked.out);
    const methods = new Set(sent.map((request) => request.method));
    for (const method of ['manifest', 'movements.list', 'movements.read']) assert.ok(methods.has(method), `listen-fire asked ${method}: ${[...methods].join(', ')}`);
    assert.deepEqual(
      sent.filter((request) => request.hostRelease !== RELEASE),
      [],
      `every request names ${RELEASE}`,
    );
  } finally {
    await new Promise<void>((done) => proxy.close(() => done()));
    await module.close();
  }
});

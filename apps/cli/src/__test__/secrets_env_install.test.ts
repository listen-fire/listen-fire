// An install from the environment: `LF_SECRET__<ENTRY>__MODULE` names the
// module whose install the entry is, as `module:` does in the secrets file.
// A separately run adapter reached at its url, whose calls carry its install's
// key (its bearer secret and its declared `key` setting), then needs no
// `using`, and every call carries the key. `__EXTERNAL` is still a
// hand-written entry: a credential a connection must name.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lf } from './interactive';

interface Received {
  method: string;
  authorization: string | undefined;
  settings: unknown;
}

const PING = {
  typeId: 'Ping',
  displayName: 'Ping',
  fields: [{ fieldId: 'Note', displayName: 'Note', kind: 'string', writable: true, required: false }],
  references: [],
};

const METHODS: Record<string, () => unknown> = {
  manifest: () => ({
    protocolVersion: 2,
    adapterType: 'beacon',
    supportedTriggers: [],
    settings: [{ name: 'key' }],
    runtimeCapabilities: { traversal: { incoming: false, edgeProperties: false }, resources: false },
    methods: ['listEntryPoints', 'describe'],
  }),
  listEntryPoints: () => [{ typeId: 'Ping', displayName: 'Ping', scope: 'self-configured', writable: true, readable: false }],
  describe: () => PING,
};

/** An adapter at a url that answers only a caller presenting `key`, and keeps what each call carried. */
async function beacon(key: string): Promise<{ url: string; received: Received[]; server: Server }> {
  const received: Received[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const envelope = JSON.parse(body || '{}') as { method?: string; settings?: unknown };
      const method = envelope.method ?? '';
      received.push({ method, authorization: req.headers.authorization, settings: envelope.settings });
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.headers.authorization !== `Bearer ${key}`) {
        res.end(JSON.stringify({ ok: false, error: { code: 'unauthorized', message: 'no install key' } }));
        return;
      }
      const answer = METHODS[method];
      res.end(JSON.stringify(answer === undefined ? { ok: false, error: { code: 'method_not_implemented', message: method } } : { ok: true, result: answer() }));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  return { url: `http://127.0.0.1:${address.port}/`, received, server };
}

function project(url: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'lf-env-install-'));
  writeFileSync(join(dir, 'lf.yaml'), 'engine: 0.12.0\nmovements: movements\nexternals: externals\n');
  mkdirSync(join(dir, 'externals/beacon'), { recursive: true });
  writeFileSync(join(dir, 'externals/beacon/lf-external.yaml'), `name: beacon\nurl: ${url}\nauth: { kind: bearer, field: key }\n`);
  mkdirSync(join(dir, 'movements'));
  writeFileSync(
    join(dir, 'movements/ping.mvt'),
    'import { beacon } from adapters\n\nb = connect beacon\n\nfunction ping(run: <manual-[:Invocation]->>) {\n  write b-[:Ping]-> { Note: "hi" }\n}\n\nlisten to manual fire ping\n',
  );
  mkdirSync(join(dir, '.lf'));
  writeFileSync(join(dir, '.lf/secrets.yaml'), '{}\n', { mode: 0o600 });
  return dir;
}

test('an install named by LF_SECRET__<ENTRY>__MODULE needs no `using`, and its key reaches each call', async () => {
  const adapter = await beacon('k-env');
  try {
    const dir = project(adapter.url);
    const checked = await lf(dir, ['check'], { env: { LF_SECRET__BEACON__MODULE: 'beacon', LF_SECRET__BEACON__KEY: 'k-env' } }).done;
    assert.equal(checked.code, 0, checked.out);
    for (const call of adapter.received) assert.equal(call.authorization, 'Bearer k-env', call.method);
    // The manifest says which settings there are, so it is read before any.
    const configured = adapter.received.filter((call) => call.method !== 'manifest');
    assert.ok(configured.length > 0, 'listen-fire check read the adapter past its manifest');
    for (const call of configured) assert.deepEqual(call.settings, { key: 'k-env' }, call.method);
  } finally {
    adapter.server.close();
  }
});

test('an entry named by LF_SECRET__<ENTRY>__EXTERNAL is still a credential a connection must name', async () => {
  const adapter = await beacon('k-env');
  try {
    const dir = project(adapter.url);
    const checked = await lf(dir, ['check'], { env: { LF_SECRET__BEACON__EXTERNAL: 'beacon', LF_SECRET__BEACON__KEY: 'k-env' } }).done;
    assert.notEqual(checked.code, 0, checked.out);
    assert.match(checked.out, /MOV_CONSTRUCT_MISSING_CRED 'beacon' requires a 'credentials' argument/);
  } finally {
    adapter.server.close();
  }
});

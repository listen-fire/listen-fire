// A credential Airtable refuses fails `listen-fire check` at once, naming the
// external, the credential, the module and what Airtable said, against a local
// stub of Airtable's API that answers every request 401. (It used to retry the
// refusal as if it were transient, for over two minutes, saying nothing.)

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { lf as lfSync, lfCommand } from './example';

const REFUSED = '{"error":{"type":"AUTHENTICATION_REQUIRED","message":"Authentication required"}}';

/** `listen-fire check`, run without blocking this process, so the stub can answer it. */
function check(dir: string): Promise<{ code: number | null; out: string }> {
  const [command, args] = lfCommand(['check']);
  const child = spawn(command, args, { cwd: dir, env: { ...process.env, NODE_NO_WARNINGS: '1' } });
  let out = '';
  child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString()));
  return new Promise((done) => child.once('close', (code) => done({ code, out })));
}

test('a refused Airtable credential fails check at once, by name', async () => {
  let requests = 0;
  const airtable = createServer((_req, res) => {
    requests += 1;
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(REFUSED);
  });
  await new Promise<void>((listening) => airtable.listen(0, '127.0.0.1', listening));
  const { port } = airtable.address() as AddressInfo;
  try {
    const dir = join(mkdtempSync(join(tmpdir(), 'lf-airtable-refused-')), 'airtable-refused');
    assert.equal(lfSync(join(dir, '..'), 'init', 'airtable-refused').code, 0);
    mkdirSync(join(dir, 'externals/airtable'), { recursive: true });
    writeFileSync(join(dir, 'externals/airtable/lf-external.yaml'), 'name: airtable\nmodule: "@lf/airtable"\n');
    mkdirSync(join(dir, '.lf'), { recursive: true });
    writeFileSync(
      join(dir, '.lf/secrets.yaml'),
      `my_airtable:\n  external: airtable\n  access_token: fake\n  base_url_override: http://127.0.0.1:${port}\n  client_id: x\n  client_secret: x\n`,
      { mode: 0o600 },
    );
    writeFileSync(
      join(dir, 'movements/main.mvt'),
      `import { \`@lf/airtable\` as airtable } from adapters
import { my_airtable } from credentials

finance = connect airtable using my_airtable { base: "Finance" }

function review(change: <finance-[e:\`Record Change\` WHERE e.table == "Expenses"]->>) {
  return only(change-[:Record]->)
}

listen to finance { table: "Expenses", events: ["record.created"] } fire review
`,
    );

    const started = Date.now();
    const result = await check(dir);
    const took = Date.now() - started;

    assert.notEqual(result.code, 0, result.out);
    assert.ok(took < 20_000, `check took ${took}ms: ${result.out}`);
    assert.match(result.out, /external "airtable"/);
    assert.match(result.out, /credential "my_airtable" was refused/);
    assert.match(result.out, /module "airtable" says: Airtable refused the access token \(HTTP 401\) to GET \/v0\/meta\/bases: .*Authentication required/);
    // Asked once, and once more after the host's refresh could not run: never retried as transient.
    assert.ok(requests <= 2, `Airtable was asked ${requests} times`);
  } finally {
    await new Promise<void>((closed) => airtable.close(() => closed()));
  }
});

// A run with the loopGuard slot filled, through `listen-fire run` on the
// example project (examples/lf-acme): the host tells the guard of the record
// the run wrote, read back as the write left it, and never asks it
// `guard.isEcho`, which the slot retired. The guard still offers it, as one
// built for listen-fire 0.13 does, and loads as before.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lf, project } from './example';
import { fillGuardSlot } from './loop_guard_module/project';

/** The host tells the guard only of a write to a source that can echo it:
 *  one whose manifest declares how its webhooks are signed (`inbound`), or
 *  that is polled. The example's CRM declares its signature in its
 *  lf-external.yaml instead, so the copy here declares it in its manifest. */
function signedInItsManifest(dir: string): void {
  const server = join(dir, 'externals/acme_crm/server.mjs');
  const source = readFileSync(server, 'utf8');
  const declared = source.replace(
    "supportedTriggers: ['webhook'],",
    "supportedTriggers: ['webhook'],\n    inbound: { providerKey: 'acme_crm', scheme: 'hmac_sha256_hex', signatureHeaders: ['x-listen-fire-signature'] },",
  );
  assert.notEqual(declared, source, "the example CRM's manifest moved: find its supportedTriggers again");
  writeFileSync(server, declared);
}

test('listen-fire run tells a guard that still offers guard.isEcho of each write, and never asks it', () => {
  const dir = project();
  signedInItsManifest(dir);
  const calls = join(dir, 'guard-calls.jsonl');
  fillGuardSlot(dir, calls);

  const run = lf(dir, 'run', '--event', 'events/company_created.json');
  assert.equal(run.code, 0, run.out);
  assert.match(run.out, /parked/);

  assert.ok(existsSync(calls), `the guard was never called:\n${run.out}`);
  const asked = readFileSync(calls, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
  assert.deepEqual(
    asked.map((call) => call.method),
    ['guard.open', 'guard.recordWrite'],
    run.out,
  );
  const wrote = asked[1].params;
  assert.equal(wrote.adapter, 'acme_crm');
  assert.equal(wrote.recordType, 'Company');
  assert.equal(wrote.writer, 'listen:companies:welcome');
  assert.equal((wrote.record as { Name?: unknown }).Name, 'Welcome Vireo Robotics');
});

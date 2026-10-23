// Attio declares two credentials, an OAuth sign-in (`attio`) and a static
// access token (`attio_token`): a connection uses one. `lf credential add`
// does not pick for the person, and the token goes into the secrets file with
// the module and credential it belongs to.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { lf as lfSync } from './example';
import { lf, ok } from './interactive';

test('lf credential add for Attio names both credentials, and attio_token prompts its fields and writes the entry', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'lf-attio-token-')), 'attio-token');
  assert.equal(lfSync(join(dir, '..'), 'init', 'attio-token').code, 0);

  // Two declarations, so no sign-in offer follows: the next step is named.
  const connected = await ok(lf(dir, ['connect', '@lf/attio', '--yes'], { answers: ['app-id', 'app-secret', '8976'] }));
  assert.match(connected, /next, a user credential: lf credential add --module attio <name>/);
  assert.doesNotMatch(connected, /Sign in now\?/);

  const refused = await lf(dir, ['credential', 'add', '--module', '@lf/attio', 'henry_attio']).done;
  assert.equal(refused.code, 1, refused.out);
  assert.match(refused.out, /module "attio" declares several credentials \(attio, attio_token\); name one with --credential/);

  const adding = lf(dir, ['credential', 'add', '--module', '@lf/attio', 'henry_attio', '--credential', 'attio_token']);
  await adding.line(/Access token/i);
  adding.answer('attio-secret-token');
  await adding.line(/Base URL/i);
  adding.answer('');
  assert.match(await ok(adding), /added henry_attio \(attio, credential attio_token\)/);

  const secrets: unknown = parse(readFileSync(join(dir, '.lf/secrets.yaml'), 'utf8'));
  assert.ok(secrets !== null && typeof secrets === 'object');
  const entry = (secrets as Record<string, Record<string, unknown>>).henry_attio;
  assert.deepEqual(entry, { module: 'attio', credential: 'attio_token', accessToken: 'attio-secret-token' });
});

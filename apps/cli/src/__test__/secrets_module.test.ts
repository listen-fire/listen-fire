// The secrets slot filled by a module lf does not build in: the test vault
// (secrets_module/serve.ts) reached at its url, its own settings in the
// project's secrets file (the bootstrap rule). The real `lf` reads its
// credentials there, writes whole entries there, and two lf processes on one
// vault refresh an expiring token once between them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeOAuthServer, type FakeOAuthServer } from 'movement-engine/public/secrets-testing';
import { EXAMPLE } from './example';
import { lf } from './interactive';
import { serveSecretsModule, type SecretsModule, type Seeded } from './secrets_module/serve';

const EVENT = 'events/company_created.json';
const LOCAL = "# the secrets module's own settings\nacme_vault:\n  module: acme_vault\n  vault: test\n";
const STATIC = [{ name: 'acme_key', kind: 'static', fields: [{ name: 'api_key', label: 'API key' }, { name: 'workspace', secret: false, optional: true }] }];

/** The example, its external logging each call's Authorization header and
 *  sending the access token, its secrets slot filled by `vault`; `local`
 *  is the secrets file (null: none). */
function project(vault: SecretsModule, options: { local?: string | null; credentials?: unknown[] } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'lf-secrets-module-'));
  cpSync(EXAMPLE, dir, { recursive: true, filter: (src) => !src.includes(`${EXAMPLE}/.lf`) });
  mkdirSync(join(dir, '.lf'), { recursive: true });
  const manifest = join(dir, 'externals/acme_crm/lf-external.yaml');
  writeFileSync(manifest, readFileSync(manifest, 'utf8').replace('field: token', 'field: access_token').replace('env:\n', 'env:\n  AUTH_LOG: "{lf}/auth.log"\n'));
  const server = join(dir, 'externals/acme_crm/server.mjs');
  const check = "if (!/^Bearer \\S+/.test(req.headers.authorization ?? '')) {";
  const methods = "    methods: Object.keys(METHODS).filter((m) => m !== 'manifest'),\n";
  let source = readFileSync(server, 'utf8');
  assert.ok(source.includes(check) && source.includes(methods), 'the example external changed; update this test patch');
  source = source.replace(check, `(await import('node:fs')).appendFileSync(process.env.AUTH_LOG, (req.headers.authorization ?? '') + '\\n');\n    ${check}`);
  if (options.credentials !== undefined) source = source.replace(methods, `${methods}    credentials: ${JSON.stringify(options.credentials)},\n`);
  writeFileSync(server, source);
  mkdirSync(join(dir, 'externals/acme_vault'));
  writeFileSync(
    join(dir, 'externals/acme_vault/lf-external.yaml'),
    `name: acme_vault\nkind: core\nslot: secrets\nurl: ${vault.url}\nsettings:\n  - { name: vault, label: the vault credentials are kept in }\n`,
  );
  appendFileSync(join(dir, 'lf.yaml'), 'core:\n  secrets: acme_vault\n');
  const local = options.local === undefined ? LOCAL : options.local;
  if (local !== null) writeFileSync(join(dir, '.lf/secrets.yaml'), local, { mode: 0o600 });
  return dir;
}

const authLog = (dir: string): string[] => readFileSync(join(dir, '.lf/externals/acme_crm/auth.log'), 'utf8').trim().split('\n');

function acme(fields: Record<string, string>): Record<string, Seeded> {
  return { acme: { external: 'acme_crm', binding: 'legacy', fields: { webhook_secret: 'w', ...fields } } };
}

test('a run reads its credential from the secrets module; the secrets file holds only the module’s own settings', async () => {
  const vault = await serveSecretsModule({ listen: 0, seed: acme({ access_token: 'vault-token' }) });
  try {
    const dir = project(vault);
    const run = await lf(dir, ['run', '--event', EVENT]).done;
    assert.equal(run.code, 0, run.out);
    assert.equal(authLog(dir).at(-1), 'Bearer vault-token');
    assert.ok(vault.calls.includes('secrets.list'), vault.calls.join('\n'));
    const listed = await lf(dir, ['credential', 'list', '--json']).done;
    assert.equal(listed.code, 0, listed.out);
    const credentials = (JSON.parse(listed.out) as { credentials: Array<{ name: string; kept: string[] }> }).credentials;
    assert.deepEqual(credentials.find((c) => c.name === 'acme')?.kept, ['the secrets module acme_vault']);
    assert.equal(readFileSync(join(dir, '.lf/secrets.yaml'), 'utf8'), LOCAL);
  } finally {
    await vault.close();
  }
});

test('the environment lies over what the secrets module holds, field by field', async () => {
  const vault = await serveSecretsModule({ listen: 0, seed: acme({ access_token: 'vault-token' }) });
  try {
    const dir = project(vault);
    const run = await lf(dir, ['run', '--event', EVENT], { env: { LF_SECRET__ACME__ACCESS_TOKEN: 'env-token' } }).done;
    assert.equal(run.code, 0, run.out);
    assert.equal(authLog(dir).at(-1), 'Bearer env-token');
  } finally {
    await vault.close();
  }
});

test('lf connect, lf credential add and lf credential delete change whole entries in the secrets module, under its lease', async () => {
  const vault = await serveSecretsModule({
    listen: 0,
    seed: { ...acme({ access_token: 'vault-token' }), bob: { external: 'acme_crm', binding: { credential: 'acme_key' }, fields: { api_key: 'bob-key' } } },
  });
  try {
    const dir = project(vault, { credentials: STATIC });
    const connected = await lf(dir, ['connect', '@lf/anthropic'], { answers: ['sk-test-key', ''] }).done;
    assert.equal(connected.code, 0, connected.out);
    assert.match(connected.out, /its settings are "anthropic" in the secrets module acme_vault/);
    const added = await lf(dir, ['credential', 'add', '--module', 'acme_crm', 'ada'], { answers: ['ada-key', ''] }).done;
    assert.equal(added.code, 0, added.out);
    const deleted = await lf(dir, ['credential', 'delete', 'bob']).done;
    assert.equal(deleted.code, 0, deleted.out);
    const held = await vault.held();
    assert.deepEqual(held.anthropic, { external: '@lf/anthropic', binding: 'install', fields: { api_key: 'sk-test-key' } });
    assert.deepEqual(held.ada, { external: 'acme_crm', binding: { credential: 'acme_key' }, fields: { api_key: 'ada-key' } });
    assert.equal(held.bob, undefined);
    assert.ok(vault.calls.includes('secrets.lock anthropic') && vault.calls.includes('secrets.unlock anthropic'), vault.calls.join('\n'));
    assert.deepEqual(vault.leased(), []);
    assert.equal(readFileSync(join(dir, '.lf/secrets.yaml'), 'utf8'), LOCAL, 'nothing is written beside the module');
  } finally {
    await vault.close();
  }
});

test('a secrets module whose own settings neither the environment nor the secrets file holds is refused as the project loads', async () => {
  const vault = await serveSecretsModule({ listen: 0 });
  try {
    const dir = project(vault, { local: null });
    const refused = await lf(dir, ['credential', 'list']).done;
    assert.notEqual(refused.code, 0, refused.out);
    assert.match(refused.out, /the secrets module's own settings come from LF_SECRET__… or the secrets file, not from the module/);
    assert.deepEqual(vault.calls, [], 'the module is never asked for its own settings');
    const fromEnv = await lf(dir, ['credential', 'list'], { env: { LF_SECRET__ACME_VAULT__EXTERNAL: 'acme_vault', LF_SECRET__ACME_VAULT__VAULT: 'test' } }).done;
    assert.equal(fromEnv.code, 0, fromEnv.out);
  } finally {
    await vault.close();
  }
});

const CLIENT = { clientId: 'lf-app', clientSecret: 'lf-app-secret' };

/** A grant at the fake provider, as a person's sign-in leaves one. */
async function signedIn(provider: FakeOAuthServer): Promise<{ access_token: string; refresh_token: string }> {
  const redirect = 'http://127.0.0.1:1/callback';
  const query = new URLSearchParams({ client_id: CLIENT.clientId, response_type: 'code', redirect_uri: redirect });
  const authorized = await fetch(`${provider.authorizeUrl}?${query}`, { redirect: 'manual' });
  const code = new URL(authorized.headers.get('location') ?? '').searchParams.get('code') ?? '';
  const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: CLIENT.clientId, client_secret: CLIENT.clientSecret });
  const answer = await fetch(provider.tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form });
  return (await answer.json()) as { access_token: string; refresh_token: string };
}

test('two lf processes on one secrets module refresh an expiring token once, and both call with the new one', async () => {
  const provider = await startFakeOAuthServer({ ...CLIENT, clientAuth: 'body' });
  const granted = await signedIn(provider);
  const vault = await serveSecretsModule({
    listen: 0,
    seed: acme({
      access_token: granted.access_token,
      refresh_token: granted.refresh_token,
      token_url: provider.tokenUrl,
      client_id: CLIENT.clientId,
      client_secret: CLIENT.clientSecret,
      expires_at: '2000-01-01T00:00:00Z',
    }),
  });
  try {
    const dirs = [project(vault), project(vault)];
    const runs = await Promise.all(dirs.map((dir) => lf(dir, ['run', '--event', EVENT]).done));
    for (const run of runs) assert.equal(run.code, 0, run.out);
    // The provider rotates the refresh token: a second refresh would have been refused.
    assert.equal(provider.calls.filter((c) => c.grant === 'refresh_token').length, 1);
    const refreshed = (await vault.held()).acme?.fields;
    assert.equal(refreshed?.access_token, 'access-2');
    assert.equal(refreshed?.refresh_token, provider.currentRefreshToken());
    for (const dir of dirs) assert.equal(authLog(dir).at(-1), 'Bearer access-2');
    assert.ok(vault.calls.includes('secrets.lock acme'), vault.calls.join('\n'));
    assert.deepEqual(vault.leased(), []);
    for (const run of runs) assert.doesNotMatch(run.out, new RegExp(`${granted.refresh_token}|${CLIENT.clientSecret}`), 'no secret reaches lf’s output');
  } finally {
    await vault.close();
    await provider.close();
  }
});

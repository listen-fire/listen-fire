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

/** The example external declaring an OAuth 2 credential at the fake provider. */
const oauth = (provider: FakeOAuthServer) => [
  { name: 'acme', kind: 'oauth2', fields: [], oauth2: { authorizeUrl: provider.authorizeUrl, tokenUrl: provider.tokenUrl, scopes: ['crm.read'], pkce: true } },
];

test('lf connect writes the install and lf credential add signs in and writes the grant through the secrets module; a second lf process lists both', async () => {
  const provider = await startFakeOAuthServer(CLIENT);
  const vault = await serveSecretsModule({ listen: 0 });
  try {
    const dir = project(vault, { credentials: oauth(provider) });
    const connected = await lf(dir, ['connect', 'acme_crm', '--yes'], { answers: ['dev-acme-token', '', CLIENT.clientId, CLIENT.clientSecret, '0'] }).done;
    assert.equal(connected.code, 0, connected.out);
    const adding = lf(dir, ['credential', 'add', '--module', 'acme_crm', 'alice_acme', '--no-browser']);
    const url = (await adding.line(/^\s+http:\/\/127\.0\.0\.1:\d+\/authorize\?/)).trim();
    const page = await fetch(url);
    assert.equal(page.status, 200, await page.clone().text());
    const added = await adding.done;
    assert.equal(added.code, 0, added.out);

    const held = await vault.held();
    assert.equal(held.acme_crm?.binding, 'install');
    assert.equal(held.acme_crm?.fields.client_id, CLIENT.clientId);
    assert.deepEqual(held.alice_acme?.binding, { credential: 'acme' });
    assert.equal(held.alice_acme?.fields.access_token, 'access-1');
    assert.equal(held.alice_acme?.fields.refresh_token, provider.currentRefreshToken());
    assert.ok(vault.calls.includes('secrets.replace acme_crm'), vault.calls.join('\n'));
    assert.ok(vault.calls.includes('secrets.create alice_acme'), vault.calls.join('\n'));
    assert.deepEqual(vault.leased(), []);
    assert.equal(readFileSync(join(dir, '.lf/secrets.yaml'), 'utf8'), LOCAL, 'nothing is written beside the module');

    // Another lf process finds both, by listing the module.
    const listed = await lf(dir, ['credential', 'list', '--json']).done;
    assert.equal(listed.code, 0, listed.out);
    const credentials = (JSON.parse(listed.out) as { credentials: Array<{ name: string; kept: string[]; binding: string }> }).credentials;
    for (const name of ['acme_crm', 'alice_acme']) assert.deepEqual(credentials.find((c) => c.name === name)?.kept, ['the secrets module acme_vault'], name);
    assert.doesNotMatch(listed.out, new RegExp(`access-1|${CLIENT.clientSecret}|dev-acme-token`), 'no value is listed');
  } finally {
    await vault.close();
    await provider.close();
  }
});

const READ_ONLY = (reason: string) => `acme_vault holds its credentials read-only: ${reason}. Add it where it lives.`;

test('a read-only secrets module makes lf connect, lf credential add, update and delete refuse by name, writing nothing and leaving no lease', async () => {
  const reason = 'it is filled from the platform';
  const vault = await serveSecretsModule({
    listen: 0,
    readOnly: reason,
    seed: { ...acme({ access_token: 'vault-token' }), bob: { external: 'acme_crm', binding: { credential: 'acme_key' }, fields: { api_key: 'bob-key' } } },
  });
  try {
    const dir = project(vault, { credentials: STATIC });
    const before = await vault.held();
    const refused = [
      await lf(dir, ['connect', '@lf/anthropic'], { answers: ['sk-test-key', ''] }).done,
      await lf(dir, ['credential', 'add', '--module', 'acme_crm', 'ada'], { answers: ['ada-key', ''] }).done,
      await lf(dir, ['credential', 'update', 'bob'], { answers: ['new-key', ''] }).done,
      await lf(dir, ['credential', 'delete', 'bob']).done,
    ];
    for (const run of refused) {
      assert.equal(run.code, 2, run.out);
      assert.ok(run.out.includes(READ_ONLY(reason)), run.out);
      assert.doesNotMatch(run.out, /sk-test-key|ada-key|new-key|bob-key|vault-token/, 'no secret reaches lf’s output');
    }
    assert.deepEqual(await vault.held(), before, 'the vault is unchanged');
    assert.deepEqual(vault.leased(), [], 'no lease is left held');
    assert.equal(readFileSync(join(dir, '.lf/secrets.yaml'), 'utf8'), LOCAL, 'nothing is written beside the module');
  } finally {
    await vault.close();
  }
});

test('a token refresh is still written back to a read-only secrets module: read-only is whole entries only', async () => {
  const provider = await startFakeOAuthServer({ ...CLIENT, clientAuth: 'body' });
  const granted = await signedIn(provider);
  const vault = await serveSecretsModule({
    listen: 0,
    readOnly: 'it is filled from the platform',
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
    const dir = project(vault);
    const run = await lf(dir, ['run', '--event', EVENT]).done;
    assert.equal(run.code, 0, run.out);
    assert.equal(authLog(dir).at(-1), 'Bearer access-2');
    const refreshed = (await vault.held()).acme?.fields;
    assert.equal(refreshed?.access_token, 'access-2');
    assert.equal(refreshed?.refresh_token, provider.currentRefreshToken());
    assert.deepEqual(vault.leased(), []);
  } finally {
    await vault.close();
    await provider.close();
  }
});

test('a read-only secrets module refuses lf credential add and update before the sign-in: nothing reaches the provider', async () => {
  const reason = 'it is filled from the platform';
  const provider = await startFakeOAuthServer(CLIENT);
  const vault = await serveSecretsModule({
    listen: 0,
    readOnly: reason,
    seed: {
      acme_crm: { external: 'acme_crm', binding: 'install', fields: { access_token: 'dev-acme-token', client_id: CLIENT.clientId, client_secret: CLIENT.clientSecret } },
      alice_acme: { external: 'acme_crm', binding: { credential: 'acme' }, fields: { access_token: 'alice-access', refresh_token: 'alice-refresh' } },
    },
  });
  try {
    const dir = project(vault, { credentials: oauth(provider) });
    const before = await vault.held();
    const refused = [
      await lf(dir, ['credential', 'add', '--module', 'acme_crm', 'ada', '--no-browser']).done,
      await lf(dir, ['credential', 'update', 'alice_acme', '--no-browser']).done,
    ];
    for (const run of refused) {
      assert.equal(run.code, 2, run.out);
      assert.ok(run.out.includes(READ_ONLY(reason)), run.out);
      assert.doesNotMatch(run.out, /authorize\?/, 'no sign-in link was printed');
    }
    assert.deepEqual(provider.authorizations, [], 'the provider was never sent to');
    assert.deepEqual(provider.calls, [], 'the provider was never called');
    assert.ok(vault.calls.includes('secrets.assertWritable ada') && vault.calls.includes('secrets.assertWritable alice_acme'), vault.calls.join('\n'));
    assert.deepEqual(await vault.held(), before, 'the vault is unchanged');
  } finally {
    await vault.close();
    await provider.close();
  }
});

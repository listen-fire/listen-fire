// Runners sharing one webhook (docs/contracts/adapter-protocol.md, "A webhook
// several runners share"): real `listen-fire serve` processes, each a project
// of its own, on one secrets module (the test vault) and one fake provider,
// all pointed at one public address. The provider is a module served here, so
// a test reads which webhooks it holds and every call that changed them; the
// vault says who holds each.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXAMPLE, served, type Served } from './example';
import { serveSecretsModule, type SecretsModule } from './secrets_module/serve';

const PUBLIC = 'https://hooks.example/lf';
const REGISTERED = /registered webhook wh-\d+ for the arrivals on Notes at /;
const SHORT_LEASE = { LF_WEBHOOK_LEASE_MS: '1500' };

interface Webhook {
  id: string;
  key: string;
  title: string | undefined;
  secret: string;
  url: string;
}

/** A provider that holds webhooks, as Attio does: one made per call that names
 *  no `current`, however many deliver to the same door. */
class Provider {
  readonly live = new Map<string, Webhook>();
  made = 0;
  removed: string[] = [];
  private constructor(
    private readonly server: Server,
    readonly url: string,
    /** How long making a webhook takes: wide enough for two runners to race. */
    private readonly latencyMs: number,
  ) {}

  static async start(latencyMs = 0): Promise<Provider> {
    let provider: Provider | undefined;
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const request = JSON.parse(body) as { method: string; params: Record<string, unknown> };
        void provider!
          .answer(request.method, request.params)
          .then((result) => ({ ok: true, result }))
          .catch((error: Error) => ({ ok: false, error: { code: 'adapter_error', message: error.message, retryable: false } }))
          .then((reply) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(reply));
          });
      });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    provider = new Provider(server, `http://127.0.0.1:${(server.address() as AddressInfo).port}`, latencyMs);
    return provider;
  }

  /** The titles its live webhooks filter on, sorted. */
  titles(): (string | undefined)[] {
    return [...this.live.values()].map((w) => w.title).sort();
  }

  only(): Webhook {
    assert.equal(this.live.size, 1, JSON.stringify([...this.live.values()]));
    return [...this.live.values()][0]!;
  }

  close(): Promise<void> {
    return new Promise((done) => {
      this.server.close(() => done());
      this.server.closeAllConnections();
    });
  }

  private async answer(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'manifest':
        return {
          protocolVersion: 2,
          protocolMinor: 6,
          adapterType: 'feed',
          supportedTriggers: ['webhook'],
          runtimeCapabilities: { traversal: { incoming: false, edgeProperties: false }, resources: false },
          credentials: [{ name: 'feed', kind: 'static', fields: [{ name: 'token', optional: true }] }],
          methods: ['listEntryPoints', 'describe', 'getFieldValue', 'getRelated', 'preprocessInbound', 'ensureEventSubscription', 'removeEventSubscription'],
        };
      case 'listEntryPoints':
        return [
          {
            typeId: 'Note',
            displayName: 'Note',
            collectionName: 'Notes',
            writable: false,
            readable: false,
            listenable: true,
            identity: 'Id',
            delivery: 'connection',
            capability: { filter: 'native', supportsLimit: false },
          },
        ];
      case 'describe':
        return {
          typeId: 'Note',
          displayName: 'Note',
          fields: [
            { fieldId: 'Id', displayName: 'Id', kind: 'string', writable: false, required: true },
            { fieldId: 'Title', displayName: 'Title', kind: 'string', writable: false, required: true, capability: { filterOperators: ['eq'] } },
          ],
          references: [],
        };
      case 'getFieldValue':
        return null;
      case 'getRelated':
        return [];
      case 'preprocessInbound': {
        const notes = (params.raw as { notes: Array<{ id: string; Title: string }> }).notes;
        const arrivals = notes.map(({ id, Title }) => ({
          edge: 'Notes',
          identity: id,
          landing: { recordId: id, recordType: 'Note', fields: { Id: id, Title } },
          takenApplied: true,
        }));
        return { events: [], arrivals };
      }
      case 'ensureEventSubscription': {
        if (params.current !== undefined) return null;
        this.made += 1;
        const id = `wh-${this.made}`;
        await new Promise((done) => setTimeout(done, this.latencyMs));
        const url = params.callbackUrl as string;
        const filter = params.filter as { right?: { value?: string } } | undefined;
        this.live.set(id, { id, key: url.split('/').at(-1)!, title: filter?.right?.value, secret: `secret-${id}`, url });
        return { externalId: id, secret: `secret-${id}` };
      }
      case 'removeEventSubscription': {
        const id = params.externalId as string;
        this.removed.push(id);
        this.live.delete(id);
        return null;
      }
      default:
        throw new Error(`no method "${method}"`);
    }
  }
}

const header = readFileSync(join(EXAMPLE, 'lf.yaml'), 'utf8').split('\n').filter((line) => line.startsWith('engine:')).join('\n');

/** The movement a runner serves: a listen on the notes titled each of `titles`. */
function movement(titles: string[]): string {
  const functions = titles.map((t) => `function on_${t}(note: <f-[:Note]->>) {\n  return "${t}"\n}\n`).join('\n');
  const listens = titles.map((t) => `listen to f-[n:Notes WHERE n.Title == "${t}"]-> fire on_${t}\n`).join('');
  return `import { feed } from adapters\nimport { shared } from credentials\n\nf = connect feed using shared\n\n${functions}\n${listens}`;
}

/** A project of its own: its movement, the provider, the vault (none: the
 *  secrets file) and the address its webhooks are registered at. */
function project(provider: Provider, titles: string[], options: { vault?: SecretsModule; publicUrl?: string } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'lf-shared-webhook-'));
  for (const folder of ['.lf', 'movements', 'externals/feed']) mkdirSync(join(dir, folder), { recursive: true });
  writeFileSync(join(dir, 'lf.yaml'), `${header}\nmovements: movements\nexternals: externals\npublicUrl: ${options.publicUrl ?? PUBLIC}\n`);
  writeFileSync(
    join(dir, 'externals/feed/lf-external.yaml'),
    `name: feed\nkind: adapter\nprotocol: 2\nurl: ${provider.url}\nwebhook:\n  signature: hmac-sha256\n  secretField: webhook_secret\n  deliveryIdHeader: X-Feed-Delivery\n`,
  );
  writeFileSync(join(dir, 'movements/noted.mvt'), movement(titles));
  if (options.vault !== undefined) {
    mkdirSync(join(dir, 'externals/acme_vault'));
    writeFileSync(join(dir, 'externals/acme_vault/lf-external.yaml'), `name: acme_vault\nkind: core\nslot: secrets\nurl: ${options.vault.url}\nsettings:\n  - { name: vault, label: the vault credentials are kept in }\n`);
    appendFileSync(join(dir, 'lf.yaml'), 'core:\n  secrets: acme_vault\n');
    writeFileSync(join(dir, '.lf/secrets.yaml'), 'acme_vault:\n  module: acme_vault\n  vault: test\n', { mode: 0o600 });
  } else {
    writeFileSync(join(dir, '.lf/secrets.yaml'), SHARED_FILE, { mode: 0o600 });
  }
  return dir;
}

const SHARED_FILE = 'shared:\n  external: feed\n  webhook_secret: unused\n  token: t\n';

async function vaultWithCredential(): Promise<SecretsModule> {
  return serveSecretsModule({ listen: 0, seed: { shared: { external: 'feed', binding: 'legacy', fields: { webhook_secret: 'unused', token: 't' } } } });
}

/** Who the vault says holds each webhook: the releases of its holders, by key. */
async function holders(vault: SecretsModule): Promise<Record<string, Array<{ release: string; events: string[]; until: string }>>> {
  const field = (await vault.held()).shared?.fields.webhook_holders;
  if (field === undefined) return {};
  const all = JSON.parse(field) as Record<string, Record<string, { release: string; events: string[]; until: string }>>;
  return Object.fromEntries(Object.entries(all).map(([key, byInstance]) => [key, Object.values(byInstance)]));
}

const holderCount = async (vault: SecretsModule, key: string): Promise<number> => (await holders(vault))[key]?.length ?? 0;

async function until(what: string, holds: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await holds())) {
    if (Date.now() > deadline) throw new Error(`never: ${what}`);
    await new Promise((done) => setTimeout(done, 50));
  }
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** A delivery to a runner's own door for `webhook`, as a fan out brings it. */
async function deliver(serving: Served, webhook: Webhook, id: string, title: string): Promise<number> {
  const body = JSON.stringify({ notes: [{ id, Title: title }] });
  const signature = createHmac('sha256', webhook.secret).update(body).digest('hex');
  const headers = { 'content-type': 'application/json', 'x-listen-fire-signature': signature, 'x-feed-delivery': id };
  const answer = await fetch(`http://127.0.0.1:${serving.port}/api/public/webhook-sync/feed/shared/${webhook.key}`, { method: 'POST', headers, body });
  return answer.status;
}

/** A provider and a vault for a test, closed after it. */
async function world<T>(body: (provider: Provider, vault: SecretsModule, serving: (dir: string, env?: Record<string, string>) => Promise<Served>) => Promise<T>, latencyMs = 0): Promise<T> {
  const provider = await Provider.start(latencyMs);
  const vault = await vaultWithCredential();
  const runners: Served[] = [];
  try {
    return await body(provider, vault, async (dir, env = {}) => {
      const runner = await served(dir, [], env);
      runners.push(runner);
      return runner;
    });
  } finally {
    await Promise.all(runners.map((runner) => runner.stop()));
    await vault.close();
    await provider.close();
  }
}

test('a second runner wanting the identical webhook registers nothing new, and both doors take its deliveries', () =>
  world(async (provider, vault, serving) => {
    const first = await serving(project(provider, ['x'], { vault }));
    await first.waitFor(REGISTERED);
    const webhook = provider.only();
    assert.deepEqual((await holders(vault))[webhook.key]?.map((h) => [h.release.length > 0, h.events]), [[true, []]]);

    const second = await serving(project(provider, ['x'], { vault }));
    await second.waitFor(/webhook wh-1 is registered for the arrivals on Notes at /);
    assert.equal(provider.made, 1, 'nothing registered anew');
    assert.equal(provider.only().id, webhook.id);
    assert.equal(await holderCount(vault, webhook.key), 2, JSON.stringify(await holders(vault)));

    // The secret the provider issued to the first reached the second through
    // the vault: a delivery fanned out to both is verified at both.
    assert.equal(await deliver(first, webhook, 'n-1', 'x'), 200);
    assert.equal(await deliver(second, webhook, 'n-1', 'x'), 200);
    await first.waitFor(/^run \S+ noted:on_x completed/);
    await second.waitFor(/^run \S+ noted:on_x completed/);
  }));

test('two runners starting at once register one webhook between them, and neither is lost as a holder', () =>
  world(
    async (provider, vault, serving) => {
      const [first, second] = await Promise.all([serving(project(provider, ['x'], { vault })), serving(project(provider, ['x'], { vault }))]);
      await first.waitFor(/webhook wh-\d+ .*(for|is registered for) the arrivals on Notes at /);
      await second.waitFor(/webhook wh-\d+ .*(for|is registered for) the arrivals on Notes at /);
      assert.equal(provider.made, 1, 'one registration');
      assert.equal(await holderCount(vault, provider.only().key), 2, JSON.stringify(await holders(vault)));
      assert.deepEqual(vault.leased(), [], 'each webhook lease let go');
    },
    300,
  ));

test('runners wanting different notes keep a webhook each: what is registered is the union of what they want', () =>
  world(async (provider, vault, serving) => {
    const first = await serving(project(provider, ['x'], { vault }), SHORT_LEASE);
    await first.waitFor(REGISTERED);
    const second = await serving(project(provider, ['y'], { vault }), SHORT_LEASE);
    await second.waitFor(REGISTERED);
    assert.deepEqual(provider.titles(), ['x', 'y'], 'the second narrowed nothing');
    // Past two leases, each runner having renewed and seen the other's: still both.
    await sleep(3_500);
    assert.deepEqual(provider.titles(), ['x', 'y']);
    assert.deepEqual(provider.removed, [], 'neither removed the other, live');
    for (const webhook of provider.live.values()) assert.equal(await holderCount(vault, webhook.key), 1);
  }));

test('a runner whose last listen goes leaves a webhook another listens through; the last to leave removes it at once', () =>
  world(async (provider, vault, serving) => {
    const dirs = [project(provider, ['x'], { vault }), project(provider, ['x'], { vault })];
    const first = await serving(dirs[0]!);
    await first.waitFor(REGISTERED);
    const second = await serving(dirs[1]!);
    await second.waitFor(/is registered for the arrivals on Notes at /);
    const webhook = provider.only();

    writeFileSync(join(dirs[1]!, 'movements/noted.mvt'), movement([]));
    await second.waitFor(/no listen here needs its webhook any more; webhook wh-1 stays for the 1 other runner\(s\) listening/);
    assert.deepEqual(provider.removed, []);
    assert.equal(await holderCount(vault, webhook.key), 1);

    writeFileSync(join(dirs[0]!, 'movements/noted.mvt'), movement([]));
    await first.waitFor(/no listen needs its webhook any more; removed webhook wh-1/);
    assert.deepEqual(provider.removed, ['wh-1']);
    assert.deepEqual(await holders(vault), {}, 'its holders go with it');
    assert.equal((await vault.held()).shared?.fields.edge_subscriptions, undefined);
  }));

test('a runner stopping leaves the webhook to the other, whose last listen going removes it at once', () =>
  world(async (provider, vault, serving) => {
    const dirs = [project(provider, ['x'], { vault }), project(provider, ['x'], { vault })];
    const first = await serving(dirs[0]!);
    await first.waitFor(REGISTERED);
    const second = await serving(dirs[1]!);
    await second.waitFor(/is registered for the arrivals on Notes at /);
    const webhook = provider.only();

    await first.stop();
    assert.equal(provider.only().id, webhook.id, 'it stays');
    assert.equal(await holderCount(vault, webhook.key), 1, 'and only the other holds it');

    writeFileSync(join(dirs[1]!, 'movements/noted.mvt'), movement([]));
    await second.waitFor(/no listen needs its webhook any more; removed webhook wh-1/);
    assert.deepEqual(provider.removed, ['wh-1']);
  }));

test('a holder that died expires, and a live runner that does not want its webhook removes it', () =>
  world(async (provider, vault, serving) => {
    const dying = await served(project(provider, ['x'], { vault }), [], SHORT_LEASE);
    await dying.waitFor(REGISTERED);
    const dead = provider.only();
    const living = await serving(project(provider, ['y'], { vault }), SHORT_LEASE);
    await living.waitFor(REGISTERED);
    assert.deepEqual(provider.titles(), ['x', 'y'], 'while it lives, it keeps its webhook');

    await dying.kill();
    assert.ok(provider.live.has(dead.id), 'not at once');
    await until('the dead holder’s webhook goes', () => !provider.live.has(dead.id));
    await living.waitFor(new RegExp(`no listen needs its webhook any more; removed webhook ${dead.id}`));
    assert.deepEqual(provider.titles(), ['y'], 'the live one keeps its own');
    assert.equal(await holderCount(vault, dead.key), 0);
  }));

test('a holder that died and comes back within its lease keeps its webhook', () =>
  world(async (provider, vault, serving) => {
    const dir = project(provider, ['x'], { vault });
    const dying = await served(dir, [], { LF_WEBHOOK_LEASE_MS: '60000' });
    await dying.waitFor(REGISTERED);
    await dying.kill();
    const back = await serving(dir, { LF_WEBHOOK_LEASE_MS: '60000' });
    await back.waitFor(/webhook wh-1 is registered for the arrivals on Notes at /);
    assert.equal(provider.made, 1);
    assert.deepEqual(provider.removed, []);
  }));

test('a lone runner on a shared module behaves as it always has: kept across a restart, removed at once when its last listen goes', () =>
  world(async (provider, vault, serving) => {
    const dir = project(provider, ['x'], { vault });
    const first = await serving(dir);
    const url = `${PUBLIC}/api/public/webhook-sync/feed/shared/`;
    assert.match(await first.waitFor(REGISTERED), new RegExp(`^feed \\(Notes, edge-[0-9a-f]+\\): registered webhook wh-1 for the arrivals on Notes at ${url}edge-[0-9a-f]+$`));
    await first.stop();
    assert.equal(provider.only().id, 'wh-1', 'stopping removes nothing');
    assert.deepEqual(await holders(vault), {});

    const second = await serving(dir);
    await second.waitFor(/webhook wh-1 is registered for the arrivals on Notes at /);
    assert.equal(provider.made, 1);
    writeFileSync(join(dir, 'movements/noted.mvt'), movement([]));
    await second.waitFor(/no listen needs its webhook any more; removed webhook wh-1/);
    assert.deepEqual(provider.removed, ['wh-1']);
    assert.equal(provider.live.size, 0);
  }));

test('a lone runner on the secrets file writes no holders, and keeps a webhook as it always has', async () => {
  const provider = await Provider.start();
  try {
    const dir = project(provider, ['x']);
    const first = await served(dir);
    await first.waitFor(REGISTERED);
    await first.stop();
    const secrets = readFileSync(join(dir, '.lf/secrets.yaml'), 'utf8');
    assert.match(secrets, /edge_subscriptions/);
    assert.doesNotMatch(secrets, /webhook_holders/);
    assert.equal(provider.only().id, 'wh-1');

    const second = await served(dir);
    try {
      await second.waitFor(/webhook wh-1 is registered for the arrivals on Notes at /);
      assert.equal(provider.made, 1);
      writeFileSync(join(dir, 'movements/noted.mvt'), movement([]));
      await second.waitFor(/no listen needs its webhook any more; removed webhook wh-1/);
      assert.equal(provider.live.size, 0);
    } finally {
      await second.stop();
    }
    assert.doesNotMatch(readFileSync(join(dir, '.lf/secrets.yaml'), 'utf8'), /webhook_holders/);
  } finally {
    await provider.close();
  }
});

test('a webhook with no holders, as one registered before this release has, is removed by the first runner that does not want it, and adopted by one that does', () =>
  world(async (provider, vault, serving) => {
    const before = await serving(project(provider, ['x'], { vault }));
    await before.waitFor(REGISTERED);
    await before.stop();
    const webhook = provider.only();
    assert.deepEqual(await holders(vault), {}, 'held by nobody known');

    const adopting = await serving(project(provider, ['x'], { vault }));
    await adopting.waitFor(/webhook wh-1 is registered for the arrivals on Notes at /);
    assert.equal(provider.made, 1, 'asked with `current`, nothing made');
    assert.equal(await holderCount(vault, webhook.key), 1);
    await adopting.stop();
    assert.deepEqual(await holders(vault), {});

    const other = await serving(project(provider, ['y'], { vault }));
    await other.waitFor(/no listen needs its webhook any more; removed webhook wh-1/);
    assert.deepEqual(provider.titles(), ['y']);
  }));

test('a runner at another address does not move a webhook others listen through, and says so', () =>
  world(async (provider, vault, serving) => {
    const first = await serving(project(provider, ['x'], { vault }));
    await first.waitFor(REGISTERED);
    const elsewhere = await serving(project(provider, ['x'], { vault, publicUrl: 'https://elsewhere.example/lf' }));
    await elsewhere.waitFor(/webhook wh-1 stays at https:\/\/hooks\.example\/lf\/.* does not reach https:\/\/elsewhere\.example\/lf\/.*: runners sharing a webhook share one publicUrl/);
    assert.equal(provider.made, 1);
    assert.deepEqual(provider.removed, []);
    assert.equal(provider.only().url.startsWith(PUBLIC), true);
    assert.equal(await holderCount(vault, provider.only().key), 2);
  }));

test('a read-only secrets module writes no holders: a webhook is refused where it would have to be kept, as ever', async () => {
  const provider = await Provider.start();
  const vault = await serveSecretsModule({ listen: 0, readOnly: 'the deployment fills it', seed: { shared: { external: 'feed', binding: 'legacy', fields: { webhook_secret: 'unused', token: 't' } } } });
  try {
    const runner = await served(project(provider, ['x'], { vault }));
    try {
      await runner.waitFor(/its webhook is not registered — acme_vault holds its credentials read-only: the deployment fills it\. Add it where it lives\. Register the webhook where the credentials live\./);
    } finally {
      await runner.stop();
    }
    assert.equal((await vault.held()).shared?.fields.webhook_holders, undefined);
  } finally {
    await vault.close();
    await provider.close();
  }
});

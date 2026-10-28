// The module's seams with its host: how the context's credential becomes a
// client, and what the module declares.

import { emptyOcrSlot, type CredentialFields, type ModuleContext } from 'module-kit';
import { emptyBrowserSlot } from 'movement-engine/public/browser';

import { GITHUB_API_VERSION } from '../api_client';
import { GITHUB_NOTIFICATION_REASONS } from '../types';
import { githubClientFrom, githubModule, GITHUB_POLL_INTERVAL_SECONDS } from '../index';

interface Seen {
  url: string;
  headers: Record<string, string>;
}

function contextOver(fields: () => CredentialFields, config: { baseUrlOverride?: string } = {}): { ctx: ModuleContext; seen: Seen[] } {
  const refuse = (): never => {
    throw new Error('not used');
  };
  const seen: Seen[] = [];
  const ctx: ModuleContext = {
    credential: { name: 'github', fields: async () => fields(), update: async () => refuse() },
    spend: { charge: () => undefined },
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)) });
      return new Response(JSON.stringify([]), { status: 200 });
    }) as typeof fetch,
    log: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    files: { put: refuse, read: refuse, expose: refuse },
    kv: { get: refuse, set: refuse, delete: refuse, list: refuse, compareAndSet: refuse },
    models: { chat: refuse, chatStructured: refuse },
    identities: { list: refuse, find: refuse },
    browser: emptyBrowserSlot('none'),
    ocr: emptyOcrSlot('none'),
    config: { tenant: 'team-1', constructionArgs: {}, ...config },
  };
  return { ctx, seen };
}

describe('githubClientFrom', () => {
  it('says how to add a token when the credential holds none', async () => {
    const source = githubClientFrom(contextOver(() => ({})).ctx);
    await expect(source()).rejects.toThrow(/holds no token\. Add one: lf credential add --module github/);
  });

  it('reaches api.github.com through the host fetch, with the token and the pinned API version', async () => {
    const { ctx, seen } = contextOver(() => ({ token: 'ghp_x' }));
    await (await githubClientFrom(ctx)()).listRepositories();
    expect(seen).toEqual([
      {
        url: 'https://api.github.com/user/repos?sort=full_name&per_page=100&page=1',
        headers: {
          Authorization: 'Bearer ghp_x',
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': GITHUB_API_VERSION,
          'User-Agent': 'listen-fire',
        },
      },
    ]);
  });

  it('reaches GitHub Enterprise Server at the credential’s base URL', async () => {
    const { ctx, seen } = contextOver(() => ({ token: 't', baseUrl: 'https://ghe.example.com/api/v3/' }));
    await (await githubClientFrom(ctx)()).listRepositories(1);
    expect(seen.map((s) => s.url)).toEqual(['https://ghe.example.com/api/v3/user/repos?sort=full_name&per_page=1&page=1']);
  });

  it('prefers the host base URL override (the dev loop fake) over the credential', async () => {
    const { ctx, seen } = contextOver(() => ({ token: 't', baseUrl: 'https://ghe.example.com/api/v3' }), { baseUrlOverride: 'http://127.0.0.1:1/github' });
    await (await githubClientFrom(ctx)()).listRepositories(1);
    expect(seen.map((s) => s.url)).toEqual(['http://127.0.0.1:1/github/user/repos?sort=full_name&per_page=1&page=1']);
  });

  it('reads the credential per call, so an edit between calls is seen by the next', async () => {
    let fields: CredentialFields = { token: 'one', baseUrl: 'https://one.example' };
    const { ctx, seen } = contextOver(() => fields);
    const source = githubClientFrom(ctx);
    const first = await source();
    expect(await source()).toBe(first);
    fields = { token: 'two', baseUrl: 'https://two.example' };
    await (await source()).listRepositories(1);
    expect(seen.map((s) => [s.url.split('?')[0], s.headers.Authorization])).toEqual([['https://two.example/user/repos', 'Bearer two']]);
  });
});

describe('githubModule', () => {
  it('declares a token credential with an optional base URL, and a one-minute poll', () => {
    expect(githubModule.credentials[0]?.fields.map((f) => [f.name, f.optional === true])).toEqual([
      ['token', false],
      ['baseUrl', true],
    ]);
    expect(githubModule.poll).toEqual({ intervalSeconds: GITHUB_POLL_INTERVAL_SECONDS });
    expect(GITHUB_POLL_INTERVAL_SECONDS).toBe(60);
  });

  it('is a polled source with no inbound, whose events are GitHub’s notification reasons', () => {
    expect(githubModule.manifest.supportedTriggers).toEqual(['poll']);
    expect('inbound' in githubModule).toBe(false);
    expect(githubModule.manifest.subscribableEvents).toEqual([...GITHUB_NOTIFICATION_REASONS]);
    expect(githubModule.manifest.methods).toEqual(expect.arrayContaining(['createRecord']));
    expect(githubModule.manifest.methods).not.toEqual(expect.arrayContaining(['updateRecord']));
  });
});

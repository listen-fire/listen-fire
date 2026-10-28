// `@lf/github`: GitHub as a module. The host hands it the install's
// credential (a personal access token, and optionally an API base URL for
// GitHub Enterprise Server) and a fetch; the module builds a client per call
// from them, so a credential edited between calls is read by the next one.
// `ctx.config.baseUrlOverride` (the dev loop's fake) wins over the
// credential's own base URL.

import { defineModule, type CredentialFields, type ModuleContext } from 'module-kit';

import { GithubClient, githubCredsParser } from './api_client';
import { GithubAdapter, type GithubClientSource } from './adapter';
import { GITHUB_MANIFEST } from './manifest';
import { GITHUB_POLL_INTERVAL_SECONDS, pollGithub } from './poll';

/** The client the context's credential reaches GitHub with. */
export function githubClientFrom(ctx: ModuleContext): GithubClientSource {
  // The client for the fields last read: a host hands back the same fields
  // until the credential changes, so one client serves until then.
  let last: { fields: CredentialFields; client: GithubClient } | undefined;
  return async () => {
    const fields = await ctx.credential.fields();
    if (last?.fields === fields) return last.client;
    const parsed = githubCredsParser.safeParse(fields);
    if (!parsed.success) {
      throw new Error('GitHub: the connected credential holds no token. Add one: lf credential add --module github <name>.');
    }
    const baseUrl = ctx.config.baseUrlOverride ?? parsed.data.baseUrl;
    const client = new GithubClient({
      token: parsed.data.token,
      ...(baseUrl !== undefined ? { baseUrl } : {}),
      fetch: ctx.fetch,
      log: ctx.log,
    });
    last = { fields, client };
    return client;
  };
}

export const githubModule = defineModule({
  kind: 'adapter',
  name: '@lf/github',
  manifest: GITHUB_MANIFEST,
  // The stored payload: `{ token, baseUrl? }`.
  credentials: [
    {
      name: 'github',
      kind: 'static',
      fields: [
        { name: 'token', label: 'Personal access token (fine-grained or classic)' },
        { name: 'baseUrl', label: 'API base URL (GitHub Enterprise Server: https://<host>/api/v3)', secret: false, optional: true },
      ],
    },
  ],
  poll: { intervalSeconds: GITHUB_POLL_INTERVAL_SECONDS },
  create: (ctx) => {
    const client = githubClientFrom(ctx);
    return Object.assign(new GithubAdapter(client), {
      poll: async (input: Parameters<typeof pollGithub>[1]) => pollGithub(await client(), input),
    });
  },
});

export default githubModule;

export * from './adapter';
export * from './api_client';
export * from './filter';
export * from './manifest';
export * from './poll';
export * from './schema';
export * from './types';
export * from './write';

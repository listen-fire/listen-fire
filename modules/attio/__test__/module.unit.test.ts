// The module as a host loads it: a connection holds exactly one of two
// credentials, an OAuth sign-in or a static access token, and either reaches
// Attio as the same bearer header.

import type { ModuleContext } from 'module-kit';

import { attioClientFrom, attioModule } from '../index';

function context(fields: Record<string, string>, baseUrlOverride?: string): ModuleContext {
  return { credential: { fields: async () => fields }, config: { tenant: 't', baseUrlOverride } } as unknown as ModuleContext;
}

describe('@lf/attio credentials', () => {
  it('declares an OAuth sign-in and a static access token as alternatives', () => {
    expect(attioModule.credentials).toEqual([
      expect.objectContaining({
        name: 'attio',
        kind: 'oauth2',
        oauth2: expect.objectContaining({ tokenUrl: 'https://app.attio.com/oauth/token' }),
        fields: [expect.objectContaining({ name: 'baseUrl' }), expect.objectContaining({ name: 'apiTokenId' })],
      }),
      {
        name: 'attio_token',
        kind: 'static',
        fields: [
          { name: 'accessToken', label: 'Access token' },
          { name: 'baseUrl', label: 'Base URL', secret: false, optional: true },
        ],
      },
    ]);
  });
});

describe('@lf/attio client from the connected credential', () => {
  const fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ workspace_slug: 'acme' }), { status: 200 }));
  });

  const seen = () => fetchMock.mock.calls.map(([url, init]) => [String(url), (init as RequestInit).headers] as const);

  it('sends a static credential’s accessToken as a bearer header, at its own base URL', async () => {
    const client = await attioClientFrom(context({ accessToken: 'static-token-1', baseUrl: 'https://attio.example.test' }))();
    await expect(client.getWorkspaceSlug()).resolves.toBe('acme');
    expect(seen()).toEqual([['https://attio.example.test/v2/self', expect.objectContaining({ Authorization: 'Bearer static-token-1' })]]);
  });

  it('sends an OAuth credential’s access_token the same way', async () => {
    const client = await attioClientFrom(context({ access_token: 'oauth-token-1', baseUrl: '' }))();
    await client.getWorkspaceSlug();
    expect(seen()).toEqual([['https://api.attio.com/v2/self', expect.objectContaining({ Authorization: 'Bearer oauth-token-1' })]]);
  });

  it('lets the dev loop’s override win over a static credential’s base URL', async () => {
    const client = await attioClientFrom(context({ accessToken: 'static-token-2', baseUrl: 'https://attio.example.test' }, 'http://127.0.0.1:9'))();
    await client.getWorkspaceSlug();
    expect(seen()[0]?.[0]).toBe('http://127.0.0.1:9/v2/self');
  });

  it('names the problem when the credential holds no token', async () => {
    await expect(attioClientFrom(context({}))()).rejects.toThrow(/holds no access token/);
  });
});

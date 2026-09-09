import { maybePrincipal } from '../ambient';
import { principalMiddleware, principalRequestFromExpress } from '../express';
import type { ExpressRequestLike, ExpressResponseLike } from '../express';
import type { Principal, PrincipalProvider, PrincipalResult } from '../principal';

const PRINCIPAL: Principal = {
  teamId: 'team-1',
  userId: 'user-1',
  access: 'write',
  scopes: ['*'],
  pinnedTeamId: 'team-1',
};

function provider(result: PrincipalResult | Error): PrincipalProvider {
  return {
    authenticate: async () => {
      if (result instanceof Error) throw result;
      return result;
    },
    listTeams: async () => [],
    resolveTeam: async () => ({
      teamId: 'team-1',
      name: 'Local',
      access: 'write',
      isPersonal: false,
    }),
  };
}

function fakeResponse() {
  const sent: { status?: number; body?: unknown; headers: Record<string, string> } = {
    headers: {},
  };
  const res: ExpressResponseLike = {
    status(code) {
      sent.status = code;
      return res;
    },
    setHeader(name, value) {
      sent.headers[name] = value;
    },
    json(body) {
      sent.body = body;
    },
  };
  return { res, sent };
}

function fakeRequest(overrides: Partial<ExpressRequestLike> = {}): ExpressRequestLike {
  return { method: 'GET', url: '/v1/things', headers: {}, ...overrides };
}

describe('principalRequestFromExpress', () => {
  it('reads headers case-insensitively and prefers the original url', () => {
    const req = principalRequestFromExpress(
      fakeRequest({
        url: '/things',
        originalUrl: '/v1/things?x=1',
        headers: { authorization: 'Bearer k', 'set-cookie': ['a=1', 'b=2'] },
      }),
    );

    expect(req.url).toBe('/v1/things?x=1');
    expect(req.header('Authorization')).toBe('Bearer k');
    expect(req.header('set-cookie')).toBe('a=1');
    expect(req.header('x-missing')).toBeUndefined();
  });

  it('reads cookies from cookie-parser when present and from the header otherwise', () => {
    const parsed = principalRequestFromExpress(
      fakeRequest({
        cookies: { listen_fire_token: 'from-parser' },
        headers: { cookie: 'listen_fire_token=raw' },
      }),
    );
    expect(parsed.cookie('listen_fire_token')).toBe('from-parser');

    const rawOnly = principalRequestFromExpress(
      fakeRequest({ headers: { cookie: 'other=1; listen_fire_token=raw%20value' } }),
    );
    expect(rawOnly.cookie('listen_fire_token')).toBe('raw value');
    expect(rawOnly.cookie('absent')).toBeUndefined();

    const noCookies = principalRequestFromExpress(fakeRequest());
    expect(noCookies.cookie('listen_fire_token')).toBeUndefined();
  });
});

describe('principalMiddleware', () => {
  it('installs the resolved principal for the rest of the chain', async () => {
    const middleware = principalMiddleware({
      provider: provider({ ok: true, principal: PRINCIPAL }),
    });
    const { res, sent } = fakeResponse();

    const downstream = await new Promise<string | undefined>((resolve) => {
      middleware(fakeRequest(), res, () => {
        // Resolving here would leave the ambient run before the assertion; read it first.
        resolve(maybePrincipal()?.teamId);
      });
    });

    expect(downstream).toBe('team-1');
    expect(sent.status).toBeUndefined();
    expect(maybePrincipal()).toBeUndefined();
  });

  it('answers the rejection itself, without calling the chain', async () => {
    const middleware = principalMiddleware({
      provider: provider({
        ok: false,
        status: 401,
        message: 'Missing API key.',
        wwwAuthenticate: 'Bearer realm="listen-fire"',
      }),
    });
    const { res, sent } = fakeResponse();
    const next = jest.fn();

    middleware(fakeRequest(), res, next);
    await new Promise((resolve) => setImmediate(resolve));

    expect(next).not.toHaveBeenCalled();
    expect(sent.status).toBe(401);
    expect(sent.body).toEqual({ error: 'Missing API key.' });
    expect(sent.headers['WWW-Authenticate']).toBe('Bearer realm="listen-fire"');
  });

  it('hands a provider failure to the error chain rather than admitting the request', async () => {
    const boom = new Error('core unreachable');
    const middleware = principalMiddleware({ provider: provider(boom) });
    const { res, sent } = fakeResponse();
    const next = jest.fn();

    middleware(fakeRequest(), res, next);
    await new Promise((resolve) => setImmediate(resolve));

    expect(next).toHaveBeenCalledWith(boom);
    expect(sent.status).toBeUndefined();
  });
});

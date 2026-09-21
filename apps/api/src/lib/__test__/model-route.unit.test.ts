// What a deployment is allowed to say about where its model calls go.
//
// The point of every assertion here is that a HALF-configured route is refused
// at boot: a key that cannot be used is the sign that the deployment believes
// it is on the other route, and a route that half-works is worse than one that
// does not start.

import { assertModelRouteConfigured, modelRoute } from '../model_route';

const GOOGLE_ACCOUNT = {
  GOOGLE_PRIVATE_KEY: 'pk',
  GOOGLE_CLIENT_EMAIL: 'robot@example.iam.gserviceaccount.com',
  GOOGLE_PROJECT_ID: 'a-project',
};

/** The smallest environment that boots on the google route. */
const GOOGLE_ENV = {
  MODEL_ROUTE: 'google',
  KNOWLEDGE_AGENT_PROVIDER: 'anthropic',
  ...GOOGLE_ACCOUNT,
};

describe('reading the route', () => {
  it('treats unset, empty and direct as the same thing', () => {
    expect(modelRoute({})).toBe('direct');
    expect(modelRoute({ MODEL_ROUTE: '' })).toBe('direct');
    expect(modelRoute({ MODEL_ROUTE: 'direct' })).toBe('direct');
  });

  it('reads the google route by name', () => {
    expect(modelRoute({ MODEL_ROUTE: 'google' })).toBe('google');
  });

  it('refuses a route nobody serves', () => {
    expect(() => modelRoute({ MODEL_ROUTE: 'vertex' })).toThrow(/must be "direct" or "google"/);
  });
});

describe('the direct route', () => {
  it('asks nothing of a deployment that sets nothing', () => {
    expect(() => assertModelRouteConfigured({})).not.toThrow();
  });

  it('does not mind vendor keys, Google credentials or agent providers', () => {
    expect(() =>
      assertModelRouteConfigured({
        ANTHROPIC_API_KEY: 'sk-ant',
        OPENAI_API_KEY: 'sk-openai',
        KNOWLEDGE_AGENT_PROVIDER: 'openai',
      }),
    ).not.toThrow();
  });
});

describe('the google route', () => {
  it('boots on the service account alone', () => {
    expect(() => assertModelRouteConfigured(GOOGLE_ENV)).not.toThrow();
  });

  it('refuses a leftover Anthropic key', () => {
    expect(() =>
      assertModelRouteConfigured({ ...GOOGLE_ENV, ANTHROPIC_API_KEY: 'sk-ant' }),
    ).toThrow(/ANTHROPIC_API_KEY is set/);
  });

  it('refuses a leftover knowledge worker key', () => {
    expect(() =>
      assertModelRouteConfigured({ ...GOOGLE_ENV, KNOWLEDGE_LLM_API_KEY: 'sk-ant' }),
    ).toThrow(/KNOWLEDGE_LLM_API_KEY is set/);
  });

  it('refuses either OpenAI key by name', () => {
    expect(() => assertModelRouteConfigured({ ...GOOGLE_ENV, OPENAI_API_KEY: 'sk' })).toThrow(
      /OPENAI_API_KEY is set/,
    );
    expect(() =>
      assertModelRouteConfigured({ ...GOOGLE_ENV, OPENAI_API_KEY_FALLBACK_OR_DEV: 'sk' }),
    ).toThrow(/OPENAI_API_KEY_FALLBACK_OR_DEV is set/);
  });

  it('refuses to boot until the knowledge agents are told to use Claude', () => {
    // Unset is the broken case, not the safe one: three of the four agents fall
    // back to the OpenAI Responses API, which Google does not serve.
    expect(() =>
      assertModelRouteConfigured({ MODEL_ROUTE: 'google', ...GOOGLE_ACCOUNT }),
    ).toThrow(/KNOWLEDGE_AGENT_PROVIDER=anthropic/);
    expect(() =>
      assertModelRouteConfigured({ ...GOOGLE_ENV, KNOWLEDGE_AGENT_PROVIDER: 'openai' }),
    ).toThrow(/Google serves no Responses API/);
  });

  it('names the service account variables a deployment still owes it', () => {
    expect(() =>
      assertModelRouteConfigured({
        MODEL_ROUTE: 'google',
        KNOWLEDGE_AGENT_PROVIDER: 'anthropic',
        GOOGLE_PROJECT_ID: 'a-project',
      }),
    ).toThrow(/set GOOGLE_PRIVATE_KEY, GOOGLE_CLIENT_EMAIL/);
  });
});

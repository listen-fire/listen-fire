// What a deployment is allowed to say about where its model calls go.
//
// The point of every assertion here is that a HALF-configured route is refused
// at boot: a key that cannot be used is the sign that the deployment believes
// it is on the other route, and a route that half-works is worse than one that
// does not start. The two vendors are asked separately, so the MIXED state —
// Claude on Anthropic's own key while the OpenAI-shaped calls go to Google — is
// a supported configuration rather than an accident, and each refusal names the
// variable that actually decided its vendor's route.

import { anthropicRoute, assertModelRouteConfigured, openAiRoute, routeChoice } from '../model_route';

const GOOGLE_ACCOUNT = {
  GOOGLE_PRIVATE_KEY: 'pk',
  GOOGLE_CLIENT_EMAIL: 'robot@example.iam.gserviceaccount.com',
  GOOGLE_PROJECT_ID: 'a-project',
};

/** The smallest environment that boots with both vendors on the google route. */
const GOOGLE_ENV = {
  MODEL_ROUTE: 'google',
  KNOWLEDGE_AGENT_PROVIDER: 'anthropic',
  ...GOOGLE_ACCOUNT,
};

describe('reading the route', () => {
  it('treats unset, empty and direct as the same thing, for both vendors', () => {
    for (const read of [anthropicRoute, openAiRoute]) {
      expect(read({})).toBe('direct');
      expect(read({ MODEL_ROUTE: '' })).toBe('direct');
      expect(read({ MODEL_ROUTE: 'direct' })).toBe('direct');
    }
  });

  it('lets one setting move both vendors', () => {
    expect(anthropicRoute({ MODEL_ROUTE: 'google' })).toBe('google');
    expect(openAiRoute({ MODEL_ROUTE: 'google' })).toBe('google');
  });

  it('lets each vendor override the shared default in either direction', () => {
    const claudeOnly = { ANTHROPIC_MODEL_ROUTE: 'google' };
    expect(anthropicRoute(claudeOnly)).toBe('google');
    expect(openAiRoute(claudeOnly)).toBe('direct');

    const openAiOnly = { OPENAI_MODEL_ROUTE: 'google' };
    expect(anthropicRoute(openAiOnly)).toBe('direct');
    expect(openAiRoute(openAiOnly)).toBe('google');

    // The override wins over the shared default, not just over its absence.
    const heldBack = { MODEL_ROUTE: 'google', ANTHROPIC_MODEL_ROUTE: 'direct' };
    expect(anthropicRoute(heldBack)).toBe('direct');
    expect(openAiRoute(heldBack)).toBe('google');
  });

  it('says which variable decided, so a message can name it', () => {
    expect(routeChoice('openai', { MODEL_ROUTE: 'google' })).toEqual({
      route: 'google',
      decidedBy: 'MODEL_ROUTE',
    });
    expect(routeChoice('openai', { MODEL_ROUTE: 'direct', OPENAI_MODEL_ROUTE: 'google' })).toEqual({
      route: 'google',
      decidedBy: 'OPENAI_MODEL_ROUTE',
    });
    expect(routeChoice('anthropic', { ANTHROPIC_MODEL_ROUTE: 'direct' })).toEqual({
      route: 'direct',
      decidedBy: 'ANTHROPIC_MODEL_ROUTE',
    });
  });

  it('refuses a route nobody serves, naming the variable it came from', () => {
    expect(() => anthropicRoute({ MODEL_ROUTE: 'vertex' })).toThrow(
      /MODEL_ROUTE environment variable must be "direct" or "google"/,
    );
    expect(() => anthropicRoute({ ANTHROPIC_MODEL_ROUTE: 'bedrock' })).toThrow(
      /ANTHROPIC_MODEL_ROUTE environment variable must be "direct" or "google"/,
    );
    expect(() => openAiRoute({ OPENAI_MODEL_ROUTE: 'azure' })).toThrow(
      /OPENAI_MODEL_ROUTE environment variable must be "direct" or "google"/,
    );
    // A garbage shared default is refused even where an override answers, so it
    // cannot sit unread in a deployment that has both.
    expect(() => openAiRoute({ MODEL_ROUTE: 'vertex', OPENAI_MODEL_ROUTE: 'direct' })).toThrow(
      /MODEL_ROUTE environment variable/,
    );
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

  it('names the variable that decided the route, not the one it might have been', () => {
    expect(() =>
      assertModelRouteConfigured({
        ...GOOGLE_ACCOUNT,
        KNOWLEDGE_AGENT_PROVIDER: 'anthropic',
        OPENAI_MODEL_ROUTE: 'google',
        OPENAI_API_KEY: 'sk',
      }),
    ).toThrow(/OPENAI_MODEL_ROUTE is google/);
  });
});

describe('one vendor on google and the other direct', () => {
  /** Claude still on Anthropic's own key; the OpenAI-shaped calls on Google. */
  const MIXED = {
    OPENAI_MODEL_ROUTE: 'google',
    KNOWLEDGE_AGENT_PROVIDER: 'anthropic',
    ...GOOGLE_ACCOUNT,
  };

  it('boots with the Anthropic key it still needs', () => {
    expect(() =>
      assertModelRouteConfigured({ ...MIXED, ANTHROPIC_API_KEY: 'sk-ant' }),
    ).not.toThrow();
    expect(() =>
      assertModelRouteConfigured({ ...MIXED, KNOWLEDGE_LLM_API_KEY: 'sk-ant' }),
    ).not.toThrow();
  });

  it('still refuses the OpenAI key the route cannot use', () => {
    expect(() =>
      assertModelRouteConfigured({ ...MIXED, ANTHROPIC_API_KEY: 'sk-ant', OPENAI_API_KEY: 'sk' }),
    ).toThrow(/OPENAI_API_KEY is set/);
  });

  it('asks the Google service account of the vendor that needs it', () => {
    expect(() =>
      assertModelRouteConfigured({
        OPENAI_MODEL_ROUTE: 'google',
        KNOWLEDGE_AGENT_PROVIDER: 'anthropic',
        ANTHROPIC_API_KEY: 'sk-ant',
      }),
    ).toThrow(/OPENAI_MODEL_ROUTE is google, but its Google service account is not configured/);
  });

  it('holds the other way round too: Claude on Google, OpenAI direct', () => {
    const claudeOnGoogle = { ANTHROPIC_MODEL_ROUTE: 'google', ...GOOGLE_ACCOUNT };
    // The knowledge agents' provider is the OpenAI route's business, so the
    // direct OpenAI route asks nothing of it.
    expect(() =>
      assertModelRouteConfigured({ ...claudeOnGoogle, OPENAI_API_KEY: 'sk' }),
    ).not.toThrow();
    expect(() =>
      assertModelRouteConfigured({ ...claudeOnGoogle, ANTHROPIC_API_KEY: 'sk-ant' }),
    ).toThrow(/ANTHROPIC_MODEL_ROUTE is google.*ANTHROPIC_API_KEY is set/s);
  });
});

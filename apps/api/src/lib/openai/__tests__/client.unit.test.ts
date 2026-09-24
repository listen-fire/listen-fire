// This file declares no imports, so it needs an explicit `export {}` to be a
// MODULE — without it every `const` here joins the global scope and collides
// with the same name in another test file at project typecheck time.
export {};

// Which OpenAI-shaped client a call gets, what the model is called once it is
// addressed to Google, and which JSON schemas that endpoint can honour.
//
// The vendor constructor is mocked: this is about which client is built, with
// what, and nothing here reaches a network.

const openAiCtor = jest.fn();

jest.mock('openai', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(function (this: unknown, options: unknown) {
    openAiCtor(options);
    return { options };
  }),
}));

const bearerToken = jest.fn().mockResolvedValue('ya29.a-google-access-token');
const googleBearerTokens = jest.fn().mockReturnValue(bearerToken);
jest.mock('../../google_cloud', () => ({
  ...jest.requireActual('../../google_cloud'),
  googleBearerTokens: (...args: unknown[]) => googleBearerTokens(...args),
}));

const GOOGLE_ENV = {
  MODEL_ROUTE: 'google',
  KNOWLEDGE_AGENT_PROVIDER: 'anthropic',
  GOOGLE_PRIVATE_KEY: 'pk',
  GOOGLE_CLIENT_EMAIL: 'robot@example.iam.gserviceaccount.com',
  GOOGLE_PROJECT_ID: 'a-project',
};

const DIRECT_ENV = { OPENAI_API_KEY_FALLBACK_OR_DEV: 'sk-dev' };

// Re-imported per test: the clients are memoized per route, and a memo from one
// test would answer for the next.
function load() {
  let mod: typeof import('../client') | undefined;
  jest.isolateModules(() => {
    mod = require('../client');
  });
  if (!mod) throw new Error('module did not load');
  return mod;
}

beforeEach(() => {
  openAiCtor.mockClear();
  googleBearerTokens.mockClear();
  bearerToken.mockClear();
});

describe('the model name on the wire', () => {
  it('leaves every model alone on the direct route', () => {
    const { wireModel } = load().platformOpenAI(DIRECT_ENV);
    expect(wireModel('gpt-4.1')).toBe('gpt-4.1');
    expect(wireModel('a-model-nobody-knows')).toBe('a-model-nobody-knows');
  });

  it('sends reasoning models to the flagship Gemini', () => {
    const { wireModel } = load().platformOpenAI(GOOGLE_ENV);
    for (const model of ['o3', 'gpt-5']) {
      expect(wireModel(model)).toBe('google/gemini-3.1-pro-preview');
    }
  });

  it('sends the small models to the fast Gemini', () => {
    const { wireModel } = load().platformOpenAI(GOOGLE_ENV);
    for (const model of ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'gpt-5-mini', 'gpt-5-nano']) {
      expect(wireModel(model)).toBe('google/gemini-3.8-flash');
    }
  });

  it('raises rather than sending a model Google has no equivalent for', () => {
    const { wireModel } = load().platformOpenAI(GOOGLE_ENV);
    expect(() => wireModel('gpt-4o')).toThrow(/no Gemini equivalent/);
    expect(() => wireModel('whisper-1')).toThrow(/no Gemini equivalent/);
  });
});

describe('the platform client', () => {
  it('sends the configured organisation on the direct route', () => {
    const { provider } = load().platformOpenAI({ ...DIRECT_ENV, OPENAI_ORGANIZATION: 'org-a-customer-owns' });
    expect(provider).toBe('openai');
    // The key is read from the PROCESS environment through `getEnvVar`, not from
    // the environment handed in — unchanged from before this file existed, and
    // the reason it still is: `getEnvVar` carries the dev default and the
    // production error, and no caller threads an environment here.
    expect(openAiCtor).toHaveBeenCalledWith({
      apiKey: expect.any(String),
      organization: 'org-a-customer-owns',
    });
    expect(openAiCtor.mock.calls[0][0]).not.toHaveProperty('baseURL');
  });

  it('sends no organisation on the direct route when none is configured', () => {
    load().platformOpenAI(DIRECT_ENV);
    expect(openAiCtor.mock.calls[0][0]).not.toHaveProperty('organization');
  });

  it('points at Google’s global OpenAI-shaped endpoint on the google route', () => {
    const { provider } = load().platformOpenAI(GOOGLE_ENV);
    expect(provider).toBe('google');
    expect(openAiCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL:
          'https://aiplatform.googleapis.com/v1/projects/a-project/locations/global/endpoints/openapi',
      }),
    );
  });

  it('keeps the region in host AND path when one is named', () => {
    load().platformOpenAI({ ...GOOGLE_ENV, GOOGLE_MODEL_REGION: 'europe-west1' });
    expect(openAiCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL:
          'https://europe-west1-aiplatform.googleapis.com/v1/projects/a-project/locations/europe-west1/endpoints/openapi',
      }),
    );
  });

  it('sends no organisation header to Google', () => {
    load().platformOpenAI(GOOGLE_ENV);
    expect(openAiCtor.mock.calls[0][0]).not.toHaveProperty('organization');
  });

  it('asks for a fresh token per request rather than pinning one', async () => {
    load().platformOpenAI(GOOGLE_ENV);
    const { apiKey } = openAiCtor.mock.calls[0][0];
    // A string here would be a token frozen at construction, and Google's expire
    // inside the hour — a server that ran longer would start 401ing.
    expect(typeof apiKey).toBe('function');
    await expect(apiKey()).resolves.toBe('ya29.a-google-access-token');
    await apiKey();
    expect(bearerToken).toHaveBeenCalledTimes(2);
    // …but bound to ONE token source, so its own cache can do its job.
    expect(googleBearerTokens).toHaveBeenCalledTimes(1);
  });

  it('builds one client per process, not one per call', () => {
    const { platformOpenAI } = load();
    platformOpenAI(GOOGLE_ENV);
    platformOpenAI(GOOGLE_ENV);
    expect(openAiCtor).toHaveBeenCalledTimes(1);
  });
});

describe('the supported-parameter list', () => {
  it('names what Google documents and nothing it does not', () => {
    const { GOOGLE_SUPPORTED_CHAT_PARAMS } = load();
    for (const documented of ['messages', 'model', 'temperature', 'n', 'response_format', 'tools']) {
      expect(GOOGLE_SUPPORTED_CHAT_PARAMS.has(documented)).toBe(true);
    }
    // Undocumented, and therefore SILENTLY ignored rather than refused — which
    // is the whole reason this list is written down.
    for (const undocumented of ['parallel_tool_calls', 'logprobs', 'stream_options', 'store', 'logit_bias']) {
      expect(GOOGLE_SUPPORTED_CHAT_PARAMS.has(undocumented)).toBe(false);
    }
  });
});

describe('refusing a schema Google would ignore', () => {
  const { assertSchemaIsNotRecursive } = load();

  it('accepts a flat schema', () => {
    expect(() =>
      assertSchemaIsNotRecursive(
        { type: 'object', properties: { name: { type: 'string' } } },
        'person',
      ),
    ).not.toThrow();
  });

  it('accepts a schema that merely REUSES a definition', () => {
    expect(() =>
      assertSchemaIsNotRecursive(
        {
          type: 'object',
          properties: { from: { $ref: '#/$defs/Addr' }, to: { $ref: '#/$defs/Addr' } },
          $defs: { Addr: { type: 'object', properties: { city: { type: 'string' } } } },
        },
        'journey',
      ),
    ).not.toThrow();
  });

  it('refuses a self-referential definition', () => {
    expect(() =>
      assertSchemaIsNotRecursive(
        {
          $ref: '#/$defs/Node',
          $defs: {
            Node: {
              type: 'object',
              properties: { children: { type: 'array', items: { $ref: '#/$defs/Node' } } },
            },
          },
        },
        'tree',
      ),
    ).toThrow(/recursive/);
  });

  it('refuses a cycle that goes the long way round', () => {
    expect(() =>
      assertSchemaIsNotRecursive(
        {
          $defs: {
            A: { type: 'object', properties: { b: { $ref: '#/$defs/B' } } },
            B: { type: 'object', properties: { a: { $ref: '#/$defs/A' } } },
          },
        },
        'pair',
      ),
    ).toThrow(/recursive/);
  });
});

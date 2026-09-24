// This file declares no imports, so it needs an explicit `export {}` to be a
// MODULE — without it every `const` here joins the global scope and collides
// with the same name in another test file at project typecheck time.
export {};

// Which OpenAI-shaped client a call gets, what the model is called once the map
// sends it to Gemini, and which JSON schemas that endpoint can honour.
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

/** The OpenAI-shaped names sent to Gemini, as the retired Google route renamed
 *  them — now a worked example of the map rather than a table in code. */
const GEMINI_MAP = {
  o3: 'gemini/gemini-3.1-pro-preview',
  'gpt-5': 'gemini/gemini-3.1-pro-preview',
  'gpt-4.1': 'gemini/gemini-3.8-flash',
  'gpt-5-nano': 'gemini/gemini-3.8-flash',
};

const GOOGLE_ENV = {
  MODEL_MAP: JSON.stringify(GEMINI_MAP),
  GOOGLE_PRIVATE_KEY: 'pk',
  GOOGLE_CLIENT_EMAIL: 'robot@example.iam.gserviceaccount.com',
  GOOGLE_PROJECT_ID: 'a-project',
};

const DIRECT_ENV = { OPENAI_API_KEY_FALLBACK_OR_DEV: 'sk-dev' };

// Re-imported per test: the clients are memoized per door, and a memo from one
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
  it('leaves every model alone where the map is silent', () => {
    expect(load().platformOpenAI('gpt-4.1', DIRECT_ENV).wireModel).toBe('gpt-4.1');
    expect(load().platformOpenAI('whisper-1', GOOGLE_ENV).wireModel).toBe('whisper-1');
  });

  it("sends a mapped name to Gemini under Google's prefixed spelling", () => {
    expect(load().platformOpenAI('o3', GOOGLE_ENV).wireModel).toBe('google/gemini-3.1-pro-preview');
    expect(load().platformOpenAI('gpt-4.1', GOOGLE_ENV).wireModel).toBe('google/gemini-3.8-flash');
  });

  it('refuses a name the map sends to a Claude door', () => {
    expect(() =>
      load().platformOpenAI('gpt-4.1', {
        MODEL_MAP: JSON.stringify({ 'gpt-4.1': 'anthropic/claude-sonnet-5' }),
      }),
    ).toThrow(/only openai and gemini serve/);
  });
});

describe('the platform client', () => {
  it('sends the configured organisation to OpenAI', () => {
    const { provider } = load().platformOpenAI('gpt-4.1', {
      ...DIRECT_ENV,
      OPENAI_ORGANIZATION: 'org-a-customer-owns',
    });
    expect(provider).toBe('openai');
    // The key is read from the PROCESS environment through `getEnvVar`, not from
    // the environment handed in — `getEnvVar` carries the dev default and the
    // production error, and no caller threads an environment here.
    expect(openAiCtor).toHaveBeenCalledWith({
      apiKey: expect.any(String),
      organization: 'org-a-customer-owns',
    });
    expect(openAiCtor.mock.calls[0][0]).not.toHaveProperty('baseURL');
  });

  it('sends no organisation to OpenAI when none is configured', () => {
    load().platformOpenAI('gpt-4.1', DIRECT_ENV);
    expect(openAiCtor.mock.calls[0][0]).not.toHaveProperty('organization');
  });

  it('points at Google’s global OpenAI-shaped endpoint for a name mapped to gemini', () => {
    const { provider } = load().platformOpenAI('gpt-4.1', GOOGLE_ENV);
    expect(provider).toBe('google');
    expect(openAiCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL:
          'https://aiplatform.googleapis.com/v1/projects/a-project/locations/global/endpoints/openapi',
      }),
    );
  });

  it('keeps the region in host AND path when one is named', () => {
    load().platformOpenAI('gpt-4.1', { ...GOOGLE_ENV, GOOGLE_MODEL_REGION: 'europe-west1' });
    expect(openAiCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL:
          'https://europe-west1-aiplatform.googleapis.com/v1/projects/a-project/locations/europe-west1/endpoints/openapi',
      }),
    );
  });

  it('sends no organisation header to Google', () => {
    load().platformOpenAI('gpt-4.1', GOOGLE_ENV);
    expect(openAiCtor.mock.calls[0][0]).not.toHaveProperty('organization');
  });

  it('asks for a fresh token per request rather than pinning one', async () => {
    load().platformOpenAI('gpt-4.1', GOOGLE_ENV);
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
    platformOpenAI('gpt-4.1', GOOGLE_ENV);
    platformOpenAI('o3', GOOGLE_ENV);
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

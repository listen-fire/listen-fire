// This file declares no imports, so it needs an explicit `export {}` to be a
// MODULE — without it every `const` here joins the global scope and collides
// with the same name in another test file at project typecheck time.
export {};

// Which OpenAI-shaped client a call gets, and what the model is called once the
// map sends it to Gemini.
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

/** OpenAI-shaped names the map sends to Gemini. */
const GEMINI_MAP = {
  'dall-e-3': 'gemini/gemini-3.8-flash-image',
  'text-embedding-3-large': 'gemini/gemini-embedding-001',
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
    expect(load().platformOpenAI('text-embedding-3-large', DIRECT_ENV).wireModel).toBe(
      'text-embedding-3-large',
    );
    expect(load().platformOpenAI('whisper-1', GOOGLE_ENV).wireModel).toBe('whisper-1');
  });

  it("sends a mapped name to Gemini under Google's prefixed spelling", () => {
    expect(load().platformOpenAI('dall-e-3', GOOGLE_ENV).wireModel).toBe(
      'google/gemini-3.8-flash-image',
    );
    expect(load().platformOpenAI('text-embedding-3-large', GOOGLE_ENV).wireModel).toBe(
      'google/gemini-embedding-001',
    );
  });

  it('refuses a name the map sends to a Claude door', () => {
    expect(() =>
      load().platformOpenAI('whisper-1', {
        MODEL_MAP: JSON.stringify({ 'whisper-1': 'anthropic/claude-sonnet-5' }),
      }),
    ).toThrow(/only openai and gemini serve/);
  });
});

describe('the platform client', () => {
  it('sends the configured organisation to OpenAI', () => {
    const { provider } = load().platformOpenAI('text-embedding-3-large', {
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
    load().platformOpenAI('text-embedding-3-large', DIRECT_ENV);
    expect(openAiCtor.mock.calls[0][0]).not.toHaveProperty('organization');
  });

  it('points at Google’s global OpenAI-shaped endpoint for a name mapped to gemini', () => {
    const { provider } = load().platformOpenAI('text-embedding-3-large', GOOGLE_ENV);
    expect(provider).toBe('google');
    expect(openAiCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL:
          'https://aiplatform.googleapis.com/v1/projects/a-project/locations/global/endpoints/openapi',
      }),
    );
  });

  it('keeps the region in host AND path when one is named', () => {
    load().platformOpenAI('text-embedding-3-large', { ...GOOGLE_ENV, GOOGLE_MODEL_REGION: 'europe-west1' });
    expect(openAiCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL:
          'https://europe-west1-aiplatform.googleapis.com/v1/projects/a-project/locations/europe-west1/endpoints/openapi',
      }),
    );
  });

  it('sends no organisation header to Google', () => {
    load().platformOpenAI('text-embedding-3-large', GOOGLE_ENV);
    expect(openAiCtor.mock.calls[0][0]).not.toHaveProperty('organization');
  });

  it('asks for a fresh token per request rather than pinning one', async () => {
    load().platformOpenAI('text-embedding-3-large', GOOGLE_ENV);
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
    platformOpenAI('text-embedding-3-large', GOOGLE_ENV);
    platformOpenAI('dall-e-3', GOOGLE_ENV);
    expect(openAiCtor).toHaveBeenCalledTimes(1);
  });
});

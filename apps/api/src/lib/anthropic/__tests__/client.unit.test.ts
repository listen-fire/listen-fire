// Which client a call gets, and what the model is called once it is addressed
// to Google.
//
// Both vendor constructors are mocked: this is about which one is built, with
// what, and nothing here reaches a network.

const anthropicCtor = jest.fn();
const vertexCtor = jest.fn();

jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(function (this: unknown, options: unknown) {
    anthropicCtor(options);
    return { kind: 'direct', options };
  }),
}));

jest.mock('@anthropic-ai/vertex-sdk', () => ({
  __esModule: true,
  AnthropicVertex: jest.fn().mockImplementation(function (this: unknown, options: unknown) {
    vertexCtor(options);
    return { kind: 'google', options };
  }),
}));

const googleAuth = jest.fn().mockReturnValue({ auth: 'google' });
jest.mock('../../google_cloud', () => ({
  ...jest.requireActual('../../google_cloud'),
  googleAuth: (...args: unknown[]) => googleAuth(...args),
}));

const GOOGLE_ENV = {
  MODEL_ROUTE: 'google',
  GOOGLE_PRIVATE_KEY: 'pk',
  GOOGLE_CLIENT_EMAIL: 'robot@example.iam.gserviceaccount.com',
  GOOGLE_PROJECT_ID: 'a-project',
};

describe('the model name on the wire', () => {
  // Re-imported per test: the clients are memoized per route, and a memo from
  // one test would answer for the next.
  function load() {
    let mod: typeof import('../client') | undefined;
    jest.isolateModules(() => {
      mod = require('../client');
    });
    if (!mod) throw new Error('module did not load');
    return mod;
  }

  it('leaves every model alone on the direct route', () => {
    const { wireModel } = load().platformAnthropic({ ANTHROPIC_API_KEY: 'sk-platform' });
    expect(wireModel('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5-20251001');
    expect(wireModel('claude-something-nobody-knows')).toBe('claude-something-nobody-knows');
  });

  it('carries the current generation over unchanged on google', () => {
    const { wireModel } = load().platformAnthropic(GOOGLE_ENV);
    for (const model of [
      'claude-sonnet-5',
      'claude-opus-5',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-opus-4-6',
      'claude-sonnet-4-6',
      'claude-fable-5',
      'claude-fable-5-1',
    ]) {
      expect(wireModel(model)).toBe(model);
    }
  });

  it('moves a dated name behind an @ on google', () => {
    const { wireModel } = load().platformAnthropic(GOOGLE_ENV);
    expect(wireModel('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5@20251001');
    expect(wireModel('claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4-5@20250929');
    expect(wireModel('claude-sonnet-4-5')).toBe('claude-sonnet-4-5@20250929');
    expect(wireModel('claude-opus-4-20250514')).toBe('claude-opus-4@20250514');
  });

  it('raises rather than sending a model Google has no name for', () => {
    const { wireModel } = load().platformAnthropic(GOOGLE_ENV);
    expect(() => wireModel('claude-haiku-4-5-20991231')).toThrow(
      /no known name on Google Cloud/,
    );
    // Mythos is invite-only on Google and has no published id, so it is a name
    // we do not know rather than one we guess at.
    expect(() => wireModel('claude-mythos-1')).toThrow(/no known name on Google Cloud/);
  });
});

describe('the platform client', () => {
  function load() {
    let mod: typeof import('../client') | undefined;
    jest.isolateModules(() => {
      mod = require('../client');
    });
    if (!mod) throw new Error('module did not load');
    return mod;
  }

  beforeEach(() => {
    anthropicCtor.mockClear();
    vertexCtor.mockClear();
  });

  it('builds a keyed Anthropic client on the direct route', () => {
    const { platformAnthropic } = load();
    platformAnthropic({ ANTHROPIC_API_KEY: 'sk-platform' });
    expect(anthropicCtor).toHaveBeenCalledWith({ apiKey: 'sk-platform' });
    expect(vertexCtor).not.toHaveBeenCalled();
  });

  it('builds a Google client at the global endpoint on the google route', () => {
    const { platformAnthropic } = load();
    platformAnthropic(GOOGLE_ENV);
    expect(vertexCtor).toHaveBeenCalledWith({
      projectId: 'a-project',
      region: 'global',
      googleAuth: { auth: 'google' },
    });
    expect(anthropicCtor).not.toHaveBeenCalled();
  });

  it('honours an explicit model region', () => {
    const { platformAnthropic } = load();
    platformAnthropic({ ...GOOGLE_ENV, GOOGLE_MODEL_REGION: 'europe-west1' });
    expect(vertexCtor).toHaveBeenCalledWith(
      expect.objectContaining({ region: 'europe-west1' }),
    );
  });

  it('builds one client per process, not one per call', () => {
    const { platformAnthropic } = load();
    platformAnthropic({ ANTHROPIC_API_KEY: 'sk-platform' });
    platformAnthropic({ ANTHROPIC_API_KEY: 'sk-platform' });
    expect(anthropicCtor).toHaveBeenCalledTimes(1);
  });

  it('keeps a team’s own key on the direct client, whatever the route', () => {
    const { clientFor } = load();
    clientFor('sk-team', GOOGLE_ENV);
    expect(anthropicCtor).toHaveBeenCalledWith({ apiKey: 'sk-team' });
    expect(vertexCtor).not.toHaveBeenCalled();
  });

  it('names the model the way the CLIENT it just chose does', () => {
    const { clientFor } = load();
    // The route says google, but a team key sends this one call to Anthropic's
    // own door — where `claude-haiku-4-5@20251001` is not a model that exists.
    const team = clientFor('sk-team', GOOGLE_ENV);
    expect(team.wireModel('claude-haiku-4-5')).toBe('claude-haiku-4-5');

    const platform = clientFor(undefined, GOOGLE_ENV);
    expect(platform.wireModel('claude-haiku-4-5')).toBe('claude-haiku-4-5@20251001');
  });
});

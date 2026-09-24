import {
  assertCallable,
  assertModelMapConfigured,
  parseModelMap,
  providerCredentialsPresent,
  providerServes,
  resolveModel,
} from '../map';

const GOOGLE = {
  GOOGLE_PRIVATE_KEY: 'pk',
  GOOGLE_CLIENT_EMAIL: 'robot@example.iam.gserviceaccount.com',
  GOOGLE_PROJECT_ID: 'a-project',
};

const mapOf = (entries: Record<string, string>) => JSON.stringify(entries);

describe('parsing MODEL_MAP', () => {
  it('reads unset, empty and blank as no map at all', () => {
    expect(parseModelMap(undefined).size).toBe(0);
    expect(parseModelMap('').size).toBe(0);
    expect(parseModelMap('   ').size).toBe(0);
  });

  it('reads provider and wire model', () => {
    const map = parseModelMap(mapOf({ 'claude-sonnet-5': 'vertex/claude-sonnet-5@x' }));
    expect(map.get('claude-sonnet-5')).toEqual({ provider: 'vertex', wireModel: 'claude-sonnet-5@x' });
  });

  it('keeps everything after the first slash as the wire model', () => {
    const map = parseModelMap(mapOf({ 'gpt-4.1': 'gemini/publishers/google/gemini-3.8-flash' }));
    expect(map.get('gpt-4.1')).toEqual({
      provider: 'gemini',
      wireModel: 'publishers/google/gemini-3.8-flash',
    });
  });

  it('refuses JSON that does not parse', () => {
    expect(() => parseModelMap('{nope')).toThrow(/MODEL_MAP is not valid JSON/);
  });

  it('refuses anything but an object of strings', () => {
    expect(() => parseModelMap('["claude-sonnet-5"]')).toThrow(/JSON object whose values are strings/);
    expect(() => parseModelMap('{"claude-sonnet-5": 3}')).toThrow(/values are strings/);
  });

  it('refuses a key that is not a registry name, naming it', () => {
    expect(() => parseModelMap(mapOf({ 'claude-sonnet-9': 'anthropic/claude-sonnet-9' }))).toThrow(
      /MODEL_MAP key "claude-sonnet-9" is not a model name/,
    );
  });

  it('refuses a provider outside the four', () => {
    expect(() => parseModelMap(mapOf({ 'claude-sonnet-5': 'bedrock/claude-sonnet-5' }))).toThrow(
      /MODEL_MAP\["claude-sonnet-5"\] is "bedrock\/claude-sonnet-5"/,
    );
  });

  it('refuses an uppercase provider rather than quietly not matching it', () => {
    expect(() => parseModelMap(mapOf({ 'gpt-4.1': 'Gemini/gemini-3.8-flash' }))).toThrow(
      /MODEL_MAP\["gpt-4.1"\]/,
    );
  });

  it('refuses whitespace anywhere in the value', () => {
    for (const value of ['gemini/gemini-3.8-flash ', ' gemini/gemini-3.8-flash', 'gemini/ x']) {
      expect(() => parseModelMap(mapOf({ 'gpt-4.1': value }))).toThrow(/MODEL_MAP\["gpt-4.1"\]/);
    }
  });

  it('refuses a value with no wire model', () => {
    expect(() => parseModelMap(mapOf({ 'gpt-4.1': 'gemini/' }))).toThrow(/MODEL_MAP\["gpt-4.1"\]/);
    expect(() => parseModelMap(mapOf({ 'gpt-4.1': 'gemini' }))).toThrow(/MODEL_MAP\["gpt-4.1"\]/);
  });
});

describe('resolving a name', () => {
  it('sends an unmapped name to its home vendor under its own name', () => {
    expect(resolveModel('claude-sonnet-5', {})).toEqual({
      preferred: 'claude-sonnet-5',
      provider: 'anthropic',
      wireModel: 'claude-sonnet-5',
    });
    expect(resolveModel('whisper-1', { MODEL_MAP: '' })).toEqual({
      preferred: 'whisper-1',
      provider: 'openai',
      wireModel: 'whisper-1',
    });
  });

  it('follows the map where it speaks, and only there', () => {
    const env = { MODEL_MAP: mapOf({ 'claude-sonnet-5': 'vertex/claude-sonnet-5' }) };
    expect(resolveModel('claude-sonnet-5', env).provider).toBe('vertex');
    expect(resolveModel('claude-opus-5', env).provider).toBe('anthropic');
  });

  it('reads a changed map rather than a remembered one', () => {
    expect(resolveModel('gpt-4.1', { MODEL_MAP: mapOf({ 'gpt-4.1': 'gemini/g' }) }).provider).toBe(
      'gemini',
    );
    expect(resolveModel('gpt-4.1', {}).provider).toBe('openai');
  });
});

describe('the capability table', () => {
  it('lets the Claude doors serve chat only', () => {
    for (const provider of ['anthropic', 'vertex'] as const) {
      expect(providerServes(provider, 'chat')).toBe(true);
      expect(providerServes(provider, 'transcription')).toBe(false);
      expect(providerServes(provider, 'embedding')).toBe(false);
      expect(providerServes(provider, 'image')).toBe(false);
    }
  });

  it('lets openai and gemini serve all four', () => {
    for (const provider of ['openai', 'gemini'] as const) {
      for (const capability of ['chat', 'transcription', 'embedding', 'image'] as const) {
        expect(providerServes(provider, capability)).toBe(true);
      }
    }
  });
});

describe('credentials', () => {
  it('asks each provider for its own', () => {
    expect(providerCredentialsPresent('anthropic', { ANTHROPIC_API_KEY: 'k' })).toBe(true);
    expect(providerCredentialsPresent('anthropic', {})).toBe(false);
    expect(providerCredentialsPresent('openai', { OPENAI_API_KEY: 'k' })).toBe(true);
    expect(providerCredentialsPresent('openai', {})).toBe(false);
    expect(providerCredentialsPresent('vertex', GOOGLE)).toBe(true);
    expect(providerCredentialsPresent('gemini', GOOGLE)).toBe(true);
    expect(providerCredentialsPresent('gemini', { GOOGLE_PROJECT_ID: 'p' })).toBe(false);
  });
});

describe('boot validation', () => {
  it('accepts an empty map with no keys at all', () => {
    expect(() => assertModelMapConfigured({})).not.toThrow();
  });

  it('accepts a home vendor key that nothing uses', () => {
    expect(() =>
      assertModelMapConfigured({
        ...GOOGLE,
        ANTHROPIC_API_KEY: 'unused',
        MODEL_MAP: mapOf({ 'claude-sonnet-5': 'vertex/claude-sonnet-5' }),
      }),
    ).not.toThrow();
  });

  it('refuses a key that is not a registry name', () => {
    expect(() =>
      assertModelMapConfigured({ MODEL_MAP: mapOf({ 'gpt-6': 'openai/gpt-6' }) }),
    ).toThrow(/MODEL_MAP key "gpt-6"/);
  });

  it('refuses an unknown provider', () => {
    expect(() =>
      assertModelMapConfigured({ MODEL_MAP: mapOf({ 'gpt-5': 'azure/gpt-5' }) }),
    ).toThrow(/MODEL_MAP\["gpt-5"\]/);
  });

  it('refuses a provider that does not serve the capability', () => {
    expect(() =>
      assertModelMapConfigured({
        ...GOOGLE,
        MODEL_MAP: mapOf({ 'whisper-1': 'vertex/whisper-1' }),
      }),
    ).toThrow(/MODEL_MAP\["whisper-1"\].*vertex does not serve transcription.*openai, gemini/);
  });

  it('refuses a mapped provider with no credentials, naming what to set', () => {
    expect(() =>
      assertModelMapConfigured({ MODEL_MAP: mapOf({ 'claude-sonnet-5': 'vertex/claude-sonnet-5' }) }),
    ).toThrow(/MODEL_MAP\["claude-sonnet-5"\] sends it to vertex.*GOOGLE_PRIVATE_KEY/);
    expect(() =>
      assertModelMapConfigured({ MODEL_MAP: mapOf({ 'claude-sonnet-5': 'openai/gpt-5' }) }),
    ).toThrow(/set OPENAI_API_KEY/);
    expect(() =>
      assertModelMapConfigured({ MODEL_MAP: mapOf({ 'gpt-5': 'anthropic/claude-sonnet-5' }) }),
    ).toThrow(/set ANTHROPIC_API_KEY/);
  });
});

describe('calling a name with nothing behind it', () => {
  it('names the map line to add when silence sent it to a vendor with no key', () => {
    const env = { NODE_ENV: 'production' };
    expect(() => assertCallable(resolveModel('dall-e-3', env), env)).toThrow(
      /"dall-e-3" is not in MODEL_MAP.*OPENAI_API_KEY.*"dall-e-3": "<provider>\/<wire model>"/,
    );
  });

  it('leaves development to the vendor clients and their defaults', () => {
    expect(() => assertCallable(resolveModel('dall-e-3', {}), {})).not.toThrow();
  });

  it('passes a vendor that has its key', () => {
    const env = { NODE_ENV: 'production', OPENAI_API_KEY: 'k' };
    expect(() => assertCallable(resolveModel('dall-e-3', env), env)).not.toThrow();
  });
});

describe('boot validation of embedding widths', () => {
  it('accepts a Gemini-only map for both embedding columns', () => {
    expect(() =>
      assertModelMapConfigured({
        ...GOOGLE,
        MODEL_MAP: mapOf({
          'text-embedding-3-large': 'gemini/gemini-embedding-001',
          'text-embedding-3-small': 'gemini/gemini-embedding-001',
        }),
      }),
    ).not.toThrow();
  });

  it('refuses a model too narrow for the column its name fills, naming the column and both numbers', () => {
    // raw_text stores 3072; text-embedding-3-small tops out at 1536. Refused,
    // never shortened or padded into the index.
    expect(() =>
      assertModelMapConfigured({
        OPENAI_API_KEY: 'k',
        MODEL_MAP: mapOf({ 'text-embedding-3-large': 'openai/text-embedding-3-small' }),
      }),
    ).toThrow(
      /MODEL_MAP\["text-embedding-3-large"\].*1 to 1536 dimensions.*knowledge\.raw_text\.embedding.*stores 3072/,
    );
  });

  it('refuses a wire model its provider file does not list, since nothing knows its width', () => {
    // text-embedding-005 yields 768: a 3072 column pointed at it must be
    // refused at boot, and an unlisted model is refused before its width is
    // even guessed at.
    expect(() =>
      assertModelMapConfigured({
        ...GOOGLE,
        MODEL_MAP: mapOf({ 'text-embedding-3-large': 'gemini/text-embedding-005' }),
      }),
    ).toThrow(/MODEL_MAP\["text-embedding-3-large"\] is "gemini\/text-embedding-005", an embedding model the gemini provider does not list/);
  });
});

import { isModelName, modelNames, models } from '../registry';

describe('the model registry', () => {
  it('knows its own names and nothing else', () => {
    expect(isModelName('claude-sonnet-5')).toBe(true);
    expect(isModelName('whisper-1')).toBe(true);
    expect(isModelName('claude-sonnet-4-9')).toBe(false);
    expect(isModelName('')).toBe(false);
    // Inherited object keys are not model names.
    expect(isModelName('toString')).toBe(false);
    expect(isModelName('__proto__')).toBe(false);
  });

  it('gives every entry a capability and a home vendor', () => {
    expect(modelNames.length).toBe(Object.keys(models).length);
    for (const name of modelNames) {
      expect(['chat', 'transcription', 'embedding', 'image']).toContain(models[name].capability);
      expect(['anthropic', 'openai']).toContain(models[name].home);
    }
  });

  it('keeps the dated Claude name callers send today', () => {
    expect(models['claude-haiku-4-5-20251001']).toEqual({ capability: 'chat', home: 'anthropic' });
  });
});

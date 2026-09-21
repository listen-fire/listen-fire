// This file declares no imports, so it needs an explicit `export {}` to be a
// MODULE — without it every `const` here joins the global scope and collides
// with the same name in another test file at project typecheck time.
export {};

// Pricing a call, and saying so when we cannot.
//
// An unpriced model records its real token count at zero cost — usage that reads
// as free rather than as missing. Nothing distinguishes the two except somebody
// being told, which is what the warning is for.

const warn = jest.fn();
jest.mock('../../services/logger', () => ({ logger: { info: jest.fn(), warn, error: jest.fn() } }));

const insertInto = jest.fn();
jest.mock('../kysely', () => ({ getQb: () => ({ insertInto }) }));

function load() {
  let mod: typeof import('../llm_usage') | undefined;
  jest.isolateModules(() => {
    mod = require('../llm_usage');
  });
  if (!mod) throw new Error('module did not load');
  return mod;
}

beforeEach(() => {
  warn.mockClear();
  insertInto.mockReset();
});

/** `recordLlmUsage` needs a team in context and otherwise no-ops, so pricing is
 *  reached through a run that does write a row. */
async function record(mod: typeof import('../llm_usage'), model: string, provider: 'openai' | 'anthropic' | 'google') {
  const execute = jest.fn().mockResolvedValue(undefined);
  insertInto.mockReturnValue({ values: jest.fn().mockReturnValue({ execute }) });
  await new mod.LlmUsageContext({ teamId: 'team-1' as never }).runAsync(async () => {
    await mod.recordLlmUsage({
      provider,
      model,
      callType: 'chat',
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
  });
  return insertInto.mock.results[0]?.value.values.mock.calls[0]?.[0];
}

describe('the Gemini models this route calls', () => {
  it('are priced, so their usage is not recorded as free', async () => {
    const mod = load();
    for (const model of [
      'google/gemini-3.1-pro-preview',
      'google/gemini-3.8-flash',
      'gemini-3.8-flash',
      'gemini-embedding-001',
    ]) {
      const row = await record(mod, model, 'google');
      expect(row.cost_microdollars).toBeGreaterThan(0);
      expect(warn).not.toHaveBeenCalled();
    }
  });

  it('records the provider that actually served the call', async () => {
    const row = await record(load(), 'google/gemini-3.8-flash', 'google');
    expect(row.provider).toBe('google');
    expect(row.model).toBe('google/gemini-3.8-flash');
  });
});

describe('a model nobody priced', () => {
  it('still records the row, at zero, and says so once', async () => {
    const mod = load();
    const row = await record(mod, 'gemini-99-imaginary', 'google');
    expect(row.cost_microdollars).toBe(0);
    expect(row.input_tokens).toBe(1_000_000);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/no price for model "gemini-99-imaginary"/);
  });

  it('says so once per NAME, not once per call', async () => {
    const mod = load();
    await record(mod, 'gemini-99-imaginary', 'google');
    await record(mod, 'gemini-99-imaginary', 'google');
    await record(mod, 'another-unknown', 'google');
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

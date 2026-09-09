import { scalarValueSchema } from '../resolve';

describe('scalarValueSchema', () => {
  it('accepts a real scalar value', () => {
    expect(scalarValueSchema.parse({ value: 'Acme Corp' })).toEqual({ value: 'Acme Corp' });
    expect(scalarValueSchema.parse({ value: 42 }).value).toBe(42);
    expect(scalarValueSchema.parse({ value: false }).value).toBe(false);
    expect(scalarValueSchema.parse({ value: null }).value).toBeNull();
  });

  it('does not fail the run when the model omits the value key', () => {
    // The prompt asks the model to emit `null` for "no value"; a model that
    // instead omits the key entirely means the same thing. This must parse to a
    // missing/undefined value (which the caller collapses to null), NOT throw a
    // ZodError that fails the whole extraction output.
    expect(() => scalarValueSchema.parse({ thought: 'nothing here' })).not.toThrow();
    expect(scalarValueSchema.parse({ thought: 'nothing here' }).value).toBeUndefined();
    expect(() => scalarValueSchema.parse({})).not.toThrow();
  });
});

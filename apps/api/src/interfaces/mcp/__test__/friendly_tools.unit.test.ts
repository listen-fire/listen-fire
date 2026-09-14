import { z } from 'zod';

import { assertFriendlyTool, assertRepresentableSchema, directoryAnnotations } from '../server';

const ok = { title: 'Save an automation', annotations: { destructiveHint: true } };

describe('assertFriendlyTool', () => {
  it('accepts a friendly camelCase tool', () => {
    expect(() => assertFriendlyTool('saveAutomation', ok)).not.toThrow();
  });
  it('rejects names failing the API charset', () => {
    expect(() => assertFriendlyTool('save automation', ok)).toThrow(/1-64/);
  });
  it('rejects internal words in the name (camelCase tokens)', () => {
    expect(() => assertFriendlyTool('saveMovement', ok)).toThrow(/internal vocabulary/);
    expect(() => assertFriendlyTool('list_asks', ok)).toThrow(/internal vocabulary/);
  });
  it('rejects internal words in the title, without false-positives on "task"', () => {
    expect(() => assertFriendlyTool('doThing', { ...ok, title: 'Answer a pending ask' })).toThrow(/internal vocabulary/);
    expect(() => assertFriendlyTool('doThing', { ...ok, title: 'Run a task now' })).not.toThrow();
  });
  it('still enforces title length and safety hints', () => {
    expect(() => assertFriendlyTool('doThing', { ...ok, title: '' })).toThrow();
    expect(() => assertFriendlyTool('doThing', { title: 'Do a thing', annotations: {} })).toThrow(/readOnlyHint or destructiveHint/);
  });
});

// The directory portal reads tool metadata from the `annotations` object — it
// wants `annotations.title` (not only the top-level Tool.title the SDK emits)
// and an explicit `readOnlyHint` on every tool to classify read vs write. These
// lock the shape the portal's tools sync validates against.
describe('directoryAnnotations', () => {
  it('mirrors the title into annotations', () => {
    expect(directoryAnnotations('List things', { readOnlyHint: true }).title).toBe('List things');
  });
  it('makes readOnlyHint explicit for a write tool that only set destructiveHint', () => {
    const a = directoryAnnotations('Delete an automation', { destructiveHint: true });
    expect(a).toEqual({ destructiveHint: true, title: 'Delete an automation', readOnlyHint: false });
  });
  it('preserves an already-explicit readOnlyHint on a read tool', () => {
    expect(directoryAnnotations('List things', { readOnlyHint: true }).readOnlyHint).toBe(true);
  });
});

// A tool's input is only ever seen as JSON Schema, and the SDK converts it
// inside its `tools/list` handler — so a type with no JSON Schema spelling
// fails the WHOLE list, at request time, as a JSON-RPC error inside an HTTP
// 200. The symptom is a connector that authenticates and then offers no tools.
// This guard moves that failure to the deploy.
describe('assertRepresentableSchema', () => {
  it('accepts the wire types a client can actually send', () => {
    expect(() =>
      assertRepresentableSchema('queryThings', {
        since: z.string().optional(),
        limit: z.number().int().optional(),
        group: z.array(z.enum(['a', 'b'])).optional(),
      }),
    ).not.toThrow();
  });

  it('rejects a z.date(), which has no JSON Schema spelling', () => {
    expect(() => assertRepresentableSchema('queryThings', { since: z.date() })).toThrow(
      /cannot be published as JSON Schema/,
    );
  });

  it('rejects a z.date() hidden in a union or nested object', () => {
    expect(() =>
      assertRepresentableSchema('queryThings', { since: z.union([z.string(), z.date()]).optional() }),
    ).toThrow(/cannot be published as JSON Schema/);
    expect(() =>
      assertRepresentableSchema('queryThings', { window: z.object({ from: z.date().optional() }) }),
    ).toThrow(/cannot be published as JSON Schema/);
  });

  it('accepts a Date narrowed to its wire type before validation', () => {
    const wireDate = z
      .preprocess((value) => (value instanceof Date ? value.toISOString() : value), z.string())
      .transform((value) => new Date(value));
    expect(() => assertRepresentableSchema('queryThings', { since: wireDate })).not.toThrow();
  });
});

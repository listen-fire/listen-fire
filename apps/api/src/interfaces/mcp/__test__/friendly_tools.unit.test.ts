import { assertFriendlyTool, directoryAnnotations } from '../server';

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

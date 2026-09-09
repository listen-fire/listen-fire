import { beatForToolCall } from './build_beats';

describe('beatForToolCall', () => {
  test('readAuthoringDoc → read beat with chapter label + passage', () => {
    const b = beatForToolCall({
      name: 'readAuthoringDoc',
      args: { chapter: 'writes' },
      result: { title: 'Writes', body: 'Connect every related record with a linked write…' },
    });
    expect(b).toMatchObject({ phase: 'read' });
    expect(b?.label).toMatch(/Writes/i);
    expect(b?.artifact).toContain('Connect every related record');
  });

  // The result shape here is `DescribedInstance` as `describeMovementInstance`
  // ACTUALLY returns it — the walked node.
  //
  // This used to pass `{ writableRoots: { … } }`, a top-level field that has
  // never existed on `DescribedInstance` (writable roots live under `schema`).
  // So the beat's summary was always empty in production while this test
  // asserted it worked: a fixture the function under test never receives can
  // assert anything at all. An absent optional artifact looks exactly like a
  // deliberately absent one, so nothing else could have caught it either.
  test('describeInstance → study beat naming the node, surfacing its edges', () => {
    const b = beatForToolCall({
      name: 'describeInstance',
      args: { adapter: 'attio' },
      result: {
        node: {
          name: 'Companies',
          position: '-[:Companies]->',
          properties: { Name: { type: 'text' } },
          edges: [
            { name: 'Notes', writable: true },
            { name: 'People', writable: false },
          ],
        },
        schema: null,
        notes: [],
      },
    });
    expect(b?.phase).toBe('study');
    expect(b?.label).toMatch(/attio/i);
    expect(b?.label).toMatch(/Companies/);
    expect(b?.artifact).toContain('Notes (writable)');
    expect(b?.artifact).toContain('People');
  });

  test('readBook (unified Library tool) → read beat with passage', () => {
    const b = beatForToolCall({
      name: 'readBook',
      args: { bookId: 'movements', chapter: 'writes' },
      result: { title: 'Writes', content: 'Connect every related record…' },
    });
    expect(b?.phase).toBe('read');
    expect(b?.label).toMatch(/Writes/i);
    expect(b?.artifact).toContain('Connect every related record');
  });

  test('readBook with multiple chapters → one read beat listing them', () => {
    const b = beatForToolCall({
      name: 'readBook',
      args: { bookId: 'movements', chapters: ['anatomy', 'patterns'] },
      result: {
        bookId: 'movements',
        chapters: [
          { id: 'anatomy', title: 'Anatomy', content: '…' },
          { id: 'patterns', title: 'Common patterns', content: '…' },
        ],
      },
    });
    expect(b?.phase).toBe('read');
    expect(b?.label).toMatch(/2 playbook chapters/);
    expect(b?.artifact).toMatch(/Anatomy.*Common patterns/);
  });

  test('listCatalog → study beat', () => {
    expect(beatForToolCall({ name: 'listCatalog', args: {}, result: {} })?.phase).toBe('study');
  });

  test('completionsAt → fill beat listing options', () => {
    const b = beatForToolCall({
      name: 'completionsAt',
      args: {},
      result: { completions: [{ label: 'Domains' }, { label: 'Description' }] },
    });
    expect(b?.phase).toBe('fill');
    expect(b?.artifact).toMatch(/Domains/);
  });

  test('unknown tool → null (no beat)', () => {
    expect(beatForToolCall({ name: 'somethingElse', args: {}, result: {} })).toBeNull();
  });
});

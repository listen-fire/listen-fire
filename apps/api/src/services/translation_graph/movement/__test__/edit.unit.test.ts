// The pure splice half of the content-anchored edit primitive — no store, no
// save, just: does the anchor pin exactly one location, and does the splice
// land at the right offsets.

import { applyContentEdit } from '../edit';

describe('applyContentEdit', () => {
  it('replaces a uniquely-anchored snippet', () => {
    const result = applyContentEdit({
      source: 'movement foo(x: a) {\n  y = 1\n}\n',
      oldString: 'y = 1',
      newString: 'y = 2',
    });
    expect(result).toEqual({ ok: true, source: 'movement foo(x: a) {\n  y = 2\n}\n' });
  });

  it('refuses when the anchor is not found', () => {
    const result = applyContentEdit({
      source: 'movement foo(x: a) {\n  y = 1\n}\n',
      oldString: 'z = 9',
      newString: 'z = 10',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not found/);
  });

  it('refuses an ambiguous anchor without replaceAll, naming the count', () => {
    const result = applyContentEdit({
      source: 'a = 1\na = 1\na = 1\n',
      oldString: 'a = 1',
      newString: 'a = 2',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/3 places/);
  });

  it('replaceAll changes every match', () => {
    const result = applyContentEdit({
      source: 'a = 1\na = 1\na = 1\n',
      oldString: 'a = 1',
      newString: 'a = 2',
      replaceAll: true,
    });
    expect(result).toEqual({ ok: true, source: 'a = 2\na = 2\na = 2\n' });
  });

  it('rejects an empty anchor', () => {
    const result = applyContentEdit({ source: 'abc', oldString: '', newString: 'x' });
    expect(result.ok).toBe(false);
  });

  it('a single match still works with replaceAll set', () => {
    const result = applyContentEdit({
      source: 'only once here',
      oldString: 'once',
      newString: 'twice',
      replaceAll: true,
    });
    expect(result).toEqual({ ok: true, source: 'only twice here' });
  });

  it('newString may be empty (a pure deletion)', () => {
    const result = applyContentEdit({
      source: 'keep this, drop that, keep this too',
      oldString: 'drop that, ',
      newString: '',
    });
    expect(result).toEqual({ ok: true, source: 'keep this, keep this too' });
  });
});

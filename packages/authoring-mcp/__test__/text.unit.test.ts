// The editing primitives: the revision rule, the anchored edit, a window of
// lines and the search across programs.

import { createHash } from 'node:crypto';

import type { StoredProgram } from '../host';
import { GREP_MAX_MATCHES, applyContentEdit, grepPrograms, readWindow, revisionOf } from '../text';

const program = (id: string, source: string): StoredProgram => ({ id, name: `n-${id}`, source, updatedAt: '2026-10-27T00:00:00.000Z' });

describe('the revision', () => {
  it('is the sha256 of the text, so any change (whitespace too) is a new one', () => {
    expect(revisionOf('a\nb')).toBe(createHash('sha256').update('a\nb', 'utf8').digest('hex'));
    expect(revisionOf('a\nb')).not.toBe(revisionOf('a\nb '));
  });
});

describe('an anchored edit', () => {
  const source = 'one\ntwo\none\n';
  it('replaces the one place its anchor pins', () => {
    expect(applyContentEdit({ source, oldString: 'two', newString: '2' })).toEqual({ ok: true, source: 'one\n2\none\n' });
  });
  it('refuses an anchor found nowhere, or in several places unless asked to replace all', () => {
    expect(applyContentEdit({ source, oldString: 'three', newString: '3' })).toMatchObject({ ok: false, error: expect.stringMatching(/not found/) });
    expect(applyContentEdit({ source, oldString: 'one', newString: '1' })).toMatchObject({ ok: false, error: expect.stringMatching(/matches 2 places/) });
    expect(applyContentEdit({ source, oldString: 'one', newString: '1', replaceAll: true })).toEqual({ ok: true, source: '1\ntwo\n1\n' });
    expect(applyContentEdit({ source, oldString: '', newString: 'x' })).toMatchObject({ ok: false });
  });
});

describe('a window of lines', () => {
  it('numbers lines from 1 and carries the revision of the whole text', () => {
    const p = program('a', 'l1\nl2\nl3\nl4');
    expect(readWindow(p, { offset: 2, limit: 2 })).toEqual({
      id: 'a',
      name: 'n-a',
      revision: revisionOf(p.source),
      totalLines: 4,
      offset: 2,
      lines: [
        { n: 2, text: 'l2' },
        { n: 3, text: 'l3' },
      ],
    });
    expect(readWindow(p, {}).lines).toHaveLength(4);
  });
});

describe('the search across programs', () => {
  const programs = [program('a', 'x = 1\nwrite app\ny = 2'), program('b', 'write app\n')];
  it('finds a literal on every line it is on, with context', () => {
    expect(grepPrograms(programs, { pattern: 'write', contextLines: 1 })).toEqual({
      matches: [
        { id: 'a', name: 'n-a', line: 2, text: 'write app', before: ['x = 1'], after: ['y = 2'] },
        { id: 'b', name: 'n-b', line: 1, text: 'write app', before: [], after: [''] },
      ],
      truncated: false,
    });
  });
  it('takes a regular expression, and says when one does not compile', () => {
    expect(grepPrograms(programs, { pattern: '^[xy] =', isRegex: true })).toMatchObject({ matches: [{ line: 1 }, { line: 3 }] });
    expect(grepPrograms(programs, { pattern: '(', isRegex: true })).toMatchObject({ error: expect.stringMatching(/not a valid regular expression/) });
  });
  it(`stops at ${GREP_MAX_MATCHES} matches and says so`, () => {
    const many = program('m', Array.from({ length: GREP_MAX_MATCHES + 5 }, () => 'hit').join('\n'));
    const found = grepPrograms([many], { pattern: 'hit' });
    expect('matches' in found && found.matches.length).toBe(GREP_MAX_MATCHES);
    expect(found).toMatchObject({ truncated: true });
  });
});

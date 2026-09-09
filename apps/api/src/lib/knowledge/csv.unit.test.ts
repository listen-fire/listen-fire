import { toCsv } from './csv';

describe('toCsv', () => {
  it('writes a header row then one row per record in column order', () => {
    const out = toCsv({
      columns: ['name', 'age'],
      rows: [{ name: 'Ada', age: 36 }, { name: 'Alan', age: 41 }],
    });
    expect(out).toBe('name,age\r\nAda,36\r\nAlan,41');
  });

  it('quotes and escapes cells containing comma, quote, or newline', () => {
    const out = toCsv({
      columns: ['note'],
      rows: [{ note: 'a,b' }, { note: 'she said "hi"' }, { note: 'line1\nline2' }],
    });
    expect(out).toBe('note\r\n"a,b"\r\n"she said ""hi"""\r\n"line1\nline2"');
  });

  it('renders null/undefined as empty and serializes objects as JSON', () => {
    const out = toCsv({
      columns: ['a', 'b', 'c'],
      rows: [{ a: null, b: undefined, c: { x: 1 } }],
    });
    expect(out).toBe('a,b,c\r\n,,"{""x"":1}"');
  });
});

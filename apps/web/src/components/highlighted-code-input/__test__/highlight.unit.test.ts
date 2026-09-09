import { highlightTokens, type HighlightSpan } from '../highlight';

/** Collapse to `[cls, text]` pairs for compact assertions. */
const pairs = (spans: HighlightSpan[]): [string, string][] =>
  spans.map((s) => [s.cls, s.text]);

/** Spans must tile the whole input with no gaps or overlaps. */
const assertContiguous = (input: string, spans: HighlightSpan[]) => {
  let cursor = 0;
  for (const s of spans) {
    expect(s.start).toBe(cursor);
    expect(s.text).toBe(input.slice(s.start, s.end));
    cursor = s.end;
  }
  expect(cursor).toBe(input.length);
};

describe('highlightTokens', () => {
  it('returns no spans for an empty string', () => {
    expect(highlightTokens('')).toEqual([]);
  });

  it('classifies a double-quoted string literal', () => {
    const spans = highlightTokens('"hello"');
    expect(pairs(spans)).toEqual([['string', '"hello"']]);
  });

  it('classifies a single-quoted string literal', () => {
    expect(pairs(highlightTokens("'hi'"))).toEqual([['string', "'hi'"]]);
  });

  it('classifies a reserved keyword', () => {
    expect(pairs(highlightTokens('AND'))).toEqual([['keyword', 'AND']]);
  });

  it('treats an identifier followed by ( as a function', () => {
    expect(pairs(highlightTokens('CONCAT('))).toEqual([
      ['function', 'CONCAT'],
      ['punctuation', '('],
    ]);
  });

  it('treats a function call with whitespace before ( as a function', () => {
    expect(pairs(highlightTokens('AI ('))).toEqual([
      ['function', 'AI'],
      ['plain', ' '],
      ['punctuation', '('],
    ]);
  });

  it('classifies a plain identifier that is neither keyword nor function', () => {
    expect(pairs(highlightTokens('Subject'))).toEqual([['plain', 'Subject']]);
  });

  it('classifies a backtick property reference', () => {
    expect(pairs(highlightTokens('`Plain Body`'))).toEqual([
      ['property', '`Plain Body`'],
    ]);
  });

  it('classifies a number literal', () => {
    expect(pairs(highlightTokens('42'))).toEqual([['number', '42']]);
    expect(pairs(highlightTokens('3.14'))).toEqual([['number', '3.14']]);
  });

  it('classifies a #meta-edge token', () => {
    expect(pairs(highlightTokens('#extract'))).toEqual([
      ['meta-edge', '#extract'],
    ]);
  });

  it('classifies an @-global token', () => {
    expect(pairs(highlightTokens('@parent'))).toEqual([['global', '@parent']]);
  });

  it('preserves whitespace as plain spans and tiles the input contiguously', () => {
    const input = 'AND  "x"';
    const spans = highlightTokens(input);
    assertContiguous(input, spans);
    expect(pairs(spans)).toEqual([
      ['keyword', 'AND'],
      ['plain', '  '],
      ['string', '"x"'],
    ]);
  });

  it('colors INSIDE a traversal #extract config (the key case)', () => {
    const input = '-[x:#extract { description: "x", data: [Subject] }]->';
    const spans = highlightTokens(input);
    assertContiguous(input, spans);
    const ps = pairs(spans);
    // The config interior is lexed, not collapsed into one traverse blob.
    expect(ps).toContainEqual(['meta-edge', '#extract']);
    expect(ps).toContainEqual(['string', '"x"']);
    expect(ps).toContainEqual(['plain', 'Subject']);
    // Structural brackets are punctuation.
    expect(ps).toContainEqual(['punctuation', '[']);
    expect(ps).toContainEqual(['punctuation', '{']);
  });

  it('colors outgoing traversal arrow delimiters as meta-edge', () => {
    const input = '-[:Owns]->';
    const spans = highlightTokens(input);
    assertContiguous(input, spans);
    const ps = pairs(spans);
    expect(ps).toContainEqual(['meta-edge', '-[']);
    expect(ps).toContainEqual(['meta-edge', ']->']);
  });

  it('colors incoming traversal arrow delimiters as meta-edge', () => {
    const input = '<-[:Owns]-';
    const spans = highlightTokens(input);
    assertContiguous(input, spans);
    const ps = pairs(spans);
    expect(ps).toContainEqual(['meta-edge', '<-[']);
    expect(ps).toContainEqual(['meta-edge', ']-']);
  });

  it('treats a string with an escaped quote as one span', () => {
    const input = '"a\\"b"';
    expect(pairs(highlightTokens(input))).toEqual([['string', input]]);
  });
});

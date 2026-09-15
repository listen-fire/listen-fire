// The cutter behind `CHUNKS(text, { size, overlap })`. Pure, so it is pinned
// here rather than through a run: the same text and the same options always
// yield the same pieces, which is the property the whole built-in rests on.

import { chunkText, readChunkSpec, type ChunkSpec } from '../chunk';

const spec = (size: number, overlap = 0): ChunkSpec => {
  const read = readChunkSpec(size, overlap);
  if ('error' in read) throw new Error(read.error);
  return read.spec;
};

describe('a text with nothing to cut', () => {
  it('an empty text has no pieces — not one empty piece', () => {
    expect(chunkText('', spec(10))).toEqual([]);
  });

  it('a whitespace-only text has no pieces either', () => {
    expect(chunkText('   \n\n\t  ', spec(3))).toEqual([]);
  });

  it('a text that already fits is one piece, uncut', () => {
    expect(chunkText('Acme raised a seed round.', spec(1000))).toEqual([
      'Acme raised a seed round.',
    ]);
  });

  it('a text exactly the size asked for is still one piece', () => {
    expect(chunkText('abcde', spec(5))).toEqual(['abcde']);
  });
});

describe('the ceiling', () => {
  it('an unbroken run longer than the size is cut hard at the size', () => {
    expect(chunkText('a'.repeat(25), spec(10))).toEqual([
      'aaaaaaaaaa',
      'aaaaaaaaaa',
      'aaaaa',
    ]);
  });

  it('no piece is ever longer than the size', () => {
    const text = 'word '.repeat(200);
    for (const piece of chunkText(text, spec(37, 7))) {
      expect(piece.length).toBeLessThanOrEqual(37);
    }
  });

  it('the pieces concatenate back into the text when nothing overlaps', () => {
    const text = 'Some prose, with spaces and\nline breaks.\n\nAnd a second paragraph.';
    expect(chunkText(text, spec(20)).join('')).toBe(text);
  });
});

describe('where the cut lands', () => {
  const size = 20;

  it('prefers a blank line in the last tenth over anything else', () => {
    //                  0123456789012345678 9 0
    const text = 'aaaaaaaaaaaaaaaaaa\n\nbbbbbbbbbbbbbbbbbbbb';
    expect(chunkText(text, spec(size))[0]).toBe('aaaaaaaaaaaaaaaaaa\n\n');
  });

  it('falls back to a line break in that same window', () => {
    const text = 'aaaaaaaaaaaaaaaaaaa\nbbbbbbbbbbbbbbbbbbbb';
    expect(chunkText(text, spec(size))[0]).toBe('aaaaaaaaaaaaaaaaaaa\n');
  });

  it('falls back to a space when there is no break at all', () => {
    const text = 'aaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbb';
    expect(chunkText(text, spec(size))[0]).toBe('aaaaaaaaaaaaaaaaaaa ');
  });

  it('looks back no further than a tenth — an early space does not shorten the piece', () => {
    // The only space is at offset 2, far outside the last tenth (offsets 18-19).
    const text = `ab ${'c'.repeat(40)}`;
    expect(chunkText(text, spec(size))[0]).toBe(`ab ${'c'.repeat(17)}`);
    expect(chunkText(text, spec(size))[0]).toHaveLength(size);
  });
});

describe('overlap', () => {
  it('the next piece starts the given number of characters before the cut', () => {
    const pieces = chunkText('a'.repeat(30), spec(10, 4));
    expect(pieces[0]).toBe('a'.repeat(10));
    // Cut at 10, so the second piece opens at 6 and runs to 16.
    expect(pieces[1]).toHaveLength(10);
    expect(pieces.slice(0, 2).map(p => p.length)).toEqual([10, 10]);
  });

  it('every consecutive pair shares exactly the overlap, character for character', () => {
    const text = 'the quick brown fox jumps over the lazy dog. '.repeat(6);
    const overlap = 9;
    const pieces = chunkText(text, spec(40, overlap));
    for (let i = 1; i < pieces.length - 1; i++) {
      const previous = pieces[i - 1];
      expect(pieces[i].slice(0, overlap)).toBe(previous.slice(previous.length - overlap));
    }
  });

  it('an overlap that would undo a short piece still advances', () => {
    // Line breaks every 3 characters put every cut near the start of its
    // window; a 9-character overlap can only be honoured by moving backwards.
    const text = 'ab\n'.repeat(40);
    const pieces = chunkText(text, spec(10, 9));
    expect(pieces.length).toBeLessThan(text.length);
    expect(pieces.length).toBeGreaterThan(0);
  });
});

describe('determinism', () => {
  it('the same text and options give the same pieces, every time', () => {
    const text = 'Paragraph one.\n\nParagraph two is a little longer.\n\nThree.';
    const once = chunkText(text, spec(24, 6));
    const again = chunkText(text, spec(24, 6));
    expect(again).toEqual(once);
  });
});

describe('unicode', () => {
  // `size` counts UTF-16 code units — what LENGTH() counts — so an emoji is
  // two. What a cut must never do is land between the two halves.
  const emoji = '😀';

  it('never splits a surrogate pair at the ceiling', () => {
    const text = emoji.repeat(20);
    for (const piece of chunkText(text, spec(9))) {
      expect(piece).toBe([...piece].join(''));
      expect(piece.length % 2).toBe(0);
    }
  });

  it('never splits a surrogate pair where an overlap re-enters the text', () => {
    const text = emoji.repeat(20);
    for (const piece of chunkText(text, spec(10, 3))) {
      expect([...piece].every(c => c === emoji)).toBe(true);
    }
  });

  it('still cuts at a break when one is in the window', () => {
    const text = `${emoji.repeat(9)}\n${emoji.repeat(9)}`;
    expect(chunkText(text, spec(20))[0]).toBe(`${emoji.repeat(9)}\n`);
  });
});

describe('the options a run is handed', () => {
  it('rounds a fractional size down — LENGTH(t) / 3 is a normal thing to write', () => {
    expect(readChunkSpec(10.9, 2)).toEqual({ spec: { size: 10, overlap: 2 } });
  });

  it('treats a missing overlap as none', () => {
    expect(readChunkSpec(10, null)).toEqual({ spec: { size: 10, overlap: 0 } });
  });

  it('refuses a size below one character', () => {
    expect(readChunkSpec(0, 0)).toEqual({
      error: expect.stringContaining('at least 1 character'),
    });
  });

  it('refuses a size that is not a number at all', () => {
    expect(readChunkSpec('big', 0)).toEqual({
      error: expect.stringContaining('the text "big"'),
    });
  });

  it('refuses an overlap that is not smaller than the size, and says why', () => {
    const read = readChunkSpec(100, 100);
    expect('error' in read && read.error).toContain('has to be smaller than the size');
  });

  it('refuses a negative overlap', () => {
    expect(readChunkSpec(100, -1)).toEqual({ error: expect.any(String) });
  });
});

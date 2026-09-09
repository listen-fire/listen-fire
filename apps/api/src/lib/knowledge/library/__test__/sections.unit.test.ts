import { getLibraryShelf, readBook } from '../index';

// Section addressing is a LIBRARY capability, not an automations one: any
// book whose chapters use `###` headings can be read a section at a time, and
// a book whose chapters don't must say so rather than fail obscurely.

describe('library section fetch', () => {
  it('reads one section of a chapter, addressed either way', () => {
    const viaSuffix = readBook({ bookId: 'automations', chapter: 'writes#identity' }) as {
      section?: string;
      content?: string;
    };
    const viaArg = readBook({ bookId: 'automations', chapter: 'writes', section: 'identity' }) as {
      section?: string;
      content?: string;
    };
    expect(viaSuffix.section).toBe('identity');
    expect(viaSuffix.content).toEqual(viaArg.content);
    expect(viaSuffix.content).toMatch(/^### identity/);
  });

  it('a section costs a fraction of its chapter', () => {
    const whole = readBook({ bookId: 'automations', chapter: 'writes' }) as { content: string };
    const one = readBook({ bookId: 'automations', chapter: 'writes#identity' }) as {
      content: string;
    };
    expect(one.content.length).toBeLessThan(whole.content.length / 4);
  });

  it('mixes whole chapters and sections in one multi-fetch', () => {
    const result = readBook({
      bookId: 'automations',
      chapters: ['foundations', 'writes#identity'],
    }) as { chapters: Array<{ id: string; section?: string; content?: string }> };
    expect(result.chapters.map((c) => c.id)).toEqual(['foundations', 'writes']);
    expect(result.chapters[1].section).toBe('identity');
    expect(result.chapters[0].section).toBeUndefined();
  });

  it('an unknown section is refused with the real section ids', () => {
    const r = readBook({ bookId: 'automations', chapter: 'writes#nope' }) as {
      chapters: Array<{ error?: string }>;
    };
    expect(r.chapters[0].error).toMatch(/identity/);
  });

  it('a chapter with no headings says so instead of crashing', () => {
    // Whichever books have flat chapters, asking for a section of one must
    // return an explanation rather than throw.
    for (const book of getLibraryShelf()) {
      for (const chapter of book.chapters) {
        if (/^###\s/m.test(chapter.content)) continue;
        const r = readBook({ bookId: book.bookId, chapter: chapter.id, section: 'anything' }) as {
          chapters: Array<{ error?: string }>;
        };
        expect(r.chapters[0].error).toMatch(/no sections/i);
      }
    }
  });

  it("the book index serves when-to-read-what as compact routing lines", () => {
    const index = readBook({ bookId: 'automations' }) as { whenToReadWhat: string };
    expect(typeof index.whenToReadWhat).toBe('string');
    expect(index.whenToReadWhat).toMatch(/ → writes#identity$/m);
    // The same routing as verbose JSON objects cost 11.7KB, and it is paid by
    // exactly the readers who are already lost. A ceiling, so it can't creep
    // back: entries earn their place or merge with a neighbour.
    expect(Buffer.byteLength(JSON.stringify(index), 'utf8')).toBeLessThan(7200);
  });
});

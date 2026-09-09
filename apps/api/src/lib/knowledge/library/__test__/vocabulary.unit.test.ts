import { readBook, getLibraryShelf } from '../index';

/**
 * The vocabulary sweep (movement → automation) covers everything
 * `readHandbook` can return: the shelf listing itself, every book's
 * index (status note + when-to-read-what), and every available book's
 * chapter bodies. Code fences and inline backticks carry language
 * syntax (e.g. the legacy `movement` keyword in Translation examples)
 * and are exempt — strip them before asserting.
 */
function stripFences(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
}

describe('library vocabulary regression', () => {
  const shelf = getLibraryShelf();

  it('the shelf listing carries no movement vocabulary', () => {
    const prose = stripFences(JSON.stringify(readBook({})));
    expect(prose).not.toMatch(/\bmovements?\b/i);
  });

  it('every book index (status note + when-to-read-what) carries no movement vocabulary', () => {
    for (const book of shelf) {
      if (book.status === 'coming_soon') continue;
      const prose = stripFences(JSON.stringify(readBook({ bookId: book.bookId })));
      expect(prose).not.toMatch(/\bmovements?\b/i);
    }
  });

  it("every available book's chapter bodies carry no movement vocabulary", () => {
    for (const book of shelf) {
      if (book.status !== 'available') continue;
      const chapterIds = book.chapters.map((c) => c.id);
      const result = readBook({ bookId: book.bookId, chapters: chapterIds });
      const prose = stripFences(JSON.stringify(result));
      expect(prose).not.toMatch(/\bmovements?\b/i);
    }
  });
});

import { getLibraryShelf } from '../index';
import { modelHandbook } from '../../model_handbook';
import { queryHandbook } from '../../query_handbook';

describe('library shelf', () => {
  const shelf = getLibraryShelf();

  it('book ids are unique', () => {
    const ids = shelf.map((b) => b.bookId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('available and legacy books have chapters; coming-soon books are stubs', () => {
    for (const book of shelf) {
      if (book.status === 'coming_soon') {
        expect(book.chapters).toHaveLength(0);
      } else {
        expect(book.chapters.length).toBeGreaterThan(0);
      }
    }
  });

  it('the using-listen-fire book is first and available', () => {
    expect(shelf[0]?.bookId).toBe('using-listen-fire');
    expect(shelf[0]?.status).toBe('available');
  });

  it('the automations book is on the shelf and available', () => {
    const automations = shelf.find((b) => b.bookId === 'automations');
    expect(automations?.status).toBe('available');
  });

  it('the build-on-listen-fire stub links to its public repository', () => {
    const book = shelf.find((b) => b.bookId === 'build-on-listen-fire');
    expect(book?.link?.url).toBe('https://github.com/listen-fire/build-on-listen-fire');
  });

  it('every intent entry routes to a chapter in its own book', () => {
    for (const book of shelf) {
      const chapterIds = new Set(book.chapters.map((c) => c.id));
      for (const entry of book.intentIndex) {
        expect(chapterIds.has(entry.chapter)).toBe(true);
      }
    }
  });
});

interface RegistryShape {
  chapters: Record<string, { id: string; title: string; content: string }>;
  intentIndex: { intent: string; chapter: string; section?: string }[];
}

const registries: Array<[string, RegistryShape]> = [
  ['model_handbook', modelHandbook],
  ['query_handbook', queryHandbook],
];

describe.each(registries)('%s registry', (_name, handbook) => {
  const chapters = Object.values(handbook.chapters);

  it('chapters are substantial', () => {
    expect(chapters.length).toBeGreaterThanOrEqual(3);
    for (const c of chapters) {
      expect(c.content.length).toBeGreaterThan(500);
    }
  });

  it('every intent entry routes to a registered chapter', () => {
    for (const e of handbook.intentIndex) {
      expect(handbook.chapters[e.chapter]).toBeDefined();
    }
  });

  it('no chapter body uses internal jargon', () => {
    for (const c of chapters) {
      expect(c.content).not.toMatch(/\bTG\b/);
      expect(c.content).not.toMatch(/\bKG\b/);
      expect(c.content).not.toMatch(/\bnode[ _]type\b/i);
      expect(c.content).not.toMatch(/\bedge[ _]type\b/i);
      expect(c.content).not.toMatch(/\bproperty[ _]type\b/i);
      expect(c.content).not.toMatch(/\bSQL\b/);
      expect(c.content).not.toMatch(/schemaRef/);
    }
  });

  it('worked examples balance their code fences', () => {
    for (const c of chapters) {
      const fences = c.content.match(/```/g) ?? [];
      expect(fences.length % 2).toBe(0);
    }
  });
});

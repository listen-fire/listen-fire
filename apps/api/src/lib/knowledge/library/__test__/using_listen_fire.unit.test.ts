import { getLibraryShelf } from '../index';
import { listAdapterCapabilities } from '../../../../services/translation_graph/adapters/registry';

describe('Using Listen-Fire book', () => {
  it('appears on the shelf as an available book', () => {
    const book = getLibraryShelf().find((b) => b.bookId === 'using-listen-fire');
    expect(book).toBeDefined();
    expect(book!.status).toBe('available');
    expect(book!.chapters.map((c) => c.id)).toEqual([
      'getting-around',
      'connecting-integrations',
      'connect-build-automate',
    ]);
  });

  it('renders the connecting chapter live from the adapter manifests', () => {
    const book = getLibraryShelf().find((b) => b.bookId === 'using-listen-fire')!;
    const chapter = book.chapters.find((c) => c.id === 'connecting-integrations')!;
    const connectable = listAdapterCapabilities().filter((c) => c.requiredCredentialType !== null);
    expect(connectable.length).toBeGreaterThan(0);
    for (const cap of connectable) {
      expect(chapter.content).toContain(cap.displayName);
    }
  });
});

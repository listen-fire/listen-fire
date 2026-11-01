import { CATALOG_SNAPSHOT_VERSION, EMPTY_CATALOG_SNAPSHOT, fromCatalogSnapshot, type CatalogSnapshot } from '../snapshot';

// Version 2 retired an edge's `awaitable` and `watchable` for `listenable`,
// and `resolvesEmpty`, since a deleted record ends a wait on every edge. A
// snapshot still carrying one is refused, not read as an edge nothing can
// listen to.
const carrying = (member: string): CatalogSnapshot =>
  JSON.parse(
    JSON.stringify({
      ...EMPTY_CATALOG_SNAPSHOT,
      adapters: {
        crm: {
          constructionArgs: [],
          schemas: {
            '': {
              positions: { Ticket: { properties: {}, edges: { Reply: { target: 'Ticket', [member]: true } } } },
              collections: {},
              writableRoots: {},
            },
          },
        },
      },
    }),
  );

describe("a snapshot's retired edge members", () => {
  it('is written as version 3', () => {
    expect(CATALOG_SNAPSHOT_VERSION).toBe(3);
  });

  // Version 3 retired the settings listen's keys and event positions: a
  // version 2 snapshot is refused by name, never read as 3 without them.
  it.each([1, 2])('refuses a version %i snapshot naming 3', (version) => {
    expect(() => fromCatalogSnapshot({ ...EMPTY_CATALOG_SNAPSHOT, contractVersion: version })).toThrow(
      `the catalog snapshot carries contract version ${version}, written before 0.13 retired the settings listen; this release reads version 3: rebuild the catalog with it`,
    );
  });

  it.each(['awaitable', 'watchable'])('refuses an edge that still carries %s', (member) => {
    expect(() => fromCatalogSnapshot(carrying(member))).toThrow(
      `the catalog snapshot's 'crm' edge 'Reply' carries '${member}', retired in catalog snapshot version 2: declare 'listenable'`,
    );
  });

  it('refuses an edge that still carries resolvesEmpty', () => {
    expect(() => fromCatalogSnapshot(carrying('resolvesEmpty'))).toThrow(
      "the catalog snapshot's 'crm' edge 'Reply' carries 'resolvesEmpty', retired in catalog snapshot version 2: a deleted record leaves the wait waiting on every edge, so drop it",
    );
  });

  it('reads an edge that declares listenable', () => {
    expect(() => fromCatalogSnapshot(carrying('listenable'))).not.toThrow();
  });
});

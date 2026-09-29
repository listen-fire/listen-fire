import type { Kysely } from 'kysely';

import { mintUniqueSlug } from '../slug';

/**
 * A query builder standing in for `legal_entity`: `taken` is the set of slugs
 * already in the table, and each probe answers from it. Only the shape
 * `mintUniqueSlug` actually calls is modelled.
 */
function qbWithTaken(taken: Set<string>, rowId = 'row-1') {
  const probes: { slug: string; excludeId?: string }[] = [];
  const qb = {
    selectFrom: () => {
      let slug = '';
      let excludeId: string | undefined;
      const chain = {
        where: (column: string, op: string, value: string) => {
          if (column === 'slug') slug = value;
          if (column === 'id' && op === '!=') excludeId = value;
          return chain;
        },
        select: () => chain,
        executeTakeFirst: async () => {
          probes.push({ slug, excludeId });
          if (!taken.has(slug)) return undefined;
          // A row excluded by id is not a collision — that is the repair case,
          // where the company already owns the slug it is being given.
          return excludeId === rowId ? undefined : { id: rowId };
        },
      };
      return chain;
    },
  } as unknown as Kysely<any>;
  return { qb, probes };
}

describe('mintUniqueSlug', () => {
  it('slugifies a company name', async () => {
    const { qb } = qbWithTaken(new Set());
    expect(await mintUniqueSlug(qb, 'Arcus Labs')).toBe('arcus-labs');
  });

  it('strips punctuation and collapses separators', async () => {
    const { qb } = qbWithTaken(new Set());
    expect(await mintUniqueSlug(qb, '  Acme, Inc.  ')).toBe('acme-inc');
  });

  it('appends a suffix when the base slug is taken', async () => {
    const { qb } = qbWithTaken(new Set(['2native']));
    const slug = await mintUniqueSlug(qb, '2Native');
    expect(slug).not.toBe('2native');
    expect(slug).toMatch(/^2native-[0-9a-f]{6}$/);
  });

  // The collision that motivated the probe: `legal_entity_slug_key` is unique
  // GLOBALLY, so another team's row must still push us off the base slug.
  it('treats any existing row as a collision, not just this team\'s', async () => {
    const { qb } = qbWithTaken(new Set(['acme']));
    expect(await mintUniqueSlug(qb, 'Acme')).toMatch(/^acme-[0-9a-f]{6}$/);
  });

  it('keeps the base slug when the only holder is the excluded row', async () => {
    const { qb } = qbWithTaken(new Set(['newco']));
    expect(await mintUniqueSlug(qb, 'NewCo', { excludeId: 'row-1' })).toBe('newco');
  });

  // A name of pure punctuation slugifies to '', which must not become a row
  // with an empty-string slug — that URL addresses nothing.
  it('returns undefined when the name slugifies to nothing', async () => {
    const { qb, probes } = qbWithTaken(new Set());
    expect(await mintUniqueSlug(qb, '!!!')).toBeUndefined();
    expect(probes).toHaveLength(0);
  });

  it('gives up rather than looping forever when every candidate collides', async () => {
    const alwaysTaken = {
      selectFrom: () => {
        const chain = {
          where: () => chain,
          select: () => chain,
          executeTakeFirst: async () => ({ id: 'someone-else' }),
        };
        return chain;
      },
    } as unknown as Kysely<any>;
    await expect(mintUniqueSlug(alwaysTaken, 'Acme')).rejects.toThrow(/after 10 attempts/);
  });
});

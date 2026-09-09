import { validateKgQuery, KgQueryValidationError } from '../../output_v3/kg_query';

describe('validateKgQuery', () => {
  describe('happy path', () => {
    it('accepts a simple kg_exists query with one positional param', () => {
      const { ast } = validateKgQuery({
        kind: 'kg_exists',
        query: 'MATCH (c:Company {name: $0}) RETURN c.id',
        paramCount: 1,
      });
      expect(ast.match.patterns.length).toBe(1);
    });

    it('accepts kg_value with single-column RETURN', () => {
      const { ast } = validateKgQuery({
        kind: 'kg_value',
        query: 'MATCH (c:Company {id: $0}) RETURN c.name',
        paramCount: 1,
      });
      expect(ast.return.items.length).toBe(1);
    });

    it('accepts queries with no params', () => {
      validateKgQuery({
        kind: 'kg_exists',
        query: 'MATCH (c:Company) RETURN c.id',
        paramCount: 0,
      });
    });

    it('accepts params referenced multiple times', () => {
      validateKgQuery({
        kind: 'kg_exists',
        query: 'MATCH (c:Company) WHERE c.name = $0 OR c.alias = $0 RETURN c.id',
        paramCount: 1,
      });
    });
  });

  describe('mutation rejection', () => {
    it('rejects CREATE', () => {
      expect(() =>
        validateKgQuery({
          kind: 'kg_exists',
          query: 'CREATE (c:Company {name: $0}) RETURN c.id',
          paramCount: 1,
        }),
      ).toThrow(KgQueryValidationError);
    });

    it('rejects MERGE', () => {
      expect(() =>
        validateKgQuery({
          kind: 'kg_exists',
          query: 'MERGE (c:Company {name: $0}) RETURN c.id',
          paramCount: 1,
        }),
      ).toThrow(/mutation/);
    });

    it('rejects SET', () => {
      expect(() =>
        validateKgQuery({
          kind: 'kg_exists',
          query: 'MATCH (c:Company) SET c.name = $0 RETURN c.id',
          paramCount: 1,
        }),
      ).toThrow(/mutation/);
    });
  });

  describe('kg_value column count', () => {
    it('rejects multi-column RETURN for kg_value', () => {
      expect(() =>
        validateKgQuery({
          kind: 'kg_value',
          query: 'MATCH (c:Company {id: $0}) RETURN c.name, c.year',
          paramCount: 1,
        }),
      ).toThrow(/single RETURN column/);
    });

    it('allows multi-column RETURN for kg_exists (only existence is checked)', () => {
      validateKgQuery({
        kind: 'kg_exists',
        query: 'MATCH (c:Company {id: $0}) RETURN c.name, c.year',
        paramCount: 1,
      });
    });
  });

  describe('param count mismatch', () => {
    it('rejects when query references a higher index than params provided', () => {
      expect(() =>
        validateKgQuery({
          kind: 'kg_exists',
          query: 'MATCH (c:Company {name: $0, year: $1}) RETURN c.id',
          paramCount: 1,
        }),
      ).toThrow(/only 1 param/);
    });

    it('rejects unreferenced trailing params', () => {
      expect(() =>
        validateKgQuery({
          kind: 'kg_exists',
          query: 'MATCH (c:Company {name: $0}) RETURN c.id',
          paramCount: 2,
        }),
      ).toThrow(/not referenced/);
    });

    it('rejects non-positional named params', () => {
      expect(() =>
        validateKgQuery({
          kind: 'kg_exists',
          query: 'MATCH (c:Company {name: $name}) RETURN c.id',
          paramCount: 1,
        }),
      ).toThrow(/positional/);
    });
  });

  describe('parse errors', () => {
    it('surfaces parse errors as KgQueryValidationError', () => {
      expect(() =>
        validateKgQuery({
          kind: 'kg_exists',
          query: 'NOT_A_QUERY',
          paramCount: 0,
        }),
      ).toThrow(KgQueryValidationError);
    });
  });
});

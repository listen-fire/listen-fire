import { parseCypher } from '../parser';
import { transpile, TranspileError, type OntologyCache, type CypherParams } from '../transpiler';

function mockOntology(): OntologyCache {
  return {
    nodeTypes: new Map([
      ['company', { id: 'nt-company', name: 'Company' }],
      ['funding round', { id: 'nt-round', name: 'Funding Round' }],
      ['funding_round', { id: 'nt-round', name: 'Funding Round' }],
      ['investor', { id: 'nt-investor', name: 'Investor' }],
    ]),
    edgeTypes: new Map([
      [
        'has_funding_round',
        {
          id: 'et-has-round',
          sourceNodeTypeId: 'nt-company',
          targetNodeTypeId: 'nt-round',
        },
      ],
      [
        'invested_in',
        {
          id: 'et-invested',
          sourceNodeTypeId: 'nt-investor',
          targetNodeTypeId: 'nt-round',
        },
      ],
    ]),
    propertyTypes: new Map([
      [
        'nt-company',
        new Map([
          ['name', { id: 'pt-co-name', valueType: 'text', name: 'Name' }],
          ['founded', { id: 'pt-co-founded', valueType: 'date', name: 'Founded' }],
          ['active', { id: 'pt-co-active', valueType: 'boolean', name: 'Active' }],
        ]),
      ],
      [
        'nt-round',
        new Map([
          ['amount', { id: 'pt-r-amount', valueType: 'number', name: 'Amount' }],
          ['date', { id: 'pt-r-date', valueType: 'date', name: 'Date' }],
          ['stage', { id: 'pt-r-stage', valueType: 'text', name: 'Stage' }],
        ]),
      ],
      [
        'nt-investor',
        new Map([['name', { id: 'pt-inv-name', valueType: 'text', name: 'Name' }]]),
      ],
    ]),
  };
}

const TEAM_ID = 'team-test';

function run(cypher: string, maxLimit?: number) {
  const ast = parseCypher(cypher);
  return transpile(ast, mockOntology(), TEAM_ID, maxLimit);
}

function runWithParams(cypher: string, params: CypherParams, maxLimit?: number) {
  const ast = parseCypher(cypher);
  return transpile(ast, mockOntology(), TEAM_ID, maxLimit, params);
}

describe('transpile', () => {
  describe('basic queries', () => {
    it('generates FROM + WHERE for single node', () => {
      const { sql, params } = run('MATCH (c:Company) RETURN c.name');
      expect(sql).toContain('FROM knowledge.node');
      expect(sql).toContain('node_type_id');
      expect(sql).toContain('team_id');
      expect(params).toContain('nt-company');
      expect(params).toContain(TEAM_ID);
    });

    it('uses knowledge.prop for text properties', () => {
      const { sql } = run('MATCH (c:Company) RETURN c.name');
      expect(sql).toMatch(/knowledge\.prop\(n\d+\.id/);
    });

    it('resolves n.id (and n._id) to the node id column, not a property lookup', () => {
      for (const field of ['id', '_id']) {
        const { sql } = run(`MATCH (c:Company) RETURN c.${field} AS theId`);
        expect(sql).toMatch(/SELECT n\d+\.id AS "theId"/);
        expect(sql).not.toMatch(/knowledge\.prop\(n\d+\.id, \$\d+\) AS "theId"/);
      }
    });

    it('uses knowledge.prop_num for number properties', () => {
      const { sql } = run(
        'MATCH (r:`Funding Round`) RETURN r.amount',
      );
      expect(sql).toMatch(/knowledge\.prop_num\(n\d+\.id/);
    });

    it('uses knowledge.prop_date for date properties', () => {
      const { sql } = run(
        'MATCH (c:Company) RETURN c.founded',
      );
      expect(sql).toMatch(/knowledge\.prop_date\(n\d+\.id/);
    });

    it('uses knowledge.prop_bool for boolean properties', () => {
      const { sql } = run(
        'MATCH (c:Company) RETURN c.active',
      );
      expect(sql).toMatch(/knowledge\.prop_bool\(n\d+\.id/);
    });
  });

  describe('relationships', () => {
    it('generates JOIN for outgoing edge', () => {
      const { sql, params } = run(
        'MATCH (c:Company)-[:has_funding_round]->(r:`Funding Round`) RETURN c.name',
      );
      expect(sql).toContain('JOIN knowledge.edge');
      expect(sql).toContain('source_node_id');
      expect(sql).toContain('target_node_id');
      expect(params).toContain('et-has-round');
    });

    it('generates correct JOINs for incoming edge', () => {
      const { sql } = run(
        'MATCH (c:Company)<-[:invested_in]-(i:Investor) RETURN c.name',
      );
      // For incoming: edge.target_node_id = c, edge.source_node_id = i
      expect(sql).toContain('target_node_id');
      expect(sql).toContain('source_node_id');
    });

    it('generates chained JOINs', () => {
      const { sql } = run(
        'MATCH (c:Company)-[:has_funding_round]->(r:`Funding Round`)<-[:invested_in]-(i:Investor) RETURN c.name',
      );
      // Should have two edge JOINs
      const edgeJoins = sql.match(/JOIN knowledge\.edge/g);
      expect(edgeJoins).toHaveLength(2);
    });
  });

  describe('WHERE transpilation', () => {
    it('transpiles equality', () => {
      const { sql, params } = run(
        "MATCH (c:Company) WHERE c.name = 'Acme' RETURN c.name",
      );
      expect(sql).toContain('=');
      expect(params).toContain('Acme');
    });

    it('transpiles CONTAINS to ILIKE', () => {
      const { sql } = run(
        "MATCH (c:Company) WHERE c.name CONTAINS 'tech' RETURN c.name",
      );
      expect(sql).toContain('ILIKE');
    });

    it('transpiles STARTS WITH to ILIKE', () => {
      const { sql } = run(
        "MATCH (c:Company) WHERE c.name STARTS WITH 'A' RETURN c.name",
      );
      expect(sql).toMatch(/ILIKE .* \|\| '%'/);
    });

    it('transpiles IS NOT NULL', () => {
      const { sql } = run(
        'MATCH (c:Company) WHERE c.name IS NOT NULL RETURN c.name',
      );
      expect(sql).toContain('IS NOT NULL');
    });

    it('transpiles IS NULL', () => {
      const { sql } = run(
        'MATCH (c:Company) WHERE c.name IS NULL RETURN c.name',
      );
      expect(sql).toContain('IS NULL');
    });

    it('transpiles AND', () => {
      const { sql } = run(
        "MATCH (c:Company) WHERE c.name = 'A' AND c.active = TRUE RETURN c",
      );
      expect(sql).toContain('AND');
    });

    it('transpiles OR with parens', () => {
      const { sql } = run(
        "MATCH (c:Company) WHERE c.name = 'A' OR c.name = 'B' RETURN c",
      );
      expect(sql).toMatch(/\(.*OR.*\)/);
    });

    it('transpiles NOT', () => {
      const { sql } = run(
        "MATCH (c:Company) WHERE NOT c.name = 'Bad' RETURN c",
      );
      expect(sql).toContain('NOT');
    });
  });

  describe('aggregation', () => {
    it('generates GROUP BY for mixed aggregate/non-aggregate RETURN', () => {
      const { sql } = run(
        'MATCH (c:Company)-[:has_funding_round]->(r:`Funding Round`) RETURN c.name, COUNT(r) AS rounds',
      );
      expect(sql).toContain('GROUP BY');
      expect(sql).toContain('COUNT(');
    });

    it('does not generate GROUP BY for non-aggregate queries', () => {
      const { sql } = run('MATCH (c:Company) RETURN c.name');
      expect(sql).not.toContain('GROUP BY');
    });

    it('generates COUNT(*)', () => {
      const { sql } = run('MATCH (c:Company) RETURN COUNT(*) AS total');
      expect(sql).toContain('COUNT(*)');
    });

    it('generates SUM with prop accessor', () => {
      const { sql } = run(
        'MATCH (c:Company)-[:has_funding_round]->(r:`Funding Round`) RETURN c.name, SUM(r.amount) AS total',
      );
      expect(sql).toContain('SUM(');
      expect(sql).toContain('prop_num');
    });
  });

  describe('ORDER BY and LIMIT', () => {
    it('generates ORDER BY', () => {
      const { sql } = run(
        'MATCH (c:Company) RETURN c.name ORDER BY c.name',
      );
      expect(sql).toContain('ORDER BY');
      expect(sql).toContain('ASC');
    });

    it('generates ORDER BY DESC', () => {
      const { sql } = run(
        'MATCH (c:Company) RETURN c.name ORDER BY c.name DESC',
      );
      expect(sql).toContain('DESC');
    });

    it('clamps to the cap when one is supplied', () => {
      const { params } = run('MATCH (c:Company) RETURN c.name LIMIT 5000', 100);
      // The last param is the limit — should be clamped to 100
      expect(params[params.length - 1]).toBe(100);
    });

    it('falls back to the cap when no LIMIT given', () => {
      const { params } = run('MATCH (c:Company) RETURN c.name', 50);
      expect(params[params.length - 1]).toBe(50);
    });

    it('uses query limit when under the cap', () => {
      const { params } = run('MATCH (c:Company) RETURN c.name LIMIT 10', 100);
      expect(params[params.length - 1]).toBe(10);
    });

    it('emits no LIMIT when none given and no cap configured', () => {
      const { sql } = run('MATCH (c:Company) RETURN c.name');
      expect(sql).not.toContain('LIMIT');
    });

    it('honors an explicit LIMIT unbounded when no cap configured', () => {
      const { sql, params } = run('MATCH (c:Company) RETURN c.name LIMIT 50000');
      expect(sql).toContain('LIMIT');
      expect(params[params.length - 1]).toBe(50000);
    });
  });

  describe('team scoping', () => {
    it('adds team_id WHERE for every node', () => {
      const { sql, params } = run(
        'MATCH (c:Company)-[:has_funding_round]->(r:`Funding Round`) RETURN c.name',
      );
      // Should have two team_id params (one per node)
      const teamIdCount = params.filter((p) => p === TEAM_ID).length;
      expect(teamIdCount).toBe(2);
    });
  });

  describe('RETURN column names', () => {
    it('uses property name as default column name', () => {
      const { columns } = run('MATCH (c:Company) RETURN c.name');
      expect(columns).toEqual(['Name']);
    });

    it('uses alias when provided', () => {
      const { columns } = run(
        'MATCH (c:Company) RETURN c.name AS company_name',
      );
      expect(columns).toEqual(['company_name']);
    });

    it('returns multiple columns', () => {
      const { columns } = run(
        'MATCH (c:Company)-[:has_funding_round]->(r:`Funding Round`) RETURN c.name, r.amount, r.date',
      );
      expect(columns).toEqual(['Name', 'Amount', 'Date']);
    });
  });

  describe('DISTINCT', () => {
    it('adds DISTINCT to SELECT', () => {
      const { sql } = run('MATCH (c:Company) RETURN DISTINCT c.name');
      expect(sql).toMatch(/^SELECT DISTINCT/);
    });
  });

  describe('anonymous nodes in relationships', () => {
    it('does not duplicate anonymous node as standalone FROM entry', () => {
      const { sql, params } = run(
        'MATCH (c:Company)<-[:invested_in]-(:Investor) WHERE c.name IS NOT NULL RETURN c AS id ORDER BY c.name SKIP 0',
      );
      // The anonymous (:Investor) should be joined via the edge, not added as a
      // separate FROM entry. There should be exactly one FROM table (for c).
      const fromMatch = sql.match(/FROM\s+(.*?)(?:\s+(?:JOIN|LEFT JOIN|WHERE|ORDER|GROUP|HAVING|LIMIT))/s);
      expect(fromMatch).toBeTruthy();
      const fromSection = fromMatch![1];
      // Only one table in FROM (no comma-separated second table)
      expect(fromSection).not.toContain(',');
      // Should have JOINs for the edge and the investor node
      const nodeJoins = sql.match(/JOIN knowledge\.node/g);
      expect(nodeJoins).toHaveLength(1);
      // Should have exactly 2 team_id params (one per node, not 3)
      const teamIdCount = params.filter((p) => p === TEAM_ID).length;
      expect(teamIdCount).toBe(2);
    });
  });

  describe('error handling', () => {
    it('throws on unknown node type, naming the available types', () => {
      expect(() =>
        run('MATCH (c:UnknownType) RETURN c.name'),
      ).toThrow(TranspileError);
      expect(() =>
        run('MATCH (c:UnknownType) RETURN c.name'),
      ).toThrow(
        'Unknown node type: UnknownType. Available: Company, Funding Round, Investor',
      );
    });

    it('throws on unknown edge type, naming the available types', () => {
      expect(() =>
        run('MATCH (c:Company)-[:nonexistent]->(r:`Funding Round`) RETURN c.name'),
      ).toThrow(TranspileError);
      expect(() =>
        run('MATCH (c:Company)-[:nonexistent]->(r:`Funding Round`) RETURN c.name'),
      ).toThrow(
        'Unknown edge type: nonexistent. Available: has_funding_round, invested_in',
      );
    });

    it('throws on unknown variable in WHERE', () => {
      expect(() =>
        run("MATCH (c:Company) WHERE x.name = 'foo' RETURN c.name"),
      ).toThrow(TranspileError);
    });

    it('throws on unknown variable in RETURN', () => {
      expect(() =>
        run('MATCH (c:Company) RETURN x.name'),
      ).toThrow(TranspileError);
    });
  });

  describe('HAVING', () => {
    it('generates HAVING clause with alias resolved to expression', () => {
      const { sql } = run(
        'MATCH (i:Investor)-[:invested_in]->(r:`Funding Round`) ' +
          'RETURN r.stage AS stage, COUNT(i) AS investor_count ' +
          'HAVING investor_count >= 2',
      );
      expect(sql).toContain('GROUP BY');
      expect(sql).toContain('HAVING');
      // Alias "investor_count" should be resolved to the COUNT expression in HAVING
      expect(sql).toMatch(/HAVING COUNT\(/);
    });

    it('generates HAVING with AND conditions', () => {
      const { sql } = run(
        'MATCH (i:Investor)-[:invested_in]->(r:`Funding Round`) ' +
          'RETURN r.stage AS stage, COUNT(i) AS cnt, SUM(r.amount) AS total ' +
          'HAVING cnt >= 2 AND total > 100',
      );
      expect(sql).toContain('HAVING');
      expect(sql).toMatch(/COUNT\(/);
      expect(sql).toMatch(/SUM\(/);
    });

    it('keeps HAVING before ORDER BY in output SQL', () => {
      const { sql } = run(
        'MATCH (i:Investor)-[:invested_in]->(r:`Funding Round`) ' +
          'RETURN r.stage AS stage, COUNT(i) AS cnt ' +
          'HAVING cnt >= 2 ' +
          'ORDER BY cnt DESC',
      );
      const havingIdx = sql.indexOf('HAVING');
      const orderIdx = sql.indexOf('ORDER BY');
      expect(havingIdx).toBeLessThan(orderIdx);
    });
  });

  describe('IN expression', () => {
    it('generates IN clause', () => {
      const { sql, params } = run(
        "MATCH (r:`Funding Round`) WHERE r.stage IN ['Series A', 'Series B'] RETURN r.amount",
      );
      expect(sql).toContain('IN (');
      expect(params).toContain('Series A');
      expect(params).toContain('Series B');
    });

    it('generates NOT IN clause', () => {
      const { sql } = run(
        "MATCH (r:`Funding Round`) WHERE r.stage NOT IN ['Seed'] RETURN r.amount",
      );
      expect(sql).toContain('NOT IN (');
    });
  });

  describe('SKIP / OFFSET', () => {
    it('generates OFFSET', () => {
      const { sql, params } = run(
        'MATCH (c:Company) RETURN c.name SKIP 10 LIMIT 5',
      );
      expect(sql).toContain('OFFSET');
      expect(params).toContain(10);
    });

    it('generates OFFSET without explicit LIMIT', () => {
      const { sql } = run('MATCH (c:Company) RETURN c.name SKIP 5');
      expect(sql).toContain('OFFSET');
      expect(sql).not.toContain('LIMIT');
    });

    it('resolves parameterized SKIP and LIMIT', () => {
      const { sql, params } = runWithParams(
        'MATCH (c:Company) RETURN c.name SKIP $offset LIMIT $limit',
        { offset: 10, limit: 5 },
      );
      expect(sql).toContain('OFFSET');
      expect(sql).toContain('LIMIT');
      expect(params).toContain(10);
      expect(params).toContain(5);
    });

    it('clamps parameterized LIMIT to maxLimit', () => {
      const { params } = runWithParams(
        'MATCH (c:Company) RETURN c.name LIMIT $limit',
        { limit: 5000 },
        100,
      );
      expect(params).toContain(100);
      expect(params).not.toContain(5000);
    });

    it('throws on missing LIMIT parameter', () => {
      expect(() =>
        runWithParams('MATCH (c:Company) RETURN c.name LIMIT $limit', {}),
      ).toThrow(TranspileError);
    });

    it('throws on non-integer LIMIT parameter', () => {
      expect(() =>
        runWithParams('MATCH (c:Company) RETURN c.name LIMIT $limit', { limit: 'five' }),
      ).toThrow(TranspileError);
    });
  });

  describe('OPTIONAL MATCH', () => {
    it('generates LEFT JOIN for OPTIONAL MATCH', () => {
      const { sql } = run(
        'MATCH (c:Company) OPTIONAL MATCH (c)-[:has_funding_round]->(r:`Funding Round`) RETURN c.name, r.amount',
      );
      expect(sql).toContain('LEFT JOIN knowledge.edge');
      expect(sql).toContain('LEFT JOIN knowledge.node');
    });

    it('does not filter out rows without optional match', () => {
      const { sql } = run(
        'MATCH (c:Company) OPTIONAL MATCH (c)-[:has_funding_round]->(r:`Funding Round`) RETURN c.name',
      );
      // Edge type filter should be in ON clause, not WHERE
      expect(sql).toMatch(/LEFT JOIN knowledge\.edge e\d+ ON .* AND e\d+\.edge_type_id/);
    });
  });

  describe('COLLECT / array_agg', () => {
    it('generates array_agg for COLLECT', () => {
      const { sql } = run(
        'MATCH (c:Company)-[:has_funding_round]->(r:`Funding Round`) RETURN c.name, COLLECT(r.amount) AS amounts',
      );
      expect(sql).toContain('array_agg(');
      expect(sql).toContain('GROUP BY');
    });

    it('generates array_agg with DISTINCT', () => {
      const { sql } = run(
        'MATCH (c:Company)-[:has_funding_round]->(r:`Funding Round`) RETURN c.name, COLLECT(DISTINCT r.stage) AS stages',
      );
      expect(sql).toContain('array_agg(DISTINCT');
    });
  });

  describe('scalar functions', () => {
    it('maps TOLOWER to lower()', () => {
      const { sql } = run(
        "MATCH (c:Company) WHERE TOLOWER(c.name) = 'acme' RETURN c.name",
      );
      expect(sql).toContain('lower(');
    });

    it('maps TOUPPER to upper()', () => {
      const { sql } = run(
        'MATCH (c:Company) RETURN TOUPPER(c.name) AS upper_name',
      );
      expect(sql).toContain('upper(');
    });

    it('maps TRIM to trim()', () => {
      const { sql } = run(
        'MATCH (c:Company) RETURN TRIM(c.name) AS trimmed',
      );
      expect(sql).toContain('trim(');
    });

    it('maps TOSTRING to CAST(... AS text)', () => {
      const { sql } = run(
        'MATCH (r:`Funding Round`) RETURN TOSTRING(r.amount) AS amount_str',
      );
      expect(sql).toContain('CAST(');
      expect(sql).toContain('AS text)');
    });

    it('maps TOINTEGER to CAST(... AS integer)', () => {
      const { sql } = run(
        'MATCH (c:Company) RETURN TOINTEGER(c.name) AS val',
      );
      expect(sql).toContain('CAST(');
      expect(sql).toContain('AS integer)');
    });

    it('maps SIZE to length()', () => {
      const { sql } = run(
        'MATCH (c:Company) RETURN SIZE(c.name) AS len',
      );
      expect(sql).toContain('length(');
    });
  });

  describe('parameterization', () => {
    it('uses parameterized values (no SQL injection)', () => {
      const { sql, params } = run(
        "MATCH (c:Company) WHERE c.name = 'Robert; DROP TABLE knowledge.node' RETURN c",
      );
      // The malicious string should be in params, not in the SQL
      expect(sql).not.toContain('DROP TABLE');
      expect(params).toContain('Robert; DROP TABLE knowledge.node');
    });
  });

  // --- Proposed extensions (TDD: use `it.failing` until implemented) ---

  describe('EXISTS subquery', () => {
    it('generates SQL EXISTS (SELECT 1 ...) for EXISTS { MATCH ... }', () => {
      const { sql } = run(
        'MATCH (c:Company) ' +
          'WHERE EXISTS { MATCH (c)-[:has_funding_round]->(r:`Funding Round`) } ' +
          'RETURN c.name',
      );
      expect(sql).toMatch(/EXISTS\s*\(\s*SELECT\s+1/i);
      // The subquery must reference the outer binding for `c` (correlated).
      expect(sql).toMatch(/FROM\s+knowledge\.edge/);
    });

    it('correlates outer variable into EXISTS subquery', () => {
      const { sql, params } = run(
        'MATCH (c:Company) ' +
          "WHERE EXISTS { MATCH (c)-[:has_funding_round]->(r:`Funding Round`) WHERE r.amount > 1000000 } " +
          'RETURN c.name',
      );
      // The subquery's edge type predicate uses the has-round edge
      expect(params).toContain('et-has-round');
      // And the amount threshold is parameterized
      expect(params).toContain(1000000);
      expect(sql).toMatch(/EXISTS/i);
    });
  });

  describe('id() function', () => {
    it('transpiles id(n) to the node table id column', () => {
      const { sql } = run('MATCH (c:Company) RETURN id(c) AS cid');
      expect(sql).toMatch(/SELECT\s+n\d+\.id\s+AS\s+"?cid"?/i);
      expect(sql).not.toMatch(/knowledge\.prop\(.*['"]id['"]/);
    });

    it('transpiles WHERE id(n) = $param using the id column', () => {
      const { sql, params } = runWithParams(
        'MATCH (c:Company) WHERE id(c) = $id RETURN c.name',
        { id: 'node-uuid-123' },
      );
      expect(sql).toMatch(/n\d+\.id\s*=\s*\$\d+/);
      expect(params).toContain('node-uuid-123');
    });
  });

  describe('n._id pseudo-property', () => {
    it('transpiles n._id to the node table id column', () => {
      const { sql } = run('MATCH (c:Company) RETURN c._id AS cid');
      expect(sql).toMatch(/SELECT\s+n\d+\.id\s+AS\s+"?cid"?/i);
      expect(sql).not.toMatch(/knowledge\.prop\(.*['"]_?id['"]/);
    });

    it('transpiles WHERE n._id = $param using the id column', () => {
      const { sql, params } = runWithParams(
        'MATCH (c:Company) WHERE c._id = $id RETURN c.name',
        { id: 'node-uuid-456' },
      );
      expect(sql).toMatch(/n\d+\.id\s*=\s*\$\d+/);
      expect(params).toContain('node-uuid-456');
    });
  });

  describe('array/list parameters', () => {
    it('transpiles WHERE x IN $arrayParam using = ANY(array)', () => {
      const { sql, params } = runWithParams(
        'MATCH (r:`Funding Round`) WHERE r.stage IN $stages RETURN r.amount',
        { stages: ['A', 'B'] },
      );
      expect(sql).toMatch(/=\s*ANY\s*\(\s*\$\d+\s*\)/i);
      const hasArray = params.some((p) => Array.isArray(p) && (p as unknown[]).includes('A'));
      expect(hasArray).toBe(true);
    });

    it('transpiles WHERE x NOT IN $arrayParam using <> ALL(array)', () => {
      const { sql, params } = runWithParams(
        'MATCH (r:`Funding Round`) WHERE r.stage NOT IN $stages RETURN r.amount',
        { stages: ['C', 'D'] },
      );
      expect(sql).toMatch(/<>\s*ALL\s*\(\s*\$\d+\s*\)/i);
      const hasArray = params.some((p) => Array.isArray(p) && (p as unknown[]).includes('C'));
      expect(hasArray).toBe(true);
    });

    it('accepts number arrays', () => {
      const { sql, params } = runWithParams(
        'MATCH (r:`Funding Round`) WHERE r.amount IN $amounts RETURN r.amount',
        { amounts: [100, 200, 300] },
      );
      expect(sql).toMatch(/=\s*ANY\s*\(\s*\$\d+\s*\)/i);
      const arr = params.find((p) => Array.isArray(p)) as number[] | undefined;
      expect(arr).toEqual([100, 200, 300]);
    });
  });
});

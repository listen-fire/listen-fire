// The unified agent's deterministic tools, exposed directly over MCP/REST.
// These tests pin the discoverability + wiring contract that doesn't need a
// live request context: the readBook reader (the thesis-critical handbook
// surface, incl. the `foundations` doctrine chapter), the registry listing
// (describe_api), and that every op is mounted on the router. The data
// round-trips (createEntity / saveMovement / getNodeDetail) are proven through
// the real MCP path in the dev loop, where a Context exists.

import { Router } from 'express';

import { readBook, getLibraryShelf } from '../../../../lib/knowledge/library';
import { routes } from '../../../mcp/registry';
import {
  mountAutomationToolRoutes,
  mountKnowledgeToolRoutes,
  registerAutomationToolRoutes,
  registerKnowledgeAgentToolRoutes,
} from '../knowledge_agent_tools';

describe('readBook (direct MCP handbook reader)', () => {
  it('no args → the shelf, listing every available book', () => {
    const result = readBook({}) as { shelf: { bookId: string }[] };
    expect(Array.isArray(result.shelf)).toBe(true);
    const ids = result.shelf.map((b) => b.bookId);
    expect(ids).toContain('automations');
    expect(ids).toContain('knowledge-model');
    expect(ids).toContain('using-listen-fire');
  });

  it('automations book → a chapter index that includes the foundations doctrine', () => {
    const result = readBook({ bookId: 'automations' }) as {
      chapters: { id: string }[];
    };
    expect(result.chapters.map((c) => c.id)).toContain('foundations');
  });

  it('automations + foundations → the doctrine chapter body', () => {
    const result = readBook({ bookId: 'automations', chapter: 'foundations' }) as {
      chapter: string;
      content: string;
    };
    expect(result.chapter).toBe('foundations');
    expect(result.content.length).toBeGreaterThan(0);
  });

  it('several chapters in one call come back as an array', () => {
    const book = getLibraryShelf().find((b) => b.bookId === 'automations')!;
    const two = book.chapters.slice(0, 2).map((c) => c.id);
    const result = readBook({ bookId: 'automations', chapters: two }) as {
      chapters: { id: string }[];
    };
    expect(result.chapters.map((c) => c.id)).toEqual(two);
  });

  it('an unknown book is a clean error, not a throw', () => {
    const result = readBook({ bookId: 'nope' }) as { error: string };
    expect(result.error).toMatch(/No book/);
  });
});

describe('registry (describe_api)', () => {
  beforeAll(() => {
    registerAutomationToolRoutes();
    registerKnowledgeAgentToolRoutes();
  });

  const has = (method: string, path: string, domain: string) =>
    routes.some((r) => r.method === method && r.path === path && r.domain === domain);

  it('lists the automation ops under the automation domain + /v1/automation', () => {
    expect(has('GET', '/v1/automation/teams', 'automation')).toBe(true);
    expect(has('POST', '/v1/automation/handbook', 'automation')).toBe(true);
    expect(has('GET', '/v1/automation/connections', 'automation')).toBe(true);
    expect(has('POST', '/v1/automation/connections/describe', 'automation')).toBe(true);
    expect(has('POST', '/v1/automation/connections/connect', 'automation')).toBe(true);
    expect(has('POST', '/v1/automation/automations/validate', 'automation')).toBe(true);
    expect(has('POST', '/v1/automation/automations/save', 'automation')).toBe(true);
    expect(has('GET', '/v1/automation/automations/:idOrName/source', 'automation')).toBe(true);
    expect(has('POST', '/v1/automation/automations/:idOrName/edit', 'automation')).toBe(true);
    expect(has('GET', '/v1/automation/automations/grep', 'automation')).toBe(true);
    expect(has('POST', '/v1/automation/automations/run', 'automation')).toBe(true);
    expect(has('POST', '/v1/automation/automations/run-status', 'automation')).toBe(true);
    expect(has('GET', '/v1/automation/automations', 'automation')).toBe(true);
    expect(has('POST', '/v1/automation/automations/cancel-run', 'automation')).toBe(true);
  });

  it('lists the KG read + edit ops under the knowledge domain', () => {
    expect(has('GET', '/v1/knowledge/teams', 'knowledge')).toBe(true);
    expect(has('GET', '/v1/knowledge/ontology', 'knowledge')).toBe(true);
    expect(has('GET', '/v1/knowledge/node-detail/:id', 'knowledge')).toBe(true);
    expect(has('POST', '/v1/knowledge/entities', 'knowledge')).toBe(true);
    expect(has('PATCH', '/v1/knowledge/entities', 'knowledge')).toBe(true);
    expect(has('DELETE', '/v1/knowledge/entities', 'knowledge')).toBe(true);
    expect(has('POST', '/v1/knowledge/relationships', 'knowledge')).toBe(true);
    expect(has('POST', '/v1/knowledge/merge', 'knowledge')).toBe(true);
  });

  it('lists the model (ontology) mutations under the knowledge domain', () => {
    expect(has('POST', '/v1/knowledge/ontology/createNodeType', 'knowledge')).toBe(true);
    expect(has('POST', '/v1/knowledge/ontology/createEdgeType', 'knowledge')).toBe(true);
    expect(has('POST', '/v1/knowledge/ontology/setUniquenessConstraints', 'knowledge')).toBe(true);
  });

  it('does NOT list any automation op under the knowledge domain (fully split)', () => {
    expect(has('POST', '/v1/knowledge/automations/run', 'knowledge')).toBe(false);
    expect(has('GET', '/v1/knowledge/connections', 'knowledge')).toBe(false);
  });
});

describe('router mounting', () => {
  const mountedPaths = (router: ReturnType<typeof Router>) =>
    router.stack
      .map((l: any) => (l.route ? `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}` : null))
      .filter(Boolean) as string[];

  it('mounts the automation ops without throwing', () => {
    const router = Router();
    expect(() => mountAutomationToolRoutes(router)).not.toThrow();
    const mounted = mountedPaths(router);
    expect(mounted).toContain('GET /teams');
    expect(mounted).toContain('POST /handbook');
    expect(mounted).toContain('GET /connections');
    expect(mounted).toContain('POST /connections/connect');
    expect(mounted).toContain('POST /automations/save');
    expect(mounted).toContain('GET /automations/:idOrName/source');
    expect(mounted).toContain('POST /automations/:idOrName/edit');
    expect(mounted).toContain('GET /automations/grep');
    expect(mounted).toContain('POST /automations/run');
    expect(mounted).toContain('POST /automations/run-status');
    expect(mounted).toContain('POST /automations/cancel-run');
    // No KG-edit ops leak onto the automation router.
    expect(mounted).not.toContain('POST /entities');
    // /automations/grep is registered BEFORE the :idOrName param route, or it
    // would resolve as an automation literally named "grep".
    expect(mounted.indexOf('GET /automations/grep')).toBeLessThan(
      mounted.indexOf('GET /automations/:idOrName'),
    );
  });

  it('mounts the knowledge ops without throwing', () => {
    const router = Router();
    expect(() => mountKnowledgeToolRoutes(router)).not.toThrow();
    const mounted = mountedPaths(router);
    expect(mounted).toContain('GET /teams');
    expect(mounted).toContain('POST /entities');
    expect(mounted).toContain('POST /ontology/createNodeType');
    // No automation ops leak onto the knowledge router.
    expect(mounted).not.toContain('POST /automations/run');
  });
});

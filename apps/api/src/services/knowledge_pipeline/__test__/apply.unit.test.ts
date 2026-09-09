/**
 * Unit tests for applyChangeset — focused on the property dedup guard
 * that prevents duplicate (node_id, property_type_id) rows from being
 * created, and ensures evidence is preserved + re-evaluation happens
 * when duplicates are detected.
 */

import type { NodeId } from '../../../generated/kysely/knowledge/Node';
import type { NodeTypeId } from '../../../generated/kysely/knowledge/NodeType';
import type { EdgeTypeId } from '../../../generated/kysely/knowledge/EdgeType';
import type { PropertyTypeId } from '../../../generated/kysely/knowledge/PropertyType';
import type { PropertyId } from '../../../generated/kysely/knowledge/Property';
import type { EdgeId } from '../../../generated/kysely/knowledge/Edge';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { ResourceId } from '../../../generated/kysely/knowledge/Resource';
import type EvidenceType from '../../../generated/kysely/knowledge/EvidenceType';
import type { Changeset, ChangesetNode, ChangesetProperty, ExtractedEvidence } from '../types';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockExecute = jest.fn();
jest.mock('../../../lib/prompts/execute', () => ({
  execute: (...args: unknown[]) => mockExecute(...args),
}));

jest.mock('../../../lib/prompts/definition', () => ({
  promptDef: (def: unknown) => def,
}));

jest.mock('../../../generated/kysely/knowledge/EvaluationStrategy', () => ({
  __esModule: true,
  default: { latest: 'latest', llm: 'llm' },
}));

jest.mock('../../../generated/kysely/knowledge/EvidenceType', () => ({
  __esModule: true,
  default: { extraction: 'extraction', user_edit: 'user_edit', retrieval: 'retrieval' },
}));

// Build a chainable mock that records operations for assertions
interface MockDbCall {
  operation: string;
  table: string;
  values?: Record<string, unknown>;
  conditions?: Array<{ column: string; op: string; value: unknown }>;
  updateValues?: Record<string, unknown>;
}

function createMockTrx() {
  const calls: MockDbCall[] = [];
  const insertedNodes = new Map<string, string>(); // temp values → generated IDs
  let nodeIdCounter = 0;
  let propertyIdCounter = 0;
  let edgeIdCounter = 0;
  let evidenceIdCounter = 0;

  // Track inserted properties to verify dedup guard
  const insertedProperties: Array<{
    id: string;
    node_id?: string;
    edge_id?: string;
    property_type_id: string;
    value_text?: string;
    value_number?: string;
  }> = [];

  // Track evidence insertions
  const insertedEvidence: Array<{
    id: string;
    property_id: string;
    description: string;
  }> = [];

  // Rows that "exist" in the DB before this transaction
  const preExistingProperties: Array<{
    id: string;
    node_id: string;
    property_type_id: string;
  }> = [];

  const preExistingEdges: Array<{
    id: string;
    source_node_id: string;
    target_node_id: string;
    edge_type_id: string;
  }> = [];

  function createChain(context: { table?: string; operation?: string; values?: Record<string, unknown>; conditions: Array<{ column: string; op: string; value: unknown }> }) {
    const chain: Record<string, unknown> = {};
    const where = (col: string, op: string, val: unknown) => {
      context.conditions.push({ column: col, op, value: val });
      return chain;
    };

    Object.assign(chain, {
      values: (v: Record<string, unknown>) => { context.values = v; return chain; },
      set: (v: Record<string, unknown>) => { context.values = { ...context.values, ...v }; return chain; },
      where,
      whereRef: where,
      select: () => chain,
      returning: () => chain,
      innerJoin: () => chain,
      orderBy: () => chain,
      execute: async () => {
        const call: MockDbCall = {
          operation: context.operation ?? 'select',
          table: context.table ?? '',
          values: context.values,
          conditions: context.conditions,
        };
        calls.push(call);

        // Handle selects on property table (for dedup checks)
        if (context.operation === 'select' && context.table === 'property') {
          const nodeId = context.conditions.find((c) => c.column === 'property.node_id')?.value as string;
          const propTypeId = context.conditions.find((c) => c.column === 'property.property_type_id')?.value as string;

          // Check pre-existing
          if (nodeId && propTypeId) {
            const found = preExistingProperties.find(
              (p) => p.node_id === nodeId && p.property_type_id === propTypeId,
            );
            if (found) return [{ id: found.id }];
          }

          // Check what we inserted this transaction
          const edgeId = context.conditions.find((c) => c.column === 'property.edge_id')?.value as string;
          if (edgeId && propTypeId) {
            const found = insertedProperties.find(
              (p) => p.edge_id === edgeId && p.property_type_id === propTypeId,
            );
            if (found) return [{ id: found.id }];
          }

          return [];
        }

        // Handle selects on edge table
        if (context.operation === 'select' && context.table === 'edge') {
          const src = context.conditions.find((c) => c.column === 'edge.source_node_id')?.value as string;
          const tgt = context.conditions.find((c) => c.column === 'edge.target_node_id')?.value as string;
          const et = context.conditions.find((c) => c.column === 'edge.edge_type_id')?.value as string;
          const found = preExistingEdges.find(
            (e) => e.source_node_id === src && e.target_node_id === tgt && e.edge_type_id === et,
          );
          if (found) return [{ id: found.id }];
          return [];
        }

        // Handle selects on evidence table (for re-evaluation count)
        if (context.operation === 'select' && context.table === 'evidence') {
          const propId = context.conditions.find((c) => c.column === 'evidence.property_id')?.value as string;
          const matching = insertedEvidence.filter((e) => e.property_id === propId);
          return matching.map((e) => ({ id: e.id }));
        }

        // Handle selects on property_type
        if (context.operation === 'select' && context.table === 'property_type') {
          return [
            { id: 'pt-name', value_type: 'text', evaluation_strategy: 'latest' },
            { id: 'pt-class', value_type: 'text', evaluation_strategy: 'latest' },
            { id: 'pt-desc', value_type: 'text', evaluation_strategy: 'llm' },
          ];
        }

        return [];
      },
      executeTakeFirst: async () => {
        const result = await (chain as { execute: () => Promise<Array<{ id: string }>> }).execute();
        return (result as Array<{ id: string }>)[0] ?? undefined;
      },
      executeTakeFirstOrThrow: async () => {
        if (context.operation === 'insert' && context.table === 'node') {
          const id = `node-${++nodeIdCounter}`;
          return { id };
        }
        if (context.operation === 'insert' && context.table === 'property') {
          const id = `prop-${++propertyIdCounter}`;
          insertedProperties.push({
            id,
            node_id: context.values?.node_id as string,
            edge_id: context.values?.edge_id as string,
            property_type_id: context.values?.property_type_id as string,
            value_text: context.values?.value_text as string,
          });
          return { id };
        }
        if (context.operation === 'insert' && context.table === 'edge') {
          const id = `edge-${++edgeIdCounter}`;
          return { id };
        }
        throw new Error(`Unexpected executeTakeFirstOrThrow on ${context.table}`);
      },
    });

    return chain;
  }

  const trx = {
    insertInto: (table: string) => createChain({ table, operation: 'insert', conditions: [] }),
    selectFrom: (table: string) => createChain({ table, operation: 'select', conditions: [] }),
    updateTable: (table: string) => createChain({ table, operation: 'update', conditions: [] }),
    // Evidence insertion tracking
    _onInsertEvidence(propertyId: string, description: string) {
      const id = `ev-${++evidenceIdCounter}`;
      insertedEvidence.push({ id, property_id: propertyId, description });
    },
  };

  return {
    trx,
    calls,
    insertedProperties,
    insertedEvidence,
    preExistingProperties,
    preExistingEdges,
  };
}

// Mock kysely to provide the transaction wrapper
let mockTrxCallback: ((trx: unknown) => Promise<unknown>) | null = null;
let mockTrxResult: unknown = null;

jest.mock('../../../lib/kysely', () => ({
  getKnowledgeQb: jest.fn(() => ({
    transaction: () => ({
      execute: async (fn: (trx: unknown) => Promise<unknown>) => {
        mockTrxCallback = fn;
        // Caller provides the trx in the test
        return mockTrxResult;
      },
    }),
  })),
  getAutomationsQb: jest.fn(() => ({
    transaction: () => ({
      execute: async (fn: (trx: unknown) => Promise<unknown>) => {
        mockTrxCallback = fn;
        // Caller provides the trx in the test
        return mockTrxResult;
      },
    }),
  })),
}));

jest.mock('../../../lib/knowledge/changes', () => ({
  ...jest.requireActual('../../../lib/knowledge/changes'),
  recordChanges: jest.fn(),
}));

import { applyChangeset } from '../apply';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEAM_ID = 'team-1' as TeamId;
const NT_CHARACTER = 'nt-character' as NodeTypeId;
const NT_SESSION = 'nt-session' as NodeTypeId;
const PT_NAME = 'pt-name' as PropertyTypeId;
const PT_CLASS = 'pt-class' as PropertyTypeId;
const PT_DESC = 'pt-desc' as PropertyTypeId;
const ET_FEATURES = 'et-features' as EdgeTypeId;
const RESOURCE_ID = 'resource-1' as ResourceId;

function makeChangeset(overrides: Partial<Changeset> = {}): Changeset {
  return {
    messageNode: { tempId: 'msg-1', nodeType: NT_SESSION },
    nodes: [],
    properties: [],
    edges: [],
    evidence: [],
    edgeEvidence: [],
    nodeResources: [],
    ...overrides,
  };
}

function makeNode(tempId: string, nodeType: NodeTypeId, action: 'create' | 'match', existingNodeId?: string): ChangesetNode {
  return {
    tempId,
    nodeType,
    resolution: action === 'create'
      ? { action: 'create' }
      : { action: 'match', existingNodeId: existingNodeId as unknown as NodeId, confidence: 1 },
  };
}

function makeProp(tempId: string, propTypeId: PropertyTypeId, parentTempId: string, value: unknown, action: 'create' | 'match', existingNodeId?: string): ChangesetProperty {
  return {
    tempId,
    propertyTypeId: propTypeId,
    parentTempId,
    value,
    evidenceDescription: `Evidence for ${value}`,
    resolution: action === 'create'
      ? { action: 'create' }
      : { action: 'match', existingNodeId: existingNodeId as unknown as NodeId, confidence: 1 },
  };
}

function makeEvidence(propTempId: string, desc: string): ExtractedEvidence {
  return {
    targetPropertyTempId: propTempId,
    resourceId: RESOURCE_ID,
    type: 'extraction' as unknown as EvidenceType,
    description: desc,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('applyChangeset — property dedup guard', () => {
  beforeEach(() => {
    mockExecute.mockReset();
    mockTrxCallback = null;
    mockTrxResult = null;
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Case 1: Two properties with same (parentTempId, propertyTypeId) in
  // changeset for a newly created node. Second should be caught by
  // insertedPropertyKeys guard, NOT create a duplicate row.
  // ─────────────────────────────────────────────────────────────────────────

  it('prevents duplicate property insertion on a new node', async () => {
    const mock = createMockTrx();

    const changeset = makeChangeset({
      nodes: [
        makeNode('msg-1', NT_SESSION, 'create'),
        makeNode('char-1', NT_CHARACTER, 'create'),
      ],
      properties: [
        makeProp('p1', PT_NAME, 'char-1', 'Gandalf', 'create'),
        makeProp('p2', PT_NAME, 'char-1', 'Gandalf the Grey', 'create'), // duplicate!
      ],
      evidence: [
        makeEvidence('p1', 'First mention of Gandalf'),
        makeEvidence('p2', 'Full name Gandalf the Grey'),
      ],
    });

    const { getKnowledgeQb } = require('../../../lib/kysely');
    getKnowledgeQb.mockReturnValue({
      transaction: () => ({
        execute: async (fn: (trx: unknown) => Promise<unknown>) => {
          return fn(mock.trx);
        },
      }),
    });

    await applyChangeset(changeset, TEAM_ID);

    // Should have inserted exactly ONE property row for PT_NAME on char-1
    const nameInserts = mock.insertedProperties.filter(
      (p) => p.property_type_id === (PT_NAME as string),
    );
    expect(nameInserts).toHaveLength(1);

    // Both evidence records should be inserted (pointing at the same property)
    const evidenceCalls = mock.calls.filter(
      (c) => c.operation === 'insert' && c.table === 'evidence' && c.values?.description,
    );
    const propEvidenceCalls = evidenceCalls.filter(
      (c) => c.values?.property_id === nameInserts[0].id,
    );
    expect(propEvidenceCalls).toHaveLength(2);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Case 2: Normal case — two different property types on the same node.
  // Both should be inserted (no false positive dedup).
  // ─────────────────────────────────────────────────────────────────────────

  it('inserts distinct property types normally without false dedup', async () => {
    const mock = createMockTrx();

    const changeset = makeChangeset({
      nodes: [
        makeNode('msg-1', NT_SESSION, 'create'),
        makeNode('char-1', NT_CHARACTER, 'create'),
      ],
      properties: [
        makeProp('p1', PT_NAME, 'char-1', 'Gandalf', 'create'),
        makeProp('p2', PT_CLASS, 'char-1', 'Wizard', 'create'),
      ],
      evidence: [
        makeEvidence('p1', 'Named Gandalf'),
        makeEvidence('p2', 'Class is Wizard'),
      ],
    });

    const { getKnowledgeQb } = require('../../../lib/kysely');
    getKnowledgeQb.mockReturnValue({
      transaction: () => ({
        execute: async (fn: (trx: unknown) => Promise<unknown>) => fn(mock.trx),
      }),
    });

    await applyChangeset(changeset, TEAM_ID);

    // Both properties should be inserted
    expect(mock.insertedProperties).toHaveLength(2);
    expect(mock.insertedProperties.map((p) => p.property_type_id).sort()).toEqual(
      [PT_CLASS as string, PT_NAME as string].sort(),
    );
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Case 3: Three duplicate properties (the "three names" scenario).
  // Only one insert, but all three evidence records preserved.
  // ─────────────────────────────────────────────────────────────────────────

  it('handles triple-duplicate properties with all evidence preserved', async () => {
    const mock = createMockTrx();

    const changeset = makeChangeset({
      nodes: [
        makeNode('msg-1', NT_SESSION, 'create'),
        makeNode('char-1', NT_CHARACTER, 'create'),
      ],
      properties: [
        makeProp('p1', PT_NAME, 'char-1', 'Aragorn', 'create'),
        makeProp('p2', PT_NAME, 'char-1', 'Strider', 'create'),
        makeProp('p3', PT_NAME, 'char-1', 'Elessar', 'create'),
      ],
      evidence: [
        makeEvidence('p1', 'Called Aragorn by Gandalf'),
        makeEvidence('p2', 'Known as Strider at the inn'),
        makeEvidence('p3', 'Crowned as Elessar'),
      ],
    });

    const { getKnowledgeQb } = require('../../../lib/kysely');
    getKnowledgeQb.mockReturnValue({
      transaction: () => ({
        execute: async (fn: (trx: unknown) => Promise<unknown>) => fn(mock.trx),
      }),
    });

    await applyChangeset(changeset, TEAM_ID);

    // Exactly one property row
    const nameInserts = mock.insertedProperties.filter(
      (p) => p.property_type_id === (PT_NAME as string),
    );
    expect(nameInserts).toHaveLength(1);
    expect(nameInserts[0].value_text).toBe('Aragorn'); // first value wins at insert

    // All three evidence records should be created
    const evidenceCalls = mock.calls.filter(
      (c) => c.operation === 'insert' && c.table === 'evidence' && c.values?.property_id === nameInserts[0].id,
    );
    expect(evidenceCalls).toHaveLength(3);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Case 4: Duplicate properties on a MATCHED node (node already exists in DB).
  // The property also already exists in DB. Should upsert once, not create dupes.
  // ─────────────────────────────────────────────────────────────────────────

  it('upserts matched node properties without creating duplicates', async () => {
    const existingNodeId = 'existing-node-1';
    const existingPropId = 'existing-prop-1';

    const mock = createMockTrx();
    mock.preExistingProperties.push({
      id: existingPropId,
      node_id: existingNodeId,
      property_type_id: PT_NAME as string,
    });

    const changeset = makeChangeset({
      nodes: [
        makeNode('msg-1', NT_SESSION, 'create'),
        makeNode('char-1', NT_CHARACTER, 'match', existingNodeId),
      ],
      properties: [
        makeProp('p1', PT_NAME, 'char-1', 'Gandalf Updated', 'create'),
        makeProp('p2', PT_NAME, 'char-1', 'Gandalf Revised', 'create'), // duplicate
      ],
      evidence: [
        makeEvidence('p1', 'Updated name'),
        makeEvidence('p2', 'Revised name'),
      ],
    });

    const { getKnowledgeQb } = require('../../../lib/kysely');
    getKnowledgeQb.mockReturnValue({
      transaction: () => ({
        execute: async (fn: (trx: unknown) => Promise<unknown>) => fn(mock.trx),
      }),
    });

    await applyChangeset(changeset, TEAM_ID);

    // No new property rows should be inserted (existing one gets upserted)
    const nameInserts = mock.insertedProperties.filter(
      (p) => p.property_type_id === (PT_NAME as string),
    );
    expect(nameInserts).toHaveLength(0);

    // The update should happen once (first property triggers upsert, second hits dedup guard)
    const updateCalls = mock.calls.filter(
      (c) => c.operation === 'update' && c.table === 'property',
    );
    expect(updateCalls).toHaveLength(1);

    // Both evidence records should still be created
    const evidenceCalls = mock.calls.filter(
      (c) => c.operation === 'insert' && c.table === 'evidence' && c.values?.property_id === existingPropId,
    );
    expect(evidenceCalls).toHaveLength(2);
  });
});

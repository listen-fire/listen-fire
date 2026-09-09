// The knowledge agent's CRUD tools, over the store's write door.
//
// What stays here is the agent's own surface: resolving names the model spoke
// ("Company", "Stage") to ontology ids, the enum check, and error text a model
// can act on. Every write itself — the `writable_by` gate, coercion, evidence,
// change rows, transactionality — is the door's (D37).

import { TeamId } from '../../generated/kysely/core/Team';
import { NodeId } from '../../generated/kysely/knowledge/Node';
import { EdgeId } from '../../generated/kysely/knowledge/Edge';
import EvidenceType from '../../generated/kysely/knowledge/EvidenceType';
import {
  createNode,
  deleteNode,
  inTransaction,
  link,
  openKnowledgeStore,
  setProperties,
  unlink,
  type KnowledgeWriteDb,
  type PropertyWrite,
  type WriteContext,
} from './store';
import { ChangeSource } from './changes';

type PropertyValue = string | number | boolean | null;

interface ResolvedPropertyType {
  id: string;
  name: string;
  value_type: string;
  enum_values: unknown;
}

/** The agent writes as a person would: `user_edit` evidence, `agent` source. */
function agentContext(teamId: string, description: string): WriteContext {
  return {
    teamId: teamId as TeamId,
    evidenceType: EvidenceType.user_edit,
    changeSource: ChangeSource.agent,
    description,
  };
}

/** The caller's transaction when it has one, the store's own handle otherwise. */
function handle(externalTrx?: any): KnowledgeWriteDb {
  return (externalTrx as KnowledgeWriteDb) ?? openKnowledgeStore();
}

/**
 * Turn the model's `{name: value}` into the door's `{propertyTypeId, value}`,
 * checking the two things only this surface knows: that the name exists, and
 * that an enum value is one of the allowed ones. `null` rides through as a
 * CLEAR (D37a) — the property keeps its row and its evidence history.
 */
function resolveProperties(
  properties: Record<string, PropertyValue>,
  propertyTypes: ResolvedPropertyType[],
): PropertyWrite[] {
  const ptMap = new Map(propertyTypes.map((pt) => [pt.name, pt]));
  const writes: PropertyWrite[] = [];

  for (const [name, value] of Object.entries(properties)) {
    const pt = ptMap.get(name);
    if (!pt) {
      const available = propertyTypes.map((p) => p.name).join(', ');
      throw new Error(`Unknown property "${name}". Available: ${available}`);
    }

    if (value !== null && pt.enum_values && Array.isArray(pt.enum_values) && pt.enum_values.length > 0) {
      if (!pt.enum_values.includes(String(value))) {
        throw new Error(
          `Invalid value "${value}" for "${name}". Allowed: ${(pt.enum_values as string[]).join(', ')}`,
        );
      }
    }

    writes.push({ propertyTypeId: pt.id, value });
  }

  return writes;
}

async function resolveNodeType(db: KnowledgeWriteDb, teamId: string, typeName: string) {
  const nodeType = await db
    .selectFrom('node_type')
    .where('team_id', '=', teamId as TeamId)
    .where('name', '=', typeName)
    .select(['id', 'name', 'category'])
    .executeTakeFirst();
  if (nodeType) return nodeType;

  const types = await db
    .selectFrom('node_type')
    .where('team_id', '=', teamId as TeamId)
    .select('name')
    .execute();
  throw new Error(
    `Unknown type "${typeName}". Available: ${types.map((t) => t.name).join(', ')}`,
  );
}

async function propertyTypesOfNodeType(
  db: KnowledgeWriteDb,
  teamId: string,
  nodeTypeId: string,
): Promise<ResolvedPropertyType[]> {
  return db
    .selectFrom('property_type')
    .where('team_id', '=', teamId as TeamId)
    .where('node_type_id', '=', nodeTypeId as never)
    .select(['id', 'name', 'value_type', 'enum_values'])
    .execute();
}

async function propertyTypesOfEdgeType(
  db: KnowledgeWriteDb,
  teamId: string,
  edgeTypeId: string,
): Promise<ResolvedPropertyType[]> {
  return db
    .selectFrom('property_type')
    .where('team_id', '=', teamId as TeamId)
    .where('edge_type_id', '=', edgeTypeId as never)
    .select(['id', 'name', 'value_type', 'enum_values'])
    .execute();
}

async function createEntity(
  args: { typeName: string; properties: Record<string, PropertyValue> },
  teamId: string,
  externalTrx?: any,
) {
  const db = handle(externalTrx);
  const nodeType = await resolveNodeType(db, teamId, args.typeName);
  const propertyTypes = await propertyTypesOfNodeType(db, teamId, nodeType.id);

  const { nodeId } = await createNode(db, {
    context: agentContext(teamId, 'Created by Ask agent'),
    nodeTypeId: nodeType.id,
    properties: resolveProperties(args.properties, propertyTypes),
  });

  return { id: nodeId as string, type: nodeType.name, category: nodeType.category };
}

async function updateEntity(
  args: { nodeId: string; properties: Record<string, PropertyValue> },
  teamId: string,
  externalTrx?: any,
) {
  const db = handle(externalTrx);
  const node = await db
    .selectFrom('node as n')
    .innerJoin('node_type as nt', 'nt.id', 'n.node_type_id')
    .where('n.id', '=', args.nodeId as NodeId)
    .where('n.team_id', '=', teamId as TeamId)
    .select(['n.id', 'n.node_type_id', 'nt.name as type_name'])
    .executeTakeFirst();

  if (!node) throw new Error('Entity not found');

  const propertyTypes = await propertyTypesOfNodeType(db, teamId, node.node_type_id);

  await setProperties(db, {
    context: agentContext(teamId, 'Updated by Ask agent'),
    anchor: { kind: 'node', nodeId: node.id, nodeTypeId: node.node_type_id },
    properties: resolveProperties(args.properties, propertyTypes),
  });

  return { id: args.nodeId, type: node.type_name, updated: Object.keys(args.properties) };
}

async function createRelationship(
  args: {
    sourceNodeId: string;
    targetNodeId: string;
    relationshipName: string;
    properties?: Record<string, PropertyValue>;
  },
  teamId: string,
  externalTrx?: any,
) {
  const db = handle(externalTrx);
  const [sourceNode, targetNode] = await Promise.all([
    db
      .selectFrom('node')
      .where('id', '=', args.sourceNodeId as NodeId)
      .where('team_id', '=', teamId as TeamId)
      .select(['id', 'node_type_id'])
      .executeTakeFirst(),
    db
      .selectFrom('node')
      .where('id', '=', args.targetNodeId as NodeId)
      .where('team_id', '=', teamId as TeamId)
      .select(['id', 'node_type_id'])
      .executeTakeFirst(),
  ]);

  if (!sourceNode) throw new Error('Source entity not found');
  if (!targetNode) throw new Error('Target entity not found');

  const edgeType = await db
    .selectFrom('edge_type')
    .where('team_id', '=', teamId as TeamId)
    .where('outbound_name', '=', args.relationshipName)
    .where('source_node_type_id', '=', sourceNode.node_type_id)
    .where('target_node_type_id', '=', targetNode.node_type_id)
    .select(['id', 'outbound_name'])
    .executeTakeFirst();

  if (!edgeType) {
    const available = await db
      .selectFrom('edge_type as et')
      .leftJoin('node_type as snt', 'snt.id', 'et.source_node_type_id')
      .leftJoin('node_type as tnt', 'tnt.id', 'et.target_node_type_id')
      .where('et.team_id', '=', teamId as TeamId)
      .select(['et.outbound_name', 'snt.name as source_type', 'tnt.name as target_type'])
      .execute();
    const listing = available
      .map((e) => `${e.source_type} → ${e.target_type} (${e.outbound_name})`)
      .join(', ');
    throw new Error(
      `No relationship "${args.relationshipName}" between these entity types. Available: ${listing}`,
    );
  }

  const context = agentContext(teamId, 'Created by Ask agent');
  const properties = args.properties && Object.keys(args.properties).length > 0
    ? resolveProperties(args.properties, await propertyTypesOfEdgeType(db, teamId, edgeType.id))
    : [];

  const edgeId = await inTransaction(db, async (trx) => {
    const { edgeId } = await link(trx, {
      context,
      edgeTypeId: edgeType.id,
      sourceNodeId: args.sourceNodeId,
      targetNodeId: args.targetNodeId,
    });
    if (properties.length > 0) {
      await setProperties(trx, { context, anchor: { kind: 'edge', edgeId }, properties });
    }
    return edgeId;
  });

  return { id: edgeId as string, relationship: edgeType.outbound_name };
}

async function updateRelationship(
  args: { edgeId: string; properties: Record<string, PropertyValue> },
  teamId: string,
  externalTrx?: any,
) {
  const db = handle(externalTrx);
  const edge = await db
    .selectFrom('edge as e')
    .innerJoin('edge_type as et', 'et.id', 'e.edge_type_id')
    .where('e.id', '=', args.edgeId as EdgeId)
    .where('e.team_id', '=', teamId as TeamId)
    .select(['e.id', 'e.edge_type_id', 'et.outbound_name'])
    .executeTakeFirst();

  if (!edge) throw new Error('Relationship not found');

  const propertyTypes = await propertyTypesOfEdgeType(db, teamId, edge.edge_type_id);

  await setProperties(db, {
    context: agentContext(teamId, 'Updated by Ask agent'),
    anchor: { kind: 'edge', edgeId: edge.id },
    properties: resolveProperties(args.properties, propertyTypes),
  });

  return { id: args.edgeId, relationship: edge.outbound_name, updated: Object.keys(args.properties) };
}

async function deleteEntity(args: { nodeId: string }, teamId: string, externalTrx?: any) {
  const db = handle(externalTrx);
  const node = await db
    .selectFrom('node as n')
    .innerJoin('node_type as nt', 'nt.id', 'n.node_type_id')
    .where('n.id', '=', args.nodeId as NodeId)
    .where('n.team_id', '=', teamId as TeamId)
    .select(['n.id', 'nt.name as type_name', 'n.summary'])
    .executeTakeFirst();

  if (!node) throw new Error('Entity not found');

  await deleteNode(db, {
    context: agentContext(teamId, 'Deleted by Ask agent'),
    nodeId: args.nodeId,
  });

  return { deleted: true, type: node.type_name, summary: node.summary };
}

async function deleteRelationship(
  args: { sourceNodeId: string; targetNodeId: string; relationshipName: string },
  teamId: string,
  externalTrx?: any,
) {
  const db = handle(externalTrx);
  const edgeType = await db
    .selectFrom('edge_type')
    .where('team_id', '=', teamId as TeamId)
    .where('outbound_name', '=', args.relationshipName)
    .select('id')
    .executeTakeFirst();

  if (!edgeType) throw new Error(`Unknown relationship type "${args.relationshipName}"`);

  const { removed } = await unlink(db, {
    context: agentContext(teamId, 'Deleted by Ask agent'),
    edgeTypeId: edgeType.id,
    sourceNodeId: args.sourceNodeId,
    targetNodeId: args.targetNodeId,
  });

  if (!removed) throw new Error('Relationship not found between these entities');

  return { deleted: true, relationship: args.relationshipName, count: 1 };
}

async function bulkCreateEntities(
  args: { typeName: string; entities: Array<Record<string, PropertyValue>> },
  teamId: string,
) {
  const db = openKnowledgeStore();
  const nodeType = await resolveNodeType(db, teamId, args.typeName);
  const propertyTypes = await propertyTypesOfNodeType(db, teamId, nodeType.id);
  const context = agentContext(teamId, 'Created by Ask agent (bulk)');

  const created = await inTransaction(db, async (trx) => {
    const rows: Array<{ id: string; type: string; category: string }> = [];
    for (const entityProps of args.entities) {
      const { nodeId } = await createNode(trx, {
        context,
        nodeTypeId: nodeType.id,
        properties: resolveProperties(entityProps, propertyTypes),
      });
      rows.push({ id: nodeId as string, type: nodeType.name, category: nodeType.category });
    }
    return rows;
  });

  return { created, count: created.length };
}

async function bulkUpdateEntities(
  args: { updates: Array<{ nodeId: string; properties: Record<string, PropertyValue> }> },
  teamId: string,
) {
  const results: Array<{ id: string; type: string; updated: string[] }> = [];

  for (const update of args.updates) {
    const result = await updateEntity(
      { nodeId: update.nodeId, properties: update.properties },
      teamId,
    );
    results.push(result);
  }

  return { updated: results, count: results.length };
}

async function bulkDeleteEntities(
  args: { nodeIds: string[] },
  teamId: string,
) {
  const results: Array<{ id: string; type: string; summary: string | null }> = [];

  for (const nodeId of args.nodeIds) {
    const result = await deleteEntity({ nodeId }, teamId);
    results.push({ id: nodeId, type: result.type, summary: result.summary });
  }

  return { deleted: results, count: results.length };
}

async function bulkCreateRelationships(
  args: {
    relationships: Array<{
      sourceNodeId: string;
      targetNodeId: string;
      relationshipName: string;
      properties?: Record<string, PropertyValue>;
    }>;
  },
  teamId: string,
) {
  const results: Array<{ id: string; relationship: string }> = [];

  for (const rel of args.relationships) {
    const result = await createRelationship(rel, teamId);
    results.push(result);
  }

  return { created: results, count: results.length };
}

async function bulkDeleteRelationships(
  args: {
    relationships: Array<{
      sourceNodeId: string;
      targetNodeId: string;
      relationshipName: string;
    }>;
  },
  teamId: string,
) {
  const results: Array<{ relationship: string; count: number }> = [];

  for (const rel of args.relationships) {
    const result = await deleteRelationship(rel, teamId);
    results.push({ relationship: result.relationship, count: result.count });
  }

  return { deleted: results, count: results.length };
}

const crudToolDefinitions = [
  {
    type: 'function',
    name: 'createEntity',
    description:
      'Create a new entity in the knowledge graph. Specify the type by name and provide property values. Properties are validated against the ontology. Before calling, search for near-duplicates with a loose (CONTAINS) name query — if something similar exists, check with the user rather than creating a second copy.',
    parameters: {
      type: 'object',
      properties: {
        typeName: {
          type: 'string',
          description:
            'Name of the entity type (e.g. "Company", "Person"). Must match an existing type in the ontology.',
        },
        properties: {
          type: 'object',
          description:
            'Property name-value pairs. Names must match existing property types for this entity type. Enum properties must use allowed values. Example: {"Name": "Acme Corp", "Stage": "Series A"}',
          additionalProperties: true,
        },
      },
      required: ['typeName', 'properties'],
    },
  },
  {
    type: 'function',
    name: 'updateEntity',
    description:
      'Update properties on an existing entity. Only the specified properties are changed; others are left as-is. Set a property to null to clear it.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: {
          type: 'string',
          description: 'ID of the entity to update (from a previous query result)',
        },
        properties: {
          type: 'object',
          description:
            'Property name-value pairs to set or update. Set to null to clear a property.',
          additionalProperties: true,
        },
      },
      required: ['nodeId', 'properties'],
    },
  },
  {
    type: 'function',
    name: 'createRelationship',
    description:
      'Create a relationship between two entities. The relationship type is specified by its outbound name and must be valid for the entity types involved.',
    parameters: {
      type: 'object',
      properties: {
        sourceNodeId: {
          type: 'string',
          description: 'ID of the source entity (from a previous query result)',
        },
        targetNodeId: {
          type: 'string',
          description: 'ID of the target entity (from a previous query result)',
        },
        relationshipName: {
          type: 'string',
          description:
            'Outbound name of the relationship type (e.g. "Mentions Org", "Member Of"). Check the ontology for available relationships.',
        },
        properties: {
          type: 'object',
          description:
            'Optional property name-value pairs for the relationship (e.g. {"Role": "Lead Investor"})',
          additionalProperties: true,
        },
      },
      required: ['sourceNodeId', 'targetNodeId', 'relationshipName'],
    },
  },
  {
    type: 'function',
    name: 'deleteEntity',
    description:
      'Permanently delete an entity and all its properties and relationships. This cannot be undone.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: {
          type: 'string',
          description: 'ID of the entity to delete (from a previous query result)',
        },
      },
      required: ['nodeId'],
    },
  },
  {
    type: 'function',
    name: 'deleteRelationship',
    description: 'Delete a specific relationship between two entities.',
    parameters: {
      type: 'object',
      properties: {
        sourceNodeId: {
          type: 'string',
          description: 'ID of the source entity',
        },
        targetNodeId: {
          type: 'string',
          description: 'ID of the target entity',
        },
        relationshipName: {
          type: 'string',
          description: 'Outbound name of the relationship type to delete',
        },
      },
      required: ['sourceNodeId', 'targetNodeId', 'relationshipName'],
    },
  },
  {
    type: 'function',
    name: 'updateRelationship',
    description:
      'Update properties on an existing relationship (edge). Only the specified properties are changed; others are left as-is. Set a property to null to clear it. Use a relationship ID from a query result.',
    parameters: {
      type: 'object',
      properties: {
        edgeId: {
          type: 'string',
          description: 'ID of the relationship (edge) to update',
        },
        properties: {
          type: 'object',
          description:
            'Property name-value pairs to set or update on the relationship. Names must match existing property types for this relationship type. Set to null to clear.',
          additionalProperties: true,
        },
      },
      required: ['edgeId', 'properties'],
    },
  },
  {
    type: 'function',
    name: 'bulkCreateEntities',
    description:
      'Create multiple entities of the same type in one operation. More efficient than calling createEntity repeatedly. All entities are created in a single transaction.',
    parameters: {
      type: 'object',
      properties: {
        typeName: {
          type: 'string',
          description: 'Name of the entity type for all entities being created.',
        },
        entities: {
          type: 'array',
          description:
            'Array of property objects, one per entity. Each object has property name-value pairs. Example: [{"Name": "Acme Corp", "Stage": "Series A"}, {"Name": "Beta Inc", "Stage": "Seed"}]',
          items: { type: 'object', additionalProperties: true },
        },
      },
      required: ['typeName', 'entities'],
    },
  },
  {
    type: 'function',
    name: 'bulkUpdateEntities',
    description:
      'Update properties on multiple entities in one operation. Each update specifies a node ID and the properties to change.',
    parameters: {
      type: 'object',
      properties: {
        updates: {
          type: 'array',
          description:
            'Array of updates. Each has a nodeId and a properties object with name-value pairs to set.',
          items: {
            type: 'object',
            properties: {
              nodeId: { type: 'string', description: 'ID of the entity to update' },
              properties: {
                type: 'object',
                description: 'Property name-value pairs to set or update.',
                additionalProperties: true,
              },
            },
            required: ['nodeId', 'properties'],
          },
        },
      },
      required: ['updates'],
    },
  },
  {
    type: 'function',
    name: 'bulkDeleteEntities',
    description:
      'Permanently delete multiple entities and all their properties and relationships. This cannot be undone.',
    parameters: {
      type: 'object',
      properties: {
        nodeIds: {
          type: 'array',
          description: 'Array of entity IDs to delete.',
          items: { type: 'string' },
        },
      },
      required: ['nodeIds'],
    },
  },
  {
    type: 'function',
    name: 'bulkCreateRelationships',
    description:
      'Create multiple relationships in one operation. Each relationship specifies source, target, and relationship name.',
    parameters: {
      type: 'object',
      properties: {
        relationships: {
          type: 'array',
          description: 'Array of relationships to create.',
          items: {
            type: 'object',
            properties: {
              sourceNodeId: { type: 'string', description: 'ID of the source entity' },
              targetNodeId: { type: 'string', description: 'ID of the target entity' },
              relationshipName: {
                type: 'string',
                description: 'Outbound name of the relationship type',
              },
              properties: {
                type: 'object',
                description: 'Optional property name-value pairs for the relationship',
                additionalProperties: true,
              },
            },
            required: ['sourceNodeId', 'targetNodeId', 'relationshipName'],
          },
        },
      },
      required: ['relationships'],
    },
  },
  {
    type: 'function',
    name: 'bulkDeleteRelationships',
    description:
      'Delete multiple relationships in one operation.',
    parameters: {
      type: 'object',
      properties: {
        relationships: {
          type: 'array',
          description: 'Array of relationships to delete.',
          items: {
            type: 'object',
            properties: {
              sourceNodeId: { type: 'string', description: 'ID of the source entity' },
              targetNodeId: { type: 'string', description: 'ID of the target entity' },
              relationshipName: {
                type: 'string',
                description: 'Outbound name of the relationship type to delete',
              },
            },
            required: ['sourceNodeId', 'targetNodeId', 'relationshipName'],
          },
        },
      },
      required: ['relationships'],
    },
  },
  {
    type: 'function',
    name: 'mergeNodes',
    description:
      'Merge two entities of the same type into one. The target entity survives; the source entity is deleted. All properties, relationships, and evidence from the source are merged into the target. Duplicate relationships are consolidated and properties are reconciled. Use this to deduplicate entities.',
    parameters: {
      type: 'object',
      properties: {
        targetNodeId: {
          type: 'string',
          description: 'ID of the entity to keep (the merge target)',
        },
        sourceNodeId: {
          type: 'string',
          description: 'ID of the entity to merge in and delete (the merge source)',
        },
      },
      required: ['targetNodeId', 'sourceNodeId'],
    },
  },
];

export {
  createEntity,
  updateEntity,
  createRelationship,
  updateRelationship,
  deleteEntity,
  deleteRelationship,
  bulkCreateEntities,
  bulkUpdateEntities,
  bulkDeleteEntities,
  bulkCreateRelationships,
  bulkDeleteRelationships,
  crudToolDefinitions,
};

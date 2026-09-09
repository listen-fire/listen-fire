// The knowledge MCP connector, as it was mounted inline in server.ts.
// Moved here so a deployment that does not run knowledge does not serve it
// (D30(d)); the definition itself is unchanged.

import { Router } from 'express';
import { z } from 'zod';

import { createMcpRouter } from '../server';
import { KNOWLEDGE_MCP_PATH } from '../paths';

function createKnowledgeMcpRouter(): ReturnType<typeof Router> {
  return createMcpRouter({
    name: 'listen-fire-knowledge',
    domain: 'knowledge',
    genericApiTools: false,
    instructions:
      "Listen-Fire holds the user's knowledge graph — a separate structured store of entities and relationships you can query and edit (Listen-Fire's own store, not a view of their other systems). Use it when the user wants to QUERY or EDIT that store directly.\n\nTalking to the user — keep the mechanics hidden by DEFAULT. They own the high-level question and want the answer or the result, not a narration of the queries you ran, \"the knowledge graph,\" or which tools you used. Report what you found or changed in their terms; explain the how only if they ask. Prefer their own terms — the answer, the company you updated — to the store's vocabulary (nodes, edges, the ontology or schema, a cypher query).\n\nTeams: this connection spans the teams the user belongs to. Call listTeams to see them (each has a teamId, name, and access). To create or change something in a specific team — the entity / relationship / merge / recipe / model tools — pass that team's id as `team`. If the user belongs to exactly one team you can omit `team`; if they belong to several you must pass it (the tool will tell you to). A single-team connection ignores `team`.\n\nTo READ it: query for natural-language lookups; schema to see what entity types exist; cypher for a precise raw query; getNodeDetail for one entity's full properties + relationships; getOntology for the full model. To EDIT it: the validated entity tools (createEntity / updateEntity / deleteEntity, and the bulk variants), the relationship tools (createRelationship / updateRelationship / deleteRelationship), mergeNodes to dedup, and the ontology (model) tools (create/update/delete NodeType / PropertyType / EdgeType, setUniquenessConstraints). saveRecipe / getRecipe store reusable instructions.\n\nFor one-off edits these tools are direct. But writing to the knowledge graph AT SCALE — or keeping it in sync with the user's other systems — is an automation: set it up on the Listen-Fire Automation connector (the knowledge graph is a target system there). The same Listen-Fire API key works for both connectors.",
    tools: {
      listTeams: {
        description:
          "List the teams this connection can act in (teamId, name, access, isPersonal). `isPersonal: true` marks the user's personal workspace (their team-of-one) vs a shared team. Pass a team's id as `team` to tools that read or change a specific team (createEntity, updateEntity, query, getOntology, the model tools, …).",
        annotations: { readOnlyHint: true },
        inputSchema: {},
        title: 'List your teams',
        endpoint: { method: 'GET', path: '/v1/knowledge/teams' },
      },
      query: {
        description:
          'Look up data in the knowledge graph. Pose a natural-language question and get structured results back. Handles query planning internally — just describe what you want to know. Reads your default team unless you pass `team`.',
        annotations: { readOnlyHint: true },
        inputSchema: {
          question: z
            .string()
            .describe(
              'What to look up (e.g. "companies with status Considering", "recent tasks", "investors linked to Acme")',
            ),
          context: z
            .string()
            .optional()
            .describe(
              'Context from previous results to narrow the search (e.g. node IDs, entity names)',
            ),
          team: z
            .string()
            .optional()
            .describe(
              'The teamId (from listTeams) whose graph to read. Omit for your default team.',
            ),
        },
        title: 'Query your data',
        endpoint: { method: 'POST', path: '/v1/knowledge/query' },
      },
      schema: {
        description:
          'Get the knowledge graph schema — what entity types, relationships, and properties exist. Call this first if you need to understand what data is available before querying. Reads your default team unless you pass `team`.',
        annotations: { readOnlyHint: true },
        inputSchema: {
          team: z
            .string()
            .optional()
            .describe(
              'The teamId (from listTeams) whose schema to read. Omit for your default team.',
            ),
        },
        title: 'View the data model',
        endpoint: { method: 'GET', path: '/v1/knowledge/schema' },
      },

      // ── Knowledge-graph read ───────────────────────────────────────────
      cypher: {
        description:
          "Run a raw Cypher read query against the knowledge graph for precise control the natural-language `query` tool can't give you (exact traversals, aggregations, specific filters). Read-only — to change data use cypherWrite. Page large results with `limit`/`offset`; for a full dataset use exportCsv to get a downloadable CSV instead of reading every row. Reads your default team unless you pass `team`.",
        annotations: { readOnlyHint: true },
        inputSchema: {
          query: z.string().describe('The Cypher query string.'),
          limit: z
            .number()
            .int()
            .positive()
            .max(1000)
            .optional()
            .describe('Cap the number of rows returned.'),
          offset: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe(
              'Skip this many rows (page through results). When more rows remain, the response says so — use exportCsv for the whole set.',
            ),
          includeGeneratedSql: z
            .boolean()
            .optional()
            .describe('Also return the SQL the Cypher compiled to (debugging).'),
          explain: z
            .boolean()
            .optional()
            .describe(
              'Estimate the query cost (row count) WITHOUT running it — use before a large exportCsv.',
            ),
          team: z
            .string()
            .optional()
            .describe(
              'The teamId (from listTeams) whose graph to query. Omit for your default team.',
            ),
        },
        title: 'Run a Cypher read query',
        endpoint: { method: 'POST', path: '/v1/knowledge/cypher' },
      },
      cypherWrite: {
        description:
          'Change the knowledge graph with a raw Cypher write (CREATE / MERGE / SET / REMOVE / DELETE). Use this — not `cypher` — when you need to add, update, or remove entities and relationships precisely. Validated against the model just like the entity tools. Acts in your default team unless you pass `team`.',
        annotations: { destructiveHint: true },
        inputSchema: {
          query: z.string().describe('The Cypher write statement.'),
          team: z
            .string()
            .optional()
            .describe('The teamId (from listTeams) to act in. Omit for your default team.'),
        },
        title: 'Run a Cypher write',
        endpoint: { method: 'POST', path: '/v1/knowledge/cypher-write' },
      },
      exportCsv: {
        description:
          'Run a Cypher read query and get the full result as a downloadable CSV file. Returns a short-lived download link, the columns, the row count, and a small preview of the first rows — the file itself is NOT read into the conversation, so this is how you extract large result sets. Give the user the link. Reads your default team unless you pass `team`.',
        annotations: { readOnlyHint: true },
        inputSchema: {
          query: z.string().describe('The Cypher read query whose result becomes the CSV.'),
          filename: z
            .string()
            .optional()
            .describe('Suggested file name (a .csv extension is ensured).'),
          maxRows: z
            .number()
            .int()
            .positive()
            .max(100000)
            .optional()
            .describe('Cap the exported rows (default 100000).'),
          team: z
            .string()
            .optional()
            .describe(
              'The teamId (from listTeams) whose graph to query. Omit for your default team.',
            ),
        },
        title: 'Export a query to CSV',
        endpoint: { method: 'POST', path: '/v1/knowledge/export-csv' },
      },
      importCsv: {
        description:
          "Load a CSV file into the knowledge graph as entities. Give a fetchable CSV URL (use the upload step if the file is local), the entity type to create, and a mapping of CSV column → entity field. Rows are matched against the type's uniqueness rules, so re-importing updates existing entities instead of duplicating them. The file is read server-side — its rows never enter the conversation. Acts in your default team unless you pass `team`.",
        annotations: { destructiveHint: false },
        inputSchema: {
          csvUrl: z
            .string()
            .describe(
              'A fetchable URL to the CSV (an uploaded-file link, a Drive/S3 share, etc.).',
            ),
          typeName: z.string().describe('The entity type to create/update (from getOntology).'),
          mapping: z
            .record(z.string(), z.string())
            .describe('CSV column name → entity field name. Only mapped columns are imported.'),
          team: z
            .string()
            .optional()
            .describe('The teamId (from listTeams) to act in. Omit for your default team.'),
        },
        title: 'Import a CSV',
        endpoint: { method: 'POST', path: '/v1/knowledge/import-csv' },
      },
      getNodeDetail: {
        description:
          'Get one entity in full: all its properties and its connected relationships with provenance. Pass mode "context" for a compact view suited to feeding back into a query. Reads your default team unless you pass `team`.',
        annotations: { readOnlyHint: true },
        inputSchema: {
          id: z.string().describe('The node (entity) id.'),
          mode: z
            .enum(['full', 'context'])
            .optional()
            .describe('"full" (default) or "context" for a compact view.'),
          team: z
            .string()
            .optional()
            .describe(
              'The teamId (from listTeams) the entity lives in. Omit for your default team.',
            ),
        },
        title: 'View one entity in full',
        endpoint: { method: 'GET', path: '/v1/knowledge/node-detail/:id' },
      },
      getOntology: {
        description:
          'The current knowledge model: every entity type with its fields, the relationships between types, and the dedup (uniqueness) rules. Read this before editing the model, and to learn what entity/relationship/field names are valid for the entity-edit tools. Reads your default team unless you pass `team`.',
        annotations: { readOnlyHint: true },
        inputSchema: {
          team: z
            .string()
            .optional()
            .describe(
              'The teamId (from listTeams) whose model to read. Omit for your default team.',
            ),
        },
        title: 'View the full data model',
        endpoint: { method: 'GET', path: '/v1/knowledge/ontology' },
      },
      getRecipe: {
        description:
          'Load a saved recipe (reusable, named instructions) by its exact name. Reads your default team unless you pass `team`.',
        annotations: { readOnlyHint: true },
        inputSchema: {
          name: z.string().describe("The recipe's exact name."),
          team: z
            .string()
            .optional()
            .describe(
              'The teamId (from listTeams) the recipe lives in. Omit for your default team.',
            ),
        },
        title: 'Read a saved recipe',
        endpoint: { method: 'GET', path: '/v1/knowledge/recipes/:name' },
      },

      // ── Knowledge-graph edit: entities ─────────────────────────────────
      createEntity: {
        description:
          "Create one entity in the knowledge graph (validated against the model). The type must be an existing entity type (see getOntology); property names must be that type's fields, and enum fields only accept their allowed values.",
        inputSchema: {
          typeName: z
            .string()
            .describe('The entity type name (from getOntology), e.g. "Company", "Person".'),
          properties: z
            .record(z.string(), z.unknown())
            .describe("Field name → value. Field names must be the type's fields."),
          team: z
            .string()
            .optional()
            .describe('The teamId (from listTeams) to act in. Omit for your default team.'),
        },
        title: 'Create an entity',
        annotations: { destructiveHint: false },
        endpoint: { method: 'POST', path: '/v1/knowledge/entities' },
      },
      updateEntity: {
        description:
          "Update one entity's properties by id (validated). Only the fields you pass are changed. A cross-team or unknown id is not found.",
        inputSchema: {
          nodeId: z.string().describe('The entity id to update.'),
          properties: z.record(z.string(), z.unknown()).describe('Field name → new value.'),
          team: z
            .string()
            .optional()
            .describe('The teamId (from listTeams) to act in. Omit for your default team.'),
        },
        title: 'Update an entity',
        annotations: { destructiveHint: true },
        endpoint: { method: 'PATCH', path: '/v1/knowledge/entities' },
      },
      deleteEntity: {
        description:
          'Delete one entity by id (team-scoped). Its relationships are removed with it.',
        inputSchema: {
          nodeId: z.string().describe('The entity id to delete.'),
          team: z
            .string()
            .optional()
            .describe('The teamId (from listTeams) to act in. Omit for your default team.'),
        },
        title: 'Delete an entity',
        annotations: { destructiveHint: true },
        endpoint: { method: 'DELETE', path: '/v1/knowledge/entities' },
      },
      bulkCreateEntities: {
        description:
          'Create many entities of the SAME type in one validated call — far cheaper than calling createEntity in a loop.',
        inputSchema: {
          typeName: z.string().describe('The shared entity type name.'),
          entities: z
            .array(z.record(z.string(), z.unknown()))
            .describe('One properties object per entity to create.'),
          team: z
            .string()
            .optional()
            .describe('The teamId (from listTeams) to act in. Omit for your default team.'),
        },
        title: 'Create many entities',
        annotations: { destructiveHint: false },
        endpoint: { method: 'POST', path: '/v1/knowledge/entities/bulk-create' },
      },
      bulkUpdateEntities: {
        description:
          'Update many entities in one validated call. Each update names a nodeId and the properties to change.',
        inputSchema: {
          updates: z
            .array(
              z.object({
                nodeId: z.string(),
                properties: z.record(z.string(), z.unknown()),
              }),
            )
            .describe('One { nodeId, properties } per entity to update.'),
          team: z
            .string()
            .optional()
            .describe('The teamId (from listTeams) to act in. Omit for your default team.'),
        },
        title: 'Update many entities',
        annotations: { destructiveHint: true },
        endpoint: { method: 'POST', path: '/v1/knowledge/entities/bulk-update' },
      },
      bulkDeleteEntities: {
        description: 'Delete many entities in one call by their ids.',
        inputSchema: {
          nodeIds: z.array(z.string()).describe('The entity ids to delete.'),
          team: z
            .string()
            .optional()
            .describe('The teamId (from listTeams) to act in. Omit for your default team.'),
        },
        title: 'Delete many entities',
        annotations: { destructiveHint: true },
        endpoint: { method: 'POST', path: '/v1/knowledge/entities/bulk-delete' },
      },

      // ── Knowledge-graph edit: relationships ────────────────────────────
      createRelationship: {
        description:
          'Create a relationship between two existing entities (validated against the model). The relationshipName must be a relationship the model allows between the source and target types (see getOntology).',
        inputSchema: {
          sourceNodeId: z.string().describe('The source entity id.'),
          targetNodeId: z.string().describe('The target entity id.'),
          relationshipName: z
            .string()
            .describe("The relationship's outbound name (from getOntology)."),
          properties: z
            .record(z.string(), z.unknown())
            .optional()
            .describe('Optional relationship fields.'),
          team: z
            .string()
            .optional()
            .describe('The teamId (from listTeams) to act in. Omit for your default team.'),
        },
        title: 'Create a relationship',
        annotations: { destructiveHint: false },
        endpoint: { method: 'POST', path: '/v1/knowledge/relationships' },
      },
      updateRelationship: {
        description: "Update a relationship's properties by its edge id (validated).",
        inputSchema: {
          edgeId: z.string().describe('The relationship (edge) id.'),
          properties: z.record(z.string(), z.unknown()).describe('Field name → new value.'),
          team: z
            .string()
            .optional()
            .describe('The teamId (from listTeams) to act in. Omit for your default team.'),
        },
        title: 'Update a relationship',
        annotations: { destructiveHint: true },
        endpoint: { method: 'PATCH', path: '/v1/knowledge/relationships' },
      },
      deleteRelationship: {
        description:
          'Delete a relationship between two entities by source, target, and relationship name.',
        inputSchema: {
          sourceNodeId: z.string().describe('The source entity id.'),
          targetNodeId: z.string().describe('The target entity id.'),
          relationshipName: z.string().describe("The relationship's outbound name."),
          team: z
            .string()
            .optional()
            .describe('The teamId (from listTeams) to act in. Omit for your default team.'),
        },
        title: 'Delete a relationship',
        annotations: { destructiveHint: true },
        endpoint: { method: 'DELETE', path: '/v1/knowledge/relationships' },
      },

      // ── Dedup + recipes ────────────────────────────────────────────────
      mergeNodes: {
        description:
          "Merge a duplicate entity into another: the source entity's properties and relationships fold into the target, and the source is removed. Use this to dedup two entities that turned out to be the same thing.",
        inputSchema: {
          targetNodeId: z.string().describe('The entity to keep.'),
          sourceNodeId: z.string().describe('The duplicate entity to fold in and remove.'),
          team: z
            .string()
            .optional()
            .describe('The teamId (from listTeams) to act in. Omit for your default team.'),
        },
        title: 'Merge duplicate entities',
        annotations: { destructiveHint: true },
        endpoint: { method: 'POST', path: '/v1/knowledge/merge' },
      },
      saveRecipe: {
        description:
          'Save or update a recipe: a named, reusable block of instructions you (or the user) can recall later by name with getRecipe.',
        inputSchema: {
          name: z.string().describe('The recipe name.'),
          description: z.string().describe('One-line description of what it does.'),
          instructions: z.string().describe('The instructions body.'),
          team: z
            .string()
            .optional()
            .describe('The teamId (from listTeams) to act in. Omit for your default team.'),
        },
        title: 'Save a recipe',
        annotations: { destructiveHint: true },
        endpoint: { method: 'POST', path: '/v1/knowledge/recipes' },
      },

      // ── Knowledge model (ontology) mutations ───────────────────────────
      createNodeType: {
        description:
          'Add a new entity type to the model. category is always "object" — a primary thing the user tracks (Company, Person, Fund).',
        inputSchema: {
          name: z.string().describe('Name of the entity type, e.g. "Company".'),
          description: z.string().describe('What this type represents.'),
          category: z.literal('object').describe('Always "object".'),
          team: z
            .string()
            .optional()
            .describe('The teamId (from listTeams) to act in. Omit for your default team.'),
        },
        title: 'Add an entity type',
        annotations: { destructiveHint: false },
        endpoint: { method: 'POST', path: '/v1/knowledge/ontology/createNodeType' },
      },
      updateNodeType: {
        description: 'Rename or re-describe an existing entity type. Provide only what changes.',
        inputSchema: {
          name: z.string().describe('Current name of the entity type.'),
          newName: z.string().optional().describe('New name (omit to keep).'),
          description: z.string().optional().describe('New description.'),
          team: z
            .string()
            .optional()
            .describe('The teamId (from listTeams) to act in. Omit for your default team.'),
        },
        title: 'Update an entity type',
        annotations: { destructiveHint: true },
        endpoint: { method: 'POST', path: '/v1/knowledge/ontology/updateNodeType' },
      },
      deleteNodeType: {
        description:
          'Delete an entity type by name. WARNING: cascades — its fields and relationships go with it.',
        inputSchema: {
          name: z.string().describe('Name of the entity type to delete.'),
          team: z
            .string()
            .optional()
            .describe('The teamId (from listTeams) to act in. Omit for your default team.'),
        },
        title: 'Delete an entity type',
        annotations: { destructiveHint: true },
        endpoint: { method: 'POST', path: '/v1/knowledge/ontology/deleteNodeType' },
      },
      createPropertyType: {
        description:
          'Add a field to an entity type OR a relationship. Provide EITHER nodeTypeName or edgeTypeOutboundName. Set enumValues for categorical fields (status, stage, role).',
        inputSchema: {
          nodeTypeName: z
            .string()
            .optional()
            .describe('Entity type the field belongs to (provide this OR edgeTypeOutboundName).'),
          edgeTypeOutboundName: z
            .string()
            .optional()
            .describe(
              'Relationship outbound name the field belongs to (provide this OR nodeTypeName).',
            ),
          name: z.string().describe('Field name, e.g. "Revenue", "Role".'),
          description: z.string().describe('What the field captures.'),
          valueType: z
            .enum(['text', 'number', 'date', 'boolean', 'json'])
            .describe("The field's data type."),
          evaluationStrategy: z
            .enum(['latest', 'llm'])
            .optional()
            .describe('Conflict resolution: latest (default) or llm.'),
          enumValues: z
            .array(z.string())
            .optional()
            .describe('Allowed values for a categorical field.'),
          team: z
            .string()
            .optional()
            .describe('The teamId (from listTeams) to act in. Omit for your default team.'),
        },
        title: 'Add a property',
        annotations: { destructiveHint: false },
        endpoint: { method: 'POST', path: '/v1/knowledge/ontology/createPropertyType' },
      },
      updatePropertyType: {
        description:
          'Update a field on an entity type or relationship. Identify it by nodeTypeName (or edgeTypeOutboundName) + name. Provide only what changes; pass enumValues null to drop the enum constraint.',
        inputSchema: {
          nodeTypeName: z
            .string()
            .optional()
            .describe('Entity type the field is on (provide this OR edgeTypeOutboundName).'),
          edgeTypeOutboundName: z
            .string()
            .optional()
            .describe('Relationship outbound name the field is on.'),
          name: z.string().describe('Current field name.'),
          newName: z.string().optional().describe('New name (omit to keep).'),
          description: z.string().optional().describe('New description.'),
          valueType: z
            .enum(['text', 'number', 'date', 'boolean', 'json'])
            .optional()
            .describe('New value type.'),
          evaluationStrategy: z
            .enum(['latest', 'llm'])
            .optional()
            .describe('New evaluation strategy.'),
          enumValues: z
            .array(z.string())
            .nullable()
            .optional()
            .describe('New enum values, or null to remove the constraint.'),
          team: z
            .string()
            .optional()
            .describe('The teamId (from listTeams) to act in. Omit for your default team.'),
        },
        title: 'Update a property',
        annotations: { destructiveHint: true },
        endpoint: { method: 'POST', path: '/v1/knowledge/ontology/updatePropertyType' },
      },
      deletePropertyType: {
        description: 'Delete a field by entity type (or relationship) + field name.',
        inputSchema: {
          nodeTypeName: z
            .string()
            .optional()
            .describe('Entity type the field is on (provide this OR edgeTypeOutboundName).'),
          edgeTypeOutboundName: z
            .string()
            .optional()
            .describe('Relationship outbound name the field is on.'),
          name: z.string().describe('Field name to delete.'),
          team: z
            .string()
            .optional()
            .describe('The teamId (from listTeams) to act in. Omit for your default team.'),
        },
        title: 'Delete a property',
        annotations: { destructiveHint: true },
        endpoint: { method: 'POST', path: '/v1/knowledge/ontology/deletePropertyType' },
      },
      createEdgeType: {
        description:
          'Add a relationship between two entity types (source → target). outboundName reads "Source [outboundName] Target"; inboundName reads "Target\'s [inboundName]".',
        inputSchema: {
          outboundName: z
            .string()
            .describe('Name from the source\'s perspective, e.g. "Deal For".'),
          inboundName: z.string().describe('Name from the target\'s perspective, e.g. "Deals".'),
          description: z.string().describe('What the relationship represents.'),
          sourceNodeTypeName: z.string().describe('Source entity type name.'),
          targetNodeTypeName: z.string().describe('Target entity type name.'),
          required: z.boolean().optional().describe('Whether it is required during extraction.'),
          group: z
            .string()
            .optional()
            .describe(
              'Display grouping key for relationships that are the same semantic edge to different types.',
            ),
          team: z
            .string()
            .optional()
            .describe('The teamId (from listTeams) to act in. Omit for your default team.'),
        },
        title: 'Add a relationship type',
        annotations: { destructiveHint: false },
        endpoint: { method: 'POST', path: '/v1/knowledge/ontology/createEdgeType' },
      },
      updateEdgeType: {
        description:
          'Update a relationship by its current outbound name. Provide only what changes.',
        inputSchema: {
          outboundName: z.string().describe('Current outbound name.'),
          newOutboundName: z.string().optional().describe('New outbound name (omit to keep).'),
          inboundName: z.string().optional().describe('New inbound name.'),
          description: z.string().optional().describe('New description.'),
          required: z.boolean().optional().describe('Whether it is required.'),
          group: z.string().nullable().optional().describe('New group key, or null to remove.'),
          team: z
            .string()
            .optional()
            .describe('The teamId (from listTeams) to act in. Omit for your default team.'),
        },
        title: 'Update a relationship type',
        annotations: { destructiveHint: true },
        endpoint: { method: 'POST', path: '/v1/knowledge/ontology/updateEdgeType' },
      },
      deleteEdgeType: {
        description:
          'Delete a relationship by its outbound name. WARNING: cascades — its fields go with it.',
        inputSchema: {
          outboundName: z.string().describe('Outbound name of the relationship to delete.'),
          team: z
            .string()
            .optional()
            .describe('The teamId (from listTeams) to act in. Omit for your default team.'),
        },
        title: 'Delete a relationship type',
        annotations: { destructiveHint: true },
        endpoint: { method: 'POST', path: '/v1/knowledge/ontology/deleteEdgeType' },
      },
      setUniquenessConstraints: {
        description:
          'Set the dedup (uniqueness) rules on an entity type. Each constraint is a text expression; multiple constraints are OR\'d — matching ANY one makes two entities duplicates. Terms within one constraint are AND-joined: a field name, FUZZY(Field) for approximate match, -[:OtherType]-> for a required relationship, WITHIN(date_field, "1 year") for a recent-activity window.',
        inputSchema: {
          nodeTypeName: z.string().describe('The entity type to set constraints on.'),
          constraints: z.array(z.string()).describe("The constraint expressions (OR'd)."),
          team: z
            .string()
            .optional()
            .describe('The teamId (from listTeams) to act in. Omit for your default team.'),
        },
        title: 'Set uniqueness rules',
        annotations: { destructiveHint: true },
        endpoint: { method: 'POST', path: '/v1/knowledge/ontology/setUniquenessConstraints' },
      },
    },
  });
}

export { KNOWLEDGE_MCP_PATH, createKnowledgeMcpRouter };

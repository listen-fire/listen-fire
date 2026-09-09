/**
 * Simulators for v3 output testing.
 *
 * These maintain internal state so tests can assert against the resulting
 * state of external systems rather than mock call arguments.
 */

import type { NodeId } from '../../../../generated/kysely/knowledge/Node';
import type { EdgeId } from '../../../../generated/kysely/knowledge/Edge';
import type { TeamId } from '../../../../generated/kysely/core/Team';

// ---------------------------------------------------------------------------
// Knowledge Graph Simulator — in-memory store queried via Kysely-shaped chains
// ---------------------------------------------------------------------------

interface SimNode {
  id: string;
  node_type_id: string;
  team_id: string;
}

interface SimNodeType {
  id: string;
  name: string;
  category: string;
}

interface SimEdge {
  id: string;
  source_node_id: string;
  target_node_id: string;
  edge_type_id: string;
  team_id: string;
}

interface SimProperty {
  node_id: string | null;
  edge_id: string | null;
  property_type_id: string;
  team_id: string;
  value_text: string | null;
  value_number: number | null;
  value_boolean: boolean | null;
  value_date: string | null;
  value_json: unknown | null;
}

interface SimPropertyType {
  id: string;
  name: string;
}

interface SimNodeResource {
  node_id: string;
  team_id: string;
  resource_id: string;
  start_offset: number | null;
  end_offset: number | null;
}

interface SimResource {
  id: string;
  raw_text_id: string;
}

interface SimRawText {
  id: string;
  content: string;
}

interface SimPipelineOutput {
  id: string;
  pipeline_configuration_id: string;
  type: string;
  config: unknown;
  credentials_id: string | null;
  config_version: number;
  deleted_at: string | null;
  run_mode: string;
}

interface SimLinkedObject {
  id: string;
  node_id: string;
  team_id: string;
  source: string;
  adapter_type: string;
  action_node_id: string | null;
  external_id: string;
  data: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

type SimRow = Record<string, unknown>;

class SimQueryChain {
  private table = '';
  private wheres: { column: string; op: string; value: unknown }[] = [];
  private joins: { table: string; leftCol: string; rightCol: string }[] = [];
  private selectedCols: string[] = [];

  constructor(private sim: KnowledgeGraphSimulator) {}

  selectFrom(table: string): SimQueryChain {
    this.table = table;
    return this;
  }

  where(column: string, op: string, value: unknown): SimQueryChain {
    this.wheres.push({ column, op, value });
    return this;
  }

  innerJoin(table: string, leftCol: string, rightCol: string): SimQueryChain {
    this.joins.push({ table, leftCol, rightCol });
    return this;
  }

  select(columns: string[]): SimQueryChain {
    this.selectedCols = columns;
    return this;
  }

  async execute(): Promise<SimRow[]> {
    return this.sim.executeQuery(this.table, this.wheres, this.joins, this.selectedCols);
  }

  async executeTakeFirst(): Promise<SimRow | undefined> {
    const rows = await this.execute();
    return rows[0];
  }
}

class KnowledgeGraphSimulator {
  nodes: SimNode[] = [];
  nodeTypes: SimNodeType[] = [];
  edges: SimEdge[] = [];
  properties: SimProperty[] = [];
  propertyTypes: SimPropertyType[] = [];
  nodeResources: SimNodeResource[] = [];
  resources: SimResource[] = [];
  rawTexts: SimRawText[] = [];
  pipelineOutputs: SimPipelineOutput[] = [];
  outputLinkedObjects: SimLinkedObject[] = [];
  outputRuns: { teamId: string; pipelineOutputId: string; actionNodeId: string; contextNodeId: string; adapterType: string; externalId: string | null; status: string }[] = [];

  private nextOloId = 1;

  // -- Builder helpers --

  addNodeType(id: string, name: string, category = 'object'): this {
    this.nodeTypes.push({ id, name, category });
    return this;
  }

  addPropertyType(id: string, name: string): this {
    this.propertyTypes.push({ id, name });
    return this;
  }

  addNode(id: string, nodeTypeId: string, teamId: string): this {
    this.nodes.push({ id, node_type_id: nodeTypeId, team_id: teamId });
    return this;
  }

  addEdge(id: string, sourceNodeId: string, targetNodeId: string, edgeTypeId: string, teamId: string): this {
    this.edges.push({ id, source_node_id: sourceNodeId, target_node_id: targetNodeId, edge_type_id: edgeTypeId, team_id: teamId });
    return this;
  }

  addProperty(nodeId: string, propertyTypeId: string, teamId: string, value: string | number | boolean): this {
    this.properties.push({
      node_id: nodeId,
      edge_id: null,
      property_type_id: propertyTypeId,
      team_id: teamId,
      value_text: typeof value === 'string' ? value : null,
      value_number: typeof value === 'number' ? value : null,
      value_boolean: typeof value === 'boolean' ? value : null,
      value_date: null,
      value_json: null,
    });
    return this;
  }

  addEdgeProperty(edgeId: string, propertyTypeId: string, teamId: string, value: string | number | boolean): this {
    this.properties.push({
      node_id: null,
      edge_id: edgeId,
      property_type_id: propertyTypeId,
      team_id: teamId,
      value_text: typeof value === 'string' ? value : null,
      value_number: typeof value === 'number' ? value : null,
      value_boolean: typeof value === 'boolean' ? value : null,
      value_date: null,
      value_json: null,
    });
    return this;
  }

  addResource(nodeId: string, teamId: string, content: string): this {
    const resourceId = `res-${this.resources.length + 1}`;
    const rawTextId = `rt-${this.rawTexts.length + 1}`;
    this.rawTexts.push({ id: rawTextId, content });
    this.resources.push({ id: resourceId, raw_text_id: rawTextId });
    this.nodeResources.push({ node_id: nodeId, team_id: teamId, resource_id: resourceId, start_offset: null, end_offset: null });
    return this;
  }

  // -- Linked object store (replaces linked_objects.ts SQL) --

  storeLinkedObject(options: { nodeId: string; teamId: string; source?: string; adapterType: string; externalId: string; data?: Record<string, unknown>; actionNodeId?: string }): void {
    const existing = this.outputLinkedObjects.find(
      (o) => o.node_id === options.nodeId && o.adapter_type === options.adapterType && o.external_id === options.externalId,
    );
    if (existing) {
      existing.data = options.data ?? {};
      existing.source = options.source ?? existing.source;
      existing.action_node_id = options.actionNodeId ?? existing.action_node_id;
      existing.updated_at = new Date();
    } else {
      this.outputLinkedObjects.push({
        id: `olo-${this.nextOloId++}`,
        node_id: options.nodeId,
        team_id: options.teamId,
        source: options.source ?? 'output',
        adapter_type: options.adapterType,
        action_node_id: options.actionNodeId ?? null,
        external_id: options.externalId,
        data: options.data ?? {},
        created_at: new Date(),
        updated_at: new Date(),
      });
    }
  }

  loadLinkedObjects(nodeId: string, teamId: string): SimLinkedObject[] {
    return this.outputLinkedObjects.filter((o) => o.node_id === nodeId && o.team_id === teamId);
  }

  storeRun(options: { teamId: string; pipelineOutputId: string; actionNodeId: string; contextNodeId: string; adapterType: string; externalId: string | null; status: string }): void {
    this.outputRuns.push(options);
  }

  // -- Query builder entrypoint --

  createQueryBuilder(): { selectFrom: (table: string) => SimQueryChain } {
    const sim = this;
    return {
      selectFrom(table: string) {
        const chain = new SimQueryChain(sim);
        return chain.selectFrom(table);
      },
    };
  }

  // -- Query execution engine --

  executeQuery(
    table: string,
    wheres: { column: string; op: string; value: unknown }[],
    joins: { table: string; leftCol: string; rightCol: string }[],
    selectedCols: string[],
  ): SimRow[] {
    let rows = this.getBaseRows(table);

    for (const join of joins) {
      rows = this.applyJoin(rows, join, table);
    }

    for (const w of wheres) {
      rows = rows.filter((r) => this.matchWhere(r, w));
    }

    if (selectedCols.length > 0) {
      rows = rows.map((r) => this.project(r, selectedCols));
    }

    return rows;
  }

  private getBaseRows(table: string): SimRow[] {
    switch (table) {
      case 'edge':
        return this.edges.map((e) => ({
          'edge.id': e.id,
          'edge.source_node_id': e.source_node_id,
          'edge.target_node_id': e.target_node_id,
          'edge.edge_type_id': e.edge_type_id,
          'edge.team_id': e.team_id,
        }));

      case 'property':
        return this.properties.map((p) => ({
          'property.node_id': p.node_id,
          'property.edge_id': p.edge_id,
          'property.property_type_id': p.property_type_id,
          'property.team_id': p.team_id,
          'property.value_text': p.value_text,
          'property.value_number': p.value_number,
          'property.value_boolean': p.value_boolean,
          'property.value_date': p.value_date,
          'property.value_json': p.value_json,
        }));

      case 'node':
        return this.nodes.map((n) => ({
          'node.id': n.id,
          'node.node_type_id': n.node_type_id,
          'node.team_id': n.team_id,
        }));

      case 'node_resource':
        return this.nodeResources.map((nr) => ({
          'node_resource.node_id': nr.node_id,
          'node_resource.team_id': nr.team_id,
          'node_resource.resource_id': nr.resource_id,
          'node_resource.start_offset': nr.start_offset,
          'node_resource.end_offset': nr.end_offset,
        }));

      case 'resource':
        return this.resources.map((r) => ({
          'resource.id': r.id,
          'resource.raw_text_id': r.raw_text_id,
        }));

      case 'pipeline_output':
        return this.pipelineOutputs.map((po) => ({
          'pipeline_output.id': po.id,
          'pipeline_output.pipeline_configuration_id': po.pipeline_configuration_id,
          'pipeline_output.type': po.type,
          'pipeline_output.config': po.config,
          'pipeline_output.credentials_id': po.credentials_id,
          'pipeline_output.config_version': po.config_version,
          'pipeline_output.deleted_at': po.deleted_at,
          'pipeline_output.run_mode': po.run_mode,
        }));

      default:
        return [];
    }
  }

  private applyJoin(
    rows: SimRow[],
    join: { table: string; leftCol: string; rightCol: string },
    _baseTable: string,
  ): SimRow[] {
    const joinRows = this.getJoinRows(join.table);
    const result: SimRow[] = [];

    for (const row of rows) {
      const leftVal = row[join.leftCol];
      for (const jr of joinRows) {
        const rightVal = jr[join.rightCol];
        if (leftVal !== undefined && leftVal === rightVal) {
          result.push({ ...row, ...jr });
        }
        // Handle reversed join direction (the ON clause)
        const leftAlt = row[join.rightCol];
        const rightAlt = jr[join.leftCol];
        if (leftVal === undefined && leftAlt !== undefined && leftAlt === rightAlt) {
          result.push({ ...row, ...jr });
        }
      }
    }

    return result;
  }

  private getJoinRows(table: string): SimRow[] {
    switch (table) {
      case 'node_type':
        return this.nodeTypes.map((nt) => ({
          'node_type.id': nt.id,
          'node_type.name': nt.name,
          'node_type.category': nt.category,
        }));

      case 'property_type':
        return this.propertyTypes.map((pt) => ({
          'property_type.id': pt.id,
          'property_type.name': pt.name,
        }));

      case 'raw_text':
        return this.rawTexts.map((rt) => ({
          'raw_text.id': rt.id,
          'raw_text.content': rt.content,
        }));

      default:
        return this.getBaseRows(table);
    }
  }

  private matchWhere(row: SimRow, w: { column: string; op: string; value: unknown }): boolean {
    const actual = row[w.column];
    if (w.op === '=') return actual === w.value;
    if (w.op === 'is') return actual === w.value;
    if (w.op === 'in') return Array.isArray(w.value) && (w.value as unknown[]).includes(actual);
    return actual === w.value;
  }

  private project(row: SimRow, cols: string[]): SimRow {
    const result: SimRow = {};
    for (const col of cols) {
      const asMatch = col.match(/^(.+)\s+as\s+(\w+)$/);
      if (asMatch) {
        result[asMatch[2]] = row[asMatch[1]];
      } else {
        // Keep both qualified and unqualified keys
        result[col] = row[col];
        const parts = col.split('.');
        if (parts.length === 2) {
          result[parts[1]] = row[col];
        }
      }
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// Attio Simulator — maintains records, list entries, notes, tasks
// ---------------------------------------------------------------------------

interface AttioRecord {
  objectId: string;
  recordId: string;
  fields: Record<string, unknown>;
}

interface AttioListEntry {
  listId: string;
  entryId: string;
  parentObjectId: string;
  parentRecordId: string;
  fields: Record<string, unknown>;
}

interface AttioNote {
  parentObjectId: string;
  parentRecordId: string;
  title: string;
  content: string;
}

interface AttioTask {
  content: string;
  assignees: { workspaceMemberId: string }[];
  linkedRecords: { targetObject: string; targetRecordId: string }[];
  deadlineAt: string | null;
}

class AttioSimulator {
  records: AttioRecord[] = [];
  listEntries: AttioListEntry[] = [];
  notes: AttioNote[] = [];
  tasks: AttioTask[] = [];

  private nextRecordId = 1;
  private nextEntryId = 1;

  // Attribute definitions for field constraints
  private attributes: { objectId?: string; listId?: string; id: string; name: string; apiSlug: string; type: string; isUnique?: boolean }[] = [];
  private attributeOptions: { attributeId: string; name: string }[] = [];

  addAttribute(options: { objectId?: string; listId?: string; id: string; name: string; apiSlug: string; type: string; isUnique?: boolean }): this {
    this.attributes.push(options);
    return this;
  }

  addAttributeOptions(attributeId: string, optionNames: string[]): this {
    for (const name of optionNames) {
      this.attributeOptions.push({ attributeId, name });
    }
    return this;
  }

  createOperations(): AttioOperationsLike {
    return {
      getClient: () => ({
        listObjects: async () => {
          // Derive objects from unique objectIds in attributes
          const objectIds = [...new Set(this.attributes.map((a) => a.objectId).filter(Boolean))];
          return objectIds.map((id) => ({ id, slug: id, name: id }));
        },
        getWorkspaceSlug: async () => 'test-workspace',
        listAttributes: async (opts: { objectId?: string; listId?: string }) =>
          this.attributes.filter(
            (a) =>
              (opts.objectId && a.objectId === opts.objectId) ||
              (opts.listId && a.listId === opts.listId),
          ),
        listAttributeOptions: async (opts: { attributeId: string }) =>
          this.attributeOptions.filter((o) => o.attributeId === opts.attributeId),
        listStatuses: async (opts: { attributeId: string }) =>
          this.attributeOptions.filter((o) => o.attributeId === opts.attributeId),
        filterRecords: async (opts: { objectId: string; filters: Record<string, unknown> }) => {
          return this.records.filter((r) => {
            if (r.objectId !== opts.objectId) return false;
            return Object.entries(opts.filters).every(([key, value]) => r.fields[key] === value);
          }).map((r) => ({ id: r.recordId }));
        },
        searchRecords: async (opts: { objectId: string; query: string }) => {
          const query = opts.query.toLowerCase();
          return this.records.filter((r) => {
            if (r.objectId !== opts.objectId) return false;
            return Object.values(r.fields).some(
              (v) => typeof v === 'string' && v.toLowerCase().includes(query),
            );
          }).map((r) => ({ id: r.recordId, text: String(Object.values(r.fields)[0] ?? '') }));
        },
      }),

      createOrUpdateObject: async (opts: {
        objectId: string;
        searchQuery?: string;
        existingId?: string;
        userText: string;
        tracer: unknown;
        fieldConfigurations: unknown[];
        additionalFields?: Record<string, unknown>;
        preResolvedValues?: Map<string, unknown>;
      }) => {
        // Check for existing record by existingId first, then search query
        let existing = opts.existingId
          ? this.records.find((r) => r.objectId === opts.objectId && r.recordId === opts.existingId)
          : undefined;

        if (!existing && opts.searchQuery) {
          existing = this.records.find(
            (r) =>
              r.objectId === opts.objectId &&
              Object.values(r.fields).some((v) => v === opts.searchQuery),
          );
        }

        const fields: Record<string, unknown> = {};
        if (opts.preResolvedValues) {
          for (const [k, v] of opts.preResolvedValues) fields[k] = v;
        }
        if (opts.additionalFields) {
          Object.assign(fields, opts.additionalFields);
        }

        if (existing) {
          Object.assign(existing.fields, fields);
          return {
            id: { workspace_id: 'ws-1', object_id: opts.objectId, record_id: existing.recordId },
            values: existing.fields,
          };
        }

        const recordId = `rec-${this.nextRecordId++}`;
        this.records.push({ objectId: opts.objectId, recordId, fields });
        return {
          id: { workspace_id: 'ws-1', object_id: opts.objectId, record_id: recordId },
          values: fields,
        };
      },

      createOrUpdateListEntry: async (opts: {
        listId: string;
        parentObjectId: string;
        parentRecordId: string;
        userText: string;
        tracer: unknown;
        fieldConfigurations: unknown[];
        preResolvedValues?: Map<string, unknown>;
        deduplicationWindow?: unknown;
      }) => {
        const fields: Record<string, unknown> = {};
        if (opts.preResolvedValues) {
          for (const [k, v] of opts.preResolvedValues) fields[k] = v;
        }

        const entryId = `entry-${this.nextEntryId++}`;
        this.listEntries.push({
          listId: opts.listId,
          entryId,
          parentObjectId: opts.parentObjectId,
          parentRecordId: opts.parentRecordId,
          fields,
        });
        return entryId;
      },

      createNote: async (opts: {
        parentObjectId: string;
        parentRecordId: string;
        title: string;
        content: string;
      }) => {
        this.notes.push(opts);
      },

      createTask: async (opts: {
        content: string;
        assignees: { workspaceMemberId: string }[];
        linkedRecords: { targetObject: string; targetRecordId: string }[];
        deadlineAt?: string | null;
      }) => {
        this.tasks.push({
          content: opts.content,
          assignees: opts.assignees,
          linkedRecords: opts.linkedRecords,
          deadlineAt: opts.deadlineAt ?? null,
        });
      },
    };
  }
}

// Minimal operations shape consumed by createAttioV3Adapter
// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface AttioOperationsLike {
  getClient: () => {
    listAttributes: (opts: { objectId?: string; listId?: string }) => Promise<{ id: string; name: string; apiSlug: string; type: string; isUnique?: boolean }[]>;
    listAttributeOptions: (opts: { attributeId: string }) => Promise<{ name: string }[]>;
    listStatuses: (opts: { attributeId: string }) => Promise<{ name: string }[]>;
    filterRecords: (opts: { objectId: string; filters: Record<string, unknown> }) => Promise<{ id: string }[]>;
    searchRecords: (opts: { objectId: string; query: string }) => Promise<{ id: string; text: string }[]>;
  };
  createOrUpdateObject: (opts: any) => Promise<{ id: { workspace_id: string; object_id: string; record_id: string }; values: Record<string, unknown> }>;
  createOrUpdateListEntry: (opts: any) => Promise<string>;
  createNote: (opts: any) => Promise<void>;
  createTask: (opts: any) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Slack Simulator — maintains channels and messages with threading
// ---------------------------------------------------------------------------

interface SlackMessage {
  channel: string;
  text: string;
  threadTs?: string;
  ts: string;
}

class SlackSimulator {
  messages: SlackMessage[] = [];
  joinedChannels: Set<string> = new Set();

  private memberChannels: Set<string> = new Set();
  private nextTs = 1000000;

  addMembership(channelId: string): this {
    this.memberChannels.add(channelId);
    return this;
  }

  createClient(): SlackClientLike {
    return {
      api: {
        conversations: {
          list: async () => ({
            channels: [...this.memberChannels].map((id) => ({ id, name: id })),
          }),
          info: async (opts: { channel: string }) => ({
            channel: { is_member: this.memberChannels.has(opts.channel) },
          }),
          join: async (opts: { channel: string }) => {
            this.joinedChannels.add(opts.channel);
            this.memberChannels.add(opts.channel);
            return {};
          },
          members: async () => ({
            members: ['U001'],
          }),
        },
        chat: {
          postMessage: async (opts: { channel: string; text: string; thread_ts?: string; unfurl_links?: boolean; unfurl_media?: boolean }) => {
            const ts = `${this.nextTs++}.000000`;
            this.messages.push({
              channel: opts.channel,
              text: opts.text,
              threadTs: opts.thread_ts,
              ts,
            });
            return { ts };
          },
        },
        users: {
          list: async (_opts?: any) => ({
            members: [
              { id: 'U001', name: 'ada', deleted: false, is_bot: false },
            ],
          }),
        },
      },
    };
  }

  getMessagesInChannel(channelId: string): SlackMessage[] {
    return this.messages.filter((m) => m.channel === channelId);
  }

  getThreadReplies(channelId: string, parentTs: string): SlackMessage[] {
    return this.messages.filter((m) => m.channel === channelId && m.threadTs === parentTs);
  }
}

interface SlackClientLike {
  api: {
    conversations: {
      list: () => Promise<{ channels: { id: string; name: string }[] }>;
      info: (opts: { channel: string }) => Promise<{ channel: { is_member: boolean } }>;
      join: (opts: { channel: string }) => Promise<unknown>;
      members: (opts: { channel: string }) => Promise<{ members: string[] }>;
    };
    chat: {
      postMessage: (opts: { channel: string; text: string; thread_ts?: string; unfurl_links?: boolean; unfurl_media?: boolean }) => Promise<{ ts: string }>;
    };
    users: {
      list: (opts?: any) => Promise<{ members: { id: string; name: string; deleted: boolean; is_bot: boolean }[] }>;
    };
  };
}

// ---------------------------------------------------------------------------
// Webhook Simulator — captures outgoing HTTP calls
// ---------------------------------------------------------------------------

interface WebhookCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

class WebhookSimulator {
  calls: WebhookCall[] = [];
  private originalFetch: typeof globalThis.fetch;

  constructor() {
    this.originalFetch = globalThis.fetch;
  }

  install(): void {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      const headers: Record<string, string> = {};
      if (init?.headers) {
        const h = init.headers as Record<string, string>;
        for (const [k, v] of Object.entries(h)) headers[k] = v;
      }
      const body = init?.body ? JSON.parse(init.body as string) : null;
      this.calls.push({ url, method: init?.method ?? 'GET', headers, body });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof globalThis.fetch;
  }

  restore(): void {
    globalThis.fetch = this.originalFetch;
  }
}

// ---------------------------------------------------------------------------
// Affinity Simulator — maintains organizations, persons, list entries, notes
// ---------------------------------------------------------------------------

interface AffinityOrganization {
  id: number;
  name: string;
  domain: string | null;
}

interface AffinityPerson {
  id: number;
  name: string;
  email: string | null;
  orgId: number | undefined;
}

interface AffinityListEntry {
  id: number;
  listId: number;
  entityId: number;
}

interface AffinityNote {
  organizationId: number | undefined;
  personId: number | undefined;
  content: string;
}

class AffinitySimulator {
  organizations: AffinityOrganization[] = [];
  persons: AffinityPerson[] = [];
  listEntries: AffinityListEntry[] = [];
  notes: AffinityNote[] = [];

  private nextOrgId = 1000;
  private nextPersonId = 2000;
  private nextEntryId = 3000;

  createOperations(): AffinityOperationsLike {
    return {
      getClient: () => ({
        getWhoami: async () => ({ tenant: { subdomain: 'test' } }),
        getOrganisationById: async (id: number) => {
          const org = this.organizations.find((o) => o.id === id);
          return org ? { id: org.id, name: org.name, domain: org.domain, domains: org.domain ? [org.domain] : [] } : null;
        },
        getPersonById: async (id: number) => {
          const person = this.persons.find((p) => p.id === id);
          return person ? { id: person.id, first_name: person.name.split(' ')[0], last_name: person.name.split(' ').slice(1).join(' '), primary_email: person.email, emails: person.email ? [person.email] : [] } : null;
        },
        getFields: async () => [],
        getFieldValues: async () => [],
        createFieldValue: async () => ({}),
        updateFieldValue: async () => ({}),
      }),

      findMatchingOrganisation: async (opts: { name: string; domain?: string | null }) => {
        let existing: AffinityOrganization | undefined;
        if (opts.domain) {
          existing = this.organizations.find(
            (o) => o.domain && o.domain.toLowerCase() === opts.domain!.toLowerCase(),
          );
        }
        if (!existing) {
          existing = this.organizations.find(
            (o) => o.name.toLowerCase() === opts.name.toLowerCase(),
          );
        }
        return existing ? { id: existing.id } : null;
      },

      findMatchingPerson: async (opts: { name: string; email?: string | null }) => {
        let existing: AffinityPerson | undefined;
        if (opts.email) {
          existing = this.persons.find((p) => p.email === opts.email);
        }
        if (!existing) {
          existing = this.persons.find(
            (p) => p.name.toLowerCase() === opts.name.toLowerCase(),
          );
        }
        return existing ? { id: existing.id } : null;
      },

      createOrUpdateOrganisation: async (opts: {
        searchQuery: { name: string; domain?: string | null };
        userText: string;
        tracer: unknown;
        fieldConfigurations: unknown[];
      }) => {
        // Match by domain first (unique), then by name (fuzzy)
        let existing: AffinityOrganization | undefined;
        if (opts.searchQuery.domain) {
          existing = this.organizations.find(
            (o) => o.domain && o.domain.toLowerCase() === opts.searchQuery.domain!.toLowerCase(),
          );
        }
        if (!existing) {
          existing = this.organizations.find(
            (o) => o.name.toLowerCase() === opts.searchQuery.name.toLowerCase(),
          );
        }
        if (existing) {
          if (opts.searchQuery.domain && !existing.domain) {
            existing.domain = opts.searchQuery.domain;
          }
          return { id: existing.id, isNew: false };
        }
        const org: AffinityOrganization = {
          id: this.nextOrgId++,
          name: opts.searchQuery.name,
          domain: opts.searchQuery.domain ?? null,
        };
        this.organizations.push(org);
        return { id: org.id, isNew: true };
      },

      createOrUpdatePerson: async (opts: {
        searchQuery: { name: string; email?: string | null };
        userText: string;
        tracer: unknown;
        fieldConfigurations: unknown[];
        orgId?: number;
      }) => {
        // Match by email first (unique), then by name (fuzzy)
        let existing: AffinityPerson | undefined;
        if (opts.searchQuery.email) {
          existing = this.persons.find(
            (p) => p.email && p.email.toLowerCase() === opts.searchQuery.email!.toLowerCase(),
          );
        }
        if (!existing) {
          existing = this.persons.find(
            (p) => p.name.toLowerCase() === opts.searchQuery.name.toLowerCase(),
          );
        }
        if (existing) {
          if (opts.orgId) existing.orgId = opts.orgId;
          return { id: existing.id, isNew: false };
        }
        const person: AffinityPerson = {
          id: this.nextPersonId++,
          name: opts.searchQuery.name,
          email: opts.searchQuery.email ?? null,
          orgId: opts.orgId,
        };
        this.persons.push(person);
        return { id: person.id, isNew: true };
      },

      createListEntry: async (opts: {
        listId: number;
        entityId: number;
        entityType: 'organization' | 'person';
        deduplicationWindow?: unknown;
        tracer: unknown;
      }) => {
        // Check for existing entry (simple dedup)
        const existing = this.listEntries.find(
          (e) => e.listId === opts.listId && e.entityId === opts.entityId,
        );
        if (existing) return { id: existing.id, isNew: false };

        const entry: AffinityListEntry = {
          id: this.nextEntryId++,
          listId: opts.listId,
          entityId: opts.entityId,
        };
        this.listEntries.push(entry);
        return { id: entry.id, isNew: true };
      },

      createNote: async (opts: {
        organizationId?: number;
        personId?: number;
        content: string;
        tracer: unknown;
      }) => {
        if (!opts.content.trim()) return;
        this.notes.push({
          organizationId: opts.organizationId,
          personId: opts.personId,
          content: opts.content,
        });
      },
    };
  }
}

interface AffinityOperationsLike {
  getClient: () => any;
  findMatchingOrganisation: (opts: any) => Promise<{ id: number } | null>;
  findMatchingPerson: (opts: any) => Promise<{ id: number } | null>;
  createOrUpdateOrganisation: (opts: any) => Promise<{ id: number; isNew: boolean }>;
  createOrUpdatePerson: (opts: any) => Promise<{ id: number; isNew: boolean }>;
  createListEntry: (opts: any) => Promise<{ id: number; isNew: boolean } | null>;
  createNote: (opts: any) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Airtable Simulator — maintains records across bases/tables
// ---------------------------------------------------------------------------

interface AirtableRecord {
  id: string;
  baseId: string;
  tableId: string;
  fields: Record<string, unknown>;
}

class AirtableSimulator {
  records: AirtableRecord[] = [];

  private nextRecordId = 1;

  createClient(): AirtableClientLike {
    return {
      listTables: async () => [],
      createRecord: async (opts: {
        baseId: string;
        tableId: string;
        fields: Record<string, unknown>;
      }) => {
        const id = `airtable-rec-${this.nextRecordId++}`;
        this.records.push({
          id,
          baseId: opts.baseId,
          tableId: opts.tableId,
          fields: opts.fields,
        });
        return { id };
      },
    };
  }

  getRecordsInTable(baseId: string, tableId: string): AirtableRecord[] {
    return this.records.filter((r) => r.baseId === baseId && r.tableId === tableId);
  }
}

interface AirtableClientLike {
  listTables: (opts: { baseId: string }) => Promise<Array<{ id: string; name: string; primaryFieldId: string; fields: Array<{ id: string; name: string; type: string; options?: unknown }> }>>;
  createRecord: (opts: { baseId: string; tableId: string; fields: Record<string, unknown> }) => Promise<{ id: string }>;
}

// ---------------------------------------------------------------------------
// Google Sheets Simulator — maintains rows and table rows
// ---------------------------------------------------------------------------

interface SheetRow {
  spreadsheetId: string;
  sheetId: number;
  row: Record<string, string | number | boolean | Date>;
}

interface TableRow {
  spreadsheetId: string;
  tableId: string;
  valuesByColumn: { columnIndex: number; value: string | number | boolean }[];
}

class GoogleSheetsSimulator {
  rows: SheetRow[] = [];
  tableRows: TableRow[] = [];
  tableColumns: Map<string, { columnIndex: number; columnName: string; columnType: string }[]> = new Map();

  setTableColumns(spreadsheetId: string, tableId: string, columns: { columnIndex: number; columnName: string; columnType?: string }[]) {
    this.tableColumns.set(`${spreadsheetId}:${tableId}`, columns.map((c) => ({ ...c, columnType: c.columnType ?? 'TEXT' })));
  }

  createClient(): GoogleSheetsClientLike {
    return {
      addRow: async (opts: {
        spreadsheetId: string;
        sheetId: number;
        row: Record<string, string | number | boolean | Date>;
      }) => {
        this.rows.push(opts);
      },
      addTableRow: async (opts: {
        spreadsheetId: string;
        tableId: string;
        valuesByColumn: { columnIndex: number; value: string | number | boolean }[];
      }) => {
        this.tableRows.push(opts);
      },
      getTableColumns: async (opts: { spreadsheetId: string; tableId: string }) => {
        return this.tableColumns.get(`${opts.spreadsheetId}:${opts.tableId}`) ?? [];
      },
    };
  }

  getRowsInSheet(spreadsheetId: string, sheetId: number): SheetRow[] {
    return this.rows.filter((r) => r.spreadsheetId === spreadsheetId && r.sheetId === sheetId);
  }

  getTableRows(spreadsheetId: string, tableId: string): TableRow[] {
    return this.tableRows.filter((r) => r.spreadsheetId === spreadsheetId && r.tableId === tableId);
  }
}

interface GoogleSheetsClientLike {
  addRow: (opts: { spreadsheetId: string; sheetId: number; row: Record<string, string | number | boolean | Date> }) => Promise<void>;
  addTableRow: (opts: { spreadsheetId: string; tableId: string; valuesByColumn: { columnIndex: number; value: string | number | boolean }[] }) => Promise<void>;
  getTableColumns: (opts: { spreadsheetId: string; tableId: string }) => Promise<{ columnIndex: number; columnName: string; columnType: string }[]>;
}

export {
  KnowledgeGraphSimulator,
  AttioSimulator,
  SlackSimulator,
  WebhookSimulator,
  AffinitySimulator,
  AirtableSimulator,
  GoogleSheetsSimulator,
};

export type {
  SimNode,
  SimEdge,
  SimProperty,
  SimPropertyType,
  SimNodeType,
  SimPipelineOutput,
  SimLinkedObject,
  AttioRecord,
  AttioListEntry,
  AttioNote,
  AttioTask,
  AttioOperationsLike,
  SlackMessage,
  SlackClientLike,
  WebhookCall,
  AffinityOrganization,
  AffinityPerson,
  AffinityListEntry as AffinityListEntrySim,
  AffinityNote as AffinityNoteSim,
  AffinityOperationsLike,
  AirtableRecord,
  AirtableClientLike,
  SheetRow,
  TableRow,
  GoogleSheetsClientLike,
};

// The MCP adapter: one connection's server, its tools as types (tools.ts).
// Every method resolves the connection's server from its credential first, so
// a refreshed token or an edited URL is read by the next call.

import type {
  GetFieldValueInput,
  GetRelatedInput,
  RelatedResult,
  ResolveEntityInput,
  ResolveEntityResult,
  SchemaEntryPoint,
  SchemaTypeDescriptor,
  WriteInput,
  WriteResult,
} from 'engine-contracts';
import { META_RECORD_TYPE, makeUnstablePosition, positionData } from 'engine-contracts';
import { randomUUID } from 'node:crypto';
import { BaseAdapter } from 'module-kit/adapter/base';

import type { McpConnection } from './client';
import { MCP_ADAPTER_TYPE } from './manifest';
import { argumentsOf, descriptorOf, entryPointOf, isReadOnly, missingArguments, resultFieldsOf } from './tools';

/** Where the adapter gets its connection: the module's from the context's
 *  credential, a test's a fake. */
export type ConnectionSource = () => Promise<McpConnection>;

export class McpAdapter extends BaseAdapter {
  readonly adapterType = MCP_ADAPTER_TYPE;
  readonly supportedTriggers = [] as const;

  constructor(private readonly connection: ConnectionSource) {
    super();
  }

  /** The server's tools, listed afresh: a changed tool list takes effect at
   *  the next describe. */
  async listEntryPoints(): Promise<SchemaEntryPoint[]> {
    const tools = await (await this.connection()).listTools();
    return tools.map(entryPointOf);
  }

  async describe(typeRef: string): Promise<SchemaTypeDescriptor | null> {
    const tools = await (await this.connection()).knownTools();
    const tool = tools.find((t) => t.name === typeRef);
    return tool === undefined ? null : descriptorOf(tool);
  }

  /** A tool call always creates: nothing it answers is a record found again. */
  async resolveEntity(_input: ResolveEntityInput): Promise<ResolveEntityResult> {
    return { candidates: [] };
  }

  /** A record carries its fields inline, named as the tool names them. */
  async getFieldValue(input: GetFieldValueInput): Promise<unknown> {
    const data = positionData(input.position) as Record<string, unknown> | null | undefined;
    return data?.[input.fieldId] ?? null;
  }

  /** A read-only tool, read from the connection's root: one call with the
   *  WHERE's pinned arguments, answered as one record. */
  async getRelated(input: GetRelatedInput): Promise<RelatedResult[]> {
    if (input.position.recordType !== META_RECORD_TYPE || input.direction !== 'outgoing') return [];
    const connection = await this.connection();
    const tool = await connection.tool(input.fieldId);
    if (!isReadOnly(tool)) {
      throw new Error(`${tool.name} changes things, so it is written (write <connection>-[:${tool.name}]-> { … }), not read.`);
    }
    const args = argumentsOf(input.where);
    const missing = missingArguments(tool, args);
    if (missing.length > 0) {
      throw new Error(
        `${tool.name} needs ${missing.map((m) => `"${m}"`).join(', ')}: pin ${missing.length === 1 ? 'it' : 'each'} in the read's WHERE with ==, e.g. -[r:${tool.name} WHERE r.${missing[0]} == …]->`,
      );
    }
    const result = resultFieldsOf(tool, await connection.call(tool.name, args));
    return [{ position: makeUnstablePosition({ adapterType: MCP_ADAPTER_TYPE, recordType: tool.name, data: { ...result, ...args } }) }];
  }

  /** A tool that changes things, written: one call with the written fields as
   *  its arguments; its result is what the write's handle reads. */
  async createRecord(input: WriteInput): Promise<WriteResult> {
    const connection = await this.connection();
    const tool = await connection.tool(input.recordType);
    const args = Object.fromEntries(Object.entries(input.fields ?? {}).filter(([, value]) => value !== undefined && value !== null));
    const data = resultFieldsOf(tool, await connection.call(tool.name, args));
    return { adapterType: MCP_ADAPTER_TYPE, externalId: `${tool.name}:${randomUUID()}`, recordType: tool.name, data };
  }
}

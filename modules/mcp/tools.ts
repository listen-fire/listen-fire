// An MCP server's tools as the types of a graph. A tool that changes things is
// a type a movement WRITES: its arguments are the fields written, and the
// call's result is read off the write's handle. A read-only tool is a type a
// movement READS from the connection's root: its arguments are the equality
// pins of the hop's WHERE, and the call answers one record carrying the
// arguments (so the engine's own WHERE keeps it) and the result.

import type { Expression } from 'engine-contracts/expression/expression';
import type { SchemaEntryPoint, SchemaFieldDescriptor, SchemaTypeDescriptor } from 'engine-contracts';

import { propertiesOf } from './schema';

/** The part of an MCP tool this module reads (the SDK's `Tool`). */
export interface McpTool {
  name: string;
  description?: string;
  inputSchema: unknown;
  outputSchema?: unknown;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

/** The part of an MCP tool call's answer this module reads. */
export interface McpCallResult {
  content?: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
}

/** The result fields every tool's type carries. */
export const TEXT_FIELD = 'text';
export const CONTENT_FIELD = 'content';
/** Present when the tool declares an `outputSchema`: its whole answer. */
export const STRUCTURED_FIELD = 'structured';

/** Read-only by its own annotations, and not destructive. Anything else is
 *  marked a write, so the run's story shows it changing something. */
export function isReadOnly(tool: McpTool): boolean {
  return tool.annotations?.readOnlyHint === true && tool.annotations.destructiveHint !== true;
}

export function entryPointOf(tool: McpTool): SchemaEntryPoint {
  const readOnly = isReadOnly(tool);
  return {
    typeId: tool.name,
    displayName: tool.name,
    writable: !readOnly,
    readable: readOnly,
    ...(tool.description ? { description: tool.description } : {}),
  };
}

/**
 * A tool's type. Its arguments come first and keep their names; a result
 * field an argument already names is left out (its value is still in
 * `content`, and in `structured` when the tool declares an output schema).
 */
export function descriptorOf(tool: McpTool): SchemaTypeDescriptor {
  const writes = !isReadOnly(tool);
  const fields: SchemaFieldDescriptor[] = propertiesOf(tool.inputSchema).map((p) => ({
    fieldId: p.name,
    displayName: p.name,
    ...p.shape,
    writable: writes,
    required: writes && p.required,
    ...(p.description !== undefined ? { description: p.description } : {}),
  }));
  const taken = new Set(fields.map((f) => f.fieldId));
  const result = (field: Omit<SchemaFieldDescriptor, 'displayName' | 'writable' | 'required'>): void => {
    if (taken.has(field.fieldId)) return;
    taken.add(field.fieldId);
    fields.push({ ...field, displayName: field.fieldId, writable: false, required: false });
  };
  result({ fieldId: TEXT_FIELD, kind: 'string', description: 'The text parts of the answer, joined by new lines.' });
  result({ fieldId: CONTENT_FIELD, kind: 'json', description: 'Every part of the answer, as the server sent it.' });
  if (tool.outputSchema !== undefined) {
    result({ fieldId: STRUCTURED_FIELD, kind: 'json', description: 'The structured answer, whole.' });
    for (const p of propertiesOf(tool.outputSchema)) {
      result({ fieldId: p.name, ...p.shape, ...(p.description !== undefined ? { description: p.description } : {}) });
    }
  }
  return {
    typeId: tool.name,
    displayName: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    fields,
    references: [],
  };
}

/** The text of an answer's text parts. */
function textOf(content: unknown[]): string {
  return content
    .filter((part): part is { type: 'text'; text: string } => typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text' && typeof (part as { text?: unknown }).text === 'string')
    .map((part) => part.text)
    .join('\n');
}

/** A refused call (`isError`), as the server worded it. */
export class ToolFailed extends Error {}

/** A call's answer as the result fields of the tool's type; a refused call
 *  throws with the server's own text. */
export function resultFieldsOf(tool: McpTool, answer: McpCallResult): Record<string, unknown> {
  const content = Array.isArray(answer.content) ? answer.content : [];
  if (answer.isError === true) {
    const text = textOf(content);
    throw new ToolFailed(`${tool.name}: ${text === '' ? 'the server refused the call and said nothing more' : text}`);
  }
  const fields: Record<string, unknown> = { [TEXT_FIELD]: textOf(content), [CONTENT_FIELD]: content };
  const structured = answer.structuredContent;
  if (tool.outputSchema !== undefined && structured !== undefined) {
    fields[STRUCTURED_FIELD] = structured;
    if (typeof structured === 'object' && structured !== null && !Array.isArray(structured)) {
      for (const [name, value] of Object.entries(structured)) {
        if (!(name in fields)) fields[name] = value;
      }
    }
  }
  return fields;
}

/** The value a WHERE operand pins, when it is a literal (or a value the engine
 *  closed over and wrote as one). */
function literalOf(e: Expression): { value: unknown } | undefined {
  return e.type === 'static' ? { value: e.value } : undefined;
}

/** The field a WHERE operand reads off the hop's own record (`r.query`, which
 *  the engine pushes as an `edge_property`). */
function fieldOf(e: Expression): string | undefined {
  return e.type === 'edge_property' || e.type === 'property' ? e.propertyTypeId : undefined;
}

/**
 * A read's arguments: each `field == literal` conjunct of the hop's WHERE (the
 * engine pushes a WHERE whose leaves it can close over, with the values in
 * scope written in). An OR, a NOT or another comparison pins nothing.
 */
export function argumentsOf(where: Expression | undefined): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const visit = (e: Expression): void => {
    if (e.type === 'logical' && e.op === 'and') {
      e.operands.forEach(visit);
      return;
    }
    if (e.type !== 'compare' || e.op !== 'eq') return;
    for (const [field, value] of [[e.left, e.right], [e.right, e.left]] as const) {
      const name = fieldOf(field);
      const literal = literalOf(value);
      if (name !== undefined && literal !== undefined) {
        args[name] = literal.value;
        return;
      }
    }
  };
  if (where !== undefined) visit(where);
  return args;
}

/** The required arguments a read left unpinned, refused by name: a read
 *  missing one passes the check (nothing marks a field the WHERE must pin)
 *  and fails here. */
export function missingArguments(tool: McpTool, args: Record<string, unknown>): string[] {
  return propertiesOf(tool.inputSchema)
    .filter((p) => p.required && !(p.name in args))
    .map((p) => p.name);
}

// A tool's JSON Schema as the field kinds a type descriptor declares. Every
// property gets a kind the host knows: a field of an unknown kind is dropped by
// the host and leaves the whole type unchecked, so anything without a closer
// kind is `json`.

import type { SchemaFieldDescriptor } from 'engine-contracts';

/** The part of a JSON Schema this mapping reads. Anything else is ignored. */
export interface JsonSchema {
  type?: string | string[];
  format?: string;
  enum?: unknown[];
  items?: JsonSchema | JsonSchema[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  description?: string;
}

/** What a field holds, before it is named. */
export type FieldShape = Pick<SchemaFieldDescriptor, 'kind' | 'enumValues' | 'cardinality'>;

const JSON_FIELD: FieldShape = { kind: 'json' };

function isSchema(value: unknown): value is JsonSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The one type a schema names, `null` aside (`["string", "null"]` is a string
 *  that may be absent); undefined when it names none or several. */
function singleType(schema: JsonSchema): string | undefined {
  if (typeof schema.type === 'string') return schema.type;
  if (Array.isArray(schema.type)) {
    const named = schema.type.filter((t) => t !== 'null');
    return named.length === 1 ? named[0] : undefined;
  }
  return undefined;
}

/** A schema that holds one value (no list): its kind. */
function scalarShape(schema: JsonSchema): FieldShape | undefined {
  if (Array.isArray(schema.enum)) {
    const options = schema.enum.filter((v) => v !== null);
    return options.length > 0 && options.every((v): v is string => typeof v === 'string') ? { kind: 'enum', enumValues: options } : undefined;
  }
  switch (singleType(schema)) {
    case 'string':
      return { kind: schema.format === 'date' ? 'date' : 'string' };
    case 'number':
    case 'integer':
      return { kind: 'number' };
    case 'boolean':
      return { kind: 'boolean' };
    default:
      return undefined;
  }
}

/** A property's field shape: a scalar, a list of one scalar kind, else json. */
export function fieldShapeOf(schema: unknown): FieldShape {
  if (!isSchema(schema)) return JSON_FIELD;
  if (singleType(schema) === 'array') {
    const items = isSchema(schema.items) ? scalarShape(schema.items) : undefined;
    return items === undefined ? JSON_FIELD : { ...items, cardinality: 'many' };
  }
  return scalarShape(schema) ?? JSON_FIELD;
}

/** One object schema's properties, in the order the server wrote them, each
 *  with whether it is required and its description. */
export function propertiesOf(schema: unknown): Array<{ name: string; shape: FieldShape; required: boolean; description?: string }> {
  if (!isSchema(schema) || !isSchema(schema.properties)) return [];
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  return Object.entries(schema.properties).map(([name, property]) => ({
    name,
    shape: fieldShapeOf(property),
    required: required.has(name),
    ...(isSchema(property) && typeof property.description === 'string' && property.description !== '' ? { description: property.description } : {}),
  }));
}

// A tool's schema as field kinds, its answer as result fields, a refused call,
// which tools are writes, and a read's arguments from its WHERE.

import type { Expression } from 'engine-contracts/expression/expression';

import { fieldShapeOf } from '../schema';
import { argumentsOf, descriptorOf, entryPointOf, missingArguments, resultFieldsOf, ToolFailed, type McpTool } from '../tools';

describe('a JSON Schema property as a field kind', () => {
  it.each([
    [{ type: 'string' }, { kind: 'string' }],
    [{ type: 'string', format: 'date' }, { kind: 'date' }],
    [{ type: 'string', format: 'date-time' }, { kind: 'string' }],
    [{ type: 'integer' }, { kind: 'number' }],
    [{ type: 'number' }, { kind: 'number' }],
    [{ type: 'boolean' }, { kind: 'boolean' }],
    [{ type: ['string', 'null'] }, { kind: 'string' }],
    [{ type: 'string', enum: ['ENG', 'OPS'] }, { kind: 'enum', enumValues: ['ENG', 'OPS'] }],
    [{ enum: [1, 2] }, { kind: 'json' }],
    [{ type: 'array', items: { type: 'string' } }, { kind: 'string', cardinality: 'many' }],
    [{ type: 'array', items: { type: 'object' } }, { kind: 'json' }],
    [{ type: 'array' }, { kind: 'json' }],
    [{ type: 'object', properties: { a: { type: 'string' } } }, { kind: 'json' }],
    [{ anyOf: [{ type: 'string' }, { type: 'number' }] }, { kind: 'json' }],
    [{ type: ['string', 'number'] }, { kind: 'json' }],
    [{}, { kind: 'json' }],
    [true, { kind: 'json' }],
  ])('%j is %j', (schema, shape) => {
    expect(fieldShapeOf(schema)).toEqual(shape);
  });
});

const CREATE: McpTool = {
  name: 'create_issue',
  inputSchema: { type: 'object', properties: { title: { type: 'string', description: 'The title.' }, team: { type: 'string', enum: ['ENG'] }, text: { type: 'string' } }, required: ['title'] },
};
const SEARCH: McpTool = {
  name: 'search_issues',
  description: 'Find issues.',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  outputSchema: { type: 'object', properties: { count: { type: 'integer' }, query: { type: 'string' }, titles: { type: 'array', items: { type: 'string' } } } },
  annotations: { readOnlyHint: true },
};

describe('which tools are writes', () => {
  it('marks a tool a write unless it says it is read-only and not destructive', () => {
    expect(entryPointOf(CREATE)).toMatchObject({ writable: true, readable: false });
    expect(entryPointOf(SEARCH)).toMatchObject({ writable: false, readable: true, description: 'Find issues.' });
    expect(entryPointOf({ ...SEARCH, annotations: { readOnlyHint: true, destructiveHint: true } })).toMatchObject({ writable: true, readable: false });
    expect(entryPointOf({ ...SEARCH, annotations: { readOnlyHint: false } })).toMatchObject({ writable: true });
  });
});

describe("a tool's type", () => {
  it('a write: its arguments are writable, required as the schema says; an argument keeps a name a result field would take', () => {
    const fields = descriptorOf(CREATE).fields;
    expect(fields.map((f) => [f.fieldId, f.kind, f.writable, f.required])).toEqual([
      ['title', 'string', true, true],
      ['team', 'enum', true, false],
      ['text', 'string', true, false],
      ['content', 'json', false, false],
    ]);
    expect(fields[0]?.description).toBe('The title.');
  });

  it('a read: its arguments are read back, then text, content, structured and the output properties', () => {
    expect(descriptorOf(SEARCH).fields.map((f) => [f.fieldId, f.kind, f.writable, f.required, f.cardinality])).toEqual([
      ['query', 'string', false, false, undefined],
      ['text', 'string', false, false, undefined],
      ['content', 'json', false, false, undefined],
      ['structured', 'json', false, false, undefined],
      ['count', 'number', false, false, undefined],
      ['titles', 'string', false, false, 'many'],
    ]);
  });

  it('a read: its required arguments are marked for the WHERE to pin; a write marks none', () => {
    const optional = { ...SEARCH, inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } }, required: ['query'] } };
    expect(descriptorOf(optional).fields.filter((f) => f.pinned === true).map((f) => f.fieldId)).toEqual(['query']);
    expect(descriptorOf(CREATE).fields.some((f) => f.pinned !== undefined)).toBe(false);
  });
});

describe("a call's answer", () => {
  it('joins the text parts, keeps every part, and spreads a structured answer', () => {
    const content = [{ type: 'text', text: 'one' }, { type: 'image', data: 'x', mimeType: 'image/png' }, { type: 'text', text: 'two' }];
    expect(resultFieldsOf(SEARCH, { content, structuredContent: { count: 2, titles: ['a', 'b'] } })).toEqual({
      text: 'one\ntwo',
      content,
      structured: { count: 2, titles: ['a', 'b'] },
      count: 2,
      titles: ['a', 'b'],
    });
  });

  it('carries no structured answer for a tool without an output schema', () => {
    expect(resultFieldsOf(CREATE, { content: [{ type: 'text', text: 'done' }], structuredContent: { x: 1 } })).toEqual({
      text: 'done',
      content: [{ type: 'text', text: 'done' }],
    });
  });

  it('fails a refused call with the server’s own text', () => {
    const refused = () => resultFieldsOf(CREATE, { content: [{ type: 'text', text: 'team archived' }], isError: true });
    expect(refused).toThrow(ToolFailed);
    expect(refused).toThrow('create_issue: team archived');
    expect(() => resultFieldsOf(CREATE, { content: [], isError: true })).toThrow('create_issue: the server refused the call and said nothing more');
  });
});

describe("a read's arguments", () => {
  const prop = (name: string): Expression => ({ type: 'edge_property', propertyTypeId: name });
  const lit = (value: string | number | boolean | null): Expression => ({ type: 'static', value });

  it('are the == pins of the AND, either way round', () => {
    const where: Expression = {
      type: 'logical',
      op: 'and',
      operands: [
        { type: 'compare', op: 'eq', left: prop('query'), right: lit('slow') },
        { type: 'compare', op: 'eq', left: lit(3), right: prop('limit') },
        { type: 'compare', op: 'gt', left: prop('count'), right: lit(1) },
      ],
    };
    expect(argumentsOf(where)).toEqual({ query: 'slow', limit: 3 });
  });

  it('read a field spelled as a plain property too', () => {
    expect(argumentsOf({ type: 'compare', op: 'eq', left: { type: 'property', propertyTypeId: 'query' }, right: lit('x') })).toEqual({ query: 'x' });
  });

  it('are nothing under an OR or with no WHERE', () => {
    expect(argumentsOf({ type: 'logical', op: 'or', operands: [{ type: 'compare', op: 'eq', left: prop('query'), right: lit('a') }] })).toEqual({});
    expect(argumentsOf(undefined)).toEqual({});
  });

  it('name the required ones left out', () => {
    expect(missingArguments(SEARCH, {})).toEqual(['query']);
    expect(missingArguments(SEARCH, { query: 'x' })).toEqual([]);
  });
});

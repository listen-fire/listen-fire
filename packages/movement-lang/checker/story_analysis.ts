// The story analysis (crates/movement-checker/src/story.rs), through the
// movement artifact's `story_analysis` export: what the one check walk
// resolved, as data a story projection reads. A scope is an id into
// `scopes`, a symbol an id into `symbols`; spans are the AST's (1-based).
// The diagnostics are the check's own, so one call gives both the verdict
// and the picture.
//
// The envelope and every record's identity (its kind, span and scope) are
// validated here. What a record carries from the AST (a write's fields, a
// walk's steps, a node declaration's tree) is trusted as the Rust's own
// output, as the parser's tree is (parser/rust_parser.ts).

import { callStoryAnalysis } from '../wasm/loader';
import type { CollectionOpExpression, CombinatorKind, ExprSlot, FieldEntry, MembersExpression, ShapeNode, Span } from '../parser/ast';
import type { TraversalStep } from '../expression/types';
import { languageVersionDiagnostic } from '../language_version';
import type { SchemaFieldType } from '../catalog/types';
import type { CatalogSnapshot } from '../service/snapshot';
import type { Diagnostic } from './diagnostic';
import { RustCheckRefused, diagnosticOf, type RustCheckOptions } from './rust_checker';

/** The analysis's shape version this binding writes and reads. */
export const STORY_ANALYSIS_VERSION = 1;

/** Every analysis version this binding reads; any other is refused by name. */
export const SUPPORTED_STORY_ANALYSIS_VERSIONS: readonly number[] = [STORY_ANALYSIS_VERSION];

export interface StoryAnalysis {
  storyAnalysisVersion: number;
  diagnostics: Diagnostic[];
  /** The file's scope is 0. */
  scopes: StoryScope[];
  symbols: StorySymbol[];
  writes: StoryWrite[];
  nodes: StoryNode[];
  bodies: StoryBody[];
  shapes: StoryShape[];
}

/** One scope: the last binding of each name in it, as the walk left it. A
 *  scope with no text of its own has no `span`. */
export interface StoryScope {
  parent?: number;
  span?: Span;
  symbols: Record<string, number>;
}

export type StorySymbolKind =
  | 'adapter'
  | 'credential'
  | 'plugin'
  | 'fileImport'
  | 'binding'
  | 'instance'
  | 'param'
  | 'movement'
  | 'shape'
  | 'alias'
  | 'type';

/** Where a record is: a system's binding name, and its record type where one place holds it. */
export interface StoryAddress {
  instance: string;
  position?: string;
}

/** What a movement may do. `reads` and `writes` name instance bindings;
 *  `partial` is set where a callee or a site could not be placed. */
export interface StoryEffects {
  reads: string[];
  writes: string[];
  ai: boolean;
  now: boolean;
  suspend: boolean;
  partial: boolean;
}

export interface StorySymbol {
  name: string;
  kind: StorySymbolKind;
  span: Span;
  adapter?: string;
  address?: StoryAddress;
  /** The binding holds an extraction's graph; `entity` the node's name, absent at its root. */
  extracted?: { entity?: string };
  /** Movements only. */
  effects?: StoryEffects;
}

export interface StoryWrite {
  span: Span;
  scope: number;
  /** The field lines, spreads written out (a spread's line carries `spread`). */
  fields: FieldEntry[];
  hasUniqueBy: boolean;
  /** `update` is a write to a position; `find` a match. */
  action: 'create' | 'update' | 'find';
  parents: Array<{ edge: string; type?: string }>;
  binding?: string;
  target?: { instance: string; recordType?: string };
}

/** Every node has its `span` and the `scope` it sits in. */
export type StoryNode = { span: Span; scope: number } & (
  | { kind: 'instance'; name: string; adapterType?: string }
  | {
      kind: 'listen';
      instance: string;
      adapterType?: string;
      fires: string;
      firesMovement: boolean;
      events?: string[];
      narrowing: Record<string, string>;
      eventTypes: Array<{ key: string; display?: string }>;
    }
  | { kind: 'link'; from: string; edge: string; to: { kind: 'handle'; name: string } | { kind: 'match'; span: Span } }
  | { kind: 'unlink'; from: string; edge: string; to: { kind: 'handle'; name: string } }
  | { kind: 'await'; binding?: string; source: StoryAwaitedSource }
  | { kind: 'combinator'; combinator: CombinatorKind; binding?: string; arms: Array<{ span: Span; scope?: number }> }
  | {
      kind: 'branch';
      arms: Array<{ span: Span; scope: number; conditionSpan: Span }>;
      otherwise?: { span: Span; scope: number };
    }
  | { kind: 'extract'; binding?: string; node?: StoryExtractNode }
  /** `argParams[i]` is null for an argument past the callee's last parameter. */
  | { kind: 'call'; binding?: string; callee: string; isMovement: boolean; argParams?: Array<string | null> }
  | { kind: 'callReading'; reading: StoryCallReading }
  | (StoryWalk & { kind: 'traversal'; from?: 'graph' | 'result' })
  /** `key` is the walk's comparable token (its root and steps as JSON, keys sorted). */
  | (StoryWalk & { kind: 'valuePath'; key: string })
  | { kind: 'delete'; subject: string }
  | { kind: 'refresh'; subject: string }
);

export type StoryNodeKind = StoryNode['kind'];

/** A walk's root, its hops, and where each hop landed (null where it did not type). */
export interface StoryWalk {
  root?: string;
  steps: TraversalStep[];
  landings: Array<StoryAddress | null>;
}

export type StoryAwaitedSource =
  | { kind: 'traversal'; root?: string; edge?: string; awaitable?: boolean; resolvesEmpty?: boolean }
  | { kind: 'sleep'; duration: string }
  | { kind: 'until'; every?: string };

export type StoryCallReading =
  | { kind: 'value'; expr: ExprSlot }
  | { kind: 'collection'; collection: CollectionOpExpression }
  | { kind: 'members'; members: MembersExpression }
  | { kind: 'refused'; refusal: { code: string; message: string; span: Span } };

/**
 * An extraction's graph: each field's `type` in the author's words, and its
 * `fieldType` as data (a borrowed field path resolved to the type it declares;
 * null where the field has no resolved annotation).
 */
export interface StoryExtractNode {
  name: string;
  fields: Array<{ name: string; at: Span; type?: string; fieldType?: SchemaFieldType | null }>;
  children: StoryExtractNode[];
}

/** A statement list the story caps a lane by, and whether it leaves. */
export interface StoryBody {
  span: Span;
  kind: 'movement' | 'arm' | 'else' | 'combinatorArm' | 'callback';
  terminates: boolean;
}

/** A file-level node declaration, `extends` folded into `root`. */
export interface StoryShape {
  name: string;
  span: Span;
  root: ShapeNode;
}

/**
 * The story analysis of `source` against `snapshot`. A pin this release
 * does not read is its version diagnostic alone, every list empty, the
 * artifact not asked (`refused_story_analysis` in Rust). Throws
 * `RustCheckRefused` for a source that does not parse or a snapshot that
 * does not load, and for an analysis version this binding does not read.
 */
export function storyAnalysisInRust(source: string, snapshot: CatalogSnapshot, options: RustCheckOptions): StoryAnalysis {
  const refusal = languageVersionDiagnostic(options.languageVersion);
  if (refusal !== undefined) {
    return {
      storyAnalysisVersion: STORY_ANALYSIS_VERSION,
      diagnostics: [refusal],
      scopes: [],
      symbols: [],
      writes: [],
      nodes: [],
      bodies: [],
      shapes: [],
    };
  }
  const reply = callStoryAnalysis(
    source,
    JSON.stringify(snapshot),
    options.upgradingFrom === undefined ? {} : { upgradingFrom: options.upgradingFrom },
  );
  const json: unknown = reply.json;
  if (!reply.ok) throw RustCheckRefused.of(json);
  return analysisOf(json);
}

/** `name` from scope `scope`, through the table: the last binding of the
 *  name in the nearest enclosing scope that binds it. */
export function resolveInAnalysis(analysis: StoryAnalysis, scope: number, name: string): StorySymbol | undefined {
  for (let at: number | undefined = scope; at !== undefined; at = analysis.scopes[at]?.parent) {
    const bound = analysis.scopes[at]?.symbols[name];
    if (bound !== undefined) return analysis.symbols[bound];
  }
  return undefined;
}

function analysisOf(json: unknown): StoryAnalysis {
  if (!isRecord(json)) throw malformed('analysis', json);
  const version = json.storyAnalysisVersion;
  if (typeof version !== 'number' || !SUPPORTED_STORY_ANALYSIS_VERSIONS.includes(version)) {
    throw new RustCheckRefused(
      `the story analysis is version ${JSON.stringify(version)}, which this binding does not read (it reads ${SUPPORTED_STORY_ANALYSIS_VERSIONS.join(', ')})`,
    );
  }
  const { diagnostics, scopes, symbols, writes, nodes, bodies, shapes } = json;
  if (
    !Array.isArray(diagnostics) ||
    !Array.isArray(scopes) ||
    !Array.isArray(symbols) ||
    !Array.isArray(writes) ||
    !Array.isArray(nodes) ||
    !Array.isArray(bodies) ||
    !Array.isArray(shapes)
  ) {
    throw malformed('analysis', json);
  }
  return {
    storyAnalysisVersion: version,
    diagnostics: diagnostics.map(diagnosticOf),
    scopes: scopes.map(each(isScope, 'scope')),
    symbols: symbols.map(each(isSymbol, 'symbol')),
    writes: writes.map(each(isWrite, 'write')),
    nodes: nodes.map(each(isNode, 'node')),
    bodies: bodies.map(each(isBody, 'body')),
    shapes: shapes.map(each(isShape, 'shape')),
  };
}

function each<T>(is: (value: unknown) => value is T, what: string): (value: unknown) => T {
  return value => {
    if (!is(value)) throw malformed(what, value);
    return value;
  };
}

const SYMBOL_KINDS: ReadonlySet<string> = new Set<StorySymbolKind>([
  'adapter',
  'credential',
  'plugin',
  'fileImport',
  'binding',
  'instance',
  'param',
  'movement',
  'shape',
  'alias',
  'type',
]);

const NODE_KINDS: ReadonlySet<string> = new Set<StoryNodeKind>([
  'instance',
  'listen',
  'link',
  'unlink',
  'await',
  'combinator',
  'branch',
  'extract',
  'call',
  'callReading',
  'traversal',
  'valuePath',
  'delete',
  'refresh',
]);

const BODY_KINDS: ReadonlySet<string> = new Set<StoryBody['kind']>(['movement', 'arm', 'else', 'combinatorArm', 'callback']);

function isScope(value: unknown): value is StoryScope {
  return (
    isRecord(value) &&
    (value.parent === undefined || isId(value.parent)) &&
    (value.span === undefined || isSpan(value.span)) &&
    isRecord(value.symbols) &&
    Object.values(value.symbols).every(isId)
  );
}

function isSymbol(value: unknown): value is StorySymbol {
  return isRecord(value) && typeof value.name === 'string' && typeof value.kind === 'string' && SYMBOL_KINDS.has(value.kind) && isSpan(value.span);
}

function isWrite(value: unknown): value is StoryWrite {
  return (
    isRecord(value) &&
    isSpan(value.span) &&
    isId(value.scope) &&
    Array.isArray(value.fields) &&
    typeof value.hasUniqueBy === 'boolean' &&
    (value.action === 'create' || value.action === 'update' || value.action === 'find') &&
    Array.isArray(value.parents)
  );
}

function isNode(value: unknown): value is StoryNode {
  return isRecord(value) && typeof value.kind === 'string' && NODE_KINDS.has(value.kind) && isSpan(value.span) && isId(value.scope);
}

function isBody(value: unknown): value is StoryBody {
  return isRecord(value) && isSpan(value.span) && typeof value.kind === 'string' && BODY_KINDS.has(value.kind) && typeof value.terminates === 'boolean';
}

function isShape(value: unknown): value is StoryShape {
  return isRecord(value) && typeof value.name === 'string' && isSpan(value.span) && isRecord(value.root);
}

function isId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isSpan(value: unknown): value is Span {
  return isRecord(value) && isLoc(value.start) && isLoc(value.end);
}

function isLoc(value: unknown): boolean {
  return isRecord(value) && typeof value.line === 'number' && typeof value.col === 'number';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function malformed(what: string, value: unknown): Error {
  return new Error(`the story analysis answered a ${what} that is not one: ${JSON.stringify(value)?.slice(0, 200)}`);
}

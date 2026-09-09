// Expression bridge — movement-language expression slots → the existing
// formula grammar (`packages/shared/expression/formula.ts`).
//
// The movement language does not invent a second expression syntax: every
// value slot is the formula grammar, plus the four deliberate amendments
// from `plans/2026-06-10-data-movement-language/3_syntax_sketch.md`:
//
//   1. `==` for equality — needs nothing here; the formula tokenizer already
//      folds `==` to `=` (formula.ts ~line 1035).
//   2. Plugin references are imported identifiers — a statement-layer /
//      checker concern, nothing for the bridge.
//   3. Double-quoted strings may span newlines and support `${…}`
//      interpolation. The formula tokenizer already tolerates newlines in
//      string literals, but knows nothing of `${…}` — when an expression
//      slot is a single double-quoted string, the bridge owns it: literal
//      parts become `{ type: 'static', value }` nodes, each `${expr}` is
//      parsed by formula `parse()`, and the parts combine into the formula
//      AST's `{ type: 'concat', parts }` node (exactly what
//      `CONCAT("a", b)` parses to).
//   4. `EXTRACT_VALUE` and the `#extract` meta-edge are retired —
//      extraction is a materialisation statement (`extract … { }`), not a
//      traversal. The bridge rejects both wherever they appear outside
//      string/backtick literals.
//
// Additionally, the spec's expression inventory includes prefix
// `EXISTS(<path> [WHERE <expr>])`. The formula AST has the node for it
// (`{ type: 'exists', steps, where? }` — types.ts) and the serializer
// emits that surface form, but the formula *parser* has no entry for it
// (only the postfix `value EXISTS` compare). The bridge fills the gap:
// it lifts each `EXISTS(…)` call out of the raw text, replaces it with a
// placeholder identifier, parses the interior path via a sentinel-property
// probe, and splices the resulting `exists` node back into the parsed AST.
// An alias-rooted path (`rec-[:Company]->`) becomes
// `{ type: 'traverse', aliasRoot, steps: [], expression: <exists> }`,
// since the `exists` node itself carries no root.
//
// Aggregates over bare traversals (M2b): the spec's meta-node reads
// (`COUNT(orgs-[:co]->)`, `FIRST(orgs-[:co]->).`url``) aggregate the
// *positions* a traversal yields, but the formula parser only accepts a
// traversal that terminates in `.property`. The bridge rewrites these at
// the text level before parsing:
//   - `AGG(<bare path>)` → `AGG(<bare path>.`__movement_position__`)` —
//     the exported POSITION_SENTINEL property marks "the positions
//     themselves"; consumers (checker, compiler) treat a terminal
//     POSITION_SENTINEL read as no property read at all.
//   - `AGG(<bare path>).`prop`` → `AGG(<bare path>.`prop`)` — postfix
//     property access on the aggregated position is desugared by moving
//     the property inside the traversal (for FIRST/LAST/COLLECT-style
//     aggregates the two are equivalent: the property of the first
//     position is the first of the property values).
//
// Namespaced stdlib calls (2026-06-11 ruling): `CURRENCY.GET_NUMBER_
// FROM_FIGURE("£1.2m")` parses, unchanged, as an alias-rooted traverse
// whose terminal is a function call — the bridge folds that shape into
// a plain `function` node carrying the dotted id (see ./stdlib.ts and
// `normalizeCalls`). No @listen-fire/shared grammar change. The same walk
// validates the flat FILE(content, "pdf" | "text") artifact built-in.
//
// M1 scope notes (documented limitations, not oversights):
//   - Resolvers are identity (`name => name`): property/edge names pass
//     through as their own ids so parsing succeeds without a catalog. The
//     checker (M2) re-parses with real resolvers.
//   - `${…}` interpolation nested inside a larger expression
//     (e.g. `AI("…${x}…")`, `COALESCE(x, "a ${b}")`) is lifted out and
//     desugared in place — see `liftInterpolatedStrings`.
//   - `IS` type tests are only recognised as top-level conjuncts of a
//     condition; `IS` under OR/NOT (or parenthesised) throws a clear
//     "not yet supported" BridgeError.

import { parse, ParseError, translateStringEscape } from '@listen-fire/shared/expression/formula';
import type { Expression, TraversalStep, MetaEdgeStep } from '@listen-fire/shared/expression/types';
import {
  FILE_FUNCTION_ID,
  FILE_ARTIFACT_TYPES,
  FILE_SIGNATURE,
  describeStdlibFamily,
  listStdlibNamespaces,
  stdlibFamily,
  type StdlibFamily,
} from './stdlib';

export class BridgeError extends Error {
  pos?: number;

  constructor(message: string, pos?: number) {
    super(message);
    this.name = 'BridgeError';
    if (pos !== undefined) this.pos = pos;
  }
}

export type MovementCondition =
  | { kind: 'and'; conjuncts: MovementCondition[] }
  | {
      kind: 'isTest';
      subjectRaw: string;
      /** `position`: the single unpinned hop's name (`<crm-[:company]->>`).
       *  `hopsRaw`: the raw hop text when the marker carries a WHERE — an
       *  event ADDRESS (`<at-[:`Record Change` WHERE `action` == "…"]->>`),
       *  resolved by the checker/engine via `eventAddressOfHops`. Exactly one
       *  of the two is set for a hop-form marker; neither for `<graph>`. */
      type: { graph: string; position?: string; hopsRaw?: string };
    }
  | { kind: 'expr'; expr: Expression };

// ── Literal-aware scanning ──
//
// All structural scanning (splitting on AND, finding IS / EXISTS, rejecting
// retired constructs) must ignore the contents of string literals and
// backtick-quoted names. `blankLiterals` produces a same-length copy of the
// text with every literal span (delimiters included) replaced by spaces, so
// regex matches and bracket-depth counting on the blanked text map directly
// to positions in the original.

function skipBacktick(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === '\\' && i + 1 < text.length) { i += 2; continue; }
    if (text[i] === '`') return i + 1;
    i++;
  }
  throw new BridgeError('Unterminated backtick-quoted name', start);
}

function skipString(text: string, start: number, onInterpolation?: (pos: number) => void): number {
  const quote = text[start];
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\' && i + 1 < text.length) { i += 2; continue; }
    if (quote === '"' && ch === '$' && text[i + 1] === '{') {
      onInterpolation?.(i);
      i = skipInterpolation(text, i + 2);
      continue;
    }
    if (ch === quote) return i + 1;
    i++;
  }
  throw new BridgeError('Unterminated string literal', start);
}

/** `start` is the index just after `${`; returns the index just after the matching `}`. */
function skipInterpolation(text: string, start: number): number {
  let depth = 1;
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") { i = skipString(text, i); continue; }
    if (ch === '`') { i = skipBacktick(text, i); continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  throw new BridgeError('Unterminated ${…} interpolation', start - 2);
}

function blankLiterals(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      const end = skipString(text, i);
      out += ' '.repeat(end - i);
      i = end;
      continue;
    }
    if (ch === '`') {
      const end = skipBacktick(text, i);
      out += ' '.repeat(end - i);
      i = end;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Bracket depth ((), [], {}) at each position of (already-blanked) text. */
function bracketDepths(blanked: string): number[] {
  const depths: number[] = new Array(blanked.length);
  let depth = 0;
  for (let i = 0; i < blanked.length; i++) {
    const ch = blanked[i];
    if (ch === '(' || ch === '[' || ch === '{') { depths[i] = depth; depth++; }
    else if (ch === ')' || ch === ']' || ch === '}') { depth--; depths[i] = depth; }
    else depths[i] = depth;
  }
  return depths;
}

function findMatchingParen(blanked: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < blanked.length; i++) {
    if (blanked[i] === '(') depth++;
    else if (blanked[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new BridgeError('Unbalanced parentheses in EXISTS(…)', openIdx);
}

// ── Amendment 4: retired constructs ──

function rejectRetiredConstructs(raw: string): void {
  const blanked = blankLiterals(raw);

  const extractValue = /\bEXTRACT_VALUE\b/.exec(blanked);
  if (extractValue) {
    throw new BridgeError(
      'EXTRACT_VALUE is retired (syntax amendment 4): extraction is a materialisation — '
        + 'declare the field in an `extract … { }` tree and read it as a plain property',
      extractValue.index,
    );
  }

  const extractEdge = /#extract\b/.exec(blanked);
  if (extractEdge) {
    throw new BridgeError(
      'The #extract meta-edge is retired (syntax amendment 4): extraction is not a traversal — '
        + 'use an `extract … { }` materialisation and traverse its result graph',
      extractEdge.index,
    );
  }
}

// ── Identity resolvers (M1) ──
//
// Discovered shapes (probed against formula.parse, see bridge.unit.test.ts):
//   - resolveProperty: name => name makes a bare/backticked name parse to
//     `{ type: 'property', propertyTypeId: <name> }` (the formula parser
//     throws on unresolved names outside tgMode).
//   - resolveEdge: name => name makes `-[:sender]->` parse to an EdgeStep
//     with `edgeTypeId: 'sender'` (the parser falls back to the raw name
//     anyway, but identity keeps intent explicit).
//   - resolveEdgeWithDirection stays undefined so the arrow syntax alone
//     determines direction (`-[:x]->` outgoing, `<-[:x]-` incoming); an
//     identity implementation would have to guess a direction.
//   - resolveStaticValueId stays undefined so string literals stay verbatim.
//   - tgMode is on: unknown-name fallbacks (alias_ref) never trigger while
//     resolveProperty is total, but tgMode also propagates into bracket
//     WHERE/config sub-parsers, matching how TG expressions parse today.

const identity = (name: string) => name;

function parseFormula(text: string): Expression {
  try {
    return parse(
      text,
      identity, // resolveProperty
      identity, // resolveEdgeProperty
      identity, // resolveEdge
      undefined, // resolveStaticValueId
      undefined, // resolveEdgeWithDirection
      undefined, // allProperties
      undefined, // allEdges
      undefined, // startNodeTypeId
      true, // tgMode
    );
  } catch (e) {
    if (e instanceof ParseError) throw new BridgeError(e.message, e.pos);
    throw e;
  }
}

// ── Prefix EXISTS(…) lifting ──

const EXISTS_PLACEHOLDER_PREFIX = '__movement_exists_';
const EXISTS_PATH_SENTINEL = '__movement_exists_probe__';

function liftExistsCalls(raw: string): { rewritten: string; replacements: Map<string, Expression> } {
  const blanked = blankLiterals(raw);
  const replacements = new Map<string, Expression>();
  const re = /\bEXISTS\s*\(/gi;
  let rewritten = '';
  let cursor = 0;
  let n = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(blanked)) !== null) {
    if (m.index < cursor) continue; // nested call — handled by the recursive interior parse
    const openIdx = m.index + m[0].length - 1;
    const closeIdx = findMatchingParen(blanked, openIdx);
    const interior = raw.slice(openIdx + 1, closeIdx);
    const placeholder = `${EXISTS_PLACEHOLDER_PREFIX}${n++}__`;
    replacements.set(placeholder, parseExistsInterior(interior, openIdx + 1));
    rewritten += raw.slice(cursor, m.index) + placeholder;
    cursor = closeIdx + 1;
    re.lastIndex = cursor;
  }
  rewritten += raw.slice(cursor);
  return { rewritten, replacements };
}

function parseExistsInterior(interior: string, basePos: number): Expression {
  const blanked = blankLiterals(interior);
  const depths = bracketDepths(blanked);

  // Optional top-level WHERE splits path from predicate:
  //   EXISTS(rec-[:Company]-> WHERE name == "Acme")
  let pathText = interior;
  let whereText: string | undefined;
  const whereRe = /\bWHERE\b/gi;
  let w: RegExpExecArray | null;
  while ((w = whereRe.exec(blanked)) !== null) {
    if (depths[w.index] === 0) {
      pathText = interior.slice(0, w.index);
      whereText = interior.slice(w.index + w[0].length);
      break;
    }
  }

  if (!pathText.trim()) {
    throw new BridgeError('EXISTS(…) expects a traversal path', basePos);
  }

  // The formula parser only accepts a traversal that terminates in
  // `.property` — probe with a sentinel property to harvest the steps. A hop
  // WHERE inside the path may itself carry a prefix `EXISTS(…)` (nested quorum
  // form) the formula parser can't read raw, so lift those to placeholders
  // first — the probe only needs the path's step shape.
  const { rewritten: pathRewritten } = liftExistsCalls(pathText.trim());
  const probe = parseFormula(`${pathRewritten}.\`${EXISTS_PATH_SENTINEL}\``);
  if (
    probe.type !== 'traverse'
    || probe.expression.type !== 'property'
    || probe.expression.propertyTypeId !== EXISTS_PATH_SENTINEL
  ) {
    return existsOverAValue(pathText, whereText, basePos);
  }

  const where = whereText !== undefined ? parseMovementExpression(whereText) : undefined;
  const exists: Expression = { type: 'exists', steps: probe.steps, ...(where ? { where } : {}) };

  // `{ type: 'exists' }` carries no root of its own; an alias-rooted path
  // re-roots via a zero-step traverse (the same shape the formula parser
  // emits for dot-chains like `opp.company`).
  if (probe.aliasRoot !== undefined) {
    return { type: 'traverse', aliasRoot: probe.aliasRoot, steps: [], expression: exists };
  }
  return exists;
}

/**
 * `EXISTS(x.`Field`)` — the null-plane question asked of a VALUE rather than a
 * relationship. On the value plane that question already has an answer in the
 * language: `x.`Field` != null`. So this lowers to exactly that comparison
 * rather than minting a second presence mechanism, and the dotted read inherits
 * everything the comparison already earns — narrowing of that property path in
 * the guard's continuation, the constant-test diagnostic, and pushdown (a
 * relationship EXISTS has to run in the app; a field's presence does not).
 *
 * Only a DIRECT read qualifies (`x.`Field``, the shape the bridge folds into an
 * alias-rooted zero-step traverse). A bare name never reaches here — it probes
 * as a rootless path and keeps its existing shape.
 */
function existsOverAValue(
  pathText: string,
  whereText: string | undefined,
  basePos: number,
): Expression {
  const notAPath = 'EXISTS(…) expects a traversal path like -[:edge]-> or alias-[:edge]->, or a property read like x.`Field`';
  if (whereText !== undefined) {
    throw new BridgeError(
      'EXISTS(… WHERE …) needs a traversal path — a value has nothing to filter',
      basePos,
    );
  }
  const read = parseMovementExpression(pathText);
  if (
    read.type !== 'traverse'
    || read.aliasRoot === undefined
    || read.steps.length > 0
    || read.expression.type !== 'property'
  ) {
    throw new BridgeError(notAPath, basePos);
  }
  return { type: 'compare', op: 'neq', left: read, right: { type: 'static', value: null } };
}

// ── Aggregates over bare traversals ──
//
// `COUNT(orgs-[:co]->)` aggregates the positions the traversal yields, and
// `FIRST(orgs-[:co]->).`url`` reads a property of the aggregated position.
// The formula parser accepts neither (a traversal must terminate in
// `.property`), so both are rewritten textually before parsing — see the
// header comment.

/** Terminal property id meaning "the traversed positions themselves" —
 *  spliced in for `AGG(<bare path>)`. A read of this property is not a
 *  property read; the traversal yields its positions. */
export const POSITION_SENTINEL = '__movement_position__';

const AGGREGATE_OPEN_RE = /\b(FIRST|LAST|ONLY|COUNT|SUM|AVG|MIN|MAX|JOIN|COLLECT|SORT|LLM_AGG)\s*\(/;
const BARE_PATH_PROBE = '__movement_bare_path_probe__';

/** True when `text` is a traversal path with no terminal property
 *  (`orgs-[:co]->`, `-[:notes]->`, `rec-[:a]->-[:b]->`). */
function isBareTraversalPath(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  let blanked: string;
  try {
    blanked = blankLiterals(trimmed);
  } catch {
    return false;
  }
  // The root may be backtick-quoted (`` `My Root`-[:co]-> ``); `blankLiterals`
  // turns a backtick span into spaces rather than removing it, so the root
  // alternative here stays bare-identifier-only and the `\s*` is pulled
  // OUTSIDE the optional group to also absorb a blanked-out backtick root's
  // now-blank span before `-[`.
  if (!/^(?:[A-Za-z_][A-Za-z0-9_]*)?\s*-\[/.test(blanked)) return false;
  if (!/\]->$/.test(blanked)) return false;
  try {
    // A hop WHERE may carry a prefix `EXISTS(<path>)` (the quorum idiom
    // `-[x:a WHERE EXISTS(x-[:Response]->)]->`). The formula parser can't read a
    // raw prefix EXISTS, and this probe only needs the path's STEP SHAPE, so
    // lift EXISTS to placeholders first (they parse as ordinary WHERE idents).
    const { rewritten } = liftExistsCalls(trimmed);
    const probe = parseFormula(`${rewritten}.\`${BARE_PATH_PROBE}\``);
    return probe.type === 'traverse' || probe.type === 'resource_traverse';
  } catch {
    return false;
  }
}

/** Rewrites `AGG(<bare path>)` and `AGG(<bare path>).`prop`` (leftmost
 *  aggregate, then recursion over interior and remainder). Returns the
 *  input unchanged when no aggregate call is present. */
function rewriteAggregateBarePaths(raw: string): string {
  const blanked = blankLiterals(raw);
  const m = AGGREGATE_OPEN_RE.exec(blanked);
  if (!m) return raw;
  const openIdx = m.index + m[0].length - 1;
  const closeIdx = findMatchingParen(blanked, openIdx);
  const interior = rewriteAggregateBarePaths(raw.slice(openIdx + 1, closeIdx));
  let after = raw.slice(closeIdx + 1);

  // Isolate the aggregate's first argument (top-level comma).
  const interiorBlanked = blankLiterals(interior);
  const interiorDepths = bracketDepths(interiorBlanked);
  let argEnd = interior.length;
  for (let i = 0; i < interior.length; i++) {
    if (interiorBlanked[i] === ',' && interiorDepths[i] === 0) {
      argEnd = i;
      break;
    }
  }
  let arg0 = interior.slice(0, argEnd);
  const restArgs = interior.slice(argEnd);

  if (isBareTraversalPath(arg0)) {
    const postfixProp = /^\s*\.\s*(`(?:[^`\\\n]|\\.)*`|[A-Za-z_][A-Za-z0-9_]*)/.exec(after);
    if (postfixProp) {
      arg0 = `${arg0.trimEnd()}.${postfixProp[1]}`;
      after = after.slice(postfixProp[0].length);
    } else {
      arg0 = `${arg0.trimEnd()}.\`${POSITION_SENTINEL}\``;
    }
  }
  return `${raw.slice(0, openIdx + 1)}${arg0}${restArgs})${rewriteAggregateBarePaths(after)}`;
}

// ── Placeholder substitution (deep AST rebuild) ──

function substituteInSteps(steps: TraversalStep[], repl: Map<string, Expression>): TraversalStep[] {
  return steps.map(step => {
    if (step.type === 'edge') {
      return step.expressionFilter
        ? { ...step, expressionFilter: substitute(step.expressionFilter, repl) }
        : step;
    }
    if (step.type === 'meta_edge') {
      const out: MetaEdgeStep = { ...step };
      if (out.config) {
        out.config = {
          ...out.config,
          ...(out.config.description ? { description: substitute(out.config.description, repl) } : {}),
          ...(out.config.data ? { data: out.config.data.map(d => substitute(d, repl)) } : {}),
          ...(out.config.plugin ? { plugin: substitute(out.config.plugin, repl) } : {}),
          ...(out.config.enrichWith
            ? {
              enrichWith: out.config.enrichWith.map(e => ({
                transform: substitute(e.transform, repl),
                argument: substitute(e.argument, repl),
              })),
            }
            : {}),
          ...(out.config.extra
            ? {
              extra: Object.fromEntries(
                Object.entries(out.config.extra).map(([k, v]) => [k, substitute(v, repl)]),
              ),
            }
            : {}),
        };
      }
      if (out.expressionFilter) out.expressionFilter = substitute(out.expressionFilter, repl);
      return out;
    }
    return step;
  });
}

function substitute(expr: Expression, repl: Map<string, Expression>): Expression {
  switch (expr.type) {
    // A lifted EXISTS placeholder parses as a property (identity resolver),
    // as an edge_property inside bracket WHERE filters, or as an alias_ref
    // if a future resolver declines the name.
    case 'property':
    case 'edge_property':
      return repl.get(expr.propertyTypeId) ?? expr;
    case 'alias_ref':
      return repl.get(expr.name) ?? expr;
    case 'static':
    case 'meta':
    case 'parent_result':
    case 'action_result':
    case 'resource':
    case 'linked_object':
    case 'extract_value':
      return expr;
    case 'llm':
      return expr.promptExpression
        ? { ...expr, promptExpression: substitute(expr.promptExpression, repl) }
        : expr;
    case 'list':
      return { ...expr, elements: expr.elements.map(e => substitute(e, repl)) };
    case 'object':
      return {
        ...expr,
        entries: expr.entries.map(e => ({ ...e, value: substitute(e.value, repl) })),
      };
    case 'traverse':
      return {
        ...expr,
        steps: substituteInSteps(expr.steps, repl),
        expression: substitute(expr.expression, repl),
      };
    case 'resource_traverse':
      return {
        ...expr,
        ...(expr.expressionFilter ? { expressionFilter: substitute(expr.expressionFilter, repl) } : {}),
        expression: substitute(expr.expression, repl),
      };
    case 'exists':
      return {
        ...expr,
        steps: substituteInSteps(expr.steps, repl),
        ...(expr.where ? { where: substitute(expr.where, repl) } : {}),
      };
    case 'arithmetic':
      return { ...expr, left: substitute(expr.left, repl), right: substitute(expr.right, repl) };
    case 'compare':
      return { ...expr, left: substitute(expr.left, repl), right: substitute(expr.right, repl) };
    case 'logical':
      return { ...expr, operands: expr.operands.map(o => substitute(o, repl)) };
    case 'not':
      return { ...expr, expression: substitute(expr.expression, repl) };
    case 'concat':
      return { ...expr, parts: expr.parts.map(p => substitute(p, repl)) };
    case 'conditional':
      return {
        ...expr,
        condition: substitute(expr.condition, repl),
        then: substitute(expr.then, repl),
        else: substitute(expr.else, repl),
      };
    case 'at':
      return { ...expr, expression: substitute(expr.expression, repl), index: substitute(expr.index, repl) };
    case 'aggregate':
      return { ...expr, expression: substitute(expr.expression, repl) };
    case 'function':
      return { ...expr, args: expr.args.map(a => substitute(a, repl)) };
    case 'kg_exists':
    case 'kg_value':
      return { ...expr, params: expr.params.map(p => substitute(p, repl)) };
  }
}

// ── Namespaced stdlib calls + FILE() (post-parse normalisation) ──
//
// `CURRENCY.GET_NUMBER_FROM_FIGURE("£1.2m")` needs NO grammar change:
// the formula parser already reads `IDENT.IDENT(args)` as an
// alias-rooted traverse (`aliasRoot: 'CURRENCY'`, no steps) whose
// terminal is a function call. This walk folds that shape into a plain
// `{ type: 'function', fn: '<ns>.<name>' }` node when the root names a
// stdlib family (./stdlib.ts), so the checker and the engine see an
// ordinary call — and rejects, with the family's inventory in the
// message, calls into a family that doesn't exist or members a family
// doesn't have. The same walk validates FILE(content, "pdf" | "text"):
// its artifact type is part of the call's static shape, so it is
// checked here, where every consumer (checker, interpretability scan,
// engine) shares the result.

/** The surface name of a call-shaped terminal, when the traverse's
 *  terminal is a call at all (`undefined` for property reads etc.). */
function callTerminalName(expr: Expression): string | undefined {
  switch (expr.type) {
    case 'function':
      return expr.fn.toUpperCase();
    case 'aggregate':
      return expr.fn === 'llm' ? 'LLM_AGG' : expr.fn.toUpperCase();
    case 'llm':
      return 'AI';
    case 'concat':
      return 'CONCAT';
    case 'kg_exists':
      return 'KG_EXISTS';
    case 'kg_value':
      return 'KG_VALUE';
    default:
      return undefined;
  }
}

const NAMESPACE_SHAPED = /^[A-Z][A-Z0-9_]+$/;

function familyInventory(family: StdlibFamily): string {
  return `${family.namespace} provides: ${describeStdlibFamily(family)}`;
}

/** Folds `traverse{aliasRoot: <family>, steps: [], expression: call}`
 *  into the dotted `function` node; errors precisely on unknown family
 *  members and on unknown ALL-CAPS namespaces in call position. */
function foldNamespacedCall(expr: Extract<Expression, { type: 'traverse' }>): Expression {
  if (expr.aliasRoot === undefined || expr.steps.length > 0) return expr;
  const family = stdlibFamily(expr.aliasRoot);
  const callName = callTerminalName(expr.expression);

  if (family) {
    if (callName === undefined) {
      throw new BridgeError(
        `${family.namespace} is a function family, not a position — call one of its functions. ${familyInventory(family)}`,
      );
    }
    const member = family.functions.find((fn) => fn.name === callName);
    if (!member || expr.expression.type !== 'function') {
      throw new BridgeError(
        `${family.namespace} has no function ${callName}() — ${familyInventory(family)}`,
      );
    }
    const args = expr.expression.args;
    if (args.length < member.arity.min || args.length > member.arity.max) {
      const expected =
        member.arity.min === member.arity.max
          ? `${member.arity.min}`
          : `${member.arity.min}–${member.arity.max}`;
      throw new BridgeError(
        `${member.signature} takes ${expected} argument${member.arity.max === 1 ? '' : 's'}, got ${args.length}`,
      );
    }
    return { type: 'function', fn: member.id, args };
  }

  if (callName !== undefined && NAMESPACE_SHAPED.test(expr.aliasRoot)) {
    throw new BridgeError(
      `Unknown function namespace '${expr.aliasRoot}' — the namespaced families are: ${listStdlibNamespaces().join(', ')}`,
    );
  }
  return expr;
}

/** FILE(content, "pdf" | "text") — the artifact type is static call
 *  shape; reject anything else here so every consumer agrees. */
function validateFileCall(expr: Extract<Expression, { type: 'function' }>): void {
  if (expr.fn !== FILE_FUNCTION_ID) return;
  if (expr.args.length !== 2) {
    throw new BridgeError(
      `${FILE_SIGNATURE} takes exactly 2 arguments, got ${expr.args.length} — e.g. FILE(report_text, "pdf")`,
    );
  }
  const typeArg = expr.args[1];
  if (
    typeArg.type !== 'static' ||
    typeof typeArg.value !== 'string' ||
    !(FILE_ARTIFACT_TYPES as readonly string[]).includes(typeArg.value)
  ) {
    throw new BridgeError(
      `FILE()'s second argument is the artifact type — a literal ${FILE_ARTIFACT_TYPES.map((t) => `"${t}"`).join(' or ')}`,
    );
  }
}

function normalizeInSteps(steps: TraversalStep[]): TraversalStep[] {
  return steps.map((step) => {
    if (step.type === 'edge') {
      return step.expressionFilter
        ? { ...step, expressionFilter: normalizeCalls(step.expressionFilter) }
        : step;
    }
    if (step.type === 'meta_edge') {
      const out: MetaEdgeStep = { ...step };
      if (out.config) {
        out.config = {
          ...out.config,
          ...(out.config.description ? { description: normalizeCalls(out.config.description) } : {}),
          ...(out.config.data ? { data: out.config.data.map((d) => normalizeCalls(d)) } : {}),
          ...(out.config.plugin ? { plugin: normalizeCalls(out.config.plugin) } : {}),
          ...(out.config.enrichWith
            ? {
              enrichWith: out.config.enrichWith.map((e) => ({
                transform: normalizeCalls(e.transform),
                argument: normalizeCalls(e.argument),
              })),
            }
            : {}),
          ...(out.config.extra
            ? {
              extra: Object.fromEntries(
                Object.entries(out.config.extra).map(([k, v]) => [k, normalizeCalls(v)]),
              ),
            }
            : {}),
        };
      }
      if (out.expressionFilter) out.expressionFilter = normalizeCalls(out.expressionFilter);
      return out;
    }
    return step;
  });
}

/** Bottom-up over the parsed AST (the same recursion shape as
 *  `substitute`): folds namespaced stdlib calls, validates FILE(). */
function normalizeCalls(expr: Expression): Expression {
  switch (expr.type) {
    case 'property':
    case 'edge_property':
    case 'alias_ref':
    case 'static':
    case 'meta':
    case 'parent_result':
    case 'action_result':
    case 'resource':
    case 'linked_object':
    case 'extract_value':
      return expr;
    case 'llm':
      return expr.promptExpression
        ? { ...expr, promptExpression: normalizeCalls(expr.promptExpression) }
        : expr;
    case 'list':
      return { ...expr, elements: expr.elements.map((e) => normalizeCalls(e)) };
    case 'object':
      return {
        ...expr,
        entries: expr.entries.map((e) => ({ ...e, value: normalizeCalls(e.value) })),
      };
    case 'traverse':
      return foldNamespacedCall({
        ...expr,
        steps: normalizeInSteps(expr.steps),
        expression: normalizeCalls(expr.expression),
      });
    case 'resource_traverse':
      return {
        ...expr,
        ...(expr.expressionFilter ? { expressionFilter: normalizeCalls(expr.expressionFilter) } : {}),
        expression: normalizeCalls(expr.expression),
      };
    case 'exists':
      return {
        ...expr,
        steps: normalizeInSteps(expr.steps),
        ...(expr.where ? { where: normalizeCalls(expr.where) } : {}),
      };
    case 'arithmetic':
      return { ...expr, left: normalizeCalls(expr.left), right: normalizeCalls(expr.right) };
    case 'compare':
      return { ...expr, left: normalizeCalls(expr.left), right: normalizeCalls(expr.right) };
    case 'logical':
      return { ...expr, operands: expr.operands.map((o) => normalizeCalls(o)) };
    case 'not':
      return { ...expr, expression: normalizeCalls(expr.expression) };
    case 'concat':
      return { ...expr, parts: expr.parts.map((p) => normalizeCalls(p)) };
    case 'conditional':
      return {
        ...expr,
        condition: normalizeCalls(expr.condition),
        then: normalizeCalls(expr.then),
        else: normalizeCalls(expr.else),
      };
    case 'at':
      return {
        ...expr,
        expression: normalizeCalls(expr.expression),
        index: normalizeCalls(expr.index),
      };
    case 'aggregate':
      return { ...expr, expression: normalizeCalls(expr.expression) };
    case 'function': {
      const normalized = { ...expr, args: expr.args.map((a) => normalizeCalls(a)) };
      validateFileCall(normalized);
      return normalized;
    }
    case 'kg_exists':
    case 'kg_value':
      return { ...expr, params: expr.params.map((p) => normalizeCalls(p)) };
  }
}

// ── Amendment 3: interpolated / multiline strings ──

/** Returns the index of the opening quote when the raw slot is exactly one
 *  double-quoted string literal (modulo surrounding whitespace), else null. */
function wholeStringSlot(raw: string): number | null {
  let i = 0;
  while (i < raw.length && /\s/.test(raw[i])) i++;
  if (raw[i] !== '"') return null;
  let end: number;
  try {
    end = skipString(raw, i);
  } catch {
    return null; // unterminated — let the formula path report it
  }
  for (let j = end; j < raw.length; j++) {
    if (!/\s/.test(raw[j])) return null;
  }
  return i;
}

function desugarInterpolatedString(raw: string, open: number): Expression {
  const parts: Expression[] = [];
  let literal = '';
  let sawInterpolation = false;
  let i = open + 1;
  while (i < raw.length && raw[i] !== '"') {
    const ch = raw[i];
    // Backslash escapes the next character, exactly as the formula
    // tokenizer does — `\${` stays literal text, `\n` is a newline.
    if (ch === '\\' && i + 1 < raw.length) {
      literal += translateStringEscape(raw[i + 1]);
      i += 2;
      continue;
    }
    if (ch === '$' && raw[i + 1] === '{') {
      const end = skipInterpolation(raw, i + 2);
      const inner = raw.slice(i + 2, end - 1);
      if (!inner.trim()) throw new BridgeError('Empty ${…} interpolation', i);
      if (literal) {
        parts.push({ type: 'static', value: literal });
        literal = '';
      }
      parts.push(parseMovementExpression(inner));
      sawInterpolation = true;
      i = end;
      continue;
    }
    literal += ch;
    i++;
  }
  if (!sawInterpolation) {
    return { type: 'static', value: literal };
  }
  if (literal) parts.push({ type: 'static', value: literal });
  // Mirrors what formula.parse produces for `CONCAT("a", b)`.
  return { type: 'concat', parts };
}

const INTERP_PLACEHOLDER_PREFIX = '__movement_interp_';

/** Lifts every double-quoted literal that carries `${…}` interpolation out of
 *  a larger expression, replacing each with a bare-identifier placeholder and
 *  recording the desugared `concat` for substitution after the formula parses.
 *  Mirrors `liftExistsCalls`: a construct the formula grammar can't express is
 *  parsed here, parked behind a placeholder, and spliced back in. A literal
 *  with no interpolation is left verbatim for the formula tokenizer. */
function liftInterpolatedStrings(raw: string): {
  rewritten: string;
  replacements: Map<string, Expression>;
} {
  const replacements = new Map<string, Expression>();
  let rewritten = '';
  let i = 0;
  let n = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '"') {
      let interpolated = false;
      const end = skipString(raw, i, () => { interpolated = true; });
      if (interpolated) {
        const placeholder = `${INTERP_PLACEHOLDER_PREFIX}${n++}__`;
        replacements.set(placeholder, desugarInterpolatedString(raw.slice(i, end), 0));
        rewritten += placeholder;
      } else {
        rewritten += raw.slice(i, end);
      }
      i = end;
      continue;
    }
    if (ch === "'") { const end = skipString(raw, i); rewritten += raw.slice(i, end); i = end; continue; }
    if (ch === '`') { const end = skipBacktick(raw, i); rewritten += raw.slice(i, end); i = end; continue; }
    rewritten += ch;
    i++;
  }
  return { rewritten, replacements };
}

// ── Public API ──

export function parseMovementExpression(raw: string): Expression {
  rejectRetiredConstructs(raw);

  const open = wholeStringSlot(raw);
  if (open !== null) {
    return desugarInterpolatedString(raw, open);
  }

  const { rewritten: interpRewritten, replacements: interpReplacements } =
    liftInterpolatedStrings(raw);
  const aggregateRewritten = rewriteAggregateBarePaths(interpRewritten);
  const { rewritten, replacements } = liftExistsCalls(aggregateRewritten);
  for (const [placeholder, expr] of interpReplacements) replacements.set(placeholder, expr);
  const parsed = parseFormula(rewritten);
  const substituted = replacements.size > 0 ? substitute(parsed, replacements) : parsed;
  return normalizeCalls(substituted);
}

// ── Conditions (if / WHERE) ──

/** Types always wear angle brackets: `rec IS <crm-[:company]->>`, `rec IS
 *  <crm>`. Both the graph/declared-node name and the position are backtick-
 *  quoted when they carry spaces, so both `rec IS <`Multi Words`>` and an
 *  event-variant like `rec IS <crm-[:`Record Created`]->>` narrow. The
 *  dotted `<crm.company>` spelling is RETIRED (`.` reads a property; an edge
 *  is an address) and errors with the exact replacement. */
const IS_TYPE_PATTERN =
  /^<\s*(`[^`]+`|[A-Za-z_][A-Za-z0-9_]*)(?:-\[\s*:\s*(`[^`]+`|[A-Za-z_][A-Za-z0-9_]*)\s*\]->)?\s*>$/;
const IS_DOTTED_TYPE_PATTERN =
  /^<?\s*(`[^`]+`|[A-Za-z_][A-Za-z0-9_]*)\s*\.\s*(`[^`]+`|[A-Za-z_][A-Za-z0-9_]*)\s*>?$/;
const IS_BARE_TYPE_PATTERN =
  /^(`[^`]+`|[A-Za-z_][A-Za-z0-9_]*)(?:-\[\s*:\s*(`[^`]+`|[A-Za-z_][A-Za-z0-9_]*)\s*\]->)?$/;

/** The interior spelling of a type segment: backticks stripped when quoted. */
function unquoteSegment(segment: string): string {
  return segment.startsWith('`') ? segment.slice(1, -1) : segment;
}

function findWordAtDepth0(blanked: string, depths: number[], word: string): number | null {
  const re = new RegExp(`\\b${word}\\b`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(blanked)) !== null) {
    if (depths[m.index] === 0) return m.index;
  }
  return null;
}

function parseConjunct(text: string, offset: number): MovementCondition {
  const blanked = blankLiterals(text);
  const depths = bracketDepths(blanked);

  const isAnywhere = /\bIS\b/i.exec(blanked);
  if (!isAnywhere) {
    return { kind: 'expr', expr: parseMovementExpression(text) };
  }

  const topLevelIs = findWordAtDepth0(blanked, depths, 'IS');
  const topLevelOr = findWordAtDepth0(blanked, depths, 'OR');
  const topLevelNot = findWordAtDepth0(blanked, depths, 'NOT');
  if (topLevelIs === null || topLevelOr !== null || topLevelNot !== null) {
    throw new BridgeError(
      'IS type tests under OR/NOT (or nested in parentheses) are not yet supported — '
        + 'use IS only as a top-level AND conjunct',
      offset + (topLevelIs ?? isAnywhere.index),
    );
  }

  const subjectRaw = text.slice(0, topLevelIs).trim();
  if (!subjectRaw) {
    throw new BridgeError('IS type test is missing its subject', offset + topLevelIs);
  }
  const rhs = text.slice(topLevelIs + 2).trim();
  const typeMatch = IS_TYPE_PATTERN.exec(rhs);
  if (typeMatch) {
    return {
      kind: 'isTest',
      subjectRaw,
      type: {
        graph: unquoteSegment(typeMatch[1]),
        ...(typeMatch[2] ? { position: unquoteSegment(typeMatch[2]) } : {}),
      },
    };
  }
  // An ADDRESS marker — the hop carries a WHERE (`<at-[:`Record Change` WHERE
  // `action` == "record.deleted"]->>`). The bridge only isolates the raw hop
  // text; the checker/engine read it through the one shared address parser
  // (`eventAddressOfHops`), so the two sides cannot disagree about what it
  // says. Structure over regex: the hop always closes `]->` then the marker's
  // own `>`, and WHERE contents (strings, backticks) never contain an
  // unliteralled close.
  const addressMatch = /^<\s*(`[^`]+`|[A-Za-z_][A-Za-z0-9_]*)\s*(-\[[\s\S]*\]->)\s*>$/.exec(rhs);
  if (addressMatch) {
    return {
      kind: 'isTest',
      subjectRaw,
      type: { graph: unquoteSegment(addressMatch[1]), hopsRaw: addressMatch[2] },
    };
  }
  const dotted = IS_DOTTED_TYPE_PATTERN.exec(rhs);
  if (dotted) {
    throw new BridgeError(
      `'.' reads a property — a type names an EDGE, and an edge is an address. Write '<${dotted[1]}-[:${dotted[2]}]->>' instead of '<${dotted[1]}.${dotted[2]}>'.`,
      offset + topLevelIs + 2,
    );
  }
  const bare = IS_BARE_TYPE_PATTERN.exec(rhs);
  if (bare) {
    throw new BridgeError(
      `Types are written in angle brackets — wrap the type in angle brackets: <${rhs}>`,
      offset + topLevelIs + 2,
    );
  }
  throw new BridgeError(
    `IS expects a position type in angle brackets like <graph> or <graph-[:position]->>, got "${rhs}"`,
    offset + topLevelIs + 2,
  );
}

export function parseMovementCondition(raw: string): MovementCondition {
  const blanked = blankLiterals(raw);
  const depths = bracketDepths(blanked);

  // Split on top-level AND — outside literals, outside any bracket.
  const spans: { start: number; end: number }[] = [];
  const re = /\bAND\b/gi;
  let start = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(blanked)) !== null) {
    if (depths[m.index] !== 0) continue;
    spans.push({ start, end: m.index });
    start = m.index + m[0].length;
  }
  spans.push({ start, end: raw.length });

  const conjuncts = spans.map(span => {
    const text = raw.slice(span.start, span.end);
    if (!text.trim()) {
      throw new BridgeError('Empty conjunct around AND', span.start);
    }
    return parseConjunct(text, span.start);
  });

  return conjuncts.length === 1 ? conjuncts[0] : { kind: 'and', conjuncts };
}

/** One top-level conjunct of a `unique by (…)` predicate, with its FUZZY
 *  modifier lifted off. */
export interface UniquenessConjunct {
  /** The conjunct's expression text, FUZZY modifier removed, trimmed. */
  raw: string;
  /** Char offset of `raw` within the original predicate (for diagnostics). */
  offset: number;
  /** True when the conjunct was prefixed with the FUZZY modifier. */
  fuzzy: boolean;
}

/** A leading `FUZZY` modifier on a uniqueness component — uppercase, like the
 *  AND/OR keywords, so a field literally named `fuzzy` is never mistaken for it. */
const FUZZY_MODIFIER = /^\s*FUZZY\b\s*/;

/**
 * Split a `unique by (…)` predicate into its components on the top-level COMMA,
 * lifting a leading `FUZZY` modifier off each. Comma is the component separator
 * (clearer than `AND`, which is *also* an expression operator); `AND` still
 * works inside a single component as an ordinary conjunction (the engine and
 * checker flatten it). FUZZY is a uniqueness-local marker — "match this
 * component by similarity, surfacing close candidates for the engine to
 * arbitrate" — not a general expression operator (it would be meaningless in a
 * WHERE filter), so it is stripped here before the remainder is parsed as an
 * ordinary movement expression. Literals and brackets are blanked so a comma
 * inside a string, a `[:edge]` hop, or a `WITHIN(7, days)` call never splits.
 */
export function splitUniquenessConjuncts(raw: string): UniquenessConjunct[] {
  const blanked = blankLiterals(raw);
  const depths = bracketDepths(blanked);

  const spans: { start: number; end: number }[] = [];
  let start = 0;
  for (let i = 0; i < blanked.length; i++) {
    if (blanked[i] === ',' && depths[i] === 0) {
      spans.push({ start, end: i });
      start = i + 1;
    }
  }
  spans.push({ start, end: raw.length });

  return spans.map((span) => {
    const text = raw.slice(span.start, span.end);
    const fuzzyMatch = FUZZY_MODIFIER.exec(text);
    if (fuzzyMatch !== null) {
      const rest = text.slice(fuzzyMatch[0].length);
      return { raw: rest.trim(), offset: span.start + fuzzyMatch[0].length, fuzzy: true };
    }
    const lead = text.length - text.trimStart().length;
    return { raw: text.trim(), offset: span.start + lead, fuzzy: false };
  });
}

// Lowering: the movement expression tree (./tree.ts) → the shared `Expression`
// (packages/shared/expression/types.ts), producing exactly what the bridge
// (expression/bridge.ts) produces today. This is where a NAME first means
// something: `COUNT` becomes an aggregate, `AI` an llm node, `EXISTS` a
// quantifier, `CURRENCY.PARSE` a stdlib function — the decisions the formula
// grammar's `parseFunctionCall` and the bridge's text rewrites make today.
//
// Each rule the bridge implements by rewriting text before parsing is written
// here as a rule over the tree, with a comment naming the rewrite it replaces.
// Where the bridge's behaviour depends on something a tree has no word for
// (the letter case of an aggregate's name, whether a path is the WHOLE slot),
// the rule says so — those are the places one grammar needs a decision.
//
// Step 1 of plans/functional-extract-2026-10-02/2_one_grammar.md: nothing
// calls this outside the differential test.

import type {
  EdgeStep,
  EnrichWithEntry,
  Expression,
  ListElement,
  MetaEdgeStep,
  TraversalStep,
} from '@listen-fire/shared/expression/types';
import { AI_TIERS } from '@listen-fire/shared/expression/types';
import {
  POSITION_SENTINEL,
  validateBuiltinCallShape,
  type MovementCondition,
} from '../../expression/bridge';
import { describeStdlibFamily, listStdlibNamespaces, stdlibFamily } from '../../expression/stdlib';
import { neverAsAny } from '../../never';
import type { BinaryOp, CallArg, Hop, MExpr, Name, TypeExpr } from './tree';
import { parseExpression } from './parse_expression';

export class LoweringError extends Error {
  constructor(
    message: string,
    /** The diagnostic code the bridge gives the same refusal, when it has one. */
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'LoweringError';
  }
}

/** Where a name is read. Inside a hop's WHERE a bare name is a property of
 *  the EDGE's landing (`edge_property`) — the formula grammar's edge-property
 *  mode, which everything nested in that WHERE inherits. */
interface Ctx {
  edgeProps: boolean;
}

const TOP: Ctx = { edgeProps: false };

/** Parse and lower one expression slot — the new path's `parseMovementExpression`. */
export function lowerMovementExpression(raw: string): Expression {
  return new Lowering(raw).top(parseExpression(raw));
}

/** Parse and lower one condition slot — the new path's `parseMovementCondition`. */
export function lowerMovementCondition(raw: string): MovementCondition {
  return new Lowering(raw).condition(parseExpression(raw));
}

const AGG_FNS: Record<string, Extract<Expression, { type: 'aggregate' }>['fn']> = {
  FIRST: 'first', LAST: 'last', ONLY: 'only', COUNT: 'count', SUM: 'sum', AVG: 'avg',
  MIN: 'min', MAX: 'max', JOIN: 'join', COLLECT: 'collect', LLM_AGG: 'llm',
};

/**
 * The aggregates whose first argument may be a bare walk (`COUNT(orgs-[:co]->)`
 * counts the landings). The bridge finds these by a CASE-SENSITIVE regex over
 * the text, so `count(orgs-[:co]->)` is refused while `count(orgs.x)` is an
 * aggregate: the rule is reproduced as written (upper-case, unquoted callee).
 */
const BARE_PATH_AGGREGATES = new Set([
  'FIRST', 'LAST', 'ONLY', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'JOIN', 'COLLECT', 'SORT', 'LLM_AGG',
]);

type ResourceField = Extract<Expression, { type: 'resource' }>['field'];
const RESOURCE_TERMINALS: ReadonlyArray<ResourceField> = ['name', 'url', 'type', 'document_url', 'content'];
const resourceTerminal = (name: string): ResourceField | undefined => RESOURCE_TERMINALS.find(f => f === name);
const RESOURCE_WHERE_FIELDS: Record<string, 'name' | 'url' | 'type' | 'document_url' | 'content' | 'contentType'> = {
  type: 'type',
  resourcetype: 'type',
  name: 'name',
  url: 'url',
  content: 'content',
  document_url: 'document_url',
  contenttype: 'contentType',
  mimetype: 'contentType',
};
const RESOURCE_TYPES = new Set(['URL', 'EMAIL', 'WHATSAPP', 'FILE', 'TEXT']);
const NAMESPACE_SHAPED = /^[A-Z][A-Z0-9_]+$/;

type Segment =
  | { kind: 'member'; name: Name }
  | { kind: 'call'; args: CallArg[] }
  | { kind: 'hops'; hops: Hop[] };

class Lowering {
  constructor(private readonly source: string) {}

  // ── Whole slots ──

  /**
   * A whole slot. The one rule that depends on being the WHOLE slot: a bare
   * walk (`c-[m:Messages]->`) is its landings — the bridge appends the
   * position sentinel when the entire text is a path, and refuses one written
   * anywhere else that is not an aggregate's first argument.
   */
  top(expr: MExpr): Expression {
    if (this.isBareWalk(expr)) return this.lower(this.positions(expr), TOP);
    return this.lower(expr, TOP);
  }

  condition(expr: MExpr): MovementCondition {
    const conjuncts: MExpr[] = [];
    const split = (e: MExpr): void => {
      if (e.kind === 'binary' && e.op === 'and') {
        split(e.left);
        split(e.right);
      } else conjuncts.push(e);
    };
    split(expr);
    const lowered = conjuncts.map(c => this.conjunct(c));
    return lowered.length === 1 ? lowered[0] : { kind: 'and', conjuncts: lowered };
  }

  private conjunct(expr: MExpr): MovementCondition {
    if (expr.kind === 'is') {
      return {
        kind: 'isTest',
        subjectRaw: this.source.slice(expr.subject.at.start, expr.subject.at.end).trim(),
        type: this.isType(expr.type),
      };
    }
    if (containsIs(expr)) {
      throw new LoweringError(
        'IS type tests under OR/NOT (or nested in parentheses) are not yet supported — use IS only as a top-level AND conjunct',
      );
    }
    return { kind: 'expr', expr: this.top(expr) };
  }

  /** The bridge's IS marker: `<graph>`, `<graph-[:position]->>` (one plain hop),
   *  or an ADDRESS kept as its raw hop text for `eventAddressOfHops`. */
  private isType(type: TypeExpr): Extract<MovementCondition, { kind: 'isTest' }>['type'] {
    if (type.kind !== 'named' || type.array || type.field !== undefined) {
      throw new LoweringError('IS expects a position type in angle brackets like <graph> or <graph-[:position]->>');
    }
    const graph = type.name.text;
    if (type.hops.length === 0) return { graph };
    const first = type.hops[0];
    const last = type.hops[type.hops.length - 1];
    if (first.direction !== 'out' || last.arrow !== '->') {
      throw new LoweringError('IS expects a position type in angle brackets like <graph> or <graph-[:position]->>');
    }
    const plain =
      type.hops.length === 1 &&
      first.alias === undefined &&
      first.where === undefined &&
      first.config === undefined &&
      first.orderBy === undefined &&
      first.limit === undefined &&
      (first.label.quoted || /^[A-Za-z_][A-Za-z0-9_]*$/.test(first.label.text));
    if (plain) return { graph, position: first.label.text };
    return { graph, hopsRaw: this.source.slice(first.at.start, last.at.end) };
  }

  // ── Expressions ──

  private lower(expr: MExpr, ctx: Ctx): Expression {
    switch (expr.kind) {
      case 'literal':
        return { type: 'static', value: expr.value };
      case 'string':
        return this.string(expr);
      case 'name':
        return this.leaf(expr.name, ctx);
      case 'special': {
        const v = expr.text.slice(1);
        // The formula grammar carries these fields unchecked; mirrored as-is.
        if (v.startsWith('parent.')) return { type: 'parent_result', field: v.slice(7) as 'created' | 'external_id' };
        if (v.startsWith('resource.')) return { type: 'resource', field: v.slice(9) as ResourceField };
        return { type: 'meta', key: v };
      }
      case 'paren':
        return this.lower(expr.expr, ctx);
      case 'list':
        return {
          type: 'list',
          elements: expr.elements.map((e): ListElement =>
            e.kind === 'spread' ? { type: 'spread', expression: this.lower(e.expr, ctx) } : this.lower(e, ctx),
          ),
        };
      case 'map':
        return {
          type: 'object',
          entries: expr.entries.map(e => ({ key: e.key.text, value: this.lower(e.value, ctx) })),
        };
      case 'member':
      case 'call':
      case 'path':
        return this.chain(expr, ctx);
      case 'index':
        throw new LoweringError('an index read `x[i]` is written AT(x, i)');
      case 'unary':
        return expr.op === 'not'
          ? { type: 'not', expression: this.lower(expr.operand, ctx) }
          : { type: 'negate', expression: this.lower(expr.operand, ctx) };
      case 'binary':
        return this.binary(expr, ctx);
      case 'exists':
        return { type: 'compare', op: 'exists', left: this.lower(expr.operand, ctx), right: { type: 'static', value: true } };
      case 'within': {
        const d = expr.duration;
        const value = d.quoted ? d.text : `${d.text.slice(0, -1)}${d.text.slice(-1).toLowerCase()}`;
        return { type: 'compare', op: 'within', left: this.lower(expr.operand, ctx), right: { type: 'static', value } };
      }
      case 'where':
        throw new LoweringError('WHERE filters a walk inside EXISTS(…) or a hop — it is not a value on its own');
      case 'is':
        throw new LoweringError('IS type tests are only recognised as top-level conjuncts of a condition');
      case 'if':
        return {
          type: 'conditional',
          condition: this.lower(expr.condition, ctx),
          then: this.lower(expr.then, ctx),
          else: expr.else ? this.lower(expr.else, ctx) : { type: 'static', value: '' },
        };
      case 'closure':
        throw new LoweringError(
          'a closure cannot be written here — bind it to a name first and pass the name',
          'MOV_EXPR_CLOSURE_POSITION',
        );
      case 'type':
      case 'node':
      case 'graph':
      case 'declaration':
      case 'mapped':
      case 'lazy':
        throw new LoweringError(`a ${expr.kind} is not a value the shared expression tree can hold`);
      default:
        return neverAsAny(expr);
    }
  }

  /** A quoted string: a literal, or — with `${…}` — a concat whose holes are
   *  each a WHOLE slot of their own (the bridge parses each one afresh). */
  private string(expr: Extract<MExpr, { kind: 'string' }>): Expression {
    if (expr.parts.every(p => typeof p === 'string')) return { type: 'static', value: expr.parts.join('') };
    return {
      type: 'concat',
      parts: expr.parts
        .filter(p => p !== '')
        .map(p => (typeof p === 'string' ? { type: 'static', value: p } : this.top(p))),
    };
  }

  private leaf(name: Name, ctx: Ctx): Expression {
    this.refuseRetired(name);
    return { type: ctx.edgeProps ? 'edge_property' : 'property', propertyTypeId: name.text };
  }

  private refuseRetired(name: Name): void {
    if (!name.quoted && name.text === 'EXTRACT_VALUE') {
      throw new LoweringError(
        'EXTRACT_VALUE is retired (syntax amendment 4): extraction is a materialisation — declare the field in an `extract … { }` tree and read it as a plain property',
      );
    }
  }

  private binary(expr: Extract<MExpr, { kind: 'binary' }>, ctx: Ctx): Expression {
    return combine(expr.op, this.lower(expr.left, ctx), this.lower(expr.right, ctx));
  }

  // ── Chains: names, members, calls, walks ──
  //
  // The tree is left-nested, as postfix syntax is (`a.b.c` = member(member(a,
  // b), c)). The formula grammar's tree is right-nested from each root
  // (`traverse{a, expression: traverse{b, expression: c}}`), so a chain is
  // flattened to its segments and rebuilt from the left.

  private chain(expr: MExpr, ctx: Ctx): Expression {
    const segments: Segment[] = [];
    let head: MExpr | undefined = expr;
    for (;;) {
      if (head === undefined) break;
      if (head.kind === 'member') {
        segments.unshift({ kind: 'member', name: head.property });
        head = head.object;
      } else if (head.kind === 'call') {
        segments.unshift({ kind: 'call', args: head.args });
        head = head.callee;
      } else if (head.kind === 'path') {
        segments.unshift({ kind: 'hops', hops: head.hops });
        head = head.root;
      } else break;
    }
    if (head === undefined) {
      const [first, ...rest] = segments;
      if (first?.kind !== 'hops') throw new LoweringError('a walk starts at a name or at a hop');
      return this.traversal(undefined, first.hops, rest, ctx);
    }
    if (head.kind !== 'name') {
      throw new LoweringError(`'.', a call or a hop can only follow a name — not a ${head.kind}`);
    }
    return this.fromName(head.name, segments, ctx, false);
  }

  /** `scoped`: this name is the member of a dot-chain (`DATETIME.AT(…)`), so a
   *  call here is named inside its root and is none of the bare built-ins. */
  private fromName(name: Name, segments: Segment[], ctx: Ctx, scoped: boolean): Expression {
    const [first, ...rest] = segments;
    if (first === undefined) return this.leaf(name, ctx);
    switch (first.kind) {
      case 'call': {
        const { expression, consumed } = this.call(name, first.args, rest, ctx, scoped);
        if (rest.length > consumed) {
          throw new LoweringError(`Unexpected '.' after the call ${name.text}(…)`);
        }
        return expression;
      }
      case 'member':
        if (name.text.toLowerCase() === 'edge') {
          if (rest.length > 0) throw new LoweringError("edge.<property> reads one property of the walked edge");
          return { type: 'edge_property', propertyTypeId: first.name.text };
        }
        return this.foldNamespace({
          type: 'traverse',
          aliasRoot: name.text,
          steps: [],
          expression: this.fromName(first.name, rest, ctx, true),
        });
      case 'hops':
        return this.traversal(name.text, first.hops, rest, ctx);
      default:
        return neverAsAny(first);
    }
  }

  /** A walk, then the `.terminal` the formula grammar requires after it. */
  private traversal(aliasRoot: string | undefined, hops: Hop[], rest: Segment[], ctx: Ctx): Expression {
    const steps: TraversalStep[] = [];
    for (let i = 0; i < hops.length; i++) {
      const hop = hops[i];
      const label = hop.label.text;
      if (label === '#extract') {
        throw new LoweringError(
          'The #extract meta-edge is retired (syntax amendment 4): extraction is not a traversal — use an `extract … { }` materialisation and traverse its result graph',
        );
      }
      if (label === '#transform') {
        const config = hop.config ? this.metaConfig(hop.config, ctx) : undefined;
        const step: MetaEdgeStep = {
          type: 'meta_edge',
          metaEdge: 'transform',
          ...(hop.alias ? { alias: hop.alias.text } : {}),
          ...(config ? { config } : {}),
        };
        steps.push(step);
        continue;
      }
      const base = label.split(/[:\s]/, 1)[0];
      if (base === '_resources' || base === '#resources' || label === '#linked') {
        if (i !== hops.length - 1) throw new LoweringError(`a hop cannot follow -[:${label}]->`);
        const inner = base === '#linked' || label === '#linked'
          ? this.linked(hop, rest)
          : this.resources(hop, rest, ctx);
        // The formula grammar drops the root of a walk that ends in a
        // resource or linked hop — reproduced, not endorsed.
        return steps.length > 0 ? { type: 'traverse', steps, expression: inner } : inner;
      }
      steps.push(this.edgeStep(hop, ctx));
    }
    const [terminal, ...after] = rest;
    if (terminal === undefined) {
      throw new LoweringError("a walk written as a value needs a '.property' after it, or to be the whole slot");
    }
    if (terminal.kind !== 'member') throw new LoweringError("Expected '.' after the walk");
    return {
      type: 'traverse',
      ...(aliasRoot !== undefined ? { aliasRoot } : {}),
      steps,
      expression: this.fromName(terminal.name, after, ctx, false),
    };
  }

  private edgeStep(hop: Hop, ctx: Ctx): EdgeStep {
    if (hop.direction === 'in' && hop.alias !== undefined) {
      throw new LoweringError('an incoming hop takes no alias (`<-[:edge]-`)');
    }
    const step: EdgeStep = {
      type: 'edge',
      edgeTypeId: hop.label.text,
      direction: hop.direction === 'in' ? 'incoming' : 'outgoing',
      ...(hop.alias ? { alias: hop.alias.text } : {}),
    };
    if (hop.orderBy !== undefined || hop.limit !== undefined) {
      step.cardinality = {
        mode: hop.limit !== undefined ? 'n' : 'all',
        ...(hop.limit !== undefined ? { limit: hop.limit } : {}),
        ...(hop.orderBy !== undefined
          ? { orderBy: this.lower(hop.orderBy.key, ctx), orderDirection: hop.orderBy.direction ?? 'asc' }
          : {}),
      };
    }
    if (hop.where !== undefined) step.expressionFilter = this.lower(hop.where, { edgeProps: true });
    // A config `{ … }` on a plain edge hop is dropped by the formula grammar.
    return step;
  }

  private resources(hop: Hop, rest: Segment[], ctx: Ctx): Expression {
    const colon = hop.label.text.indexOf(':');
    const typeVal = colon === -1 ? undefined : hop.label.text.slice(colon + 1).trim().toUpperCase();
    const shorthand: Expression | undefined =
      typeVal !== undefined && RESOURCE_TYPES.has(typeVal)
        ? { type: 'compare', op: 'eq', left: { type: 'resource', field: 'type' }, right: { type: 'static', value: typeVal } }
        : undefined;
    const where = hop.where !== undefined ? this.resourcePredicate(hop.where) : undefined;
    const expressionFilter: Expression | undefined =
      shorthand && where ? { type: 'logical', op: 'and', operands: [shorthand, where] } : (shorthand ?? where);
    const [terminal, ...after] = rest;
    if (terminal?.kind !== 'member') throw new LoweringError("Expected '.' after the resource hop");
    let expression: Expression;
    const field = resourceTerminal(terminal.name.text);
    if (field !== undefined) {
      if (after.length > 0) throw new LoweringError(`Unexpected '.' after the resource field ${terminal.name.text}`);
      expression = { type: 'resource', field };
    } else {
      expression = this.fromName(terminal.name, after, ctx, false);
    }
    return { type: 'resource_traverse', ...(expressionFilter ? { expressionFilter } : {}), expression };
  }

  /** A `_resources` WHERE reads resource fields only. */
  private resourcePredicate(expr: MExpr): Expression {
    switch (expr.kind) {
      case 'name': {
        const field = RESOURCE_WHERE_FIELDS[expr.name.text.toLowerCase()];
        if (field === undefined) throw new LoweringError(`Unknown property: ${expr.name.text}`);
        return { type: 'resource', field };
      }
      case 'literal':
      case 'string':
      case 'special':
        return this.lower(expr, TOP);
      case 'paren':
        return this.resourcePredicate(expr.expr);
      case 'binary': {
        if (expr.op === '+' || expr.op === '-' || expr.op === '*' || expr.op === '/' || expr.op === '%') {
          throw new LoweringError("a _resources WHERE compares resource fields — 'arithmetic' is not supported here");
        }
        return combine(expr.op, this.resourcePredicate(expr.left), this.resourcePredicate(expr.right));
      }
      case 'unary':
        return expr.op === 'not'
          ? { type: 'not', expression: this.resourcePredicate(expr.operand) }
          : { type: 'negate', expression: this.resourcePredicate(expr.operand) };
      case 'list':
        return {
          type: 'list',
          elements: expr.elements.map((e): ListElement =>
            e.kind === 'spread' ? { type: 'spread', expression: this.resourcePredicate(e.expr) } : this.resourcePredicate(e),
          ),
        };
      case 'exists':
        return { type: 'compare', op: 'exists', left: this.resourcePredicate(expr.operand), right: { type: 'static', value: true } };
      default:
        throw new LoweringError(`a _resources WHERE compares resource fields — '${expr.kind}' is not supported here`);
    }
  }

  /** `-[#linked WHERE type = "ATTIO"]->.field` — legacy. The adapter is read
   *  off the WHERE's SOURCE TEXT by the formula grammar's regex, so this
   *  needs the text: the one rule here a tree cannot express. */
  private linked(hop: Hop, rest: Segment[]): Expression {
    const whereText = hop.where ? this.source.slice(hop.where.at.start, hop.where.at.end) : '';
    const match = whereText.match(/type\s*=\s*"([^"]*)"/i)
      ?? whereText.match(/type\s*=\s*'([^']*)'/i)
      ?? whereText.match(/type\s*=\s*(\S+)/i);
    const adapter = match?.[1]?.toUpperCase() ?? '';
    const [terminal, ...after] = rest;
    if (terminal?.kind !== 'member' || after.length > 0) throw new LoweringError('Expected field name after -[#linked...]->.');
    return { type: 'linked_object', adapter, field: terminal.name.text };
  }

  private metaConfig(config: Extract<MExpr, { kind: 'map' }>, ctx: Ctx): MetaEdgeStep['config'] | undefined {
    const cfg: NonNullable<MetaEdgeStep['config']> = {};
    for (const entry of config.entries) {
      const key = entry.key.text;
      if (key === 'enrich_with') {
        if (entry.value.kind !== 'list') throw new LoweringError('enrich_with: expects a list literal');
        cfg.enrichWith = entry.value.elements.map((e): EnrichWithEntry => {
          if (e.kind !== 'map') throw new LoweringError('enrich_with: each entry must be an object literal');
          const transform = e.entries.find(x => x.key.text === 'transform');
          const argument = e.entries.find(x => x.key.text === 'argument');
          if (!transform || !argument || e.entries.length !== 2) {
            throw new LoweringError('enrich_with entry: requires exactly "transform" and "argument"');
          }
          return { transform: this.lower(transform.value, ctx), argument: this.lower(argument.value, ctx) };
        });
        continue;
      }
      const value = this.lower(entry.value, ctx);
      if (key === 'description') cfg.description = value;
      else if (key === 'data') {
        if (value.type !== 'list') throw new LoweringError('data: expects a list literal [expr, expr, ...]');
        cfg.data = value.elements.map(e => {
          if (e.type === 'spread') throw new LoweringError("data: lists its values one by one — a spread ('...') is not accepted here");
          return e;
        });
      } else if (key === 'plugin') cfg.plugin = value;
      else {
        cfg.extra = cfg.extra ?? {};
        cfg.extra[key] = value;
      }
    }
    return Object.keys(cfg).length === 0 ? undefined : cfg;
  }

  // ── Calls: where a name becomes a built-in ──

  /** `consumed`: how many of the segments AFTER the call it absorbed (the
   *  aggregate's postfix property). */
  private call(
    name: Name,
    args: CallArg[],
    after: Segment[],
    ctx: Ctx,
    scoped: boolean,
  ): { expression: Expression; consumed: number } {
    this.refuseRetired(name);
    const named = args.find(a => a.name !== undefined);
    if (named) throw new LoweringError(`a named argument (${named.name?.text}: …) is a movement call's, not an expression's`);
    const upper = name.text.toUpperCase();

    // `EXISTS(…)` — the bridge lifts every one out of the text (in any letter
    // case) and parses its interior itself. Here it is a call like any other,
    // resolved by name.
    if (!name.quoted && upper === 'EXISTS' && !scoped) return { expression: this.exists(args), consumed: 0 };

    // `AGG(<bare walk>)` counts the landings; `AGG(<bare walk>).prop` reads a
    // property of them — the bridge's text rewrite moves `.prop` inside.
    let values = args.map(a => a.value);
    let consumed = 0;
    if (!name.quoted && BARE_PATH_AGGREGATES.has(name.text) && values.length > 0 && this.isBareWalk(values[0])) {
      const next = after[0];
      if (next?.kind === 'member') {
        values = [this.member(values[0], next.name), ...values.slice(1)];
        consumed = 1;
      } else {
        values = [this.positions(values[0]), ...values.slice(1)];
      }
    }

    if (scoped) {
      const fn: Expression = { type: 'function', fn: upper.toLowerCase(), args: values.map(v => this.lower(v, ctx)) };
      validateBuiltinCallShape(fn);
      return { expression: fn, consumed };
    }
    if (upper === 'SORT') return { expression: this.sort(values, ctx), consumed };
    const lowered = values.map(v => this.lower(v, ctx));
    return { expression: this.builtin(upper, lowered), consumed };
  }

  private builtin(upper: string, args: Expression[]): Expression {
    const agg = AGG_FNS[upper];
    if (agg !== undefined) {
      const sep = args[1];
      return {
        type: 'aggregate',
        fn: agg,
        expression: args[0] ?? { type: 'static', value: '' },
        ...(sep?.type === 'static' && typeof sep.value === 'string' ? { separator: sep.value } : {}),
      };
    }
    switch (upper) {
      case 'AI': {
        if (args.length > 2) throw new LoweringError(`AI takes at most 2 arguments (prompt, tier), got ${args.length}`);
        let tier: string | undefined;
        if (args.length === 2) {
          const t = args[1];
          if (t.type !== 'static' || typeof t.value !== 'string') {
            throw new LoweringError(
              `AI's second argument is the tier — ${AI_TIERS.map(x => `"${x}"`).join(', ')} — written down in place`,
            );
          }
          tier = t.value;
        }
        const prompt = args[0];
        if (prompt?.type === 'static' && typeof prompt.value === 'string') {
          return { type: 'llm', prompt: prompt.value, ...(tier !== undefined ? { tier } : {}) };
        }
        return { type: 'llm', prompt: '', promptExpression: prompt, ...(tier !== undefined ? { tier } : {}) };
      }
      case 'CONCAT':
        return { type: 'concat', parts: args };
      case 'KG_EXISTS':
      case 'KG_VALUE': {
        const q = args[0];
        return {
          type: upper === 'KG_EXISTS' ? 'kg_exists' : 'kg_value',
          query: q && q.type === 'static' && typeof q.value === 'string' ? q.value : '',
          params: args.slice(1),
        };
      }
      case 'AT':
        if (args.length !== 2) throw new LoweringError(`AT takes exactly 2 arguments (AT(list, index)), got ${args.length}`);
        return { type: 'at', expression: args[0], index: args[1] };
      default: {
        const fn: Extract<Expression, { type: 'function' }> = { type: 'function', fn: upper.toLowerCase(), args };
        validateBuiltinCallShape(fn);
        return fn;
      }
    }
  }

  /** SORT(collection[, key][, ASC|DESC]) — a bare ASC/DESC in the LAST slot
   *  is the direction, not a field of that name. */
  private sort(values: MExpr[], ctx: Ctx): Expression {
    if (values.length === 0) throw new LoweringError('SORT orders a collection');
    const [source, ...rest] = values;
    let direction: 'asc' | 'desc' | undefined;
    const last = rest[rest.length - 1];
    if (last?.kind === 'name' && /^(ASC|DESC)$/i.test(last.name.text)) {
      direction = last.name.text.toUpperCase() === 'DESC' ? 'desc' : 'asc';
      rest.pop();
    }
    if (rest.length > 1) throw new LoweringError('SORT takes a collection, a key and a direction');
    return {
      type: 'aggregate',
      fn: 'sort',
      expression: this.lower(source, ctx),
      ...(rest[0] !== undefined ? { orderBy: this.lower(rest[0], ctx) } : {}),
      orderDirection: direction ?? 'asc',
    };
  }

  /**
   * `EXISTS(walk [WHERE predicate])` — true when the walk lands anywhere (that
   * the predicate holds). The interior is read afresh, whatever surrounds the
   * call: the bridge parses it out of the text as a slot of its own, so a
   * name in its predicate is never an edge property of an enclosing hop.
   */
  private exists(args: CallArg[]): Expression {
    if (args.length !== 1) throw new LoweringError('EXISTS(…) expects a traversal path');
    let walk = args[0].value;
    let predicate: MExpr | undefined;
    if (walk.kind === 'where') {
      predicate = walk.predicate;
      walk = walk.source;
    }
    const steps = this.walkSteps(walk);
    if (steps !== undefined) {
      const exists: Expression = {
        type: 'exists',
        steps: steps.steps,
        ...(predicate !== undefined ? { where: this.top(predicate) } : {}),
      };
      return steps.root !== undefined
        ? this.foldNamespace({ type: 'traverse', aliasRoot: steps.root, steps: [], expression: exists })
        : exists;
    }
    // `EXISTS(x.Field)` asks a VALUE's presence: `x.Field != null`.
    if (predicate !== undefined) throw new LoweringError('EXISTS(… WHERE …) needs a traversal path — a value has nothing to filter');
    if (walk.kind === 'member' && walk.object.kind === 'name' && walk.object.name.text.toLowerCase() !== 'edge') {
      const read = this.top(walk);
      return { type: 'compare', op: 'neq', left: read, right: { type: 'static', value: null } };
    }
    throw new LoweringError(
      'EXISTS(…) expects a traversal path like -[:edge]-> or alias-[:edge]->, or a property read like x.`Field`',
    );
  }

  /** A walk's steps and root, when `walk` is a name or a bare walk from one. */
  private walkSteps(walk: MExpr): { root?: string; steps: TraversalStep[] } | undefined {
    if (walk.kind === 'name') return { root: walk.name.text, steps: [] };
    if (walk.kind !== 'path' || (walk.root !== undefined && walk.root.kind !== 'name')) return undefined;
    const probe = this.lower(this.member(walk, { text: '__movement_exists_probe__', quoted: true, at: walk.at }), TOP);
    if (probe.type !== 'traverse' || probe.expression.type !== 'property') return undefined;
    return { ...(probe.aliasRoot !== undefined ? { root: probe.aliasRoot } : {}), steps: probe.steps };
  }

  // ── Bare walks ──

  /** A walk with nothing read off its end, from a plain root, ending `]->`. */
  private isBareWalk(expr: MExpr): expr is Extract<MExpr, { kind: 'path' }> {
    if (expr.kind !== 'path') return false;
    if (expr.root !== undefined && expr.root.kind !== 'name') return false;
    const last = expr.hops[expr.hops.length - 1];
    return last !== undefined && last.direction === 'out' && last.arrow === '->';
  }

  private positions(walk: MExpr): MExpr {
    return this.member(walk, { text: POSITION_SENTINEL, quoted: true, at: walk.at });
  }

  private member(object: MExpr, property: Name): MExpr {
    return { kind: 'member', object, property, at: object.at };
  }

  // ── Namespaced stdlib calls ──

  /** `CURRENCY.GET_NUMBER_FROM_FIGURE(…)` → the family's function; an unknown
   *  member or an unknown ALL-CAPS namespace in call position is refused. */
  private foldNamespace(expr: Extract<Expression, { type: 'traverse' }>): Expression {
    if (expr.aliasRoot === undefined || expr.steps.length > 0) return expr;
    const family = stdlibFamily(expr.aliasRoot);
    const callName = callTerminalName(expr.expression);
    if (family) {
      const inventory = `${family.namespace} provides: ${describeStdlibFamily(family)}`;
      if (callName === undefined) {
        throw new LoweringError(`${family.namespace} is a function family, not a position — call one of its functions. ${inventory}`);
      }
      const member = family.functions.find(fn => fn.name === callName);
      if (!member || expr.expression.type !== 'function') {
        throw new LoweringError(`${family.namespace} has no function ${callName}() — ${inventory}`);
      }
      const args = expr.expression.args;
      if (args.length < member.arity.min || args.length > member.arity.max) {
        throw new LoweringError(`${member.signature} takes ${member.arity.min}–${member.arity.max} arguments, got ${args.length}`);
      }
      return { type: 'function', fn: member.id, args };
    }
    if (callName !== undefined && NAMESPACE_SHAPED.test(expr.aliasRoot)) {
      throw new LoweringError(
        `Unknown function namespace '${expr.aliasRoot}' — the namespaced families are: ${listStdlibNamespaces().join(', ')}`,
      );
    }
    return expr;
  }
}

function combine(op: BinaryOp, left: Expression, right: Expression): Expression {
  switch (op) {
    case 'or':
    case 'and':
      // The formula grammar folds a left operand that is already the same
      // connective — parenthesised or not — into one flat list.
      return left.type === 'logical' && left.op === op
        ? { type: 'logical', op, operands: [...left.operands, right] }
        : { type: 'logical', op, operands: [left, right] };
    case '==':
      return { type: 'compare', op: 'eq', left, right };
    case '!=':
      return { type: 'compare', op: 'neq', left, right };
    case '<':
      return { type: 'compare', op: 'lt', left, right };
    case '<=':
      return { type: 'compare', op: 'lte', left, right };
    case '>':
      return { type: 'compare', op: 'gt', left, right };
    case '>=':
      return { type: 'compare', op: 'gte', left, right };
    case 'contains':
      return { type: 'compare', op: 'contains', left, right };
    case 'in':
      return { type: 'compare', op: 'in', left, right };
    case '+':
    case '-':
    case '*':
    case '/':
    case '%':
      return { type: 'arithmetic', op, left, right };
    default:
      return neverAsAny(op);
  }
}

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

function containsIs(expr: MExpr): boolean {
  let found = false;
  const visit = (e: MExpr | undefined): void => {
    if (e === undefined || found) return;
    if (e.kind === 'is') {
      found = true;
      return;
    }
    for (const child of children(e)) visit(child);
  };
  visit(expr);
  return found;
}

/** The sub-expressions of a node, for walkers with nothing to say about the node itself. */
export function children(e: MExpr): MExpr[] {
  switch (e.kind) {
    case 'literal':
    case 'name':
    case 'special':
    case 'type':
    case 'declaration':
      return [];
    case 'string':
      return e.parts.filter((p): p is MExpr => typeof p !== 'string');
    case 'paren':
      return [e.expr];
    case 'list':
      return e.elements.map(x => (x.kind === 'spread' ? x.expr : x));
    case 'map':
      return e.entries.map(x => x.value);
    case 'member':
      return [e.object];
    case 'index':
      return [e.object, e.index];
    case 'call':
      return [e.callee, ...e.args.map(a => a.value)];
    case 'path':
      return [
        ...(e.root ? [e.root] : []),
        ...e.hops.flatMap(h => [
          ...(h.where ? [h.where] : []),
          ...(h.config ? [h.config] : []),
          ...(h.orderBy ? [h.orderBy.key] : []),
        ]),
      ];
    case 'unary':
      return [e.operand];
    case 'binary':
      return [e.left, e.right];
    case 'exists':
    case 'within':
      return [e.operand];
    case 'where':
      return [e.source, e.predicate];
    case 'is':
      return [e.subject];
    case 'if':
      return [e.condition, e.then, ...(e.else ? [e.else] : [])];
    case 'closure':
      return e.body.kind === 'expr' ? [e.body.expr] : [];
    case 'node':
      return e.entries.flatMap(x => (x.value.kind === 'declaredEdge' ? [] : [x.value]));
    case 'graph':
      return [...e.entries.flatMap(x => (x.value.kind === 'declaredEdge' ? [] : [x.value])), ...e.spreads];
    case 'mapped':
      return [e.source, e.body];
    case 'lazy':
      return [e.walk];
    default:
      return neverAsAny(e);
  }
}

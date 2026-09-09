// Movement engine — the dry interpretability check.
//
// The movement engine executes every movement from its canonical text
// (6_engine.md). It raises a clean MOVENG_UNSUPPORTED at fire time for
// anything outside its slice, but a failed firing is the WRONG place to
// discover that — so every save runs this static scan first and refuses
// (status 'error') with the constructs named.
//
// This is a STATIC approximation of the interpreter's unsupported set:
// it walks the parsed AST (statements, conditions, expression slots) for
// constructs `run.ts` / `expression.ts` reject unconditionally. Runtime-
// dependent rejections (a block head over a binding of the wrong kind,
// WHERE filters on a particular hop) are not statically decidable here
// and still surface as failed runs — the list below is the honest
// construct-level gate, not a proof of interpretability.

import {
  BridgeError,
  MovementParseError,
  linkImports,
  parseMovementCondition,
  parseMovementExpression,
  parseProgram,
} from 'movement-lang';
import type {
  CallArg,
  CombinatorExpression,
  ExprSlot,
  ExtractExpression,
  LinkExpression,
  NodeLiteral,
  MovementCondition,
  Program,
  ResolveFile,
  Statement,
  WriteExpression,
} from 'movement-lang';
import type { Expression } from '#shared/expression/types';
import { isMovementBuiltinFunction } from './expression';

/** Expression kinds the interpreter's evaluator executes today —
 *  everything else in a slot flags the movement as non-interpretable. */
const SUPPORTED_EXPRESSION_KINDS: ReadonlySet<Expression['type']> = new Set<
  Expression['type']
>([
  'static',
  'list',
  // Object literals — the structured-value form (`{ key: expr, … }`); the
  // engine evaluates every entry, no adapter or LLM involved.
  'object',
  'concat',
  'conditional',
  'compare',
  'logical',
  'not',
  'arithmetic',
  'traverse',
  'aggregate',
  'alias_ref',
  // AI() — runs through the LlmClient seam (movement_engine/expression.ts).
  'llm',
  // A bare name parses as a root-less `property` node (the bridge's
  // identity resolver is total) — the engine reads it as a value binding.
  'property',
  // EXISTS() — the frozen engine's quantifier semantics over the same
  // read seams (adapter getRelated / extract emissions / meta-node
  // edges); the bridge lifts it as a traverse terminal or a bare node.
  'exists',
  // Function calls — the frozen engine's built-in pure scalar functions
  // (COALESCE, TRIM, …) run everywhere; adapter field functions run as
  // write-field values (bound to the write target's adapter at
  // field-mapping time); non-built-ins anywhere else are flagged per
  // name in scanExpression.
  'function',
  // `@<key>` meta values — the frozen engine's time / acting-user /
  // raw-actor key families, mirrored over the run's dispatch context.
  'meta',
  // `[n]` array indexing — frozen semantics, mirrored verbatim.
  'at',
]);

const EXPRESSION_KIND_LABEL: Partial<Record<Expression['type'], string>> = {
  // Retired by generalisation, not pending: the kg is an ordinary graph
  // here — query it with a traversal instead of an inline query function.
  kg_exists:
    'KG_EXISTS() (retired — query the graph with a traversal instead: EXISTS(graph-[c:Company WHERE …]->))',
  kg_value:
    'KG_VALUE() (retired — query the graph with a traversal instead: graph-[c:Company WHERE …]->.`field`)',
  // TG-shaped reads whose sources don't exist in a movement run — not
  // "later increments" but constructs with movement-native replacements.
  parent_result: "'@parent.*' reads (read the parent write's handle instead)",
  resource: "'@resource.*' reads (traverse -[:_resources]-> instead)",
};

/**
 * The constructs in this program the movement engine cannot interpret
 * yet, deduplicated, in encounter order. Empty = the dry check passes
 * and the save may go live. A program that doesn't parse returns [] —
 * parse/check diagnostics own that failure mode.
 *
 * File imports run since E8 (the engine resolves them through
 * `RunMovementInput.resolveFile`); pass the SAME resolver here so the
 * imported library files are scanned too — a library body carrying an
 * unsupported construct flags the importing file, suffixed with the
 * library path. Resolution failures stay silent: checkProgram owns those
 * diagnostics (every gate caller runs both).
 */
export function listUnsupportedConstructs(
  source: string,
  options: { resolveFile?: ResolveFile } = {},
): string[] {
  let program: Program;
  try {
    program = parseProgram(source);
  } catch (e) {
    if (e instanceof MovementParseError) return [];
    throw e;
  }
  const found = new InterpretabilityScan().scan(program);
  if (options.resolveFile) {
    const link = linkImports(program, options.resolveFile);
    for (const [path, file] of link.files) {
      for (const construct of new InterpretabilityScan().scan(file.program)) {
        const labelled = `${construct} (in "${path}")`;
        if (!found.includes(labelled)) found.push(labelled);
      }
    }
  }
  return found;
}

class InterpretabilityScan {
  private readonly found: string[] = [];
  private readonly seen = new Set<string>();
  /** File-scope construction + shape names — a movement parameter must
   *  be typed against one (instance-rooted entries; shape-rooted
   *  callees since the composition increment). Nothing is ambient: the
   *  knowledge graph is constructed and named like every other system. */
  private readonly graphRoots = new Set<string>();
  /** Declared node names — a write to one has no adapter, so its
   *  fields are NOT a field-function context (see scanWrite). */
  private readonly shapeNames = new Set<string>();
  /** > 0 while scanning the field slots of an adapter-target write —
   *  the only place a non-built-in function can resolve at runtime. */
  private writeFieldDepth = 0;

  scan(program: Program): string[] {
    for (const statement of program.statements) {
      if (statement.kind === 'assign' && statement.value.kind === 'construct') {
        this.graphRoots.add(statement.name);
      }
      if (statement.kind === 'shape') {
        this.graphRoots.add(statement.name);
        this.shapeNames.add(statement.name);
      }
      if (statement.kind === 'import' && statement.source.kind === 'file') {
        // An imported name may be a shape (a valid movement root) —
        // benefit of the doubt; the checker owns kind validation.
        for (const { name, alias } of statement.names) {
          this.graphRoots.add(alias ?? name);
        }
      }
      // A bare adapter import is NOT a graph root — instantiation is
      // explicit (`go = manual()`). A movement param typed against a bare
      // import (`<manual-[:Invocation]->>`) is therefore flagged as unsupported,
      // agreeing with the checker's ADAPTER_NOT_CONSTRUCTED error.
    }
    for (const statement of program.statements) this.scanFileStatement(statement);
    return this.found;
  }

  private flag(construct: string): void {
    if (this.seen.has(construct)) return;
    this.seen.add(construct);
    this.found.push(construct);
  }

  // ── File scope ──

  private scanFileStatement(statement: Statement): void {
    switch (statement.kind) {
      case 'import':
        // File imports run since E8 (resolved via RunMovementInput.
        // resolveFile); the imported library's own constructs are
        // scanned by listUnsupportedConstructs' link walk.
        return;
      case 'assign':
        switch (statement.value.kind) {
          case 'extract':
            this.flag('file-level extract expressions');
            return;
          case 'block':
            this.flag('file-level traversal blocks');
            return;
          case 'write':
            this.flag('file-level writes');
            return;
          case 'expr':
            this.scanSlot(statement.value.expr);
            return;
          case 'callback':
            // The engine mints it, the router fires it — an interpretable
            // construct since chunk 2. Nothing to scan at file scope (a
            // callback lives inside a movement body).
            return;
          case 'construct':
            return;
          case 'call':
            this.flag('file-level calls');
            return;
        }
        return;
      case 'movement': {
        // Arity is the CHECKER's territory now: listen/run entries take
        // exactly one parameter (dispatch supplies one event); library
        // movements take any arity (call-fit covers them). Every param
        // must still be typed against a file-scope graph root (a
        // construction or a shape).
        for (const param of statement.params) {
          // An unannotated parameter is refused at save; nothing here to place.
          if (param.type === undefined) continue;
          if (!this.graphRoots.has(param.type.graph)) {
            this.flag(`a movement seeded from '${param.type.graph}' (not a constructed instance or shape)`);
          }
        }
        this.scanBody(statement.body);
        return;
      }
      default:
        // listen / run / shape / edge contribute nothing to a firing.
        return;
    }
  }

  // ── Movement bodies (recursive through if / parallel / blocks) ──

  /** A combinator's arms are ordinary bodies, scanned like any other. An arm
   *  that is a NAME is a movement (or a closure bound earlier) — scanned where
   *  it was declared, not again here. */
  private scanArms(expr: CombinatorExpression): void {
    if (expr.arms.kind === 'dynamic') {
      this.scanSlot(expr.arms.expr);
      return;
    }
    for (const arm of expr.arms.arms) {
      if (arm.kind === 'closure') this.scanBody(arm.closure.body);
    }
  }

  private scanBody(statements: Statement[]): void {
    for (const statement of statements) {
      switch (statement.kind) {
        case 'import':
          this.scanFileStatement(statement);
          break;
        // A binding and a `return` take the same right-hand side, so what a
        // scan makes of one it makes of the other.
        case 'assign':
        case 'return':
          switch (statement.value.kind) {
            case 'construct':
              break;
            case 'call':
              for (const arg of statement.value.call.args) this.scanCallArg(arg);
              break;
            case 'write':
              this.scanWrite(statement.value.write);
              break;
            case 'link':
              this.scanLink(statement.value.link);
              break;
            case 'expr':
              this.scanSlot(statement.value.expr);
              break;
            case 'extract':
              this.scanExtract(statement.value.extract);
              break;
            case 'block':
              this.scanBody(statement.value.block.body);
              break;
            case 'node':
              this.scanNode(statement.value.node);
              break;
            case 'lazy':
              // A deferred traversal is a traversal — the same head every
              // block runs, held rather than walked. Its per-item tail is a
              // node literal, and gets scanned as one.
              if (statement.value.lazy.mapping) this.scanNode(statement.value.lazy.mapping);
              break;
            case 'callback': {
              // Interpretable since chunk 2 — but what it DEFERS is scanned
              // like any other body: an unsupported construct inside a callback
              // body is one this movement cannot run, whenever it runs.
              const subject = statement.value.callback.subject;
              if (subject.kind === 'inline') this.scanBody(subject.closure.body);
              else {
                for (const arg of subject.args) this.scanCallArg(arg);
              }
              break;
            }
            case 'closure':
              // A closure's body runs when it is CALLED, and an unsupported
              // construct inside one is unsupported whenever that happens.
              this.scanBody(statement.value.closure.body);
              break;
            case 'inlineBlock':
              this.flag("reading a block's inner binding by name ('{ … }.name')");
              break;
            case 'combinator':
              this.scanArms(statement.value.combinator);
              break;
            case 'collection': {
              // The op runs its function once per member, so the function's
              // body is body this movement runs.
              const op = statement.value.collection;
              this.scanSlot(op.source);
              if (op.init !== undefined) this.scanSlot(op.init);
              if (op.fn.kind === 'closure') this.scanBody(op.fn.closure.body);
              break;
            }
            case 'members':
              // A list of a type's own values — nothing runs.
              break;
            case 'await':
              if (statement.value.await.source.kind === 'combinator') {
                this.scanArms(statement.value.await.source.combinator);
              } else if (
                statement.value.await.source.kind === 'until'
                && statement.value.await.source.condition.kind === 'closure'
              ) {
                this.scanBody(statement.value.await.source.condition.closure.body);
              }
              break;
          }
          break;
        case 'write':
          this.scanWrite(statement.write);
          break;
        case 'error':
          // ERROR() runs (it fails the run with a reason) — scan its message.
          this.scanSlot(statement.message);
          break;
        case 'if':
          for (const arm of statement.arms) {
            this.scanCondition(arm.condition);
            this.scanBody(arm.body);
          }
          if (statement.elseArm) this.scanBody(statement.elseArm.body);
          break;
        case 'combinator':
          this.scanArms(statement.combinator);
          break;
        case 'await':
          if (statement.await.source.kind === 'combinator') {
            this.scanArms(statement.await.source.combinator);
          } else if (
            statement.await.source.kind === 'until'
            && statement.await.source.condition.kind === 'closure'
          ) {
            this.scanBody(statement.await.source.condition.closure.body);
          }
          break;
        case 'call':
          // Calls run (composition) — same-file and imported callees
          // alike (E8). Arguments still carry expression slots / inline
          // shape-writes — scan them.
          for (const arg of statement.args) this.scanCallArg(arg);
          break;
        case 'link':
          // Link statements run (E7 — the Adapter.linkRecords seam),
          // both forms: bare-handle asserts and criteria links (the
          // target resolved like a write's identity, never created).
          // Runtime-dependent rejections (cross-graph endpoints, an
          // adapter without the capability) are not statically decidable
          // here — like other binding-kind checks they surface as failed
          // runs. Criteria field slots carry expressions — scan them.
          this.scanLink(statement.link);
          break;
        case 'unlink':
          // The inverse of the bare-handle link (the Adapter.unlinkRecords
          // seam) runs; runtime-dependent rejections surface as failed
          // runs, as above.
          break;
        case 'delete':
          // Record removal runs (`delete <handle>` — the adapter's
          // deleteRecord). Capability-less adapters reject at runtime,
          // by name, like the link statements above.
          break;
        case 'block':
          this.scanBody(statement.block.body);
          break;
        case 'shape':
          this.flag('nested node declarations inside a movement body');
          break;
        case 'movement':
          this.flag('nested movement declarations inside a movement body');
          break;
        default:
          break;
      }
    }
  }

  /** One call argument, whatever form it takes — a nested CALL's own arguments
   *  are more of the same, one level down. */
  private scanCallArg(arg: CallArg): void {
    if (arg.kind === 'write') this.scanWrite(arg.write);
    else if (arg.kind === 'node') this.scanNode(arg.node);
    else if (arg.kind === 'call') for (const nested of arg.call.args) this.scanCallArg(nested);
    else this.scanSlot(arg.expr);
  }

  /** A node literal computes and nothing else — its value entries are ordinary
   *  expression slots, and its nested literals are more of the same. Not a
   *  field-function context: there is no adapter behind a synthesised node to
   *  advertise functions. */
  private scanNode(node: NodeLiteral): void {
    for (const entry of node.entries) {
      if (entry.kind === 'value') this.scanSlot(entry.value);
      // A traversal entry is a hop chain, not an expression slot — heads carry
      // no interpretability question of their own (every other head is scanned
      // the same way: not at all). Its per-item tail is a literal, though.
      else if (entry.kind === 'traversal') {
        if (entry.mapping) this.scanNode(entry.mapping);
      }
      // A declared edge is a TYPE and nothing else — no slot, no literal.
      else if (entry.kind === 'nodes') for (const nested of entry.nodes) this.scanNode(nested);
    }
  }

  private scanWrite(write: WriteExpression): void {
    // The fields of an ADAPTER-target write are a field-function
    // context: the write path binds the destination field's advertised
    // functions at runtime, so whether a non-built-in name resolves
    // depends on the live descriptor — not statically decidable here
    // (an unadvertised name still fails the run loud, per name). Shape
    // writes have no adapter; their fields stay flagged.
    const functionBearing = !(
      write.target.kind === 'linked' &&
      write.target.path.root !== undefined &&
      this.shapeNames.has(write.target.path.root)
    );
    if (functionBearing) this.writeFieldDepth++;
    for (const field of write.fields) this.scanSlot(field.value);
    if (functionBearing) this.writeFieldDepth--;
  }

  /** Criteria-form link bodies carry expression slots (match values —
   *  no write-target field functions bind, so no field depth). */
  private scanLink(link: LinkExpression): void {
    if (link.target.kind !== 'criteria') return;
    for (const field of link.target.fields) this.scanSlot(field.value);
  }

  private scanExtract(extract: ExtractExpression): void {
    for (const slot of extract.from) this.scanSlot(slot);
    // Stage/node internals (descriptions, through plugins) are the
    // extraction module's territory — it runs them since E2.
  }

  // ── Conditions and expression slots ──

  private scanCondition(slot: ExprSlot): void {
    let condition: MovementCondition;
    try {
      condition = parseMovementCondition(slot.raw);
    } catch (e) {
      if (e instanceof BridgeError) return; // checker territory
      throw e;
    }
    this.scanParsedCondition(condition);
  }

  private scanParsedCondition(condition: MovementCondition): void {
    switch (condition.kind) {
      case 'isTest':
        // Runtime IS runs (a type test against the runtime position's
        // type where known; falsy-skip otherwise — run.ts). The subject
        // may itself be an expression — scan it.
        this.scanSlotRaw(condition.subjectRaw);
        return;
      case 'and':
        for (const conjunct of condition.conjuncts) this.scanParsedCondition(conjunct);
        return;
      case 'expr':
        this.scanExpression(condition.expr);
        return;
    }
  }

  private scanSlot(slot: ExprSlot): void {
    this.scanSlotRaw(slot.raw);
  }

  private scanSlotRaw(raw: string): void {
    let expr: Expression;
    try {
      expr = parseMovementExpression(raw);
    } catch (e) {
      if (e instanceof BridgeError) return; // checker territory
      throw e;
    }
    this.scanExpression(expr);
  }

  private scanExpression(expr: Expression): void {
    if (!SUPPORTED_EXPRESSION_KINDS.has(expr.type)) {
      this.flag(EXPRESSION_KIND_LABEL[expr.type] ?? `'${expr.type}' expressions`);
    }
    switch (expr.type) {
      case 'list':
        for (const e of expr.elements) this.scanExpression(e);
        return;
      case 'object':
        for (const entry of expr.entries) this.scanExpression(entry.value);
        return;
      case 'concat':
        for (const p of expr.parts) this.scanExpression(p);
        return;
      case 'conditional':
        this.scanExpression(expr.condition);
        this.scanExpression(expr.then);
        this.scanExpression(expr.else);
        return;
      case 'arithmetic':
      case 'compare':
        this.scanExpression(expr.left);
        this.scanExpression(expr.right);
        return;
      case 'logical':
        for (const o of expr.operands) this.scanExpression(o);
        return;
      case 'not':
        this.scanExpression(expr.expression);
        return;
      case 'resource_traverse':
        if (expr.expressionFilter) this.scanExpression(expr.expressionFilter);
        this.scanExpression(expr.expression);
        return;
      case 'traverse':
        // A terminal property/POSITION read belongs to the traverse —
        // the engine evaluates it as one read; don't descend into it.
        // An `edge_property` terminal is the SAME single field read: the
        // bracket-WHERE grammar parses `alias.`field`` inside a hop filter
        // as edge_property, and the engine reads it as that position's field
        // (see `fieldTerminalId`). Any OTHER terminal (`EXISTS(m-[:files]->)`
        // parses as a traverse whose terminal is the exists — itself
        // supported, scanned for its WHERE) is its own construct.
        if (expr.expression.type !== 'property' && expr.expression.type !== 'edge_property') {
          this.scanExpression(expr.expression);
        }
        return;
      case 'aggregate':
        this.scanExpression(expr.expression);
        return;
      case 'at':
        this.scanExpression(expr.expression);
        this.scanExpression(expr.index);
        return;
      case 'function':
        // Built-ins (the mirrored pure set, FILE(), the namespaced
        // stdlib) run everywhere; a non-built-in name resolves only as
        // a write-field value (the write target's adapter functions,
        // bound at field-mapping time) — outside one it is certainly
        // unsupported, named.
        if (!isMovementBuiltinFunction(expr.fn) && this.writeFieldDepth === 0) {
          this.flag(`non-built-in function calls (${expr.fn.toUpperCase()}())`);
        }
        for (const a of expr.args) this.scanExpression(a);
        return;
      case 'exists':
        if (expr.where) this.scanExpression(expr.where);
        return;
      case 'kg_exists':
      case 'kg_value':
        for (const p of expr.params) this.scanExpression(p);
        return;
      default:
        return;
    }
  }
}

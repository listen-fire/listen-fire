// The position-aware-narrowing pre-scan (2026-07-05).
//
// Before the pure checker runs, the host needs to know which POSITIONS a
// program selects decidably — every hop chain rooted at a constructed
// instance, with its WHERE filters as authored — so it can resolve each
// decidable selection by walking to the type the selector names, and register
// the result as a refined position type (`InstanceSchema.refinements`).
//
// This module is that scan, kept in movement-lang because it reuses the
// parser and must see paths exactly the way the checker will (the same
// probe-parse `checkPathHead` uses). It is purely syntactic: it reports hop
// chains and which (adapter, credential) instance they root at, and leaves
// resolving hop TARGETS against a schema to the host — the schemas don't
// exist yet when this runs.
//
// Chains rooted at a block alias are expanded through the enclosing block's
// own chain (`sheets-[s:…]-> { write s-[:…]-> … }` yields the full path from
// `sheets`), so nested selection composes. Aliases the scan can't ground in
// a constructed instance are skipped — an unresolved chain only means no
// STATIC narrowing there, never a wrong result.

import type { Expression, TraversalStep } from '@listen-fire/shared/expression/types';
import type {
  AwaitExpression,
  CallArg,
  ExprSlot,
  NodeLiteral,
  PathHead,
  Program,
  CombinatorExpression,
  Statement,
  WriteExpression,
  WriteTarget,
} from '../parser/ast';
import { parseProgram } from '../parser/parse';
import { unwrapCredentialArg } from '../parser/scan';
import { parseMovementExpression } from '../expression/bridge';

export interface InstanceChain {
  /** The construction's adapter slug (import aliases resolved back). */
  adapter: string;
  /** The construction's original credential import name, when present. */
  credential?: string;
  /** Non-credential construction args as authored (raw source, e.g.
   *  `{ spreadsheet: '"Pipeline"' }`) — they pick the instance's entry
   *  POSITION, so the catalog pre-builds a schema per distinct set. */
  constructionArgs?: Record<string, string>;
  /** The hop chain from the instance's meta position, as authored. */
  steps: TraversalStep[];
  /**
   * When set, the chain roots at THIS position type instead of the meta
   * position — a movement parameter (`movement m(x: <wa-[:\`Type\`]->>)`) or a
   * root-write handle (`x = write crm-[:Type]-> { … }`). Walkers start their
   * hop resolution from this type's edges rather than the collections.
   */
  startPosition?: string;
  /**
   * The WRITE BODY this chain is the target of — field name → the value as
   * authored (raw source), first spelling wins (the same rule the checker's own
   * body lookups use). Present only on the chain a write's target path emits.
   *
   * Carried because some landing types are decided BY THE BODY: an ask's
   * `Response` is generic over the `Options` that write offered, so the host's
   * pre-pass needs the literals alongside the hop that reaches the type
   * (`genericLandingKey`). Read chains never have one.
   */
  writeBody?: Record<string, string>;
}

interface ConstructionBinding {
  adapter: string;
  credential?: string;
  constructionArgs?: Record<string, string>;
}

/** An alias's grounding: the instance it roots at + the steps to reach it. */
interface AliasGrounding {
  binding: ConstructionBinding;
  prefix: TraversalStep[];
  /** The position type the alias's chain roots at (parameter / write
   *  handle) — carried onto every chain grounded through it. */
  startPosition?: string;
}

/**
 * Every hop chain the program walks from a constructed instance — block
 * heads (statement and assign form), linked/tuple write paths, awaited
 * traversals (bound and unbound), and alias-rooted traversals inside
 * expression slots (write fields, unique predicates, assignments, call args,
 * if conditions, extract sources, error messages) — nested chains expanded
 * through their enclosing blocks' aliases, and through the bodies every
 * nesting form carries (blocks, movements, `parallel`, `if`, race branches,
 * inline blocks). Never throws: an unparseable program or path yields no
 * chains.
 */
export function scanInstanceChains(source: string): InstanceChain[] {
  let program: Program;
  try {
    program = parseProgram(source);
  } catch {
    return []; // unparseable program — the save path's own parse reports it
  }

  const adapterAliases = new Map<string, string>();
  const credentialAliases = new Map<string, string>();
  const bindings = new Map<string, ConstructionBinding>();
  const chains: InstanceChain[] = [];

  const parseSteps = (head: PathHead): TraversalStep[] | undefined => {
    if (head.root === undefined || head.hopsRaw.length === 0) return undefined;
    try {
      const parsed = parseMovementExpression(
        `${head.root}${head.hopsRaw}.\`__movement_selector_probe__\``,
      );
      return parsed.type === 'traverse' ? parsed.steps : undefined;
    } catch {
      // ANY parse failure (BridgeError, the formula parser's raw ParseError,
      // …) — the checker owns the author's diagnostic; the scan only loses a
      // narrowing opportunity. It must never take down a save.
      return undefined;
    }
  };

  /** Ground a path head in a constructed instance, through alias scopes. */
  const groundHead = (
    head: PathHead,
    aliasScope: Map<string, AliasGrounding>,
  ): { binding: ConstructionBinding; steps: TraversalStep[]; startPosition?: string } | undefined => {
    if (head.root === undefined) return undefined;
    const steps = parseSteps(head);
    if (steps === undefined || steps.length === 0) return undefined;
    const direct = bindings.get(head.root);
    if (direct) return { binding: direct, steps };
    const viaAlias = aliasScope.get(head.root);
    if (viaAlias) {
      return {
        binding: viaAlias.binding,
        steps: [...viaAlias.prefix, ...steps],
        ...(viaAlias.startPosition !== undefined ? { startPosition: viaAlias.startPosition } : {}),
      };
    }
    return undefined;
  };

  const emitChain = (
    binding: ConstructionBinding,
    steps: TraversalStep[],
    startPosition?: string,
    writeBody?: Record<string, string>,
  ): void => {
    chains.push({
      adapter: adapterAliases.get(binding.adapter) ?? binding.adapter,
      ...(binding.credential !== undefined
        ? { credential: credentialAliases.get(binding.credential) ?? binding.credential }
        : {}),
      ...(binding.constructionArgs !== undefined
        ? { constructionArgs: binding.constructionArgs }
        : {}),
      steps,
      ...(startPosition !== undefined ? { startPosition } : {}),
      ...(writeBody !== undefined ? { writeBody } : {}),
    });
  };

  /** Ground a bare root name (instance binding or in-scope block alias). */
  const groundRoot = (
    root: string,
    steps: TraversalStep[],
    aliasScope: Map<string, AliasGrounding>,
  ): { binding: ConstructionBinding; steps: TraversalStep[]; startPosition?: string } | undefined => {
    const direct = bindings.get(root);
    if (direct) return { binding: direct, steps };
    const viaAlias = aliasScope.get(root);
    if (viaAlias) {
      return {
        binding: viaAlias.binding,
        steps: [...viaAlias.prefix, ...steps],
        ...(viaAlias.startPosition !== undefined ? { startPosition: viaAlias.startPosition } : {}),
      };
    }
    return undefined;
  };

  const visitHead = (
    head: PathHead,
    aliasScope: Map<string, AliasGrounding>,
    writeBody?: Record<string, string>,
  ): void => {
    const grounded = groundHead(head, aliasScope);
    if (grounded) {
      emitChain(grounded.binding, grounded.steps, grounded.startPosition, writeBody);
    }
  };

  /**
   * Traversals inside EXPRESSIONS (`Notes: sheets-[:Spreadsheet WHERE …]->.\`X\``)
   * select positions just like block heads do — walk every sub-expression
   * for alias-rooted traverses and ground them the same way. Leaves and
   * traverses the scan can't ground stay unscanned (union surface).
   */
  const visitExpression = (expr: Expression, aliasScope: Map<string, AliasGrounding>): void => {
    switch (expr.type) {
      case 'traverse': {
        if (expr.aliasRoot !== undefined && expr.steps.length > 0) {
          const grounded = groundRoot(expr.aliasRoot, expr.steps, aliasScope);
          if (grounded) emitChain(grounded.binding, grounded.steps, grounded.startPosition);
        }
        for (const step of expr.steps) {
          if ('expressionFilter' in step && step.expressionFilter !== undefined) {
            visitExpression(step.expressionFilter, aliasScope);
          }
        }
        visitExpression(expr.expression, aliasScope);
        return;
      }
      case 'exists': {
        for (const step of expr.steps) {
          if ('expressionFilter' in step && step.expressionFilter !== undefined) {
            visitExpression(step.expressionFilter, aliasScope);
          }
        }
        if (expr.where) visitExpression(expr.where, aliasScope);
        return;
      }
      case 'resource_traverse':
        visitExpression(expr.expression, aliasScope);
        return;
      case 'list':
        expr.elements.forEach((e) => visitExpression(e, aliasScope));
        return;
      case 'object':
        expr.entries.forEach((e) => visitExpression(e.value, aliasScope));
        return;
      case 'arithmetic':
      case 'compare':
        visitExpression(expr.left, aliasScope);
        visitExpression(expr.right, aliasScope);
        return;
      case 'logical':
        expr.operands.forEach((e) => visitExpression(e, aliasScope));
        return;
      case 'not':
        visitExpression(expr.expression, aliasScope);
        return;
      case 'concat':
        expr.parts.forEach((e) => visitExpression(e, aliasScope));
        return;
      case 'conditional':
        visitExpression(expr.condition, aliasScope);
        visitExpression(expr.then, aliasScope);
        visitExpression(expr.else, aliasScope);
        return;
      case 'at':
        visitExpression(expr.expression, aliasScope);
        visitExpression(expr.index, aliasScope);
        return;
      case 'aggregate':
        visitExpression(expr.expression, aliasScope);
        return;
      case 'function':
        expr.args.forEach((e) => visitExpression(e, aliasScope));
        return;
      case 'kg_exists':
        expr.params.forEach((e) => visitExpression(e, aliasScope));
        return;
      case 'llm':
        if (expr.promptExpression) visitExpression(expr.promptExpression, aliasScope);
        return;
      default:
        return; // leaves carry no traversals
    }
  };

  const visitSlot = (slot: ExprSlot, aliasScope: Map<string, AliasGrounding>): void => {
    let parsed: Expression;
    try {
      parsed = parseMovementExpression(slot.raw);
    } catch {
      // Unparseable slot — any parser error class. The checker reports it to
      // the author; the scan must never throw (a prod save 500'd otherwise).
      return;
    }
    visitExpression(parsed, aliasScope);
  };

  const visitWrite = (write: WriteExpression, aliasScope: Map<string, AliasGrounding>): void => {
    // First spelling wins on a repeated name — the same rule the checker's own
    // body lookups follow, so the two read one body the same way.
    const body: Record<string, string> = {};
    for (const field of write.fields) {
      if (body[field.name] === undefined) body[field.name] = field.value.raw;
    }
    visitWriteTarget(write.target, aliasScope, body);
    for (const field of write.fields) visitSlot(field.value, aliasScope);
    for (const clause of write.uniqueBy) visitSlot(clause.predicate, aliasScope);
  };

  /** A node literal's value entries are ordinary expressions in this scope;
   *  its nested literals are more of the same, one level down. */
  const visitNode = (node: NodeLiteral, aliasScope: Map<string, AliasGrounding>): void => {
    for (const entry of node.entries) {
      if (entry.kind === 'value') visitSlot(entry.value, aliasScope);
      else if (entry.kind === 'traversal') {
        visitLanding(entry.head, aliasScope);
        // A per-item tail reads the LANDING (`a.\`Name\``), so its reads are
        // demanded through the hop's alias exactly as a block body's are —
        // without this the mapped fields would never be demanded and the
        // adapter would never fetch them.
        if (entry.mapping) visitNode(entry.mapping, blockScope(entry.head, aliasScope));
      }
      // A DECLARED edge walks nothing here — its landings arrive later, each
      // already demanded wherever it was produced.
      else if (entry.kind === 'nodes') for (const nested of entry.nodes) visitNode(nested, aliasScope);
    }
  };

  /** One call argument, whatever form it takes. A nested CALL's own arguments
   *  read this scope, so its demand is this scope's demand one level down. */
  const visitCallArg = (arg: CallArg, aliasScope: Map<string, AliasGrounding>): void => {
    if (arg.kind === 'expr') visitSlot(arg.expr, aliasScope);
    else if (arg.kind === 'write') visitWrite(arg.write, aliasScope);
    else if (arg.kind === 'call') {
      for (const nested of arg.call.args) visitCallArg(nested, aliasScope);
    } else visitNode(arg.node, aliasScope);
  };

  /** A block head grounds its hop aliases for the block's body. */
  const blockScope = (
    head: PathHead,
    aliasScope: Map<string, AliasGrounding>,
  ): Map<string, AliasGrounding> => {
    const grounded = groundHead(head, aliasScope);
    if (!grounded) return aliasScope;
    const inner = new Map(aliasScope);
    for (let i = 0; i < grounded.steps.length; i++) {
      const step = grounded.steps[i];
      if (step.type === 'edge' && step.alias !== undefined) {
        inner.set(step.alias, {
          binding: grounded.binding,
          prefix: grounded.steps.slice(0, i + 1),
          ...(grounded.startPosition !== undefined ? { startPosition: grounded.startPosition } : {}),
        });
      }
    }
    return inner;
  };

  /**
   * A root-write handle (`co = write crm-[:Organization]-> { … }`) grounds
   * exactly like a block alias: the handle NAMES the written record, so a later
   * `co-[:\`List Entries\`]->` is the chain `crm-[:Organization]->-[:\`List
   * Entries\`]->`. Carrying the path (rather than a type name) is what keeps
   * the scan schema-free — the meta hop resolves through `collections` at
   * demand time, exactly as it does for a read.
   *
   * Without this, NOTHING rooted at a write handle was scanned, so a type
   * reached only by a write edge was never demanded, never described, and its
   * create body was checked against nothing. `InstanceChain.startPosition`
   * already documented this case; the walk simply never registered it.
   */
  const writeHandleGrounding = (
    write: WriteExpression,
    aliasScope: Map<string, AliasGrounding>,
  ): AliasGrounding | undefined => {
    // Only a `linked` target names ONE record. A tuple write yields several,
    // so its handle is not a single position — leave it unscanned.
    if (write.target.kind !== 'linked') return undefined;
    const grounded = groundHead(write.target.path, aliasScope);
    if (!grounded) return undefined;
    return {
      binding: grounded.binding,
      prefix: grounded.steps,
      ...(grounded.startPosition !== undefined ? { startPosition: grounded.startPosition } : {}),
    };
  };

  /**
   * `await a-[:Response]->` — an AWAITED traversal is a hop chain like any
   * other. The wait is about WHEN it resolves, never about where it lands, so
   * the scan yields exactly the chain the same traversal would without the
   * `await`, and the bound name grounds like a write handle (`r = await
   * a-[:Response]->` then `r.Answer` / `r-[:E]->`).
   *
   * Without this, an awaited landing entered no chain closure and was never
   * demanded, so the checker saw it undescribed and refused every field read on
   * an answer. It survived only while the ask adapter's landing type happened to
   * be spelled `Response` — the same word as the edge — so the demand set's
   * SUBSTRING seed matched it by coincidence; per-family landing names
   * (`Check Response`) killed the coincidence and exposed the missing case.
   *
   * `sleep` binds nothing. `until` waits on a CONDITION, not a landing — the
   * condition is an ordinary expression/statement position, walked for the
   * chains it contains.
   */
  const visitAwait = (
    awaitExpr: AwaitExpression,
    aliasScope: Map<string, AliasGrounding>,
  ): AliasGrounding | undefined => {
    const source = awaitExpr.source;
    if (source.kind === 'sleep') return undefined;
    if (source.kind === 'until') {
      if (source.condition.kind === 'expr') visitSlot(source.condition.expr, aliasScope);
      else walk(source.condition.closure.body, aliasScope);
      return undefined;
    }
    // The combinators: an arm closure's body walks like any body; the receipt
    // itself grounds nothing (it is a value the host assembled, not a hop).
    if (source.kind === 'combinator') {
      visitCombinator(source.combinator, aliasScope);
      return undefined;
    }
    return visitLanding(source.head, aliasScope);
  };

  /** A traversal that BINDS its landing rather than entering a block — an
   *  awaited edge, a `lazy` hop, a node literal's pass-through entry. The chain
   *  is demanded exactly as a block head's is, and the landing grounds whatever
   *  name it was bound to. */
  const visitLanding = (
    head: PathHead,
    aliasScope: Map<string, AliasGrounding>,
  ): AliasGrounding | undefined => {
    const grounded = groundHead(head, aliasScope);
    if (!grounded) return undefined;
    emitChain(grounded.binding, grounded.steps, grounded.startPosition);
    return {
      binding: grounded.binding,
      prefix: grounded.steps,
      ...(grounded.startPosition !== undefined ? { startPosition: grounded.startPosition } : {}),
    };
  };

  /**
   * A combinator's arms are ordinary function bodies — every chain inside one
   * is a chain the program walks, so a closure arm is walked with the enclosing
   * scope (closure capture). An arm that is only a NAME has its body walked
   * where it was declared.
   *
   * The RECEIPT is deliberately not grounded: its slots are values the host
   * assembled from what the arms returned, not hops on an adapter's graph.
   */
  const visitCombinator = (
    expr: CombinatorExpression,
    aliasScope: Map<string, AliasGrounding>,
  ): void => {
    if (expr.arms.kind === 'dynamic') {
      visitSlot(expr.arms.expr, aliasScope);
      return;
    }
    for (const arm of expr.arms.arms) {
      if (arm.kind === 'closure') walk(arm.closure.body, aliasScope);
    }
  };
  const walk = (statements: Statement[], outerScope: Map<string, AliasGrounding>): void => {
    // Handles bind for the REST of the block, so the scope accumulates as we
    // go. A local copy — mutating the caller's map would leak a handle into
    // sibling blocks (and across movements at the top level).
    const aliasScope = new Map(outerScope);
    for (const statement of statements) {
      switch (statement.kind) {
        case 'import':
          if (statement.source.kind === 'builtin' && statement.source.namespace !== 'plugins') {
            const map =
              statement.source.namespace === 'adapters' ? adapterAliases : credentialAliases;
            for (const { name, alias } of statement.names) {
              if (alias !== undefined) map.set(alias, name);
            }
          }
          break;
        case 'assign':
          if (statement.value.kind === 'construct') {
            const construct = statement.value.construct;
            const credentialRaw = construct.args.find((a) => a.name === 'credentials')?.value.raw;
            const credential =
              credentialRaw !== undefined ? unwrapCredentialArg(credentialRaw) : null;
            // Non-credential args (raw) pick the entry position — carry them so
            // the host can pre-build the positioned schema.
            const constructionArgs: Record<string, string> = {};
            for (const a of construct.args) {
              if (a.name === 'credentials') continue;
              constructionArgs[a.name] = a.value.raw.trim();
            }
            bindings.set(statement.name, {
              adapter: construct.callee,
              ...(credential !== null ? { credential } : {}),
              ...(Object.keys(constructionArgs).length ? { constructionArgs } : {}),
            });
          } else if (statement.value.kind === 'block') {
            visitHead(statement.value.block.head, aliasScope);
            walk(statement.value.block.body, blockScope(statement.value.block.head, aliasScope));
          } else if (statement.value.kind === 'write') {
            visitWrite(statement.value.write, aliasScope);
            const handle = writeHandleGrounding(statement.value.write, aliasScope);
            if (handle) aliasScope.set(statement.name, handle);
          } else if (statement.value.kind === 'expr') {
            visitSlot(statement.value.expr, aliasScope);
          } else if (statement.value.kind === 'extract') {
            for (const slot of statement.value.extract.from) visitSlot(slot, aliasScope);
          } else if (statement.value.kind === 'await') {
            const landing = visitAwait(statement.value.await, aliasScope);
            if (landing) aliasScope.set(statement.name, landing);
          } else if (statement.value.kind === 'combinator') {
            visitCombinator(statement.value.combinator, aliasScope);
          } else if (statement.value.kind === 'call') {
            // A bound call's demand is its ARGUMENTS' — what the callee reads
            // off them is the callee's own file's demand, gathered there.
            for (const arg of statement.value.call.args) visitCallArg(arg, aliasScope);
          } else if (statement.value.kind === 'node') {
            visitNode(statement.value.node, aliasScope);
          } else if (statement.value.kind === 'lazy') {
            const lazy = statement.value.lazy;
            const landing = visitLanding(lazy.head, aliasScope);
            if (lazy.mapping) visitNode(lazy.mapping, blockScope(lazy.head, aliasScope));
            // A MAPPED walk binds synthesised landings, not source positions —
            // there is no chain to ground the name against.
            if (landing && lazy.mapping === undefined) aliasScope.set(statement.name, landing);
          } else if (statement.value.kind === 'inlineBlock') {
            walk(statement.value.inlineBlock.body, aliasScope);
          } else if (statement.value.kind === 'closure') {
            // A closure body reads through the scope it captured — its demand
            // is this movement's, deferred.
            walk(statement.value.closure.body, aliasScope);
          } else if (statement.value.kind === 'callback') {
            // A callback body is a closure over this scope — its writes and
            // traversals are this movement's, minted now and run later.
            const subject = statement.value.callback.subject;
            if (subject.kind === 'inline') walk(subject.closure.body, aliasScope);
            else {
              for (const arg of subject.args) visitCallArg(arg, aliasScope);
            }
          }
          break;
        // `return <value>` — the same right-hand side a binding takes, minus
        // the name. What it READS is this movement's demand exactly as if it
        // had been bound; there is just nothing to ground a name against.
        case 'return': {
          const value = statement.value;
          if (value.kind === 'expr') visitSlot(value.expr, aliasScope);
          else if (value.kind === 'node') visitNode(value.node, aliasScope);
          else if (value.kind === 'write') visitWrite(value.write, aliasScope);
          else if (value.kind === 'block') {
            visitHead(value.block.head, aliasScope);
            walk(value.block.body, blockScope(value.block.head, aliasScope));
          } else if (value.kind === 'extract') {
            for (const slot of value.extract.from) visitSlot(slot, aliasScope);
          } else if (value.kind === 'await') visitAwait(value.await, aliasScope);
          else if (value.kind === 'combinator') visitCombinator(value.combinator, aliasScope);
          else if (value.kind === 'call') {
            for (const arg of value.call.args) visitCallArg(arg, aliasScope);
          } else if (value.kind === 'closure') walk(value.closure.body, aliasScope);
          else if (value.kind === 'lazy') {
            visitLanding(value.lazy.head, aliasScope);
            if (value.lazy.mapping) {
              visitNode(value.lazy.mapping, blockScope(value.lazy.head, aliasScope));
            }
          }
          break;
        }
        case 'block':
          visitHead(statement.block.head, aliasScope);
          walk(statement.block.body, blockScope(statement.block.head, aliasScope));
          break;
        case 'write':
          visitWrite(statement.write, aliasScope);
          break;
        case 'call':
          for (const arg of statement.args) visitCallArg(arg, aliasScope);
          break;
        case 'movement': {
          // Parameters root chains at their declared position type
          // (`movement m(x: <wa-[:\`Type\`]->>)` — `x-[:edge]->` walks Type's
          // edges), so ground each typed param for the body's scope.
          const paramScope = new Map(aliasScope);
          for (const param of statement.params) {
            if (param.type?.position === undefined) continue;
            const instanceBinding = bindings.get(param.type.graph);
            if (!instanceBinding) continue;
            paramScope.set(param.name, {
              binding: instanceBinding,
              prefix: [],
              startPosition: param.type.position,
            });
          }
          walk(statement.body, paramScope);
          break;
        }
        case 'await':
          visitAwait(statement.await, aliasScope);
          break;
        case 'combinator':
          visitCombinator(statement.combinator, aliasScope);
          break;
        case 'if':
          for (const arm of statement.arms) {
            visitSlot(arm.condition, aliasScope);
            walk(arm.body, aliasScope);
          }
          if (statement.elseArm) walk(statement.elseArm.body, aliasScope);
          break;
        case 'error':
          visitSlot(statement.message, aliasScope);
          break;
        default:
          break;
      }
    }
  };

  const visitWriteTarget = (
    target: WriteTarget,
    aliasScope: Map<string, AliasGrounding>,
    writeBody: Record<string, string>,
  ): void => {
    if (target.kind === 'linked') visitHead(target.path, aliasScope, writeBody);
    if (target.kind === 'tuple') {
      // ONE record at the convergence of N edges, so every path reaches the
      // type this body writes — each carries the same body.
      for (const path of target.paths) visitHead(path, aliasScope, writeBody);
    }
  };

  walk(program.statements, new Map());
  return chains;
}

/**
 * Parse a bare traversal PATH — `-[:Base WHERE `name` == "CRM"]->-[:Companies]->`
 * — into its steps. The addressing form for describing a type by the walk that
 * reaches it rather than by a string that encodes the walk.
 *
 * It runs the REAL expression parser (the same `parseMovementExpression` the
 * chain scan above uses), so a path means exactly what it means in a movement:
 * no second grammar to drift, and `WHERE` narrowing comes free.
 *
 * Returns undefined for anything that isn't a parseable hop chain — callers
 * treat the input as a plain type NAME instead.
 *
 */
export function parseTraversalPath(path: string): TraversalStep[] | undefined {
  const trimmed = path.trim();
  if (!trimmed.startsWith('-[')) return undefined;
  try {
    // The probe field gives the traversal something to land on — the parser
    // wants an expression, and we only keep the steps.
    const parsed = parseMovementExpression(
      `__movement_path_root__${trimmed}.\`__movement_path_probe__\``,
    );
    return parsed.type === 'traverse' ? parsed.steps : undefined;
  } catch {
    return undefined;
  }
}

// Lexical scope structure for the movement checker (M2).
//
// The checker walks the program once, in source order, maintaining a chain
// of `Scope`s. Each scope carries:
//   - `symbols`   — names bound so far (imports, assignments, params,
//                   hoisted movement/node declarations, traversal aliases,
//                   graph instances);
//   - `pending`   — names a *later* statement in the same statement list
//                   will bind (prescanned), so a read before the binding
//                   statement is reported as use-before-bind rather than
//                   unknown-name. TDZ-style: a pending name shadows an
//                   outer binding of the same name;
//   - `escaped`   — names that were bound inside an already-closed
//                   traversal block (out of scope, but remembered so the
//                   diagnostic can hint at the block's meta-node edge);
//   - `declarations` — every binding in source order, with the location it
//                   becomes the answer from. The checker never needs it (it
//                   asks where it stands); the editor does (it asks at a
//                   cursor), so it is kept only when recording.
//
// M2b layers type information onto `ScopeSymbol` (instance schemas via
// `Catalog.instantiate`, write-result handle shapes, narrowed positions)
// without changing the resolution mechanics here: `schema` for graph-like
// symbols (instances, shapes), `posType` for position-like
// symbols (params, aliases, handles, extract/block bindings), `movement`
// for lazy parameter typing at call sites.

import { Loc, MovementDeclaration, Span } from '../parser/ast';
import { FieldType, InstanceSchema } from './catalog';
import type { EffectRow } from './effects';
import { PositionTypeRef, ReturnShape } from './typing';

export type SymbolKind =
  /** `import { attio } from adapters` */
  | 'adapter'
  /** `import { acme_main } from credentials` */
  | 'credential'
  /** `import { scrub_sensitive } from plugins` */
  | 'plugin'
  /** `import { Files } from "lib/file-routines"` — category unknown until M3 file resolution. */
  | 'fileImport'
  /** `name = <expr | write | extract | block>` */
  | 'binding'
  /** `crm = attio(credentials: acme_main)` — a constructed instance. */
  | 'instance'
  /** A movement parameter. */
  | 'param'
  /** A movement declaration (hoisted across its statement list). */
  | 'movement'
  /** A node declaration (hoisted across its statement list); the discriminant
   *  keeps its historical spelling — see ShapeDeclaration in the AST. */
  | 'shape'
  /** A traversal-head alias (`-[c:companies]->`), scoped to the block body. */
  | 'alias'
  /** `type Thesis = <"A" | "B">` — an author-declared refinement of text. */
  | 'type';

export interface ScopeSymbol {
  name: string;
  kind: SymbolKind;
  span: Span;
  /** For imports: the name in the source namespace/file — catalog lookups key on this; `name` is the local binding (the alias, when one was given). */
  importedName?: string;
  /** For `instance`: the constructing adapter. */
  adapter?: string;
  /** For `instance`: the construction's credential, as its ORIGINAL import
   *  name — the key a per-credential instance schema (and its failure note)
   *  is filed under. */
  credential?: string;
  /** For a name bound by a FILE import (`import { x } from "lib/y"`): the
   *  import's path, so navigation can target the file. */
  importPath?: string;
  /** For `instance`: the construction's NON-credential args, raw as authored
   *  (`{ base: '"Dev Base"' }`). The entry position rides here — a listen's
   *  address is relative to it, so `checkListen` reads it to know which
   *  required address hops the position already supplies. */
  constructionArgs?: Record<string, string>;
  /** For `credential`: the adapters it can authenticate (set membership). */
  adapters?: string[];
  /** For `movement`: parameter count, for call arity checks. */
  arity?: number;
  /** For `instance` / `shape`: the graph's schema (when resolvable). */
  schema?: InstanceSchema;
  /** Graph identity override for IMPORTED graphs: the symbol the graph was
   *  originally declared by (in its library's file scope). Two positions
   *  are in the same graph iff their tokens match by reference, so an
   *  imported declaration must carry its library symbol — otherwise a handle
   *  written through the import would never fit the library movement's
   *  parameter. Absent = this symbol IS the graph's declaration. */
  graphToken?: ScopeSymbol;
  /** For `param` / `alias` / `binding`: the bound position's type (when derivable). */
  posType?: PositionTypeRef;
  /**
   * The ACCESS PLANE of this binding (asks-as-adapter F13) — set on assignments
   * so a race receipt / block meta can route a name to the right plane. A `node`
   * binding (write / await / block / extract / race — anything producing a
   * position or landing) escapes as an EDGE (arrow: `r-[x:name]->`); a `scalar`
   * binding (a plain value expression) escapes as a PROPERTY (dot: `r.name`),
   * carrying its `fieldType`. Absent for non-assignment symbols. */
  bindingPlane?: 'node' | 'scalar';
  /** For a `scalar`-plane `binding`: the value's field type, so a receipt can
   *  type its property read (`T` present, `T | absent` when partial). For a
   *  `type`: the closed enum the declaration names — the same shape a borrowed
   *  option set resolves to, so an annotation cannot tell the two apart. */
  fieldType?: FieldType;
  /** For `movement`: the declaration + declaring scope, so call sites can type parameters lazily. */
  movement?: {
    decl: MovementDeclaration;
    declScope: Scope;
    /** Cache — computed on first use. */
    paramTypes?: Array<PositionTypeRef | undefined>;
    /**
     * The type of a CALL of this movement: what its body RETURNS
     * (`checker/check.ts` `movementReturnType`). Cached like `paramTypes` and
     * for the same reason — it is a fact about the DECLARATION, so every call
     * site asks once. `done: false` is the in-progress marker, so a cycle in
     * type space answers "unknown" instead of recursing; `done: true` with an
     * EMPTY shape records "asked, and this movement returns nothing" — which
     * is a fact a bound call is refused on, not an absence of information.
     */
    returnType?: { done: boolean; shape: ReturnShape };
    /**
     * What CALLING this movement may do — its inferred effect row
     * (`checker/check.ts` `movementEffects`). Cached on the declaration for
     * the same reason `returnType` is: a call site may sit above the
     * declaration, so the row is computed from the body on first ask and
     * every later caller reads the same answer. This is the per-declaration
     * fact the picture and the language service both read, through the
     * `ScopeSymbol` they already hold.
     */
    effects?: EffectRow;
  };
}

/** What an AUTHORED declaration of a name would shadow. A binding whose
 *  declaration the walk has already passed carries its symbol (and so its
 *  location); one an enclosing statement list binds LATER is known only by
 *  name, because its declaration has not been walked yet. */
export type Shadowing =
  | { kind: 'bound'; symbol: ScopeSymbol }
  | { kind: 'pending' };

export type Resolution =
  | { kind: 'found'; symbol: ScopeSymbol }
  /** Bound by a later statement in an enclosing statement list. */
  | { kind: 'pending' }
  /** Bound inside a traversal block that has closed; `blockName` is the block's meta-node binding when it was assigned. */
  | { kind: 'escaped'; blockName?: string }
  | { kind: 'unknown' };

export type ScopeKind = 'file' | 'movement' | 'traversal' | 'branch';

/**
 * One `declare` into a scope, kept in source order. `symbols` holds only the
 * LAST binding of a name — enough for the checker, which walks forwards and
 * always asks at the position it has reached, but not for the editor, which
 * asks at an arbitrary cursor. A guard clause re-declares its subject narrowed
 * into the ENCLOSING scope, so the live map answers "narrowed" for the whole
 * scope, including positions before the guard ran.
 */
export interface Declaration {
  symbol: ScopeSymbol;
  /** The location from which this binding is the answer for its name — the
   *  declaration's own end normally; the end of the guard statement for a
   *  narrowing that only holds in the guard's continuation. */
  visibleFrom: Loc;
}

export class Scope {
  readonly symbols = new Map<string, ScopeSymbol>();
  readonly pending = new Set<string>();
  readonly escaped = new Map<string, string | undefined>();
  /**
   * Append-only log of every `declare`, for cursor queries (`log: true`, set
   * by the checker when the language service asked for a recording and
   * inherited by every child scope). Absent on the compile path, which only
   * ever reads the live map and so pays nothing for the history.
   */
  readonly declarations?: Declaration[];

  constructor(
    readonly kind: ScopeKind,
    readonly parent?: Scope,
    options: { log?: boolean } = {},
  ) {
    if (options.log ?? parent?.declarations !== undefined) this.declarations = [];
  }

  /** Binds a symbol; returns the previously-bound symbol of the same name in THIS scope, if any. */
  declare(symbol: ScopeSymbol, options: { visibleFrom?: Loc } = {}): ScopeSymbol | undefined {
    const existing = this.symbols.get(symbol.name);
    this.symbols.set(symbol.name, symbol);
    this.pending.delete(symbol.name);
    this.declarations?.push({ symbol, visibleFrom: options.visibleFrom ?? symbol.span.end });
    return existing;
  }

  /**
   * What an authored binding of `name` HERE would shadow — the same walk
   * `resolve` makes, minus this scope, which is the same-scope duplicate
   * question and already has its own answer. A NARROWING re-declaration asks
   * this nothing: it is the enclosing binding, sharpened, not a second one.
   */
  shadowing(name: string): Shadowing | undefined {
    let child: Scope = this;
    for (let scope: Scope | undefined = this.parent; scope; child = scope, scope = scope.parent) {
      const symbol = scope.symbols.get(name);
      if (symbol) return { kind: 'bound', symbol };
      if (scope.pending.has(name)) return { kind: 'pending' };
    }
    return undefined;
  }

  resolve(name: string): Resolution {
    for (let scope: Scope | undefined = this; scope; scope = scope.parent) {
      const symbol = scope.symbols.get(name);
      if (symbol) return { kind: 'found', symbol };
      if (scope.pending.has(name)) return { kind: 'pending' };
    }
    for (let scope: Scope | undefined = this; scope; scope = scope.parent) {
      if (scope.escaped.has(name)) {
        return { kind: 'escaped', blockName: scope.escaped.get(name) };
      }
    }
    return { kind: 'unknown' };
  }
}

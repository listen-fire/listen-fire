// AST for the data-movement language statement layer.
// Spec: plans/2026-06-10-data-movement-language/ (3_syntax_sketch.md is the surface).
//
// Value expressions are NOT parsed here: every expression position is captured as a
// raw source span (ExprSlot) and handed to expression/bridge.ts, which delegates to
// the existing formula grammar in @listen-fire/shared. The statement layer owns only the
// constructs the language adds: import, assignment, construction, shape, extract,
// movement, listen (the one invoker), write (root + linked + tuple),
// traversal-headed block, link, if, parallel, call.

export interface Loc {
  line: number; // 1-based
  col: number; // 1-based
}

export interface Span {
  start: Loc;
  end: Loc;
}

/** A value-expression position, captured verbatim for the expression bridge. */
export interface ExprSlot {
  raw: string;
  span: Span;
}

// ── Names and references ──

/**
 * `<inbox-[:message]->>`, `<crm>` (meta position / self-entry shape),
 * `<number>`. Types ALWAYS wear angle brackets at the surface — the universal
 * type marker (3_syntax_sketch.md, 2026-06-11) — but the AST stores the
 * unbracketed spelling; brackets are surface syntax only.
 */
export interface TypeRef {
  graph: string;
  /**
   * The bare position name an UNPINNED single-hop address lands on —
   * `<kg-[:company]->>` stores `position: 'company'`, derived by the parser
   * from `hopsRaw` (the same judgement `eventAddressKey` makes: no pins ⇒ the
   * bare name). A pinned address (a WHERE) narrows below any one name, so it
   * leaves `position` unset. Never set without `hopsRaw`: the dotted
   * `<graph.position>` spelling is RETIRED — `.` reads a property, an edge is
   * an address — and parse-errors with the exact address replacement.
   *
   */
  position?: string;
  /**
   * The ADDRESS form's hop chain — `<at-[:`Record Change` WHERE `table` ==
   * "tblDeals"]->>` stores `graph: 'at'` and `hopsRaw: '-[:`Record Change`
   * WHERE `table` == "tblDeals"]->'`.
   *
   * A type annotation is an ADDRESS. The dotted form flattened a walk into a
   * name, which has nowhere to put a WHERE — and an event edge and a position
   * type shared one namespace under it, so `<crm.Event>` could not say which
   * it meant.
   *
   */
  hopsRaw?: string;
  span: Span;
}

/** A traversal head: optional in-scope root name + raw hop chain (existing grammar). */
export interface PathHead {
  root?: string;
  /** e.g. `-[c:companies]->` or `-[c:companies]->-[d:deals]->`; empty string is invalid. */
  hopsRaw: string;
  span: Span;
}

// ── Top-level program ──

export interface Program {
  statements: Statement[];
}

export type Statement =
  | ImportStatement
  | AssignStatement
  | ShapeDeclaration
  | TypeDeclaration
  | MovementDeclaration
  | ListenDeclaration
  | WriteStatement
  | CallStatement
  | BlockStatement
  | LinkStatement
  | UnlinkStatement
  | DeleteStatement
  | RefreshStatement
  | IfStatement
  | AwaitStatement
  | CombinatorStatement
  | ReturnStatement
  | ErrorStatement;

/**
 * `return <value>` — the one way a body hands a value back.
 *
 * What it returns is an ordinary right-hand side: whatever can be BOUND to a
 * name can be returned, and nothing else exists to return. A body with no
 * `return` hands nothing back (it ran for its effects), so there is no bare
 * `return` — the absence of the statement already says that.
 *
 * The nearest enclosing body is what it returns FROM: a movement/function, a
 * traversal-headed block (once per iteration), or a closure. An `if` arm is
 * transparent, exactly as it is in TypeScript.
 */
export interface ReturnStatement {
  kind: 'return';
  value: RValue;
  span: Span;
}

// ── Imports ──

export type ImportSource =
  | { kind: 'builtin'; namespace: 'adapters' | 'credentials' | 'plugins' }
  | { kind: 'file'; path: string };

/** One entry of an import list: `name` or `name as alias`. */
export interface ImportedName {
  /** The name in the source namespace/file — what catalog resolution keys on. */
  name: string;
  /** Optional local rebinding (`import { acme_main as crm_creds }`) — when present, the in-scope name. */
  alias?: string;
}

export interface ImportStatement {
  kind: 'import';
  names: ImportedName[];
  source: ImportSource;
  span: Span;
}

// ── Assignment (the one binding form) ──

export interface AssignStatement {
  kind: 'assign';
  name: string;
  value: RValue;
  span: Span;
}

export type RValue =
  | { kind: 'construct'; construct: ConstructionCall }
  /**
   * `doc = email_to_doc(d: node { … })` — a bound CALL the parser could tell
   * apart from a construction, because an argument took a form only a call
   * accepts (a `node { … }`, an inline write). Where every argument is a plain
   * value the two forms are identical and the parser records the `construct`
   * above instead, leaving the decision to resolution (`constructionAsCall`).
   * Both routes reach the same check and the same execution.
   */
  | { kind: 'call'; call: CallStatement }
  | { kind: 'write'; write: WriteExpression }
  | { kind: 'link'; link: LinkExpression }
  | { kind: 'extract'; extract: ExtractExpression }
  | { kind: 'block'; block: TraversalBlock }
  | { kind: 'await'; await: AwaitExpression }
  /** `race([f, g])` / `parallel([f, g])` written WITHOUT `await` — a
   *  combinator composes a wait; `await` is what parks, so the checker refuses
   *  this with the rewrite. Parsed so the refusal can name it. */
  | { kind: 'combinator'; combinator: CombinatorExpression }
  /** `MAP(xs, f)` and its siblings — iteration over a value collection. */
  | { kind: 'collection'; collection: CollectionOpExpression }
  /** `MEMBERS(<Thesis>)` — a closed type's values, in declaration order. */
  | { kind: 'members'; members: MembersExpression }
  | { kind: 'inlineBlock'; inlineBlock: InlineBlockExpression }
  | { kind: 'callback'; callback: CallbackExpression }
  /** `(d: <date>) => { … }` / `() => { … }` — an anonymous closure. */
  | { kind: 'closure'; closure: ClosureExpression }
  | { kind: 'node'; node: NodeLiteral }
  | { kind: 'lazy'; lazy: LazyTraversal }
  | { kind: 'expr'; expr: ExprSlot };

/**
 * `lazy m-[a:Attachments]->` — a traversal whose WALK is deferred to the read.
 *
 * `await`'s dual, in the same syntactic slot and over the same `PathHead`:
 * `await` waits for the edge to exist, `lazy` waits to look at all. It changes
 * WHEN the walk runs, never what it yields — the type is the eager traversal's,
 * and every read re-walks the live source (no caching; layer 8 ruling 3).
 *
 */
export interface LazyTraversal {
  head: PathHead;
  /** `-> node { … }` — PER-ITEM synthesis: each landing is bound (by the hop's
   *  alias) and mapped through this literal, so what the walk yields is the
   *  renamed view rather than the source's own positions. See `NodeEntry`. */
  mapping?: NodeLiteral;
  span: Span;
}

/** `attio(credentials: acme_main, list: "Dealflow")` — an adapter type called with config. */
export interface ConstructionCall {
  callee: string;
  args: NamedArg[];
  span: Span;
}

/**
 * A value-position `f(a: x)` read as the CALL it is when `f` resolves to a
 * movement rather than an adapter type.
 *
 * The two are ONE surface form — `name(named: args)` — and nothing lexical
 * separates them, so the parser records the shape and resolution decides the
 * meaning. This is the projection both deciders share, so the checker and the
 * engine cannot disagree about what such a call's arguments are.
 *
 */
export function constructionAsCall(construct: ConstructionCall): CallStatement {
  return {
    kind: 'call',
    callee: construct.callee,
    args: construct.args.map((arg) => ({ kind: 'expr', name: arg.name, expr: arg.value })),
    span: construct.span,
  };
}

export interface NamedArg {
  name: string;
  value: ExprSlot;
  /**
   * The value is a TYPE reference, not an expression — `type: <company>`
   * in a kg listen's config. Types always wear angle brackets at the
   * surface (the universal type marker); the AST stores the unbracketed
   * spelling in `value.raw`, with `value.span` covering the `<…>`.
   * Listen-config only: constructions, plugin calls and run args never
   * carry type values.
   */
  isType?: boolean;
}

// ── Writes ──

export type WriteTarget =
  /**
   * `write crm-[:company]-> { … }` — the linked write mints the record and the
   * edge that reaches it in one move. Optionally `…-><company> { … }` names the
   * written type for polymorphic edges.
   */
  | { kind: 'linked'; path: PathHead; explicitType?: string; span: Span }
  /**
   * `write (company-[:investments]->, investor-[:investments]->) { … }` —
   * a tuple-path multi-parent write: ONE create at the convergence of N
   * parent edges. Each path is a linked-write path (a typed root handle
   * plus one declared edge); the written type is inferred from the edges
   * and must agree across paths. `explicitType` names it for polymorphic
   * edges, like linked writes.
   */
  | { kind: 'tuple'; paths: PathHead[]; explicitType?: string; span: Span }
  /**
   * `write a { … }` — update IN PLACE the record at the bound position
   * `a` (a traversal alias or a prior write result). No creation, no
   * identity resolution: you already have the exact record. Valid only
   * when `a` is a stable record and its adapter supports updates.
   */
  | { kind: 'position'; alias: string; span: Span };

export interface WriteExpression {
  target: WriteTarget;
  uniqueBy: UniqueClause[];
  fields: FieldEntry[];
  /**
   * `bind <name>` between the write target and the body — "this written
   * record IS the counterpart of `<name>`." Declares an engine-owned,
   * symmetric correspondence (binding) between the written position and
   * the bound record's position, across any pair of systems. The engine
   * owns the binding's storage, lifecycle, and id-based matching; the
   * adapter stays correspondence-agnostic. A bound write IGNORES `unique
   * by` (the binding IS the identity) and takes at most ONE bind
   * (compound binding deferred). Absent on writes that declare no
   * correspondence.
   *
   * DEPRECATED pending review (2026-06-23): the engine-owned, durable
   * correspondence state conflicts with the language's stateless-function /
   * derived-identity model. Undocumented on purpose; not surfaced as a
   * recommended construct. Parse/check/engine paths remain intact (no real
   * movement uses it) until the review decides removal vs a declarative
   * replacement. See plans/2026-06-23-deprecate-bind-pending-review/0_mission.md.
   *
   */
  bind?: BindClause;
  span: Span;
}

/** `bind other` — the bound counterpart record's name, captured with its
 *  span for diagnostics. The name must resolve (in the checker) to a
 *  stable record position. */
export interface BindClause {
  name: string;
  span: Span;
}

/** A write used as a statement without binding its handle. */
export interface WriteStatement {
  kind: 'write';
  write: WriteExpression;
  span: Span;
}

/**
 * Per-field write-precedence — the rule the engine applies when a field already
 * has a value. Absent = `replace` (plain `name: expr`). The merge is computed in
 * the engine against the target's current value (read via `readRecord`); the
 * adapter always writes a single final value.
 *
 *   - `'fill'`           — `name ?: expr`  — write only when the current value
 *                          is empty (null/undefined/empty list). Single or multi.
 *   - `'append'`         — `name +: expr`  — multi-value only: current ++ expr
 *                          (duplicates allowed).
 *   - `'append-missing'` — `name +?: expr` — multi-value only: append only the
 *                          elements of expr not already present (set union).
 *
 * On a CREATE all modes collapse to a plain set (there is no current value).
 */
export type FieldWriteMode = 'fill' | 'append' | 'append-missing';

export interface FieldEntry {
  name: string;
  value: ExprSlot;
  /** Write-precedence operator; absent ⇒ `replace`. See {@link FieldWriteMode}. */
  semantics?: FieldWriteMode;
  span: Span;
}

/**
 * One `unique by (…)` clause — a predicate that finds the existing record this
 * write should resolve onto. The predicate is a full expression, captured as a
 * raw slot and bridged like any other: `\`email\`` (bare field → "the same
 * email as the one being written"), `\`stage\` == "Open" AND \`updated\`
 * WITHIN 30d`, a bound parent handle (edge-scoped identity), or any
 * combination. Repeated clauses are OR-ed.
 */
export interface UniqueClause {
  predicate: ExprSlot;
  span: Span;
}

// ── Node literals (in-memory node synthesis) ──

/**
 * `node { title: m.`Subject`, company: node { name: … } }` — an in-memory
 * position synthesised from a literal, and the language's composition
 * currency: it belongs to no graph, so it is typed STRUCTURALLY from what
 * the literal writes.
 *
 * It sits on the POSITION plane, not the value plane — like `write`, and
 * unlike anything the expression grammar parses. So it appears exactly
 * where a position is spelled out: bound to a name (`d = node { … }`), as
 * a call argument (`process(d: node { … })`), and as an entry of another
 * literal.
 *
 */
export interface NodeLiteral {
  entries: NodeEntry[];
  span: Span;
}

/**
 * One entry of a node literal. Ruling 1: the entry expression's KIND decides
 * what it declares — no marker syntax. A VALUE is a field (the dot plane); one
 * or more nested literals are an EDGE (the arrow plane), a single literal
 * declaring an edge with one synthesised landing and a list declaring a plural
 * one (ruling 5).
 */
export type NodeEntry =
  /** `title: m.`Subject`` — a field. */
  | { kind: 'value'; name: string; value: ExprSlot; span: Span }
  /** `company: node { … }` / `files: [node { … }, node { … }]` — an edge whose
   *  landings are synthesised here. `nodes` holds them in source order; one
   *  entry is the single-landing form. */
  | { kind: 'nodes'; name: string; nodes: NodeLiteral[]; span: Span }
  /**
   * `files: m-[a:Attachments]->` / `files: lazy m-[a:Attachments]->` — a
   * PASS-THROUGH edge: its landings are the walked source's REAL positions,
   * carrying their own field names and their own values (a FileRef included)
   * with nothing copied in between.
   *
   * With a `mapping` (`-> node { name: a.`Name`, blob: a.`File` }`) the edge is
   * PER-ITEM synthesised instead: every landing is bound to the hop's alias and
   * mapped through the nested literal, so the callee sees the names the mapping
   * chose and never couples to the source's. The values still come from the
   * real source — the wrapper is renaming, not copying.
   *
   * `lazy` is the same modifier the RValue takes (`LazyTraversal`) and means
   * the same thing here: eager walks (and synthesises) where the literal is
   * written, lazy walks and synthesises at every read.
   */
  /**
   * `messages: <slack-[:Channels]->-[:Messages]->>` — an edge DECLARED and
   * EMPTY. The value is an address type marker, the same one a movement
   * parameter accepts, and it says what the landings will BE; `link` appends
   * them as the run goes.
   *
   */
  | { kind: 'declared'; name: string; type: TypeRef; span: Span }
  | {
      kind: 'traversal';
      name: string;
      head: PathHead;
      lazy: boolean;
      mapping?: NodeLiteral;
      span: Span;
    };

/** A name re-spelled as SOURCE TEXT: bare when it scans as an identifier,
 *  backtick-quoted otherwise. The scanner STRIPS backticks (`PathHead.root`
 *  holds the unquoted name), so anything that recomposes source text from a
 *  parsed name must put them back — recomposing bare is how a backticked
 *  traversal root failed to re-parse (layer 13). */
export function spellName(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `\`${name}\``;
}

/** A path head re-spelled as source text — the one sanctioned way to rebuild
 *  `root-[…]->` text from a parsed head. */
export function spellPathHead(head: Pick<PathHead, 'root' | 'hopsRaw'>): string {
  return `${head.root === undefined ? '' : spellName(head.root)}${head.hopsRaw}`;
}

// ── Traversal-headed blocks ──

/**
 * `crm-[c:Companies]-> { … }` — the body runs once per landing. BOUND
 * (`names = crm-[c:Companies]-> { return c.\`Name\` }`) its value is the list
 * of what each iteration returned; unbound it runs for its effects. Bindings
 * made inside stay inside — the only way out is `return`.
 */
export interface TraversalBlock {
  head: PathHead;
  body: Statement[];
  span: Span;
}

export interface BlockStatement {
  kind: 'block';
  block: TraversalBlock;
  span: Span;
}

// ── Link statements (the edge-only write) ──

/** What a `link` connects its source to. */
export type LinkTarget =
  /** `link a -[:e]-> b` — both records already written and bound. */
  | { kind: 'handle'; name: string }
  /**
   * `link c -[:portfolio]-> { name: "Fund III" }` — the target is FOUND
   * by identity criteria: the body's fields resolve an existing record
   * (adapter candidate search + arbitration, exactly as a write's
   * identity does) but the target is NEVER created and NEVER written.
   * `explicitType` names the found type for polymorphic edges, like
   * linked writes.
   */
  | { kind: 'criteria'; explicitType?: string; fields: FieldEntry[]; span: Span };

/**
 * The edge-only write of the symmetric family (`write` node+edge, `link`
 * edge only, `unlink` edge removal, `delete` node+edges). Used as a
 * statement, or — criteria form only — bound: `p = link c-[:e]-> { … }`
 * yields the FOUND target's handle.
 */
export interface LinkExpression {
  from: string;
  edge: string;
  target: LinkTarget;
  span: Span;
}

/** `link champion -[:led]-> part` / `link c -[:portfolio]-> { … }`. */
export interface LinkStatement {
  kind: 'link';
  link: LinkExpression;
  span: Span;
}

/** `unlink a -[:e]-> b` — sever an edge between two written handles
 *  (the inverse of the bare-handle `link`). */
export interface UnlinkStatement {
  kind: 'unlink';
  from: string;
  edge: string;
  to: string;
  span: Span;
}

/** `delete <handle>` — remove the record a written handle stands on. */
export interface DeleteStatement {
  kind: 'delete';
  name: string;
  span: Span;
}

/**
 * `refresh <handle>` — re-fetch the record behind a STABLE write/traversal
 * handle and move its field snapshot to now (asks-as-adapter F5/F22). Fields
 * read the snapshot, hops stay live; `refresh` moves the snapshot. Counts as a
 * READ (legal inside an `await`/`until` pure condition). The head must be a
 * re-fetchable record (a write handle or a traversed record) — refreshing the
 * event payload or an extracted node is a checker error (no record id to
 * re-fetch by); a refresh of a since-deleted record is a loud RUN error.
 */
export interface RefreshStatement {
  kind: 'refresh';
  name: string;
  nameSpan: Span;
  span: Span;
}

// ── Branching ──

export interface IfStatement {
  kind: 'if';
  /** `if` plus any `else if` arms, in order. Each arm spans its condition
   *  through its closing brace — an arm is a SCOPE (its condition's IS tests
   *  narrow into it), so it needs its own extent, not the statement's. */
  arms: Array<{ condition: ExprSlot; body: Statement[]; span: Span }>;
  /** The trailing `else` — one fact (body + its extent), so there's no
   *  "body without a span" state to keep in sync. Spans the `else` keyword
   *  through its closing brace. */
  elseArm?: { body: Statement[]; span: Span };
  span: Span;
}

// ── Durations ──

/** A bare unit-suffixed duration literal (`4h`, `2d`, `90m`, `1h30m`) captured
 *  verbatim; the unit grammar is validated in the checker. */
export interface DurationLiteral {
  raw: string;
  span: Span;
}

/**
 * `await a-[:Response]->` / `r = await a-[:Response]->` / `await sleep(2d)` —
 * durably wait on a named WAKE SOURCE, then resume the branch forward
 * (asks-as-adapter, plans/2026-07-23-asks-as-adapter/, P18). Two sources in
 * chunk B:
 *   - a `traversal` over an AWAITABLE edge (`untilNonEmpty`): the engine
 *     evaluates the (possibly WHERE-narrowed, PURE-predicate) traversal live;
 *     nonempty → continue inline, else park until a landing resolves it. A
 *     bound `await` binds the landed node(s); an empty resolution binds an
 *     empty match (downstream blocks run zero times).
 *   - `sleep(<duration>)`: the existing timer park re-skinned as a promise —
 *     the clock is the wake source. Binds nothing.
 * (`race`/`until` are later chunks; this AST models only the two chunk-B forms.)
 */
export interface AwaitExpression {
  source: AwaitSource;
  span: Span;
}

export type AwaitSource =
  /** `await <head>-[:Edge WHERE …]->` — wait until the traversal is nonempty.
   *  RETIRED SPELLING (layer 13 C1): still parses so the checker can refuse it
   *  with the rewrite; the living form is `first` below. */
  | { kind: 'traversal'; head: PathHead; span: Span }
  /**
   * `await FIRST(<head>)` — the parked FIRST: the same read `FIRST(<head>)`
   * performs, parked until it has a landing, so the binding carries the
   * landing WITHOUT the "not yet" arm (`T`, not `T | null`). Legal only where
   * waiting can end — the final edge must be awaitable, exactly as the bare
   * form required.
   *
   */
  | { kind: 'first'; head: PathHead; span: Span }
  /**
   * `await race([…])` / `await parallel([…])` — the combinator wake sources
   * (core calculus v2 R5). Both take one ordinary argument: the ARMS, a
   * collection of function values the combinator invokes concurrently.
   *
   */
  | { kind: 'combinator'; combinator: CombinatorExpression; span: Span }
  /** `await sleep(<duration>)` — wait a fixed interval (the clock wake source). */
  | { kind: 'sleep'; duration: DurationLiteral; span: Span }
  /**
   * `await until(<condition>, every: <duration>)` — the CLOCK, RECURRING wake
   * source (P18/F12). The engine evaluates the BOOLEAN `condition` each tick (a
   * recurring timer park) and resolves when it holds. `every` is the cadence,
   * named (default 1h, floor 1m). The condition is READ-ONLY (refresh allowed;
   * writes/asks/awaits/race are checker errors); liveness is explicit — a
   * re-fetch is written `refresh` inside the closure body.
   *
   * A comparand is not a second argument: it is an equality in the condition
   * (`until(x == "done", every: 5m)`).
   */
  | {
      kind: 'until';
      condition: UntilCondition;
      every?: DurationLiteral;
      span: Span;
    };

/**
 * The `until` condition — a CLOSURE returning boolean (`() => { refresh a;
 * return a.\`State\` == "done" }`), run once per tick, or a plain boolean
 * expression (`COUNT(m-[:a]->) >= 3`), which is the same closure with the
 * ceremony elided.
 */
export type UntilCondition =
  | { kind: 'closure'; closure: ClosureExpression }
  | { kind: 'expr'; expr: ExprSlot };

/** `await …` used as a statement without binding its result (the unbound form —
 *  `await a-[:Response]->`, `await sleep(2d)`). The bound form parses as an
 *  `AssignStatement` whose RValue is `{ kind: 'await' }`. */
export interface AwaitStatement {
  kind: 'await';
  await: AwaitExpression;
  span: Span;
}

/**
 * `race([f, () => sleep(3d)])` / `parallel([f, g])` — the two concurrency
 * combinators (core calculus v2 R5). Both take ONE ordinary argument: the arms,
 * a collection of FUNCTION values, invoked concurrently. There is no special
 * evaluation zone — the bracket is an ordinary eager list of closures and
 * function names, and "evaluate as soon as reached" holds inside it as
 * everywhere else.
 *
 * `race` settles at the first arm to settle and stops listening on arms parked
 * at a suspension; `parallel` joins every arm. Both hand back a POSITIONAL
 * receipt — an ordinary value, one slot per arm, in the arms' own order — so
 * "the timer won" and "the value is absent" are one null check on a slot.
 *
 */
export interface CombinatorExpression {
  kind: 'race' | 'parallel';
  arms: CombinatorArms;
  span: Span;
}

/**
 * The arms a combinator runs. A LITERAL bracket is a fixed, author-written set,
 * so each slot is typed exactly (a tuple); anything else is a collection built
 * at run time, so the arms are same-typed and the receipt is a list.
 */
export type CombinatorArms =
  | { kind: 'literal'; arms: ArmExpression[]; span: Span }
  | { kind: 'dynamic'; expr: ExprSlot; span: Span };

/** One literal arm: a closure written in place, or a name already bound to a
 *  function (a movement, or a closure bound earlier). */
export type ArmExpression =
  | { kind: 'closure'; closure: ClosureExpression; span: Span }
  | { kind: 'ref'; name: string; span: Span };

/**
 * `MAP(xs, f)` / `FILTER(xs, f)` / `REDUCE(xs, init, f)` / `GROUPBY(xs, key)` /
 * `KEYBY(xs, key)` — iteration over a VALUE collection, with a function.
 *
 * They live where `race` and `parallel` live rather than among the expression
 * functions, and for the same reason: the argument is a FUNCTION, and a
 * function's body is a body — statements, `return`, everything a body may do.
 * Positions keep the traversal-headed block; this is the values' form.
 */
export interface CollectionOpExpression {
  op: CollectionOp;
  /** The collection being read. */
  source: ExprSlot;
  /** `REDUCE`'s starting value — the fold's zero, and the only op with one. */
  init?: ExprSlot;
  /** The function, written in place or named — an arm, in every sense the
   *  combinators mean it. */
  fn: ArmExpression;
  span: Span;
}

export type CollectionOp = 'map' | 'filter' | 'reduce' | 'groupby' | 'keyby';

/**
 * `MEMBERS(<Thesis>)` — a closed type's values, as a list in the order they
 * were DECLARED. That order is a property of the type, which is the point: a
 * report's sections come from the declaration rather than from a hand-written
 * list that drifts from it.
 *
 * `type` is the annotation as written — a declared refinement's name, or a
 * borrowed path into a live field's option set — read with the same marker
 * grammar an extract field's annotation uses.
 */
export interface MembersExpression {
  type: string;
  span: Span;
  /** The annotation's own span, for a diagnostic that points at the type. */
  typeSpan: Span;
}

/** `race([…])` / `parallel([…])` written as a statement, without `await`. A
 *  combinator composes a wait and `await` is what parks, so this is refused
 *  with the rewrite — it parses so the refusal can name it. */
export interface CombinatorStatement {
  kind: 'combinator';
  combinator: CombinatorExpression;
  span: Span;
}

/**
 * `(d: <date>) => { … }` — an anonymous CLOSURE: the parameter grammar every
 * callable shares, an arrow, and a body. It is a VALUE — bind it, pass it,
 * park with it — and it is (AST, captured bindings): the body rides across a
 * park as itself, the capture as ordinary serialised bindings.
 *
 * Its body returns like any other body (`return <value>`), which is what makes
 * `until(() => { … return <bool> })` an ordinary closure rather than a special
 * condition form.
 */
export interface ClosureExpression {
  params: MovementParam[];
  body: Statement[];
  span: Span;
}

/**
 * `{ …statements…; binding = … }.binding` — RETIRED (core calculus v2): reading
 * a block's inner binding by name is naming-is-exporting, which explicit
 * `return` replaces. Still PARSED so the checker can refuse it with the
 * replacement — a closure returning the value.
 */
export interface InlineBlockExpression {
  body: Statement[];
  /** The `.name` accessor that names which of the block's bindings this reads. */
  binding: string;
  bindingSpan: Span;
  span: Span;
}

// ── Callbacks (the deferred, addressable invocation) ──

/**
 * `cb = callback(<subject>)` / `callback(<subject>, { once: …, ttl: … })` —
 * mints a DEFERRED INVOCATION addressable by an opaque id. The binding reads
 * `.id` (the payload every platform button/tap carries) and `.url` (the human
 * link). A callback is strictly scoped to its run — JS closure semantics: it
 * captures the enclosing scope, firing it RESUMES the parked run at the
 * subject's entry point, and the run ending revokes what never fired.
 *
 */
export interface CallbackExpression {
  subject: CallbackSubject;
  /**
   * `{ once: <boolean>, ttl: <duration> }` — the OPTIONAL config object,
   * always the second argument. Kept as raw named args (no key-driven parsing):
   * the checker owns the closed vocabulary (`once` defaults TRUE; `ttl` is a
   * duration literal) and reports an unknown key with a did-you-mean.
   */
  config: NamedArg[];
  /** The config object's span, for diagnostics; absent when no config was given. */
  configSpan?: Span;
  span: Span;
}

/** What a callback defers: an anonymous inline movement, or a named one. */
export type CallbackSubject =
  /**
   * `callback({ … })` — an anonymous inline movement with no parameters; or
   * `callback((d: <date>) => { … })` — one with parameters, the values the
   * PLATFORM supplies at fire time (a picked date, entered text). The parameter
   * list is the movement-declaration parameter grammar verbatim; the arrow
   * separates it from the body, and the bare-brace form is the elision of an
   * empty parameter list.
   *
   * `callback()` / `callback((d: <date>))` — the BODY-LESS forms — are the
   * same node with an EMPTY body, not a variant: firing one records the call
   * and wakes whoever awaits `Called`, which is what an empty body does. It is
   * the minimal confirm pattern (`cb = callback(); await cb-[:Called]->`).
   */
  | { kind: 'inline'; closure: ClosureExpression; span: Span }
  /**
   * `callback(send_reminder)` / `callback(send_reminder(who: "sam"))` — the
   * ONLY position in the language where a movement is a value. The optional
   * argument list supplies the FIXED arguments (named, like any call); the
   * parameters it leaves unsupplied are the callback's fire-time signature,
   * bound by the router from what the platform sends.
   */
  | { kind: 'named'; movement: string; args: CallArg[]; nameSpan: Span; span: Span };

/** `ERROR("message")` — fail the whole run with a reason (3f). Used as a
 *  statement and as a `fallback … to` terminal. */
export interface ErrorStatement {
  kind: 'error';
  message: ExprSlot;
  span: Span;
}

// ── Calls ──

/**
 * Call arguments are NAMED, matching the callee's parameter names
 * (3_syntax_sketch.md, 2026-06-11: parens = callable arguments, always
 * named). Positional arguments are a parse error. The checker matches
 * arguments to parameters by `name`.
 */
export type CallArg =
  /** `log_lead(l: m)` — a named expression argument. */
  | { kind: 'expr'; name: string; expr: ExprSlot }
  /** RETIRED (wave 4): inline shape-write adaptation,
   *  `files_to_dropbox(file: write Files-[:file]-> { … })`. Still PARSED — the
   *  checker refuses it by name and points at the `node` form below, which it
   *  can only do if the grammar still reaches it — and still RUN, for programs
   *  saved before the refusal. */
  | { kind: 'write'; name: string; write: WriteExpression }
  /** inline node synthesis: `process_deal(d: node { title: m.`Subject` })` */
  | { kind: 'node'; name: string; node: NodeLiteral }
  /**
   * A CALL, passed on: `log_doc(d: email_to_doc(m: msg))`. The utility idiom —
   * one movement's value is another's argument — so it is a position argument
   * like the two above, not an expression: the value is a node, and nothing in
   * the expression plane can hold one.
   *
   * Recognised by the NAMED-argument form (`f(x: …)`), which is the whole
   * grammar of a call and no part of any expression: every stdlib function is
   * positional.
   *
   */
  | { kind: 'call'; name: string; call: CallStatement };

/**
 * `log_doc(d: msg)` — a movement invoked. A call is a STATEMENT and an
 * ARGUMENT (`CallArg`'s `call` kind) with one AST node, because it is one
 * thing: a call's value is what the callee RETURNS, and using it is optional
 * (a callee that returns nothing is a statement and nothing else).
 *
 */
export interface CallStatement {
  kind: 'call';
  callee: string;
  args: CallArg[];
  span: Span;
}

// ── Node declarations ──

/**
 * `node doc { title: <text>  node file { … } }` — a NAMED node declaration: the
 * structure a parameter is checked against, written as the tree it describes.
 *
 * The declaration IS its root node. Nesting declares the edge and the nested
 * node's name IS the edge name, so `<doc>` types the root directly and
 * `d-[f:file]->` traverses to the child — one nesting idiom shared with the
 * extract tree and the node literal.
 *
 * The AST discriminant stays `'shape'` (and the types keep their names) because
 * a parked run's scope descriptors persist it: rehydrating a run saved before
 * the syntax change must still find its code refs.
 *
 */
export interface ShapeDeclaration {
  kind: 'shape';
  name: string;
  /** The declaration's own node — `name` is the declaration's name. */
  root: ShapeNode;
  /** Declared with the `export` prefix — offered to other files. A file
   *  with at least one export is a LIBRARY. */
  exported?: boolean;
  span: Span;
}

/** One node of a declaration tree. A child's `name` is the edge that reaches it. */
export interface ShapeNode {
  name: string;
  fields: Array<{ name: string; type: string; span: Span }>;
  children: ShapeNode[];
  span: Span;
}

/**
 * `type Thesis = <"A" | "B">` — an author-declared REFINEMENT: a closed set of
 * text values, the WRITTEN twin of an option set borrowed from a live field
 * (`<crm-[:companies]->.\`funding_stage\`>`). Both resolve to the same closed
 * enum, so a declared type does everything a borrowed one does — constrains the
 * extraction, hints the prompt, and checks a literal with a did-you-mean.
 *
 * The values are plain text at run time; nothing new exists at run time at all.
 * What the declaration adds is the set the checker checks against.
 */
export interface TypeDeclaration {
  kind: 'type';
  name: string;
  /** The values, in the order written. */
  options: string[];
  span: Span;
}

// ── Movements ──

/** One typed parameter of a callable — a movement declaration's, and (the same
 *  grammar, the same node) an anonymous inline movement's inside `callback`. */
export interface MovementParam {
  name: string;
  /**
   * The written type. ABSENT where the caller supplies it — a collection op
   * hands its function one element, and the element's type is the
   * collection's, so `MAP(xs, (x) => …)` needs no annotation to know what `x`
   * is (TypeScript types a callback's parameter the same way, from the
   * signature it is passed to). Everywhere else a parameter's type is what the
   * declaration promises its callers, so leaving it out is refused.
   */
  type?: TypeRef;
  span: Span;
}

/**
 * `movement <name>(<params>) { … }` — and, since the callback work, `function
 * <name>(…) { … }`: the two spellings are ONE declaration. `function` is a pure
 * parser alias (authoring LLMs' priors are strong for it, and movements now
 * behave like functions — parameters, invocation by name), so the AST keeps a
 * single node kind and nothing downstream can tell them apart.
 *
 */
export interface MovementDeclaration {
  kind: 'movement';
  name: string;
  params: MovementParam[];
  body: Statement[];
  /** Declared with the `export` prefix — offered to other files. A file
   *  with at least one export is a LIBRARY. */
  exported?: boolean;
  span: Span;
}

// ── Listeners ──

/**
 * `listen to inbox { key: "dealflow" } fire dealflow_intake` — a file-level
 * statement declaring that events on a constructed adapter instance fire a
 * movement. Trigger rows are fully DERIVED from these (one per listen); a
 * file with no listens is a library. The config block is the trigger's
 * adapter-specific routing config (e.g. the email plus-address `key`) and
 * may be omitted.
 *
 * A system whose RECORDS change is listened to the same way — the knowledge
 * graph included, which is constructed and named like any other:
 *
 *   graph = kg()
 *   listen to graph { type: "Company", events: ["record.created", "record.updated"],
 *                     fields: [Domains] } fire on_company_change
 *
 * Every value here is a plain quoted one: `type` pins which record type is
 * watched, `events` names the uniform `record.*` change kinds, and `fields`
 * narrows updates to ones touching the named properties. What the listen
 * FIRES is the change, not the record — the fired movement's parameter is the
 * event position (`change: <graph-[:`Record Change` WHERE `type` ==
 * "Company"]->>`) and the record is one hop along its `Record` edge.
 *
 * `listen` is the ONLY invoker (the former `run` entry retired when time
 * and manual runs collapsed into adapters). Every channel is constructed
 * EXPLICITLY and named first, then listened to by name: scheduled work
 * constructs a cron instance (`timer = cron()`; `listen to timer { schedule:
 * "0 9 * * 1" } fire digest`), on-demand work a manual one (`go = manual()`;
 * `listen to go {} fire backfill` — "Run now" injects an event on that
 * channel). The fired movement's parameter is typed against the SAME named
 * instance (`go: <go-[:invocation]->>`).
 *
 * An inline construction — `listen to manual() {}` — still parses (the call
 * lands in `construct`) but the checker rejects it: an instance exists only
 * from an explicit `name = adapter()` construction (spec
 * `plans/2026-06-24-required-instantiation/0_spec.md`). `construct` is kept
 * on the node only so the checker can recognise that mistake and guide the
 * fix.
 */
export interface ListenDeclaration {
  kind: 'listen';
  /** The listened name — a constructed instance, always. (When `construct` is
   *  present the author wrote the now-rejected inline form — `instance` then
   *  carries the adapter name from the call.) */
  instance: string;
  /** Lane name from a leading `listen as "<alias>"`. Derives the trigger name
   *  at provisioning time; absent → today's derived name. */
  alias?: string;
  /** `listen to manual() …` — the inline construction call. Present only for
   *  the rejected inline form; the checker reports it and points at the
   *  named-construction fix. */
  construct?: ConstructionCall;
  config: NamedArg[];
  movement: string;
  span: Span;
}

// ── Extraction ──

/**
 * `extract "thorough" from [data…] through [plugins…] { stage } through [plugins…] { stage } …`
 * Stages alternate with `through` pipelines; a stage's `through` is the pipeline that
 * runs before it (absent on the first stage unless declared on `from`). A stage
 * INHERITS the fields of the stage before it and declares only what it transforms,
 * so a node's shape is every field it declares anywhere.
 */
export interface ExtractExpression {
  from: ExprSlot[];
  stages: ExtractStage[];
  /**
   * How much thinking this extraction is worth — `AI()`'s tier vocabulary,
   * one concept across both surfaces. Carried VERBATIM as it was written (the
   * checker owns the closed set and the did-you-mean), and STATEMENT-level:
   * it applies to every call the extraction makes, at every stage. Per-stage
   * tiers are deliberately absent — an extraction is one declared tree, and a
   * reader should not have to assemble its cost from its stages.
   */
  tier?: string;
  span: Span;
}

export interface ExtractStage {
  /** The pipeline this stage's context passed through before extraction; absent for an unpiped first stage. */
  through?: PluginCall[];
  fields: ExtractField[];
  children: ExtractNode[];
  span: Span;
}

/**
 * `name: "description"`, `amount: <number> "description"`, or a BORROWED
 * type — an edge into another graph's schema, then the field as a property
 * tail, resolved live: `stage: <crm-[:companies]->.\`funding_stage\`>
 * "description"`. (The AST stores the resolver's `<instance>.<root>.<field>`
 * segments; the surface spelling is the address-then-property form.)
 */
export interface ExtractField {
  name: string;
  /** Optional explicit type annotation (surface-bracketed, stored bare):
   *  a primitive type name or a borrowed instance.root.field path. Only
   *  explicit annotations constrain extraction; an unannotated field
   *  flowing into a typed write target gets a checker SUGGESTION to
   *  annotate, never a silent adopted type. */
  type?: string;
  description: string;
  span: Span;
}

/** `node company: "description" { stage } through […] { stage } …` */
export interface ExtractNode {
  name: string;
  description: string;
  stages: ExtractStage[];
  span: Span;
}

/** `vc_url_retrieval(urls: urls)` or bare `scrub_sensitive` inside a `through [...]`. */
export interface PluginCall {
  plugin: string;
  args: NamedArg[];
  span: Span;
}

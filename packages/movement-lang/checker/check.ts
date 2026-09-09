// Checker for the movement language.
// Spec: plans/2026-06-10-data-movement-language/4_type_system.md.
//
// M2a (binding layer): checks 1 (import/construction validity) and 3
// (bound-before-read & parallel sibling isolation) — plus the scoping
// model: file/movement/traversal/branch scopes, traversal-block bindings
// that do NOT escape (only the block's assigned meta-node does), traversal
// aliases scoped to their block body, movement/shape hoisting, calls, and
// `through`-argument phasing inside `extract` trees.
//
// M2b (schema-typed layer, built on checker/typing.ts): checks 2 (write
// root/field validity), 4 (traversal validity), 5 (linked writes), 6 (IS
// narrowing), 7 (call fit), 8 (effect typing: write handles, block
// meta-nodes), 9 (extraction-tree validity + explicit type annotations,
// primitive or BORROWED by dotted path, with write-target adoption
// demoted to an info-severity annotation suggestion). Types attach to
// ScopeSymbols where derivable —
// construction → instance schema, write → handle, extract → inferred
// result graph, block → meta-node, parameter → TypeRef resolution — and
// every typed check fires only where the type is KNOWN; unknown stays
// silent (no false positives from missing schemas).
//
// Diagnostics are COLLECTED, never thrown — the checker is the feedback
// surface of the agent's author → typecheck → repair loop, so it reports
// every problem it can find with the most precise span it has.
//
// Name references inside expression slots come from the expression bridge:
// each slot is parsed by `parseMovementExpression` / `parseMovementCondition`
// (bridge parse failures become MOV_EXPR_PARSE), and the resulting formula
// AST is walked for the names that resolve against statement scope —
// `traverse.aliasRoot` / `alias_ref` nodes, plus slots that are exactly one
// bare identifier. Formula `property` references relative to the ambient
// position (backticked or nested bare names like `AI(prompt_binding)`) are
// NOT scope references and are deliberately not resolved here; ambient
// property validity is M2b's schema work.

import type { Expression, TraversalStep } from '@listen-fire/shared/expression/types';
import { quoteName } from '@listen-fire/shared/expression/formula';
import { constructionAsCall, spellPathHead } from '../parser/ast';
import {
  AwaitExpression,
  AwaitSource,
  AssignStatement,
  CallbackExpression,
  CallArg,
  CallbackSubject,
  CallStatement,
  ConstructionCall,
  ErrorStatement,
  ExprSlot,
  UniqueClause,
  ExtractExpression,
  ExtractField,
  ExtractStage,
  IfStatement,
  ImportStatement,
  InlineBlockExpression,
  LazyTraversal,
  LinkExpression,
  ListenDeclaration,
  Loc,
  MovementDeclaration,
  MovementParam,
  NamedArg,
  NodeEntry,
  NodeLiteral,
  PathHead,
  PluginCall,
  Program,
  CombinatorExpression,
  CollectionOp,
  CollectionOpExpression,
  MembersExpression,
  ArmExpression,
  RefreshStatement,
  RValue,
  ClosureExpression,
  ShapeNode,
  Span,
  Statement,
  TraversalBlock,
  TypeRef,
  WriteExpression,
} from '../parser/ast';
import { isValidDuration, durationToMs } from '../parser/duration';

export type { ReturnShape } from './typing';

/** The `until` cadence floor (F12 / build-order ops ruling): re-checking faster
 *  than once a minute is refused. */
const UNTIL_CADENCE_FLOOR_MS = 60_000;
import { unwrapCredentialArg } from '../parser/scan';
import { cronScheduleError, cronTimezoneError } from '@listen-fire/shared/cron';
import {
  BridgeError,
  splitUniquenessConjuncts,
  MovementCondition,
  parseMovementCondition,
  parseMovementExpression,
} from '../expression/bridge';
import {
  borrowableFieldsOf,
  borrowedTypeSegments,
  Catalog,
  writableEdgesOf,
  credentialArgOf,
  describeFieldType,
  EVENT_ACTION_FIELD,
  RECORD_DELETED_ACTION,
  FieldType,
  InstanceSchema,
  declaredTypeOf,
  parseFieldTypeName,
  type PluginSpec,
  type PositionSchema,
  SUPPRESS_SELF_KEY,
  surfaceNotEnumerated,
  unionKey,
  unionVariants,
  WritableRootSchema,
} from './catalog';
import {
  LinkDiagnosticCodes,
  linkImports,
  LinkedExport,
  LinkedFile,
  ProgramLink,
  ResolveFile,
} from './link';
import {
  type EventAddress,
  eventAddressDisplay,
  eventAddressKey,
  eventAddressOfHops,
  eventAddressSource,
  narrowingPrefixKey,
  listenNarrowing,
} from './event_address';
import {
  type RequiredPosition,
  schemaSurface,
  shapeToSchema,
  type SuppliedSurface,
  surfaceMisfit,
} from './conformance';
import {
  EffectFrame,
  EMPTY_ROW,
  rowFromDeclaration,
  UNKNOWN_ROW,
  type EffectRow,
} from './effects';
import { terminates } from './flow';
import { didYouMean } from './meta';
import { genericLandingKey, literalStringValuesOf } from './generics';
import { parseTraversalPath } from '../service/selectors';
import { Scope, ScopeKind, ScopeSymbol, SymbolKind } from './scopes';
import {
  CALLBACK_CONFIG_KEYS,
  CallbackParams,
  callbackType,
  checkEnumLiteral,
  aggregatedBarePath,
  bareName,
  checkEnumDomain,
  describePosition,
  checkJsonOpaque,
  displayNameOf,
  EXTRACT_ROOT_NAME,
  ExpressionTyping,
  type ExpressionEffect,
  ExtractNodeType,
  instanceOfType,
  fieldAssignable,
  fieldTypeCompatible,
  fieldTypeEquals,
  LocalEdge,
  InstanceRef,
  isMaybeAbsent,
  maybeAbsent,
  narrowPresent,
  narrowPresentNode,
  negativePresenceProofs,
  PositionTypeRef,
  ClosureParam,
  closureType,
  type CollectionOrder,
  listOf,
  collectionOrderOf,
  aiTierDiagnostics,
  collectionElementOf,
  type PlaneType,
  type ReturnShape,
  PresenceProof,
  presenceProofs,
  positionRefIn,
  positionSchemaOfRef,
  stripAbsent,
  TypedDiagnosticCodes,
  WriteTargetRef,
} from './typing';

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  code: string;
  message: string;
  span: Span;
  /** Absent means 'error'. 'warning' and 'info' diagnostics never gate a
   *  compile — warnings flag likely-unintended-but-legal authoring. */
  severity?: DiagnosticSeverity;
}

export function diagnosticSeverity(diagnostic: Diagnostic): DiagnosticSeverity {
  return diagnostic.severity ?? 'error';
}

export const DiagnosticCodes = {
  IMPORT_UNKNOWN: 'MOV_IMPORT_UNKNOWN',
  IMPORT_DUPLICATE: 'MOV_IMPORT_DUPLICATE',
  IMPORT_FILE_UNSUPPORTED: 'MOV_IMPORT_FILE_UNSUPPORTED',
  EXPR_PARSE: 'MOV_EXPR_PARSE',
  NAME_UNRESOLVED: 'MOV_NAME_UNRESOLVED',
  USE_BEFORE_BIND: 'MOV_USE_BEFORE_BIND',
  CONSTRUCT_NOT_ADAPTER: 'MOV_CONSTRUCT_NOT_ADAPTER',
  CONSTRUCT_BAD_ARG: 'MOV_CONSTRUCT_BAD_ARG',
  /** Warning severity: an enum-typed construction arg (an entry-position arg
   *  like Sheets' `spreadsheet:`) names a value this connection can't see. */
  CONSTRUCT_UNKNOWN_OPTION: 'MOV_CONSTRUCT_UNKNOWN_OPTION',
  CONSTRUCT_MISSING_CRED: 'MOV_CONSTRUCT_MISSING_CRED',
  CRED_WRONG_ADAPTER: 'MOV_CRED_WRONG_ADAPTER',
  DUPLICATE_DECL: 'MOV_DUPLICATE_DECL',
  /** An authored binding reuses a name an ENCLOSING scope already binds. The
   *  same-scope half of this is DUPLICATE_DECL; this is the cross-scope half,
   *  which used to resolve silently and leave one name meaning two things. */
  SHADOWED_NAME: 'MOV_SHADOWED_NAME',
  CALL_NOT_MOVEMENT: 'MOV_CALL_NOT_MOVEMENT',
  CALL_ARITY: 'MOV_CALL_ARITY',
  // Named-argument matching (calls and `run` both: parens = callable
  // arguments, always named; the checker matches arguments to parameters
  // by name, so order carries no meaning).
  /** An argument name that is not a parameter of the callee. */
  CALL_ARG_UNKNOWN: 'MOV_CALL_ARG_UNKNOWN',
  /** Parameters the argument list does not supply. */
  CALL_ARG_MISSING: 'MOV_CALL_ARG_MISSING',
  /** The same argument name given twice. */
  CALL_ARG_DUPLICATE: 'MOV_CALL_ARG_DUPLICATE',
  // Node literals (`node { … }` — in-memory node synthesis)
  /** The same entry name written twice in one node literal — one name, one
   *  meaning, and nothing says which of the two the callee would read. */
  NODE_ENTRY_DUPLICATE: 'MOV_NODE_ENTRY_DUPLICATE',
  /** An entry VALUE that is a NODE — `btn: b`, `f: FIRST(b-[:E]->)`. The value
   *  plane is scalar; a child edge is declared by a nested literal or a walk.
   *  Filing the node as an untyped field (the old behavior) went dark exactly
   *  where the author meant an edge. */
  NODE_ENTRY_NODE_VALUE: 'MOV_NODE_ENTRY_NODE_VALUE',
  /** A plural synthesised edge whose landings disagree about an entry's type.
   *  A traversal yields ONE landing type, so the landings must agree on what
   *  they carry; disagreeing silently would leave a read typed by whichever
   *  literal happened to come first. */
  NODE_LANDING_MISMATCH: 'MOV_NODE_LANDING_MISMATCH',
  /** A synthesised node passed where the parameter's declared type needs
   *  something the literal doesn't carry. A node belongs to no graph, so it is
   *  compared STRUCTURALLY: it fits when it has every field and edge the
   *  parameter declares (extras are fine — the callee can't see them). */
  NODE_ARG_SHAPE: 'MOV_NODE_ARG_SHAPE',
  /** A `link` onto an edge name the run-local node never declared. The literal
   *  is the whole of what the node has, so the edge is a typo rather than
   *  something a system might know about. */
  NODE_EDGE_UNDECLARED: 'MOV_NODE_EDGE_UNDECLARED',
  /** A `link` onto a `lazy` entry. Its landings come from a walk that runs
   *  again at every read, so an appended one would be gone by the next. */
  NODE_EDGE_DEFERRED: 'MOV_NODE_EDGE_DEFERRED',
  /** A `link` whose landing doesn't carry what the declared edge says its
   *  landings are — the same structural assignability an argument gets. */
  NODE_LINK_SHAPE: 'MOV_NODE_LINK_SHAPE',
  /** A criteria body (`link a -[:e]-> { … }`) on a run-local node. Criteria
   *  FIND a record in the from-side's graph; a node this run built has none. */
  NODE_LINK_CRITERIA: 'MOV_NODE_LINK_CRITERIA',
  THROUGH_NOT_PLUGIN: 'MOV_THROUGH_NOT_PLUGIN',
  THROUGH_BAD_ARG: 'MOV_THROUGH_BAD_ARG',
  /** A required argument (`PluginSpec.requiredArgs`) the call never wrote at
   *  all — distinct from one that resolves absent at run time, which the
   *  engine's skip-on-absent sentinel already covers honestly. Omitting the
   *  argument is an authoring mistake, not a data outcome, so it's refused
   *  here rather than left to skip the stage silently on every firing. */
  THROUGH_ARG_MISSING: 'MOV_THROUGH_ARG_MISSING',
  THROUGH_FORWARD_REF: 'MOV_THROUGH_FORWARD_REF',
  /** A plugin called as an ordinary function whose registry entry declares no
   *  effect row. A plugin is a function whose body nobody can walk, so the row
   *  is the only thing that says what folding a call into a movement would add
   *  — without one the honest place for it is a `through [ … ]` stage, whose
   *  pipeline bounds what it reaches. */
  PLUGIN_ROW_UNDECLARED: 'MOV_PLUGIN_ROW_UNDECLARED',
  /** A plugin called as an ordinary function when the EXTRACTION is what feeds
   *  it — its input is the `from [ … ]` text, or the fields the extract has
   *  produced so far. There is nothing for a bare call to pass it. */
  PLUGIN_FED_BY_EXTRACTION: 'MOV_PLUGIN_FED_BY_EXTRACTION',
  // Listeners (trigger rows are derived from `listen` statements)
  LISTEN_FILE_LEVEL: 'MOV_LISTEN_FILE_LEVEL',
  LISTEN_NOT_INSTANCE: 'MOV_LISTEN_NOT_INSTANCE',
  /** An adapter import used where a constructed instance is required — a
   *  movement parameter's position source (`<manual-[:invocation]->>`) or a
   *  `listen to`. Instantiation is explicit: construct + name the instance
   *  first (`go = manual()`), then reference it by name. */
  ADAPTER_NOT_CONSTRUCTED: 'MOV_ADAPTER_NOT_CONSTRUCTED',
  /** The listened system has no inbound surface at all — its manifest names
   *  zero trigger types, so nothing it does can ever reach us. A definite
   *  fact, not an unknown: see `AdapterSpec.canFire`. */
  LISTEN_CANNOT_FIRE: 'MOV_LISTEN_CANNOT_FIRE',
  LISTEN_PARAM_MISMATCH: 'MOV_LISTEN_PARAM_MISMATCH',
  LISTEN_SHAPE_MISMATCH: 'MOV_LISTEN_SHAPE_MISMATCH',
  LISTEN_DUPLICATE: 'MOV_LISTEN_DUPLICATE',
  LISTEN_ALIAS_DUPLICATE: 'MOV_LISTEN_ALIAS_DUPLICATE',
  LISTEN_BAD_CONFIG: 'MOV_LISTEN_BAD_CONFIG',
  /** Info severity: a dispatchable movement with no listen — nothing fires it. */
  LISTEN_MISSING: 'MOV_LISTEN_MISSING',
  // Native uniqueness vs authored `unique by`
  /** Info severity: the authored clause exactly duplicates a native rule.
   *  (The disjoint "conflict" case is intentionally NOT a diagnostic — the
   *  target matching on its own native rules is expected; the editor shows
   *  the native rules as an overlay hint on the write target instead.) */
  UNIQUE_NATIVE_REDUNDANT: 'MOV_UNIQUE_NATIVE_REDUNDANT',
  /** A `FUZZY` modifier on a `unique by` component whose target can't resolve
   *  identity by similarity (no `fuzzyResolution` capability). */
  UNIQUE_FUZZY_UNSUPPORTED: 'MOV_UNIQUE_FUZZY_UNSUPPORTED',
  /** `unique by (…)` on a target that decides record identity itself and does
   *  not accept author-defined uniqueness (the adapter declared
   *  `uniquenessAuthorable: false` — e.g. Affinity, whose org/person matching
   *  is native and not a thing a movement configures). */
  UNIQUE_NOT_AUTHORABLE: 'MOV_UNIQUE_NOT_AUTHORABLE',
  /** A write/link target rooted at a name that is not a graph this file
   *  declares (a constructed adapter instance, kg, or a shape). The
   *  canonical case is an instance-typed PARAMETER used as a write
   *  target — permanently rejected: schemas are per-credential, so an
   *  instance can't travel between movements; the writing movement
   *  constructs the instance itself. */
  WRITE_TARGET_NOT_GRAPH: 'MOV_WRITE_TARGET_NOT_GRAPH',
  /** RETIRED: a write whose target graph is a declared `node`
   *  (`write Lead-[:item]-> { … }`). A shape names a structure, not a system
   *  that stores anything, so the construct only ever pretended to be a write.
   *  `node { … }` synthesises the record instead, and carries edges a shape
   *  write never could. Refused at author time; the engine keeps running
   *  programs saved before the retirement until that path is deleted. */
  WRITE_SHAPE_RETIRED: 'MOV_WRITE_SHAPE_RETIRED',
  /** RETIRED: a type annotation that HOPS through a node declaration
   *  (`<Doc-[:item]->>`). A declaration used to wrap its nodes in a meta-node
   *  you had to hop past; it IS its root node now, so `<Doc>` starts where the
   *  author meant to start and the hop names a graph that no longer exists. */
  SHAPE_HOP_RETIRED: 'MOV_SHAPE_HOP_RETIRED',
  // Tuple-path multi-parent writes (`write (a-[:e]->, b-[:f]->) { … }`)
  /** The tuple's paths infer DIFFERENT written types — they must agree. */
  WRITE_TUPLE_MISMATCH: 'MOV_WRITE_TUPLE_MISMATCH',
  /** The written type declares required edges this write form doesn't establish. */
  WRITE_MISSING_REQUIRED_EDGE: 'MOV_WRITE_MISSING_REQUIRED_EDGE',
  /** The written type declares required fields this write's body never sets —
   *  the target would reject the create at runtime. */
  WRITE_MISSING_REQUIRED_FIELD: 'MOV_WRITE_MISSING_REQUIRED_FIELD',
  /** Info severity: a handle assigned directly to a reference-named field —
   *  nudge toward the link / tuple-path forms (one idiomatic spelling). */
  WRITE_LINK_FIELD_NUDGE: 'MOV_WRITE_LINK_FIELD_NUDGE',
  /** `+:` / `+?:` (append / append-if-missing) on a field that isn't a list —
   *  append only has meaning for a multi-valued field. */
  WRITE_APPEND_NOT_MULTI: 'MOV_WRITE_APPEND_NOT_MULTI',
  /** Warning severity: every field of a write is a `?:` (fill) with a
   *  possibly-absent value, so at runtime they can ALL be omitted and the write
   *  reaches the adapter empty. Gate it on presence instead (asks-as-adapter
   *  chunk D, from C's absence gate). */
  WRITE_MAY_BE_EMPTY: 'MOV_WRITE_MAY_BE_EMPTY',
  /** `x = write parent-[:edge]->` where the final edge is ephemeral —
   *  the write is an action (e.g. a typing indicator); nothing is created,
   *  so there is nothing to bind or chain from. */
  WRITE_EPHEMERAL_BOUND: 'MOV_WRITE_EPHEMERAL_BOUND',
  /** A write/link path ends on a READ-ONLY edge (`EdgeSchema.writable:
   *  false`) — the external system materialises those records itself (a
   *  message's inbound `attachments`), so nothing can be created or attached
   *  along it. Fires before the generic target-not-writable gate so the
   *  message names the EDGE's read-only nature, not the target's. */
  WRITE_READ_ONLY_EDGE: 'MOV_WRITE_READ_ONLY_EDGE',
  /** `link` / `unlink` along an edge the source system can only CREATE along
   *  (`EdgeSchema.linkable: false`). The write promise covers making the
   *  relationship as part of writing the target; it does not cover joining two
   *  records that already exist, and the system says so rather than letting
   *  the run find out. */
  LINK_UNSUPPORTED_EDGE: 'MOV_LINK_UNSUPPORTED_EDGE',
  // Position writes (`write a { … }` — update the record bound at alias `a`)
  /** The bare-alias write target doesn't resolve to a writable record
   *  position — a meta/extract/block node, or an unknown name, has no single
   *  record to update in place. */
  WRITE_POSITION_NOT_RECORD: 'MOV_WRITE_POSITION_NOT_RECORD',
  /** The bound position's system can't update records in place — its adapter
   *  doesn't implement `updateRecord` (e.g. an append-only Slack/Drive). */
  WRITE_POSITION_NO_UPDATE: 'MOV_WRITE_POSITION_NO_UPDATE',
  /** `unique by (…)` on a position write — you already hold the exact record,
   *  so there is nothing to resolve. */
  WRITE_POSITION_UNIQUE: 'MOV_WRITE_POSITION_UNIQUE',
  // Bound writes (`write crm-[:Company]-> bind other { … }` — engine-owned
  // correspondence between the written record and `other`'s record)
  /** The `bind` target doesn't resolve to a stable record position — it
   *  must name a record (a traversal alias, a prior write handle, the event
   *  position), the same shape correspondence is keyed on. */
  WRITE_BIND_NOT_RECORD: 'MOV_WRITE_BIND_NOT_RECORD',
  /** `unique by (…)` together with `bind` — the binding IS the identity,
   *  so field uniqueness has no role on a bound write. They don't compose. */
  WRITE_BIND_UNIQUE: 'MOV_WRITE_BIND_UNIQUE',
  /** `bind` on a position write (`write a bind … { … }`) — a position write
   *  already holds the exact record, so there is nothing to correspond. */
  WRITE_BIND_POSITION: 'MOV_WRITE_BIND_POSITION',
  /** `bind` against a target whose system can't update records in place
   *  (`supportsInPlaceUpdate` false — append-only Sheets, write-only Drive). A
   *  bound write re-fires as `updateRecord` when the counterpart recurs, so the
   *  target MUST support update-by-id; otherwise it detonates on the 2nd fire. */
  WRITE_BIND_NO_UPDATE: 'MOV_WRITE_BIND_NO_UPDATE',
  /** A type reference (`graph.position`) names a position the graph's KNOWN
   *  schema does not declare — movement parameters, IS tests, shape-edge
   *  endpoints. Schema-less graphs stay silent (unknown never errors). */
  UNKNOWN_POSITION: 'MOV_UNKNOWN_POSITION',
  /** A bare type annotation names neither a primitive nor a declared type
   *  (`type Thesis = <"A" | "B">`), so it constrains nothing. */
  UNKNOWN_TYPE_NAME: 'MOV_UNKNOWN_TYPE_NAME',
  // Borrowed types (`stage: crm.companies.funding_stage "…"`)
  BORROW_MALFORMED: 'MOV_BORROW_MALFORMED',
  BORROW_UNKNOWN_GRAPH: 'MOV_BORROW_UNKNOWN_GRAPH',
  BORROW_UNKNOWN_ROOT: 'MOV_BORROW_UNKNOWN_ROOT',
  BORROW_UNKNOWN_FIELD: 'MOV_BORROW_UNKNOWN_FIELD',
  // await (asks-as-adapter wake primitive). AWAIT_REQUIRED / AWAIT_IMPURE_WHERE
  // ride in via TypedDiagnosticCodes (fired inside the traversal walk).
  /** `await <traversal>` whose final edge is NOT awaitable — await requires an
   *  edge whose resolution resumes the run (an ask's `Response`). Read an
   *  ordinary edge live, without `await`. */
  AWAIT_NOT_AWAITABLE: 'MOV_AWAIT_NOT_AWAITABLE',
  /** `await FIRST(<traversal>)` on an awaitable edge the platform does NOT
   *  deliver events for. A park needs something to wake it: where the source
   *  pushes, `await FIRST` is the form; where it doesn't, the author owns the
   *  cadence (`await until(…, every: …)`) and the message names it. */
  AWAIT_NEEDS_CADENCE: 'MOV_AWAIT_NEEDS_CADENCE',
  /** WARNING — an `until` poll over an edge the source now pushes. The rewrite
   *  is never made for the author (an adapter gaining webhooks must not change
   *  what a saved movement does), so the checker says so and leaves it. */
  UNTIL_EDGE_WATCHABLE: 'MOV_UNTIL_EDGE_WATCHABLE',
  /** `await <traversal>` — the retired bare-walk spelling. The park IS the
   *  FIRST read, parked, so it is spelled that way: `await FIRST(<traversal>)`.
   *  Hard break (layer 13 C1, ruling 2026-08-05); the message carries the
   *  rewrite. */
  AWAIT_BARE_WALK: 'MOV_AWAIT_BARE_WALK',
  /** `race([…])` / `parallel([…])` outside `await` — a combinator composes a
   *  wait; only `await` parks. The message carries the rewrite. */
  COMBINATOR_NEEDS_AWAIT: 'MOV_COMBINATOR_NEEDS_AWAIT',
  /** An arm of `race`/`parallel` that is not a function — a name bound to a
   *  record, a value, an instance. The combinator's whole job is to CALL its
   *  arms, so there is nothing it could do with one. */
  COMBINATOR_ARM_NOT_FUNCTION: 'MOV_COMBINATOR_ARM_NOT_FUNCTION',
  /** An arm that declares parameters. A combinator calls its arms with nothing
   *  — there is no caller to supply an argument — so a parameter could only
   *  ever arrive null. Capture the value instead: a closure sees what is in
   *  scope where it is written. */
  COMBINATOR_ARM_TAKES_NOTHING: 'MOV_COMBINATOR_ARM_TAKES_NOTHING',
  /** A parameter written with no `: <type>` where nothing supplies one. Only a
   *  collection op does — it hands its function one element, so `MAP(xs, (x)
   *  => …)` knows what `x` is. Everywhere else a parameter's type is the
   *  promise its callers are checked against, so it is written down. */
  PARAM_NEEDS_TYPE: 'MOV_PARAM_NEEDS_TYPE',
  /** A collection op (`MAP`, `FILTER`, `REDUCE`, `GROUPBY`, `KEYBY`) reads
   *  something that is not a collection of values — a single value, or a
   *  position. Positions have their own iteration form (the traversal-headed
   *  block), which is where the null-safety, the provenance and the writes
   *  live; these ops are the VALUES' form. */
  COLLECTION_OP_NOT_A_COLLECTION: 'MOV_COLLECTION_OP_NOT_A_COLLECTION',
  /** A collection op's function takes the wrong number of parameters — one
   *  element for `MAP`/`FILTER`/`GROUPBY`/`KEYBY`, the carried value and the
   *  element for `REDUCE`. */
  COLLECTION_OP_ARITY: 'MOV_COLLECTION_OP_ARITY',
  /** A collection op's function hands nothing back. Every one of them is a
   *  question asked per element — what it becomes, whether it stays, what it
   *  is filed under — so a function with no `return` answers none of them. */
  COLLECTION_OP_RETURNS_NOTHING: 'MOV_COLLECTION_OP_RETURNS_NOTHING',
  /** A collection op's function may PARK the run (it awaits). These ops run
   *  their function over every element and hand back one value; waiting inside
   *  one has no answer for what the half-finished collection is. Waiting
   *  belongs to the forms built for it — a traversal-headed block, or
   *  `race`/`parallel`. */
  COLLECTION_OP_SUSPENDS: 'MOV_COLLECTION_OP_SUSPENDS',
  /** `MEMBERS(<T>)` names a type whose membership is not CLOSED — an open
   *  known-values field, whose listed options are what could be enumerated and
   *  not all there are. There is no complete list to iterate. */
  MEMBERS_NOT_CLOSED: 'MOV_MEMBERS_NOT_CLOSED',
  /** `await sleep(<duration>)` with a malformed duration literal. */
  AWAIT_BAD_DURATION: 'MOV_AWAIT_BAD_DURATION',
  /** `await until(…)`'s cadence is below the 1m floor — re-checking faster than
   *  once a minute is refused (the MOV_AWAIT_IMPURE_WHERE family's ops sibling). */
  UNTIL_CADENCE_TOO_SHORT: 'MOV_UNTIL_CADENCE_TOO_SHORT',
  /** A statement inside an `await until(…)` condition is not read-only — a
   *  write/ask/await/race in the condition (extends the MOV_AWAIT_IMPURE_WHERE
   *  family: an await/until condition is evaluated repeatedly and must not act). */
  AWAIT_IMPURE_CONDITION: 'MOV_AWAIT_IMPURE_CONDITION',
  /** `refresh <handle>` on a head that has no re-fetchable record id — the event
   *  payload or an extracted node. Refresh a write handle or a traversed record. */
  REFRESH_UNSTABLE: 'MOV_REFRESH_UNSTABLE',
  // race + receipts + absence (asks-as-adapter chunk C). ABSENT_REQUIRED rides in
  // via TypedDiagnosticCodes (also fired inside the typing layer's comparison
  // check), reached here through the spread below as DiagnosticCodes.ABSENT_REQUIRED.
  /** RETIRED: the inline block expression (`{ … }.name`) — reading a body's
   *  inner binding by name is naming-is-exporting, which `return` replaces.
   *  Still parsed so the refusal can name the replacement. */
  INLINE_BLOCK_RETIRED: 'MOV_INLINE_BLOCK_RETIRED',
  // Explicit returns (core calculus v2). A body hands its value back with
  // `return`; nothing else escapes a scope.
  /** A `return` with no body to return from — at file scope, or inside a
   *  construct whose arms hand nothing back (a `parallel` sibling, a race
   *  branch). */
  RETURN_OUTSIDE_BODY: 'MOV_RETURN_OUTSIDE_BODY',
  /** Two `return`s in one body hand back different KINDS of thing — one a
   *  record position, one a value. A body has one value type. */
  RETURN_PLANE_MISMATCH: 'MOV_RETURN_PLANE_MISMATCH',
  /** A `return` of something that is not a value — a constructed instance.
   *  An instance stands for a live system and its schema is per-credential, so
   *  it cannot travel; the movement that needs one constructs it. */
  RETURN_NOT_A_VALUE: 'MOV_RETURN_NOT_A_VALUE',
  /** RETIRED: reading a block's inner binding off the block's value —
   *  `orgs.name` / `orgs-[o:co]->`. A block's bindings never leave it; the ONE
   *  way a value comes out is `return`. */
  BLOCK_READ_BACK_RETIRED: 'MOV_BLOCK_READ_BACK_RETIRED',
  /** A bound call whose callee returns nothing. A call's value IS its return
   *  value, so there is nothing to bind. */
  CALL_RETURNS_NOTHING: 'MOV_CALL_RETURNS_NOTHING',
  /** A bound traversal block whose body returns nothing. The block's value is
   *  the list of what each iteration returned. */
  BLOCK_RETURNS_NOTHING: 'MOV_BLOCK_RETURNS_NOTHING',
  /** An authored binding whose name starts with `#` — the prefix that marks
   *  the ENGINE's own names in this language (`#resources` is the other one).
   *  The engine binds a run's return under such a name so it survives a park;
   *  refusing the prefix is what makes that slot uncollidable rather than
   *  merely unlikely to collide. */
  RESERVED_NAME: 'MOV_RESERVED_NAME',
  /** A name bound twice in ONE scope. Bindings are immutable — the cross-scope
   *  half of this rule is SHADOWED_NAME. */
  REBOUND_NAME: 'MOV_REBOUND_NAME',
  // callback (the deferred, addressable invocation)
  /** `callback(<name>, …)`'s first argument names something that is not a
   *  movement in scope — with a did-you-mean over the movements that are.
   *  A movement is a VALUE in this one position and nowhere else. */
  CALLBACK_NOT_MOVEMENT: 'MOV_CALLBACK_NOT_MOVEMENT',
  /** A key in `callback(…, { … })`'s config object is not one the vocabulary
   *  has (`once`, `ttl`), is repeated, or carries the wrong kind of value. */
  CALLBACK_BAD_CONFIG: 'MOV_CALLBACK_BAD_CONFIG',
  /** A callback parameter typed against a record position — a fire-time
   *  parameter is a VALUE the platform sends, so it must be a scalar. */
  CALLBACK_PARAM_NOT_VALUE: 'MOV_CALLBACK_PARAM_NOT_VALUE',
  // File imports (the linker — checker/link.ts)
  ...LinkDiagnosticCodes,
  // Schema-typed checks (M2b)
  ...TypedDiagnosticCodes,
} as const;

/**
 * One lexical scope the checker opened, with the source extent it covers —
 * the editor's answer to "which names are in scope HERE". Recorded (opt-in)
 * rather than re-derived by a second walker: the scope is the checker's own,
 * with the types it actually inferred.
 */
export interface RecordedFrame {
  kind: ScopeKind;
  /** The file frame covers the whole program; its span is synthetic. */
  span: Span;
  scope: Scope;
}

/**
 * The instance and record type a write resolved onto — the ADDRESS, as
 * declared strings, never parsed out of `description`.
 */
export interface RecordedTarget {
  /** The constructed instance's BINDING name (`crm`), not its adapter. */
  instance: string;
  /** The written record type, as the schema names it. Absent for a
   *  writable-only type that mints no position. */
  recordType?: string;
}

/**
 * A `write … { … }` body, recorded where the checker knows most about it:
 * after the target's variant selection and the handle's generic landings, so
 * `root` is the shape the body is actually validated against.
 */
export interface RecordedWrite {
  span: Span;
  root?: WritableRootSchema;
  /** Plain-language target name, e.g. `crm.company`. */
  description: string;
  declaredFields: Set<string>;
  hasUniqueBy: boolean;
  /** The scope the write sits in (for `unique by` handle references). */
  scope: Scope;
  /** The name this write's handle was bound to (`a = write …`); absent for a
   *  bare write statement. */
  binding?: string;
  /** Where it lands, resolved. Absent when the target didn't type. */
  target?: RecordedTarget;
  /** A position write updates the record it already holds; every other form
   *  resolves-or-creates one. */
  action: 'create' | 'update';
  /** The parent edges this write's form establishes (linked / tuple), as the
   *  checker resolved them. Empty for a root or position write. */
  parents: Array<{ edge: string; type?: string }>;
}

/**
 * The remaining effect-bearing constructs, recorded as the one walk passes
 * them. Each carries only what the CHECKER resolved — the AST already says
 * what was written, and the story projection reads it there — plus the scope
 * the construct sits in, so a projected expression's names resolve against
 * the same bindings the checker saw.
 */
export type RecordedNode =
  | RecordedInstance
  | RecordedListen
  | RecordedLink
  | RecordedAwait
  | RecordedCombinator
  | RecordedBranch
  | RecordedExtract
  | RecordedCall
  | RecordedTraversal
  | RecordedValuePath
  | RecordedHandleOp;

/** `crm = attio(credentials: …)` — the binding, and the adapter type it
 *  resolved to (after any import alias). */
export interface RecordedInstance {
  kind: 'instance';
  span: Span;
  scope: Scope;
  name: string;
  adapterType?: string;
}

/** `listen to <instance> { … } fire <movement>` — the trigger, with the event
 *  surface the checker derived from the config. */
export interface RecordedListen {
  kind: 'listen';
  span: Span;
  scope: Scope;
  /** The listened name as written. */
  instance: string;
  /** The instance's adapter type. Absent for an instance that didn't resolve. */
  adapterType?: string;
  /** The movement named after `fire`, and whether it resolved to one. */
  fires: string;
  firesMovement: boolean;
  /** The event kinds this listener subscribes to — the config's own selection,
   *  or the adapter's dispatch default where it selected none. Absent ⇒ nobody
   *  published a selection, which is not the same as selecting nothing. */
  events?: string[];
  /** Every SINGLE-literal config value, by key — the address the listen
   *  subscribes to. Opaque declared strings on both sides. */
  narrowing: Record<string, string>;
  /** The event position types this listen derives, by their address key (the
   *  identity) and the display the ref carries. Empty when the instance
   *  declares no event edges. */
  eventTypes: Array<{ key: string; display?: string }>;
}

/** `link a -[:e]-> b` / `p = link c -[:e]-> { … }` — the edge-only write. */
export interface RecordedLink {
  kind: 'link';
  span: Span;
  scope: Scope;
  from: string;
  edge: string;
  /** A bare-handle link names its target; a criteria link FINDS one, so what
   *  is known is the type it resolved to. */
  target: { kind: 'handle'; name: string } | ({ kind: 'criteria' } & Partial<RecordedTarget>);
  binding?: string;
}

/** `await …` — the wake primitive, in each of its three sources. */
export interface RecordedAwait {
  kind: 'await';
  span: Span;
  scope: Scope;
  binding?: string;
  source: RecordedAwaitSource;
}

export type RecordedAwaitSource =
  /** `await a-[:Response]->` — the awaited edge, resolved. `awaitable` is the
   *  edge's own promise; an ASK is exactly this over a write handle. */
  | {
      kind: 'traversal';
      /** The traversal's root name, when it has one. */
      root?: string;
      /** The final edge's declared name. */
      edge?: string;
      /** Absent ⇒ the edge wasn't typed; nobody looked, so nothing is claimed. */
      awaitable?: boolean;
      resolvesEmpty?: boolean;
    }
  | { kind: 'sleep'; duration: string }
  | { kind: 'until'; every?: string };

/** `race([…])` / `parallel([…])` — the concurrent wait. Each arm written as a
 *  closure records its body scope, so the arm's own bindings resolve inside it;
 *  an arm that is only a NAME has no scope here (its body was checked where it
 *  was declared). */
export interface RecordedCombinator {
  kind: 'combinator';
  combinator: 'race' | 'parallel';
  span: Span;
  scope: Scope;
  binding?: string;
  arms: Array<{ span: Span; scope?: Scope }>;
}

/** `if … else if … else` — the arm scopes are the point: an arm's condition
 *  narrows INTO it, so its body's names resolve there and nowhere else. */
export interface RecordedBranch {
  kind: 'branch';
  span: Span;
  scope: Scope;
  arms: Array<{ span: Span; scope: Scope; conditionSpan: Span }>;
  otherwise?: { span: Span; scope: Scope };
}

/** `extract from [ … ] { … }` — the resolved result graph (borrowed field
 *  types resolved, working fields separated from the outward shape). */
export interface RecordedExtract {
  kind: 'extract';
  span: Span;
  scope: Scope;
  binding?: string;
  node: ExtractNodeType;
}

/** `log_lead(l: m)` — a movement invoked. */
export interface RecordedCall {
  kind: 'call';
  span: Span;
  scope: Scope;
  binding?: string;
  callee: string;
  /** Whether `callee` resolved to a movement declaration. */
  isMovement: boolean;
}

/**
 * A traversal HEAD — `chat-[ch:Channels WHERE \`Name\` == "dealflow"]->` — as
 * structure rather than as text. `steps` is the compiler's own parse of the
 * hops (so nothing downstream re-reads the syntax), and `landings` is where the
 * type walk put each of them, so a renderer can name what the walk reaches.
 */
export interface RecordedTraversal {
  kind: 'traversal';
  span: Span;
  scope: Scope;
  /** The name the walk starts from, as written. */
  root?: string;
  /**
   * How the walk STARTS, as the checker typed that name: `graph` fans out over
   * records that live in a system, `result` continues from what an earlier step
   * produced (a race receipt, an awaited response, a callback's landing).
   * ABSENT ⇒ the root did not type, and nothing is claimed.
   */
  from?: 'graph' | 'result';
  /** The hop chain. Empty when the head did not parse (an invalid program). */
  steps: TraversalStep[];
  /** Where each hop lands, POSITIONALLY against `steps`. An entry is absent
   *  where the walk could not type that hop — a silence, not a landing. */
  landings: Array<RecordedLanding | undefined>;
}

/**
 * A traversal written as a VALUE (`n-[:Attendees]->.\`Name\``) rather than as a
 * statement head.
 *
 * Same facts as `RecordedTraversal`, from the one place such a path is ever
 * walked — the expression typer. `span` is the SLOT's, since an expression AST
 * carries no positions of its own, so a slot with two paths in it records two
 * nodes at the same span; `key` tells them apart. It is derived from the hop
 * chain by both sides and only ever COMPARED — nothing reads it.
 */
export interface RecordedValuePath {
  kind: 'valuePath';
  span: Span;
  scope: Scope;
  key: string;
  root?: string;
  steps: TraversalStep[];
  landings: Array<RecordedLanding | undefined>;
}

/** The comparable token for one walked path. Both the checker and the story
 *  projection derive it from the SAME parse of the same slot. */
export function valuePathKey(root: string | undefined, steps: TraversalStep[]): string {
  return JSON.stringify([root ?? null, steps]);
}

/** A landing's ADDRESS: the instance it belongs to and the type the schema
 *  names it by. Both declared strings; display is resolved downstream. */
export interface RecordedLanding {
  instance: string;
  position?: string;
}

/** `delete <handle>` / `refresh <handle>`. */
export interface RecordedHandleOp {
  kind: 'delete' | 'refresh';
  span: Span;
  scope: Scope;
  subject: string;
}

export interface CheckRecording {
  frames: RecordedFrame[];
  writes: RecordedWrite[];
  nodes: RecordedNode[];
}

export interface CheckOptions {
  /**
   * Record scope frames and write regions as the check runs, for the language
   * service to resolve cursors against (`checkProgramWithLink` returns them).
   * Off by default so the compile path pays nothing.
   */
  recordAnalysis?: boolean;
  /**
   * Movement-library resolution (file imports, 3_syntax_sketch.md §H).
   * When present, `import { … } from "<file>"` resolves: each library is
   * parsed and checked in its OWN scope (its error diagnostics surface
   * prefixed with the import path), and the imported names bind as real
   * movements/shapes — callable, usable as types and write targets.
   * Absent, file imports keep the M2 behavior: MOV_IMPORT_FILE_UNSUPPORTED
   * with the names treated as opaque.
   */
  resolveFile?: ResolveFile;
}

export function checkProgram(
  program: Program,
  catalog: Catalog,
  options?: CheckOptions,
): Diagnostic[] {
  return checkProgramWithLink(program, catalog, options).diagnostics;
}

/**
 * `checkProgram` plus the resolved import structure (`ProgramLink`) — the
 * movement engine's seam: it validates through this call and then executes
 * imported callees from the SAME resolved link, so resolution lives here
 * (the parse/check layer) and the engine consumes an already-resolved
 * program.
 */
export function checkProgramWithLink(
  program: Program,
  catalog: Catalog,
  options?: CheckOptions,
): { diagnostics: Diagnostic[]; link?: ProgramLink; recording?: CheckRecording } {
  const link = options?.resolveFile ? linkImports(program, options.resolveFile) : undefined;
  const recording: CheckRecording | undefined =
    options?.recordAnalysis === true ? { frames: [], writes: [], nodes: [] } : undefined;
  const checker = new Checker(catalog, {
    ...(link ? { linkContext: { link, checked: new Map() } } : {}),
    ...(recording ? { recording } : {}),
  });
  checker.run(program);
  if (!link) {
    return { diagnostics: checker.diagnostics, ...(recording ? { recording } : {}) };
  }
  return {
    diagnostics: [...link.problems, ...checker.diagnostics],
    link,
    ...(recording ? { recording } : {}),
  };
}

const BARE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A movement's parameters by name, for named-argument matching. */
type NamedParams = Array<{ name: string; type: PositionTypeRef | undefined }>;
/** Expression-grammar literals a bare slot may legitimately be. */
const EXPR_LITERALS = new Set(['TRUE', 'FALSE', 'NULL']);

/** The field type of a BARE literal RValue (`done = true`, `n = 3`, `s = "x"`) —
 *  checkExprSlot short-circuits these before typing them, but a scalar receipt
 *  property needs the type (`boolean | absent`). Undefined for anything not a
 *  plain literal (a name / expression carries its own type through infer). */
function scalarLiteralType(raw: string): FieldType | undefined {
  const t = raw.trim();
  const upper = t.toUpperCase();
  if (upper === 'TRUE' || upper === 'FALSE') return 'boolean';
  if (upper === 'NULL') return undefined;
  if (/^-?\d+(\.\d+)?$/.test(t)) return 'number';
  if (/^"(?:[^"\\]|\\.)*"$/.test(t) || /^'(?:[^'\\]|\\.)*'$/.test(t)) return 'text';
  return undefined;
}

/**
 * The address a resolved write/link handle stands on, as declared strings —
 * the recorded form of `describePosition`'s subject. Structural: read off the
 * ref the checker built, never split out of the display text.
 */
function recordedTargetOf(handle: PositionTypeRef | undefined): RecordedTarget | undefined {
  switch (handle?.kind) {
    case 'handle':
      return {
        instance: handle.instance.name,
        ...(handle.position !== undefined ? { recordType: handle.position } : {}),
      };
    case 'position':
      return { instance: handle.instance.name, recordType: handle.position };
    case 'union':
      return { instance: handle.instance.name, recordType: handle.union };
    default:
      return undefined;
  }
}

/** The primitive type names an annotation may spell — the fixed half of the
 *  candidate set a mistyped annotation is matched against. */
const PRIMITIVE_TYPE_NAMES = ['text', 'number', 'boolean', 'date', 'datetime', 'file', 'json'];

/** Every type name an annotation may spell here: the primitives plus every
 *  refinement declared in scope. */
function typeNamesInScope(scope: Scope): string[] {
  const names = [...PRIMITIVE_TYPE_NAMES];
  for (let s: Scope | undefined = scope; s; s = s.parent) {
    for (const symbol of s.symbols.values()) {
      if (symbol.kind === 'type' && !names.includes(symbol.name)) names.push(symbol.name);
    }
  }
  return names;
}

/** Every movement name visible from `scope`, innermost first — the candidate
 *  set for a callback's did-you-mean. */
function movementNamesInScope(scope: Scope): string[] {
  const names: string[] = [];
  for (let s: Scope | undefined = scope; s; s = s.parent) {
    for (const symbol of s.symbols.values()) {
      if (symbol.kind === 'movement' && !names.includes(symbol.name)) names.push(symbol.name);
    }
  }
  return names;
}

/**
 * The universal construction parameter every adapter accepts:
 * `crm = attio(credentials: acme_main, dry_run: true)` marks the INSTANCE
 * for dry-run capture — writes to it are rehearsed, not committed
 * (6_engine.md "Dry-run is movement-level, not trigger-level"). It is a
 * platform argument, not adapter config, so it is validated here (boolean
 * literal only) and filtered out before manifest validation and
 * `Catalog.instantiate`.
 */
export const DRY_RUN_ARG = 'dry_run';
const BOOLEAN_LITERAL = /^(true|false)$/i;

const SYNTHETIC_SPAN: Span = { start: { line: 1, col: 1 }, end: { line: 1, col: 1 } };

/** Each collection op as the author writes it — the name every diagnostic uses,
 *  so a message can be pasted back into the program. */
const COLLECTION_OP_SPELLING: Record<CollectionOp, string> = {
  map: 'MAP',
  filter: 'FILTER',
  reduce: 'REDUCE',
  groupby: 'GROUPBY',
  keyby: 'KEYBY',
};

const describeKind: Record<SymbolKind, string> = {
  adapter: 'an adapter type',
  credential: 'a credential',
  plugin: 'a plugin',
  fileImport: 'a file import',
  binding: 'a binding',
  instance: 'a constructed instance',
  param: 'a parameter',
  movement: 'a movement',
  shape: 'a declared node',
  alias: 'a traversal alias',
  type: 'a declared type',
};

// ── Name collection over the formula AST ──

export interface CollectedNames {
  /** `traverse.aliasRoot` and `alias_ref` names — these resolve against statement scope. */
  refs: string[];
  /** Aliases bound by traversal steps within the same expression (locally resolved). */
  aliases: Set<string>;
  /** Every ROOTED read, as its root and the member names it reaches for
   *  (`x-[v:n]->.f` ⇒ root `x`, members `n`, `f`). What a read is FOR, rather
   *  than which names it mentions — the retired block read-back is diagnosed
   *  off this. */
  rooted: Array<{ root: string; members: string[] }>;
}

// Step filters and extract-config slots are evaluated in the traversal head's
// context, so a rootless name in them is a field, not an outer variable —
// collect in `field` position. Rooted reads still surface their root: the
// `traverse` case pushes its aliasRoot regardless of position.
function collectFromSteps(steps: TraversalStep[], out: CollectedNames): void {
  for (const step of steps) {
    if (step.type === 'edge') {
      if (step.alias) out.aliases.add(step.alias);
      if (step.expressionFilter) collectNames(step.expressionFilter, out, 'field');
    } else if (step.type === 'meta_edge') {
      if (step.alias) out.aliases.add(step.alias);
      if (step.expressionFilter) collectNames(step.expressionFilter, out, 'field');
      const config = step.config;
      if (config) {
        if (config.description) collectNames(config.description, out, 'field');
        for (const d of config.data ?? []) collectNames(d, out, 'field');
        if (config.plugin) collectNames(config.plugin, out, 'field');
        for (const e of config.enrichWith ?? []) {
          collectNames(e.transform, out, 'field');
          collectNames(e.argument, out, 'field');
        }
        for (const v of Object.values(config.extra ?? {})) collectNames(v, out, 'field');
      }
    }
  }
}

// A name's *position* decides whether a rootless spelling is a variable or a
// field. In `value` position (an interpolated `${foo}`, an `AI(foo)` prompt, a
// `COALESCE(foo, …)` arg) a bare name is a reference to resolve against scope.
// In `field` position — the tail of a traversal (`msg.`subject``), a step
// filter, an extract-config slot — it is a field of the traversal head, typed
// against the head's schema, so it is NOT a name to resolve here. (Backticks
// are just whitespace-safe quoting and don't change this; position does.)
type NamePosition = 'value' | 'field';

function collectNames(expr: Expression, out: CollectedNames, position: NamePosition = 'value'): void {
  switch (expr.type) {
    case 'alias_ref':
      out.refs.push(expr.name);
      return;
    case 'traverse':
      if (expr.aliasRoot !== undefined) {
        out.refs.push(expr.aliasRoot);
        out.rooted.push({ root: expr.aliasRoot, members: memberNames(expr) });
      }
      collectFromSteps(expr.steps, out);
      collectNames(expr.expression, out, 'field');
      return;
    case 'exists':
      collectFromSteps(expr.steps, out);
      if (expr.where) collectNames(expr.where, out, 'field');
      return;
    case 'resource_traverse':
      if (expr.expressionFilter) collectNames(expr.expressionFilter, out, 'field');
      collectNames(expr.expression, out, 'field');
      return;
    case 'llm':
      if (expr.promptExpression) collectNames(expr.promptExpression, out, 'value');
      return;
    case 'list':
      expr.elements.forEach(e => collectNames(e, out, position));
      return;
    // An object literal's KEYS are the target API's own spelling, never names
    // to resolve; its values carry the position through unchanged.
    case 'object':
      expr.entries.forEach(e => collectNames(e.value, out, position));
      return;
    case 'arithmetic':
    case 'compare':
      collectNames(expr.left, out, position);
      collectNames(expr.right, out, position);
      return;
    case 'logical':
      expr.operands.forEach(o => collectNames(o, out, position));
      return;
    case 'not':
      collectNames(expr.expression, out, position);
      return;
    case 'concat':
      expr.parts.forEach(p => collectNames(p, out, position));
      return;
    case 'conditional':
      collectNames(expr.condition, out, position);
      collectNames(expr.then, out, position);
      collectNames(expr.else, out, position);
      return;
    case 'at':
      collectNames(expr.expression, out, position);
      collectNames(expr.index, out, position);
      return;
    case 'aggregate':
      collectNames(expr.expression, out, position);
      return;
    case 'function':
      expr.args.forEach(a => collectNames(a, out, position));
      return;
    case 'kg_exists':
    case 'kg_value':
      expr.params.forEach(p => collectNames(p, out, position));
      return;
    case 'property':
      if (position === 'value') out.refs.push(expr.propertyTypeId);
      return;
    case 'edge_property':
    case 'static':
    case 'meta':
    case 'parent_result':
    case 'resource':
    case 'linked_object':
    case 'extract_value':
      return;
  }
}

/** The member names a rooted read reaches for: each hop's edge name, then the
 *  property it lands on. */
function memberNames(expr: Extract<Expression, { type: 'traverse' }>): string[] {
  const members = expr.steps.flatMap((step) =>
    'edgeTypeId' in step && step.edgeTypeId !== undefined ? [step.edgeTypeId] : [],
  );
  if (expr.expression.type === 'property') members.push(expr.expression.propertyTypeId);
  return members;
}

export function collectExpressionNames(expr: Expression): CollectedNames {
  const out: CollectedNames = { refs: [], aliases: new Set(), rooted: [] };
  collectNames(expr, out);
  return out;
}

// ── Traversal-head alias extraction ──
//
// Hop aliases (`-[c:companies]->`) must come from the raw hop text: a
// `_resources` head parses to `resource_traverse`, which carries neither
// alias nor root, so the probe AST alone would lose them.

function skipHeadString(text: string, start: number): number {
  const quote = text[start];
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2;
      continue;
    }
    if (text[i] === quote) return i + 1;
    i++;
  }
  return text.length;
}

export function extractHopAliases(hopsRaw: string): string[] {
  const aliases: string[] = [];
  let i = 0;
  while (i < hopsRaw.length) {
    const open = hopsRaw.indexOf('-[', i);
    if (open === -1) break;
    const interiorStart = open + 2;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(hopsRaw.slice(interiorStart));
    if (match) aliases.push(match[1]);
    // Skip to the hop's closing ']' respecting nesting and literals.
    let depth = 1;
    let j = interiorStart;
    while (j < hopsRaw.length && depth > 0) {
      const ch = hopsRaw[j];
      if (ch === '"' || ch === "'" || ch === '`') {
        j = skipHeadString(hopsRaw, j);
        continue;
      }
      if (ch === '[' || ch === '(' || ch === '{') depth++;
      else if (ch === ']' || ch === ')' || ch === '}') depth--;
      j++;
    }
    i = j;
  }
  return aliases;
}

/** Did `member` escape the block that was bound to `blockName`? The scope chain
 *  records exactly that when a block closes. */
function escapedFromBlock(scope: Scope, member: string, blockName: string): boolean {
  for (let s: Scope | undefined = scope; s; s = s.parent) {
    if (s.escaped.has(member)) return s.escaped.get(member) === blockName;
  }
  return false;
}

// ── Span helpers ──

/** A path head as the author wrote it — diagnostics currency. */
function rawPath(path: PathHead): string {
  return spellPathHead(path);
}

/** Maps a character offset inside a slot's raw text back to a source location. */
function spanWithin(slot: ExprSlot, pos: number | undefined): Span {
  if (pos === undefined || pos < 0 || pos > slot.raw.length) return slot.span;
  let { line, col } = slot.span.start;
  for (let i = 0; i < pos; i++) {
    if (slot.raw[i] === '\n') {
      line++;
      col = 1;
    } else {
      col++;
    }
  }
  return { start: { line, col }, end: slot.span.end };
}

// ── Listen-config value helpers ──

/**
 * A config value's static string contents: a quoted string yields itself,
 * a list of quoted strings yields its elements — anything else (a binding,
 * a traversal, a mixed list) is undefined, i.e. not validatable against a
 * closed vocabulary.
 */
/** The distinct names a `unique by` clause predicate references (fields and/or
 *  bound handles), for the native-uniqueness comparison. Undefined when the
 *  predicate doesn't parse (the expression check reports that separately). */
function uniqueClauseRefs(clause: UniqueClause): string[] | undefined {
  try {
    const refs = new Set<string>();
    // Split first so a FUZZY modifier is lifted off each component — it isn't an
    // expression token, so the stripped remainder is what parses.
    for (const part of splitUniquenessConjuncts(clause.predicate.raw)) {
      for (const ref of collectExpressionNames(parseMovementExpression(part.raw)).refs) {
        refs.add(ref);
      }
    }
    return [...refs];
  } catch (e) {
    if (e instanceof BridgeError) return undefined;
    throw e;
  }
}

function staticStringValues(slot: ExprSlot): string[] | undefined {
  let parsed: Expression;
  try {
    parsed = parseMovementExpression(slot.raw);
  } catch (e) {
    if (e instanceof BridgeError) return undefined;
    throw e;
  }
  const stringOf = (node: Expression): string | undefined =>
    node.type === 'static' && typeof node.value === 'string' ? node.value : undefined;
  if (parsed.type === 'static') {
    const value = stringOf(parsed);
    return value !== undefined ? [value] : undefined;
  }
  if (parsed.type === 'list') {
    const values = parsed.elements.map(stringOf);
    return values.every((v): v is string => v !== undefined) ? values : undefined;
  }
  return undefined;
}

/**
 * Whether a config slot is written as a bracketed list literal (`["…"]`).
 * Event-subscription config (`events`, kg `changes`) is authored as a list even
 * when it names a single event, so the syntax is uniform and every reader sees
 * an array — a bare scalar (`events: "…"`) is rejected with a wrap-in-brackets
 * fix-it. Non-parsing slots are handled by the caller's value check.
 */
function isListSlot(slot: ExprSlot): boolean {
  try {
    return parseMovementExpression(slot.raw).type === 'list';
  } catch (e) {
    if (e instanceof BridgeError) return false;
    throw e;
  }
}

/**
 * A config value that is a bare name or a list of bare names
 * (`fields: [domains]`) — the bridge parses a bare name as a root-less
 * `property` node, so a clean list of those yields the names. Undefined
 * for anything else.
 */
function bareNameValues(slot: ExprSlot): string[] | undefined {
  const trimmed = slot.raw.trim();
  if (BARE_IDENT.test(trimmed)) return [trimmed];
  let parsed: Expression;
  try {
    parsed = parseMovementExpression(slot.raw);
  } catch (e) {
    if (e instanceof BridgeError) return undefined;
    throw e;
  }
  if (parsed.type !== 'list') return undefined;
  const names = parsed.elements.map(element =>
    element.type === 'property' ? element.propertyTypeId : undefined,
  );
  return names.every((n): n is string => n !== undefined) ? names : undefined;
}

/**
 * The string value of a slot that is a bare string LITERAL (`"Open"`),
 * undefined for anything else (a property read, a call, an interpolation). The
 * enum-literal membership check reads this: only a literal carries a value
 * known at author time.
 */
function staticStringLiteralOf(slot: ExprSlot): string | undefined {
  let parsed: Expression;
  try {
    parsed = parseMovementExpression(slot.raw);
  } catch (e) {
    if (e instanceof BridgeError) return undefined;
    throw e;
  }
  return parsed.type === 'static' && typeof parsed.value === 'string' ? parsed.value : undefined;
}

/** ` (e.g. Answer Type: "text")` — a fix-it spelling the author can paste,
 *  drawn from the field's OWN option set so it can never suggest a value the
 *  field rejects. Empty when the field isn't enum-typed: a made-up example for
 *  a free-text parameter would be a guess dressed as guidance. */
function literalExampleFor(field: string, type: FieldType | undefined): string {
  if (typeof type !== 'object' || type.kind !== 'enum' || type.options.length === 0) return '';
  return ` (e.g. ${field}: "${type.options[0]}")`;
}

/** `a`, `a or b`, `a, b, or c` — a prose alternation for a diagnostic. */
function orList(items: string[]): string {
  return joinList(items, 'or');
}

/** `a`, `a and b`, `a, b and c` — a prose conjunction for a diagnostic. */
function andList(items: string[]): string {
  return joinList(items, 'and');
}

function joinList(items: string[], conjunction: 'and' | 'or'): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} ${conjunction} ${items[1]}`;
  const separator = conjunction === 'or' ? ', or ' : ' and ';
  return `${items.slice(0, -1).join(', ')}${separator}${items[items.length - 1]}`;
}

/**
 * The clause naming the fields that fit no write shape TOGETHER. Always two or
 * more while the host's rule holds (every writable field belongs to some
 * variant); the one-field wording exists so a hand-built schema that breaks
 * that rule still reads as a sentence.
 */
function writeUnionClash(conflict: string[]): string {
  if (conflict.length === 2) return `${conflict[0]} and ${conflict[1]} can't both be set`;
  if (conflict.length > 2) return `${andList(conflict)} can't be set together`;
  return `${andList(conflict)} fits none of them`;
}

// ── `through`-argument phasing context ──

interface ThroughFieldsContext {
  /** Field names of the node's PRIOR stages plus inherited ancestor fields — readable. */
  prior: Set<string>;
  /** Field names of the stage the `through` precedes, and later stages — a forward reference. */
  ownOrLater: Set<string>;
}

// ── Typed-symbol helpers (M2b) ──

/** Options threaded through expression-slot checking. */
interface SlotOptions {
  fields?: ThroughFieldsContext;
  /** The typed write target the slot flows into — drives extract-field
   *  annotation suggestions and annotation-vs-write conflict checks. */
  writeTarget?: WriteTargetRef;
}

interface HeadInfo {
  /** Lexically-scanned hop aliases (robust to `_resources` heads). */
  aliases: string[];
  /** Probe-parsed hop steps, when the head parsed to a property-terminated traverse. */
  steps?: TraversalStep[];
  /** The head root's position type, when the root is typed. */
  rootType?: PositionTypeRef;
  /** The recorded node for this head, when recording is on — the caller that
   *  walks the chain finishes it with the landings it resolves. */
  recorded?: RecordedTraversal;
}

/**
 * Where a traversal STARTS, told apart by the checker's own type of the root:
 * a graph position fans out over records that live in a system; a result node —
 * a race receipt, a write handle, a callback's local landing — continues from
 * what an earlier step produced. Absent ⇒ untyped, so nothing is claimed.
 */
function traversalFrom(type: PositionTypeRef | undefined): 'graph' | 'result' | undefined {
  if (type === undefined) return undefined;
  switch (type.kind) {
    case 'meta':
    case 'position':
    case 'union':
    case 'extract':
      return 'graph';
    case 'handle':
    case 'local':
      return 'result';
    case 'closure':
      // Nothing traverses off a closure; the typing layer refuses the hop.
      return undefined;
    case 'maybeEmpty':
      return traversalFrom(type.of);
  }
}

/** A landing's address, for the kinds a schema actually names. The rest — a
 *  meta node, an extract node, a receipt — have no declared type name to
 *  resolve a label from, and saying nothing is the honest answer. */
function recordedLanding(type: PositionTypeRef | undefined): RecordedLanding | undefined {
  if (type === undefined) return undefined;
  switch (type.kind) {
    case 'position':
      return { instance: type.instance.name, position: type.position };
    case 'union':
      return { instance: type.instance.name, position: type.union };
    case 'handle':
      return {
        instance: type.instance.name,
        ...(type.position !== undefined ? { position: type.position } : {}),
      };
    case 'maybeEmpty':
      return recordedLanding(type.of);
    default:
      return undefined;
  }
}

function isGraphSymbol(symbol: ScopeSymbol): boolean {
  // A graph is a CONSTRUCTED instance or a declared shape. A bare adapter
  // import is NOT a graph — instantiation is explicit now (`go = manual()`),
  // so `<manual-[:invocation]->>` (import as position source) is an error
  // guiding "construct an instance and name it first"
  // (spec plans/2026-06-24-required-instantiation/0_spec.md §"What is removed").
  // The knowledge graph is an instance like any other as of D25 — an instance
  // is already a graph, so there is no third case.
  return symbol.kind === 'instance' || symbol.kind === 'shape';
}

/** Graph identity: the introducing symbol IS the token compared by
 *  reference — for imports, the LIBRARY's declaring symbol (`graphToken`). */
export function instanceRefOf(symbol: ScopeSymbol): InstanceRef | undefined {
  return symbol.schema
    ? { token: symbol.graphToken ?? symbol, name: symbol.name, schema: symbol.schema }
    : undefined;
}

/** The position a bound name denotes: its own type, or — for a graph — the
 *  graph's meta position. The one rule for "what type is this name?", shared
 *  by the checker and the editor so neither can drift from the other. */
export function positionTypeOf(symbol: ScopeSymbol): PositionTypeRef | undefined {
  if (symbol.posType) return symbol.posType;
  if (isGraphSymbol(symbol)) {
    const instance = instanceRefOf(symbol);
    if (instance) return { kind: 'meta', instance };
  }
  return undefined;
}

/**
 * What a union becomes once an `IS` chain has ruled members out of it.
 *
 * Structural throughout, so nothing has to be registered anywhere: a union IS
 * its member set (`unionKey`), so the residual is keyed and displayed off the
 * members that remain, and every union rule downstream already reads
 * `variants` rather than looking the key up on the schema.
 *
 * Three cases, all TypeScript's:
 *   - one member left ⇒ that member. A set collapsing to one cannot masquerade
 *     as a union (`unionKey`'s own contract).
 *   - two or more ⇒ the smaller union.
 *   - none ⇒ the empty union, `never`. It is not an error to REACH — `if
 *     (x === "nope")` on `x: "a" | "b"` is a true statement — so it errors
 *     where the handle is USED, which the empty variant list already does.
 */
function residualUnion(
  union: Extract<PositionTypeRef, { kind: 'union' }>,
  remaining: readonly string[],
): PositionTypeRef {
  const variants = unionVariants(remaining);
  if (variants.length === 1) {
    return { kind: 'position', instance: union.instance, position: variants[0] };
  }
  return {
    kind: 'union',
    instance: union.instance,
    union: unionKey(variants),
    variants,
    // No schema ever registered this residual, so it carries its own
    // author-facing text — the `display` escape hatch, never a parsed key.
    display: variants.map(v => displayNameOf(union.instance, v)).join(' | '),
  };
}

/** The position a node declaration's `<name>` annotation denotes — its root. */
function declaredRootPosition(symbol: ScopeSymbol): PositionTypeRef | undefined {
  const instance = instanceRefOf(symbol);
  return instance ? positionRefIn(instance, instance.name) : undefined;
}

/** That same root, as the comparator's required side — so "what does `<Doc>`
 *  mean" is answered once for the parameter and the predicate alike. */
function declaredNodeRequirement(symbol: ScopeSymbol): RequiredPosition | undefined {
  const root = declaredRootPosition(symbol);
  return root?.kind === 'position'
    ? { schema: root.instance.schema, position: root.position }
    : undefined;
}

/**
 * Does `position` structurally satisfy the declared node? The predicate behind
 * `x IS <Doc>`, and the one the arm and the `else` both consult.
 *
 * `undefined` is the THIRD answer, and it has to be one: an undescribed
 * position or a declaration whose schema didn't resolve is "nobody has looked",
 * not "it fits". Collapsing that into `true` would let the `else` eliminate a
 * member on the strength of a comparison that never happened — the silent
 * degradation this language bans. Both sides therefore KEEP an unknown member:
 * the arm can't rule it out, and neither can the else.
 */
function conformsToDeclaredNode(
  instance: InstanceRef,
  position: string,
  declaration: ScopeSymbol,
): boolean | undefined {
  const required = declaredNodeRequirement(declaration);
  if (required === undefined) return undefined;
  if (surfaceNotEnumerated(required.schema.positions[required.position])) return undefined;
  const surface = schemaSurface(instance.schema, position);
  if (surface === undefined) return undefined;
  return surfaceMisfit(surface, required) === undefined;
}

/** Resolves one extract field's explicit annotation to a FieldType. */
type ExtractTypeResolver = (field: ExtractField) => FieldType | undefined;

/** Infers an extract result graph from the tree (4_type_system.md "Extract graphs"). */
function buildExtractGraph(
  name: string,
  stages: ExtractStage[],
  resolveType: ExtractTypeResolver,
  description?: string,
): ExtractNodeType {
  const node: ExtractNodeType = {
    name,
    ...(description !== undefined ? { description } : {}),
    properties: new Map(),
    children: new Map(),
  };
  // A stage INHERITS the fields of the stage before it and declares only what
  // it transforms, so every field a node declares anywhere is part of its
  // shape; a re-declaration is the transformation, and wins.
  for (const stage of stages) {
    for (const child of stage.children) {
      node.children.set(
        child.name,
        buildExtractGraph(child.name, child.stages, resolveType, child.description),
      );
    }
    for (const field of stage.fields) {
      const explicit = resolveType(field);
      node.properties.set(field.name, {
        span: field.span,
        description: field.description,
        ...(explicit !== undefined ? { explicit } : {}),
        ...(field.type !== undefined ? { annotationRaw: field.type } : {}),
      });
    }
  }
  return node;
}

/**
 * Does an argument's (graph, position) fit a parameter's (check 7)?
 * `undefined` = cannot tell (stay silent).
 */
function positionsMatch(arg: PositionTypeRef, param: PositionTypeRef): boolean | undefined {
  switch (param.kind) {
    case 'position':
      if (arg.kind === 'position') {
        if (arg.instance.token !== param.instance.token) return false;
        if (arg.position === param.position) return true;
        return acceptsAnyNarrowing(param, arg.narrowsEvent);
      }
      if (arg.kind === 'union') {
        // A multi-action listen's derived union against a plain-position
        // param: only the unnarrowed event node itself is wide enough —
        // "no address on the param accepts any listen".
        if (arg.instance.token !== param.instance.token) return false;
        return acceptsAnyNarrowing(param, arg.narrowsEvent);
      }
      if (arg.kind === 'handle') {
        if (arg.instance.token !== param.instance.token) return false;
        return arg.position === undefined ? undefined : arg.position === param.position;
      }
      return false;
    case 'union':
      if (arg.kind === 'union') {
        if (arg.instance.token !== param.instance.token) return false;
        if (arg.union === param.union) return true;
        return acceptsAnyNarrowing(param, arg.narrowsEvent);
      }
      if (arg.kind === 'position') {
        if (arg.instance.token !== param.instance.token) return false;
        if (param.variants.includes(arg.position)) return true;
        // An unaddressed union accepts any narrowing of the event it names —
        // wider type, not a mechanism.
        return acceptsAnyNarrowing(param, arg.narrowsEvent);
      }
      if (arg.kind === 'handle') {
        if (arg.instance.token !== param.instance.token) return false;
        return arg.position === undefined ? undefined : param.variants.includes(arg.position);
      }
      return false;
    case 'meta':
      return arg.kind === 'meta' ? arg.instance.token === param.instance.token : false;
    case 'handle':
    case 'extract':
    case 'closure':
    case 'local':
    case 'maybeEmpty':
      // Parameters come from TypeRefs; these kinds cannot be declared.
      return undefined;
  }
}

/** Where an argument is written, whatever form it takes. */
function callArgSpan(arg: CallArg): Span {
  switch (arg.kind) {
    case 'expr':
      return arg.expr.span;
    case 'write':
      return arg.write.span;
    case 'node':
      return arg.node.span;
    case 'call':
      return arg.call.span;
  }
}

/**
 * Does a SYNTHESISED node fit a declared parameter type?
 *
 * A node literal belongs to no graph, so there is no instance token to compare
 * — the whole point of `positionsMatch` above does not apply to it. It is typed
 * by its STRUCTURE, and it fits when it carries every member the parameter's
 * type declares, recursively through edges. That is TS's structural
 * assignability, unchanged: extra entries are fine (the callee cannot see
 * them), missing ones are not.
 *
 * Returns the first thing that doesn't fit, phrased for the author, or
 * `undefined` when the node fits (or when the parameter's shape isn't known, in
 * which case there is nothing to check against and silence is the honest
 * answer).
 *
 */
function synthesisedNodeMisfit(
  node: Extract<PositionTypeRef, { kind: 'local' }>,
  param: PositionTypeRef,
  path = '',
): string | undefined {
  switch (param.kind) {
    case 'position':
      return nodeMisfitAgainst(node, param.instance, param.position, path);
    case 'union': {
      // A union parameter accepts anything one of its variants accepts —
      // exactly what an `IS` test would then narrow. Fitting NO variant is the
      // misfit, and the message names the one that came closest to nothing.
      const misfits: string[] = [];
      for (const variant of param.variants) {
        const misfit = nodeMisfitAgainst(node, param.instance, variant, path);
        if (misfit === undefined) return undefined;
        misfits.push(`${variant} (${misfit})`);
      }
      return misfits.length > 0 ? `it fits none of ${orList(misfits)}` : undefined;
    }
    case 'meta':
      return `a synthesised node is a position, not a whole graph`;
    default:
      // Parameters come from TypeRefs; no other kind can be declared.
      return undefined;
  }
}

/**
 * A type ref's surface, in the shared comparator's currency. The only
 * checker-side knowledge here is which type KINDS have a structure to offer;
 * the comparison itself is `surfaceMisfit`, shared with the engine so a
 * predicate cannot mean one thing at author time and another at run time.
 *
 * `undefined` for a position with nothing enumerated behind it — no surface,
 * so no claim in either direction.
 */
function suppliedSurface(type: PositionTypeRef): SuppliedSurface | undefined {
  switch (type.kind) {
    case 'local':
      return {
        properties: type.reads,
        edges: Object.fromEntries(
          Object.entries(type.edges ?? {}).map(([name, edge]) => {
            const { target } = edge;
            return [name, target === undefined ? undefined : () => suppliedSurface(target)];
          }),
        ),
      };
    // Emptiness is discharged by the traversal that reaches this landing, so
    // what it CARRIES is the inner node's surface.
    case 'maybeEmpty':
      return suppliedSurface(type.of);
    case 'position':
      return schemaSurface(type.instance.schema, type.position);
    default:
      return undefined;
  }
}

/**
 * Does `supplied` carry everything the required position declares? The
 * checker's doorway into the shared comparator.
 */
function nodeMisfitAgainst(
  supplied: PositionTypeRef | undefined,
  instance: InstanceRef,
  position: string,
  path: string,
): string | undefined {
  // An entry we couldn't type is UNKNOWN, and unknown fits anything — the same
  // benefit of the doubt every other unchecked read gets.
  if (supplied === undefined) return undefined;
  return surfaceMisfit(suppliedSurface(supplied), { schema: instance.schema, position }, path);
}

/**
 * "No address on the param accepts any listen" — an unnarrowed signature is not
 * a mechanism, it is a WIDER TYPE. So a parameter that pins nothing accepts an
 * argument narrowed from the event it names; a parameter that pins an address
 * accepts only that exact address, which is what makes a listen watching another
 * table a type error rather than a silence.
 *
 */
function acceptsAnyNarrowing(
  param: Extract<PositionTypeRef, { kind: 'position' | 'union' }>,
  argNarrowsEvent: string | undefined,
): boolean {
  if (param.narrowsEvent !== undefined) return false; // the signature named an address
  const name = param.kind === 'position' ? param.position : param.union;
  return argNarrowsEvent === name;
}

/**
 * A parameter's ADDRESS (`<at-[:`Record Change` WHERE `action` == "record.created"]->>`)
 * → the position it names.
 *
 * Resolving a type ref becomes a WALK, which is what layer 5's rule says every
 * address already is — so this runs the REAL hop parser rather than a second
 * grammar, and the position it lands on is the one the HOST grafted for this
 * same address (both sides name it through `eventAddressPositionName`).
 *
 * Silence, not an error, on anything that doesn't resolve: an address the host
 * didn't graft is one it couldn't walk, and the unknown-stays-silent contract
 * is what keeps a missing schema from reading as a broken movement.
 *
 */
function addressOfTypeRef(hopsRaw: string): EventAddress | undefined {
  // ONE hop, shared reading (`eventAddressOfHops`). An event edge is not
  // traversable, so there is nothing to walk on from the event node at author
  // time — the address names the edge and pins it.
  return eventAddressOfHops(hopsRaw);
}

/**
 * The variant of `union` that a FAILED `IS` rules out — the one a passing test
 * would have narrowed to, which is the only thing failing it disproves.
 *
 * A record test names its variant outright. An ADDRESS test names it by pins,
 * and the variant is that address's KEY — merged with the subject's own pins,
 * exactly as the positive narrowing merges them (`A & B`), so a test never has
 * to restate what the signature already pinned. The key is CONSTRUCTED from the
 * merged address and compared; the variants' own keys are never parsed.
 *
 * Undefined where nothing is ruled out: pins that CONTRADICT the subject's
 * (`never` — a test that could not have passed disproves nothing), a different
 * event, or an address whose key is not one of these variants. That last case
 * covers the unpinned test (`ev IS <crm-[:`Webhook Event`]->>`, whose key is the
 * union's own): always true at run time, so its `else` is unreachable, but
 * saying so would need each variant's address and the keys are opaque. Nothing
 * eliminated is the conservative answer, and it costs only an unreachability
 * warning on a test no author writes.
 */
function ruledOutVariant(
  type: Pick<TypeRef, 'position' | 'hopsRaw'>,
  union: Extract<PositionTypeRef, { kind: 'union' }>,
): string | undefined {
  if (type.hopsRaw === undefined) return type.position;
  const test = addressOfTypeRef(type.hopsRaw);
  if (test === undefined) return undefined;
  const subjectAddress: EventAddress = union.address ?? { event: union.union, narrowing: {} };
  if (subjectAddress.event !== test.event) return undefined;
  const merged: Record<string, string> = { ...subjectAddress.narrowing };
  for (const [key, value] of Object.entries(test.narrowing)) {
    if (merged[key] !== undefined && merged[key] !== value) return undefined;
    merged[key] = value;
  }
  const key = eventAddressKey({ event: test.event, narrowing: merged });
  return union.variants.includes(key) ? key : undefined;
}

function positionFromAddress(instance: InstanceRef, hopsRaw: string): PositionTypeRef | undefined {
  const address = addressOfTypeRef(hopsRaw);
  if (address === undefined) return undefined;
  // The IDENTITY of the position this address names — the same key the host
  // grafted it under. Opaque: compared, never parsed.
  const key = eventAddressKey(address);
  const resolved = positionRefIn(instance, key);
  // An address that resolves to NOTHING is not an error here, and that is
  // a rule rather than a tolerance: a narrowing that matches nothing is
  // `never`, exactly as `if (x === "nope")` on `x: "a" | "b"` is, and erroring
  // at the narrow would be erroring at a true statement. The typo dies at the
  // pin (`checkAddressPins` — `enum == "not in the enum"`), and the handle dies
  // where it is USED (`MOV_UNDESCRIBED_POSITION`).
  if (resolved === undefined) return undefined;
  // A pinned address is a NARROWER type than the event it names; an unpinned one
  // IS that event, so it carries no `narrowsEvent` and accepts any listen.
  // Either way the parsed address rides along, so an IS test can narrow by
  // EXTENDING it (subject pins ∪ test pins).
  if (resolved.kind === 'position' || resolved.kind === 'union') {
    const narrowed = Object.keys(address.narrowing).length > 0;
    return { ...resolved, address, ...(narrowed ? { narrowsEvent: address.event } : {}) };
  }
  return resolved;
}

/**
 * The record an event position is ABOUT — the edge the adapter marked
 * `subject`, and where it lands.
 *
 * `undefined` for anything that is not an event node with such an edge: a
 * position that fires the record itself, and a delete-narrowed event (whose
 * `requiresLiveRecord` edges the host drops — the record is gone, so there is
 * nothing one hop away). Both cases mean "this position IS the subject",
 * which is what every caller falls back to.
 *
 * The marker is DECLARED by the adapter and only compared here; nothing reads
 * the edge's name, because a name is a display string an adapter may spell as
 * it likes.
 *
 */
function subjectOf(
  instance: InstanceRef,
  event: PositionSchema,
): { edge: string; target: string; position: PositionSchema } | undefined {
  for (const [edge, schema] of Object.entries(event.edges)) {
    if (schema.subject !== true) continue;
    const position = instance.schema.positions[schema.target];
    if (position === undefined) continue;
    return { edge, target: schema.target, position };
  }
  return undefined;
}

/** Renders a derived event type for a diagnostic — a config-scoped union
 *  reads as its variant list (the per-action displays), a single
 *  action as the variant name. Always the DISPLAY, never the key a narrowed
 *  event address is identified by. */
function describeEventType(type: PositionTypeRef): string {
  if (type.kind === 'union') {
    return type.display ?? type.variants.map((v) => displayNameOf(type.instance, v)).join(' | ');
  }
  if (type.kind === 'position') {
    return type.display ?? displayNameOf(type.instance, type.position);
  }
  return describePosition(type);
}

// ── The checker ──

/**
 * The `return`s of ONE body, collected while its statements are walked. A
 * `return` belongs to the nearest enclosing body — a movement/function, a
 * traversal-headed block, or a closure. An `if` arm pushes nothing: it is
 * transparent, exactly as in TypeScript.
 *
 * `refuses` is set where a statement list is NOT a body — a `parallel`
 * sibling, a race branch — so a `return` there is refused with the reason
 * rather than silently returning from something further out.
 */
interface ReturnCollector {
  /** Author-facing name of the construct, for diagnostics. */
  what: string;
  refuses?: string;
  returns: Array<ReturnShape & { span: Span }>;
}

/** The prefix the ENGINE's own names wear (`#resources`, and the slot a
 *  `return` binds into so it survives a park). Authored bindings may not use
 *  it, which is what makes those slots uncollidable. */
const RESERVED_NAME_PREFIX = '#';

/** A body with no `return` at all. */
const NO_RETURN: ReturnShape = { returns: false };

/** We could not tell whether this returns — an unresolved callee, a cycle in
 *  type space. Neither a claim that it does nor that it doesn't, so no site
 *  refuses on it. */
const UNKNOWN_RETURN: ReturnShape = { returns: true };

/** Which plane a return sits on — `undefined` for a return whose value the
 *  checker could not type (unknown is not a plane). */
function returnPlane(shape: ReturnShape): 'node' | 'scalar' | undefined {
  if (shape.posType !== undefined) return 'node';
  if (shape.fieldType !== undefined) return 'scalar';
  return undefined;
}

/** One checked library: its file scope (the exported symbols live there)
 *  and its error diagnostics (raw, library-file spans). */
interface CheckedLibrary {
  scope: Scope;
  errors: Diagnostic[];
}

/** Shared across the root checker and every nested library checker of one
 *  `checkProgram` call: the resolved link plus the per-path check memo. */
interface LinkContext {
  link: ProgramLink;
  checked: Map<string, CheckedLibrary>;
}

interface CheckerOptions {
  linkContext?: LinkContext;
  /** The file being checked, when it is an imported library (its imports
   *  resolve through `file.imports` rather than `link.imports`). */
  currentFile?: LinkedFile;
  /** Library mode: suppress whole-file invoker advice (LISTEN_MISSING) —
   *  a library is invoker-less by definition. */
  library?: boolean;
  /** Collects scope frames + write regions for the language service. Absent =
   *  the compile path, which records nothing. Imported libraries are checked
   *  by their own Checker without one, so a recording stays file-local. */
  recording?: CheckRecording;
}

class Checker {
  readonly diagnostics: Diagnostic[] = [];

  /** Listens seen anywhere in the file (any listen suppresses LISTEN_MISSING). */
  private listenCount = 0;
  /** Canonical (instance, config) identities for duplicate detection. */
  private readonly listenIdentities = new Set<string>();
  /** `${movement}::${alias}` keys for per-movement alias uniqueness. */
  private readonly listenAliases = new Set<string>();
  /** File-level single-param movements typed against a constructed instance
   *  — the dispatchable ones LISTEN_MISSING reports on when no listen
   *  exists. */
  private readonly dispatchables: Array<{
    movement: string;
    instanceName: string;
    adapter?: string;
    /** The parameter's position — the type the listen's address must land on. */
    position?: string;
    /** The instance's event-address hops, for filling the suggested config. */
    narrowingKeys?: string[];
    span: Span;
  }> = [];

  constructor(
    private readonly catalog: Catalog,
    private readonly options: CheckerOptions = {},
  ) {}

  /** Notes a scope the editor may resolve a cursor inside. Every `new Scope`
   *  the checker opens has one of these beside it — the pairing IS the
   *  guarantee that the editor sees what the checker saw. */
  private recordFrame(kind: ScopeKind, span: Span, scope: Scope): void {
    if (this.typeOnly) return;
    this.options.recording?.frames.push({ kind, span, scope });
  }

  /**
   * Notes an effect-bearing construct the story projection reads. Returns the
   * recorded object (or undefined when nothing is recording), so a site that
   * learns more further down — a listen's derived event types — can finish it
   * where it knows, instead of the walk being re-shaped around one consumer.
   */
  private recordNode<T extends RecordedNode>(node: T): T | undefined {
    if (this.typeOnly) return undefined;
    const recording = this.options.recording;
    if (recording === undefined) return undefined;
    recording.nodes.push(node);
    return node;
  }

  run(program: Program): Scope {
    // Every scope below inherits the declaration log from this one, so a
    // recorded frame always has the history a cursor query resolves against.
    const file = new Scope('file', undefined, { log: this.options.recording !== undefined });
    this.recordFrame('file', SYNTHETIC_SPAN, file);
    // Nothing is ambient. The knowledge graph is an ordinary adapter as of
    // D25 — imported, then CONSTRUCTED against a connection like any other
    // (`graph = kg(credentials: native_knowledge)`); an unconstructed `kg`
    // used as a graph is ADAPTER_NOT_CONSTRUCTED, the true diagnosis.
    this.checkStatementList(program.statements, file);
    if (!this.options.library) this.reportMissingListens();
    return file;
  }

  /**
   * A file that declares a dispatchable movement but no `listen` saves fine
   * (it is a library), but nothing will ever fire the movement — surface
   * that as an INFO diagnostic with a ready-to-paste listen line.
   */
  private reportMissingListens(): void {
    if (this.listenCount > 0) return;
    for (const d of this.dispatchables) {
      const spec = d.adapter !== undefined ? this.catalog.adapter(d.adapter) : undefined;
      const vocabulary = spec?.triggerConfig;
      // A ready-to-paste line means filling the keys a listen MUST carry.
      // Where a required key is the last hop of the event address, the
      // parameter's own position IS the value that address lands on — which
      // is how a graph listen gets `{ type: "Company" }` suggested without
      // anything here knowing what a graph is.
      const required = spec?.triggerConfigRequired ?? [];
      const addressTail = d.narrowingKeys?.[d.narrowingKeys.length - 1];
      const config =
        spec?.triggerConfigFormats?.['schedule'] === 'cron' ? ' { schedule: "0 9 * * 1" }'
        : required.length > 0
          ? ` { ${required
              .map(key =>
                key === addressTail && d.position !== undefined
                  ? `${key}: "${d.position}"`
                  : `${key}: "…"`,
              )
              .join(', ')} }`
        : vocabulary?.includes('key') ? ` { key: "${d.movement.replace(/_/g, '-')}" }`
        : '';
      this.reportInfo(
        DiagnosticCodes.LISTEN_MISSING,
        `'${d.movement}' has no listener, so nothing dispatches it — add a listen statement, e.g. listen to ${d.instanceName}${config} fire ${d.movement}`,
        d.span,
      );
    }
  }

  /**
   * Depth of TYPE-ONLY walks in progress (`movementValueType`). A callee's body
   * is walked to learn what its bindings are, and everything that walk would
   * say is said again — at the declaration, where the author wrote it — when
   * the body is checked for real. So a type-only walk reports nothing and
   * records nothing: it is `silentTyping`, one level up.
   */
  private typeOnlyDepth = 0;

  private get typeOnly(): boolean {
    return this.typeOnlyDepth > 0;
  }

  private report(code: string, message: string, span: Span): void {
    if (this.typeOnly) return;
    this.diagnostics.push({ code, message, span });
  }

  private reportInfo(code: string, message: string, span: Span): void {
    if (this.typeOnly) return;
    this.diagnostics.push({ code, message, span, severity: 'info' });
  }

  private reportWarning(code: string, message: string, span: Span): void {
    if (this.typeOnly) return;
    this.diagnostics.push({ code, message, span, severity: 'warning' });
  }

  /**
   * Declares a binding the AUTHOR wrote, refusing a name an enclosing scope
   * already binds. Shadowing is the one remaining place a name could silently
   * mean two things, so it is a save error — the cross-scope half of the
   * same-scope duplicate rule, not a resolution nicety.
   *
   * A NARROWING is not shadowing and does not come through here: it re-declares
   * the SAME symbol with a sharper type (a guard clause narrowing its subject
   * into the arm, or into the guard's continuation), and calls `scope.declare`
   * directly. Two entry points rather than a flag, because they are two
   * different acts: authoring a name, and sharpening one that exists.
   *
   * Returns the same-scope binding this replaced, exactly as `declare` does, so
   * callers keep reporting their own duplicate errors.
   */
  private declareAuthored(
    scope: Scope,
    symbol: ScopeSymbol,
    span: Span,
    options: { visibleFrom?: Loc } = {},
  ): ScopeSymbol | undefined {
    const shadowing = scope.shadowing(symbol.name);
    if (shadowing !== undefined) {
      const where =
        shadowing.kind === 'bound'
          ? `${describeKind[shadowing.symbol.kind]} at line ${shadowing.symbol.span.start.line}`
          : 'bound further down this file';
      this.report(
        DiagnosticCodes.SHADOWED_NAME,
        `'${symbol.name}' is already ${where} — a name means one thing everywhere it is visible, so this one would hide it. Rename it.`,
        span,
      );
    }
    return scope.declare(symbol, options);
  }

  /** The refinement a name declares (`type Thesis = <"A" | "B">`), when it
   *  declares one — resolved like every other name, so a type is shadowed,
   *  imported and duplicated by the same rules. */
  private declaredTypeIn(name: string, scope: Scope): FieldType | undefined {
    const resolution = scope.resolve(name);
    return resolution.kind === 'found' && resolution.symbol.kind === 'type'
      ? resolution.symbol.fieldType
      : undefined;
  }

  /** A bound name's position type, where one is derivable. */
  private symbolPositionType(symbol: ScopeSymbol): PositionTypeRef | undefined {
    return positionTypeOf(symbol);
  }

  /** A typed expression walker that reports NOTHING — for a second pass over an
   *  expression the checker has already walked (presence narrowing), where
   *  re-reporting would duplicate every diagnostic. */
  private silentTyping(scope: Scope, span: Span): ExpressionTyping {
    return new ExpressionTyping({
      resolveRoot: name => {
        const resolution = scope.resolve(name);
        return resolution.kind === 'found' ? this.symbolPositionType(resolution.symbol) : undefined;
      },
      resolveScalar: name => this.symbolScalarType(scope, name),
      nameInScope: name => scope.resolve(name).kind === 'found',
      report: () => {},
      span,
    });
  }

  /** A bound name's SCALAR (dot-plane) type — the seam that lets a binding's
   *  `T | absent` be read back where the name is USED. Only a scalar-plane
   *  binding answers: a node binding's absence is its position type's. */
  private symbolScalarType(scope: Scope, name: string): FieldType | undefined {
    const resolution = scope.resolve(name);
    if (resolution.kind !== 'found') return undefined;
    return resolution.symbol.bindingPlane === 'scalar' ? resolution.symbol.fieldType : undefined;
  }

  /** A typed expression walker rooted at `scope` that REPORTS and nothing else
   *  — for a walk the program never runs, where a read effect or a recorded
   *  path would claim something happened. */
  private reportingTyping(scope: Scope, span: Span): ExpressionTyping {
    return new ExpressionTyping({
      resolveRoot: name => {
        const resolution = scope.resolve(name);
        return resolution.kind === 'found' ? this.symbolPositionType(resolution.symbol) : undefined;
      },
      resolveScalar: name => this.symbolScalarType(scope, name),
      nameInScope: name => scope.resolve(name).kind === 'found',
      report: (code, message, at, severity) =>
        severity === 'info'
          ? this.reportInfo(code, message, at)
          : severity === 'warning'
            ? this.reportWarning(code, message, at)
            : this.report(code, message, at),
      span,
    });
  }

  /** A typed expression walker rooted at `scope`, reporting at `span`. */
  private slotTyping(scope: Scope, span: Span): ExpressionTyping {
    return new ExpressionTyping({
      resolveRoot: name => {
        const resolution = scope.resolve(name);
        return resolution.kind === 'found' ? this.symbolPositionType(resolution.symbol) : undefined;
      },
      resolveScalar: name => this.symbolScalarType(scope, name),
      nameInScope: name => scope.resolve(name).kind === 'found',
      report: (code, message, at, severity) =>
        severity === 'info'
          ? this.reportInfo(code, message, at)
          : severity === 'warning'
            ? this.reportWarning(code, message, at)
            : this.report(code, message, at),
      span,
      onEffect: (effect) => this.absorbExpressionEffect(effect),
      onWatchableRead: (edge) => this.polledWatchableEdges?.add(edge),
      recordPath: (path) => {
        this.recordNode<RecordedValuePath>({
          kind: 'valuePath',
          span,
          scope,
          key: valuePathKey(path.root, path.steps),
          ...(path.root !== undefined ? { root: path.root } : {}),
          steps: path.steps,
          landings: path.landings.map(recordedLanding),
        });
      },
    });
  }

  /** Resolves `graph.position` / `graph-[:edge WHERE …]->` / bare `graph`
   *  against the graph symbol's schema. */
  private positionFromTypeRef(symbol: ScopeSymbol, type: TypeRef): PositionTypeRef | undefined {
    const instance = instanceRefOf(symbol);
    if (!instance) return undefined;
    // A DECLARATION is its root node, so `<doc>` starts there; a hop off the
    // name is the retired meta-node form (refused at the declaration site).
    if (symbol.kind === 'shape') {
      return type.hopsRaw === undefined ? declaredRootPosition(symbol) : undefined;
    }
    if (type.hopsRaw !== undefined) return positionFromAddress(instance, type.hopsRaw);
    if (type.position === undefined) return { kind: 'meta', instance };
    return positionRefIn(instance, type.position);
  }

  /**
   * `positionFromTypeRef` at a DECLARATION site: when the graph's schema IS
   * known and the named position does not exist, that is an error — the
   * author typed a position the system does not have, and every downstream
   * check would otherwise silently degrade to untyped. Schema-less graph
   * symbols keep the silent contract. Call-site resolutions
   * (`movementParamTypes`) stay non-reporting so a bad declaration is
   * reported once, where it is written.
   *
   * An ADDRESS is checked differently, and deliberately: not "does this resolve"
   * — a narrowing that matches nothing is `never`, a true statement — but "is
   * every value it pins one this hop actually offers". That is where a typo
   * lives, and it is an ordinary enum comparison.
   */
  private positionFromTypeRefStrict(
    symbol: ScopeSymbol,
    type: TypeRef,
    span: Span,
  ): PositionTypeRef | undefined {
    // A node declaration used to be reached through a meta hop
    // (`<Doc-[:item]->>`). The declaration IS the node now, so the hop names a
    // graph that no longer exists — and silently typing the parameter as the
    // root would make the author's `item` mean something they didn't write.
    if (symbol.kind === 'shape' && type.hopsRaw !== undefined) {
      this.report(
        DiagnosticCodes.SHAPE_HOP_RETIRED,
        `'${type.graph}' is a declared node — the structure a parameter is checked against — and it IS the record it describes, so there is nothing to hop through: write '<${type.graph}>'. Its nested nodes are edges you traverse off the parameter instead ('d-[x:${type.position ?? 'name'}]->')`,
        span,
      );
      return undefined;
    }
    const resolved = this.positionFromTypeRef(symbol, type);
    if (type.hopsRaw !== undefined) {
      const instance = instanceRefOf(symbol);
      const address = addressOfTypeRef(type.hopsRaw);
      if (instance && address) this.checkAddressPins(instance, address, span);
      // An UNPINNED address (`position` set) is the bare name it keys as, so a
      // name the schema doesn't have is the same typo the dotted form used to
      // catch — MOV_UNKNOWN_POSITION, with the schema's actual types. A PINNED
      // address that lands nowhere stays silent deliberately: a narrowing that
      // matches nothing is `never`, and its typos die at the pins above.
      if (resolved === undefined && type.position !== undefined) {
        this.reportUnknownPosition(symbol, type.graph, type.position, span);
      }
      return resolved;
    }
    if (resolved === undefined && type.position !== undefined) {
      this.reportUnknownPosition(symbol, type.graph, type.position, span);
    }
    return resolved;
  }

  /**
   * Each pin of an address, checked against what this hop actually offers.
   *
   * `` `table` == "tblDaels" `` is `enum == "a string literal that isn't in the
   * enum"`, so it rides `checkEnumLiteral` — the same membership rule and the
   * same did-you-mean phrasing as every other enum comparison in the language.
   * There is nothing special about an address; the check simply never reached
   * the event node before.
   *
   * THE VARIANCE IS THE MODEL, and it is why this is a LOOP rather than a
   * lookup. `base` is checked against the bases the root walk already holds;
   * `table` only becomes checkable once `base` is pinned, and then only against
   * THAT base's tables. So a pin we can't vouch for ends the walk: a typo'd base
   * makes every table id unknowable, and guessing would mean a `listTables` per
   * base — the 1 + N this whole plan exists to kill, arrived at while
   * diagnosing a typo.
   *
   * Silent where the options weren't published (an adapter that declares no
   * address hops, a prefix the host couldn't walk). Unknown never becomes an
   * accusation.
   *
   */
  private checkAddressPins(instance: InstanceRef, address: EventAddress, span: Span): void {
    // The `action` pin dies at the EVENT NODE'S OWN ENUM — the change-kind
    // axis is an ordinary field there, its options the `events:` vocabulary,
    // so `` `action` == "record.deletd" `` is `enum == "a literal that isn't
    // in the enum"` like any other. Independent of the hop pins below.
    const actionPin = address.narrowing[EVENT_ACTION_FIELD];
    const actionType = instance.schema.positions[address.event]?.properties[EVENT_ACTION_FIELD];
    if (
      actionPin !== undefined
      && typeof actionType === 'object'
      && actionType.kind === 'enum'
    ) {
      const diagnostic = checkEnumLiteral(actionPin, actionType);
      if (diagnostic) {
        if (diagnostic.severity === 'warning') {
          this.reportWarning(diagnostic.code, diagnostic.message, span);
        } else {
          this.report(diagnostic.code, diagnostic.message, span);
          return;
        }
      }
    }
    this.checkHopPins(instance, address.narrowing, () => span);
  }

  /**
   * The hop pins of an event address, each against what the adapter published
   * as legal UNDER THE PINS SO FAR (`eventNarrowingValues`, keyed by prefix).
   * A typo'd hop is `enum == "a literal that isn't in the enum"` — the same
   * `checkEnumLiteral` with the same did-you-mean every other enum comparison
   * rides, never a downstream read error.
   *
   * Shared by the two places an address is WRITTEN: a signature's type ref,
   * and a listen's config. They are the same address in two spellings, so a
   * typo has to die the same way in both — it did not, until D25 made the
   * graph's `type:` an ordinary hop and the asymmetry became visible.
   */
  private checkHopPins(
    instance: InstanceRef,
    pins: Record<string, string | undefined>,
    spanFor: (key: string) => Span,
  ): void {
    const keys = instance.schema.eventNarrowingKeys;
    const values = instance.schema.eventNarrowingValues;
    if (keys === undefined || values === undefined) return;
    const pinned: Record<string, string> = {};
    for (const key of keys) {
      const value = pins[key];
      if (value === undefined) return; // the address pins nothing further
      const options = values[narrowingPrefixKey(pinned)]?.[key];
      if (options === undefined) return; // nobody published what's legal here
      const diagnostic = checkEnumLiteral(value, { kind: 'enum', options });
      if (diagnostic) {
        if (diagnostic.severity === 'warning') {
          this.reportWarning(diagnostic.code, diagnostic.message, spanFor(key));
        } else {
          this.report(diagnostic.code, diagnostic.message, spanFor(key));
        }
        return;
      }
      pinned[key] = value;
    }
  }

  /** MOV_UNKNOWN_POSITION, listing the schema's actual position types. */
  private reportUnknownPosition(
    symbol: ScopeSymbol,
    graphName: string,
    position: string,
    span: Span,
  ): void {
    const schema = isGraphSymbol(symbol) ? symbol.schema : undefined;
    if (!schema) return; // no schema → every schema-typed check stays silent
    const available = [
      ...new Set([...Object.keys(schema.unions ?? {}), ...Object.keys(schema.positions)]),
    ];
    this.report(
      DiagnosticCodes.UNKNOWN_POSITION,
      `'${graphName}' has no position type '${position}'${available.length ? ` — it has: ${available.join(', ')}` : ''}`,
      span,
    );
  }

  /** Lazily types a movement's parameters in its declaring scope (cached on the symbol). */
  private movementParamTypes(symbol: ScopeSymbol): Array<PositionTypeRef | undefined> | undefined {
    const info = symbol.movement;
    if (!info) return undefined;
    if (!info.paramTypes) {
      info.paramTypes = info.decl.params.map(param => {
        // An unannotated parameter is refused where it is DECLARED; here it
        // simply has no type to offer.
        if (param.type === undefined) return undefined;
        const paramType = param.type;
        const resolution = info.declScope.resolve(paramType.graph);
        if (resolution.kind !== 'found') return undefined;
        return this.positionFromTypeRef(resolution.symbol, paramType);
      });
    }
    return info.paramTypes;
  }

  /**
   * The bodies whose `return`s are currently being collected — innermost last.
   * A movement/function, a traversal-headed block and a closure each push one;
   * an `if` arm pushes nothing (it is transparent, as in TypeScript).
   */
  private readonly returnStack: ReturnCollector[] = [];

  // ── The effect row ──

  /**
   * The FUNCTION bodies whose effects are being collected — innermost last. A
   * movement declaration and a closure each push one; an `if` arm, a race
   * branch and a traversal-headed block push nothing, because they are part of
   * the function around them. That is what makes a closure's row its own: its
   * body's effects land in its frame, not in the frame of whoever wrote it.
   */
  private readonly effectStack: EffectFrame[] = [];

  /** The function currently being walked, when there is one. Effects at file
   *  level belong to no function and are dropped. */
  private get effects(): EffectFrame | undefined {
    return this.effectStack[this.effectStack.length - 1];
  }

  /** Walks `body` as one FUNCTION and hands back what it may do. */
  private withEffectFrame<T>(body: () => T): { value: T; row: EffectRow } {
    const frame = new EffectFrame();
    this.effectStack.push(frame);
    let value: T;
    try {
      value = body();
    } finally {
      this.effectStack.pop();
    }
    return { value, row: frame.close() };
  }

  /**
   * The push-backed edges an `until` condition READ, while one is being checked
   * — undefined everywhere else, which is what keeps the nudge to the one place
   * it means something. A set, so a condition that reads the same edge twice
   * says it once.
   */
  private polledWatchableEdges: Set<string> | undefined = undefined;

  /** The effects an expression walk passed, folded into the function around it. */
  private absorbExpressionEffect(effect: ExpressionEffect): void {
    const frame = this.effects;
    if (frame === undefined) return;
    if (effect.kind === 'read') frame.addRead(...effect.instances);
    else frame.flag(effect.kind);
  }

  /** A read/write of whatever graph `type` belongs to. */
  private noteTypedEffect(kind: 'read' | 'write', type: PositionTypeRef | undefined): void {
    const instance = type !== undefined ? instanceOfType(type) : undefined;
    if (kind === 'read') this.effects?.addRead(instance);
    else this.effects?.addWrite(instance);
  }

  /** A read/write against whatever graph a BOUND NAME denotes — the shape
   *  `delete` / `unlink` reach an instance by. */
  private noteNamedEffect(kind: 'read' | 'write', name: string, scope: Scope): void {
    const resolution = scope.resolve(name);
    this.noteTypedEffect(
      kind,
      resolution.kind === 'found' ? this.symbolPositionType(resolution.symbol) : undefined,
    );
  }

  /**
   * What calling `symbol` may do. Computed from the body exactly as
   * `movementReturnType` computes what it hands back — bottom-up over the call
   * graph, and with the same laziness, because a call site may sit above the
   * declaration. There is no recursion in the language, so there is no fixpoint
   * to iterate: a movement whose row is asked for while its own body is being
   * walked answers "unknown" rather than looping.
   */
  private movementEffects(symbol: ScopeSymbol): EffectRow {
    const info = symbol.movement;
    if (info === undefined) return UNKNOWN_ROW;
    if (info.effects !== undefined) return info.effects;
    // Fills `info.effects` as a side effect of walking the body; a cycle leaves
    // it unset, and unknown is the honest answer there.
    this.movementReturnType(symbol);
    return info.effects ?? UNKNOWN_ROW;
  }

  /** Walks `symbol`'s body as one function's, and files the row on the
   *  declaration so every call site reads the same answer. */
  private recordMovementRow(symbol: ScopeSymbol | undefined, walk: () => ReturnShape): ReturnShape {
    const { value, row } = this.withEffectFrame(walk);
    if (symbol?.movement !== undefined) symbol.movement.effects = row;
    return value;
  }

  /** Walks `statements` as ONE body and returns what it hands back. */
  private checkBody(
    statements: Statement[],
    scope: Scope,
    collector: ReturnCollector,
  ): ReturnShape {
    this.returnStack.push(collector);
    try {
      this.checkStatementList(statements, scope);
    } finally {
      this.returnStack.pop();
    }
    return this.closeReturns(collector);
  }

  /**
   * One body's collected `return`s, as its value. A body has ONE value, so
   * returns that disagree about which PLANE they are on — a record position
   * versus a value — is an error naming both. (Returns that agree on the plane
   * but differ in type take the first one's; a real union of position types
   * arrives with the type-model wave.)
   */
  private closeReturns(collector: ReturnCollector): ReturnShape {
    const first = collector.returns[0];
    if (first === undefined) return NO_RETURN;
    const firstPlane = returnPlane(first);
    for (const later of collector.returns.slice(1)) {
      const plane = returnPlane(later);
      if (plane === undefined || firstPlane === undefined || plane === firstPlane) continue;
      this.report(
        DiagnosticCodes.RETURN_PLANE_MISMATCH,
        `${collector.what} returns ${firstPlane === 'node' ? 'a record' : 'a value'} on line ${first.span.start.line} and ${plane === 'node' ? 'a record' : 'a value'} here — a body has one value, so every 'return' in it hands back the same kind of thing`,
        later.span,
      );
    }
    return {
      returns: true,
      ...(first.posType !== undefined ? { posType: first.posType } : {}),
      ...(first.fieldType !== undefined ? { fieldType: first.fieldType } : {}),
    };
  }

  /** `return <value>` — records what this body hands back, against the nearest
   *  enclosing body. */
  private checkReturn(statement: Extract<Statement, { kind: 'return' }>, scope: Scope): void {
    const shape = this.checkRValue(statement.value, scope, undefined, statement.span);
    const collector = this.returnStack[this.returnStack.length - 1];
    if (collector === undefined) {
      this.report(
        DiagnosticCodes.RETURN_OUTSIDE_BODY,
        `'return' hands a value back from a body — there is none here. A movement, a traversal-headed block and a closure each return; file-level statements do not.`,
        statement.span,
      );
      return;
    }
    if (collector.refuses !== undefined) {
      this.report(DiagnosticCodes.RETURN_OUTSIDE_BODY, collector.refuses, statement.span);
      return;
    }
    collector.returns.push({
      returns: true,
      span: statement.span,
      ...(shape.posType !== undefined ? { posType: shape.posType } : {}),
      ...(shape.fieldType !== undefined ? { fieldType: shape.fieldType } : {}),
    });
  }

  /**
   * The type of a CALL of this movement — what its body RETURNS, and nothing
   * else. A callee that never returns hands nothing back: its call is a
   * statement, and binding it is an error at the call site.
   *
   * Computed by walking the body in a fresh scope, lazily and cached exactly as
   * `movementParamTypes` is: a signature is a fact about the declaration, and a
   * call site may sit ABOVE the declaration in the file, so it cannot wait for
   * the body's own check to have happened. The walk is TYPE-ONLY — it reports
   * nothing, because the real check of that body reports everything, at the
   * declaration where the author can act on it.
   */
  private movementReturnType(symbol: ScopeSymbol): ReturnShape {
    const info = symbol.movement;
    if (!info) return UNKNOWN_RETURN;
    // A cycle in TYPE space (a call whose value's type needs its own) has no
    // fixed point to find; recursion is refused anyway, so answering "unknown"
    // here is the same answer arrived at earlier.
    if (info.returnType) return info.returnType.done ? info.returnType.shape : UNKNOWN_RETURN;
    info.returnType = { done: false, shape: UNKNOWN_RETURN };
    const bodyScope = new Scope('movement', info.declScope);
    for (const param of info.decl.params) {
      const paramType = param.type;
      const graphSymbol = paramType !== undefined
        ? info.declScope.resolve(paramType.graph)
        : undefined;
      const posType =
        paramType !== undefined
        && graphSymbol?.kind === 'found'
        && graphSymbol.symbol.kind !== 'adapter'
          ? this.positionFromTypeRef(graphSymbol.symbol, paramType)
          : undefined;
      // A type-only re-walk of a declaration the real walk also visits, so it
      // declares without reporting — the shadowing (and duplicate) errors are
      // this movement's own, raised where the author wrote it.
      bodyScope.declare({
        name: param.name,
        kind: 'param',
        span: param.span,
        ...(posType ? { posType } : {}),
      });
    }
    this.typeOnlyDepth++;
    let shape: ReturnShape;
    try {
      // The row is collected on this walk too — it is the same body, and the
      // type-only pass is what a call ABOVE the declaration has to go through.
      // Silence is about reporting, not about inference.
      shape = this.recordMovementRow(symbol, () =>
        this.checkBody(info.decl.body, bodyScope, {
          what: `'${info.decl.name}'`,
          returns: [],
        }),
      );
    } finally {
      this.typeOnlyDepth--;
    }
    // A returned checker-local node carries a free-text label, and at a call
    // site the useful text is WHOSE value this is. Nothing else about the type
    // changes — a local node IS its structure.
    const labelled: ReturnShape =
      shape.posType?.kind === 'local'
        ? { ...shape, posType: { ...shape.posType, label: `the value of '${info.decl.name}'` } }
        : shape;
    info.returnType = { done: true, shape: labelled };
    return labelled;
  }

  /** The movement's parameters by NAME with their types — what named-argument
   *  matching resolves against. */
  private movementParams(symbol: ScopeSymbol): NamedParams | undefined {
    const info = symbol.movement;
    if (!info) return undefined;
    const types = this.movementParamTypes(symbol) ?? [];
    return info.decl.params.map((param, i) => ({ name: param.name, type: types[i] }));
  }

  // ── Statement lists: hoisting, pending prescan, source-order walk ──

  private checkStatementList(statements: Statement[], scope: Scope): void {
    this.hoistDeclarations(statements, scope);
    this.prescanPending(statements, scope);
    for (const statement of statements) {
      this.checkStatement(statement, scope);
    }
  }

  /** Movement, node and type names are visible across their whole statement
   *  list. Types are hoisted FIRST: a node declaration's field annotation may
   *  name one, and `shapeToSchema` resolves annotations as it builds. */
  private hoistDeclarations(statements: Statement[], scope: Scope): void {
    for (const statement of statements) {
      if (statement.kind !== 'type') continue;
      const existing = this.declareAuthored(
        scope,
        {
          name: statement.name,
          kind: 'type',
          span: statement.span,
          fieldType: declaredTypeOf(statement),
        },
        statement.span,
      );
      if (existing) {
        this.report(
          DiagnosticCodes.DUPLICATE_DECL,
          `'${statement.name}' is already declared as ${describeKind[existing.kind]}`,
          statement.span,
        );
      }
    }
    for (const statement of statements) {
      if (statement.kind !== 'movement' && statement.kind !== 'shape') continue;
      const symbol: ScopeSymbol = {
        name: statement.name,
        kind: statement.kind,
        span: statement.span,
        ...(statement.kind === 'movement'
          ? { arity: statement.params.length, movement: { decl: statement, declScope: scope } }
          : { schema: shapeToSchema(statement, name => this.declaredTypeIn(name, scope)) }),
      };
      const existing = this.declareAuthored(scope, symbol, statement.span);
      if (existing) {
        this.report(
          DiagnosticCodes.DUPLICATE_DECL,
          `'${statement.name}' is already declared as ${describeKind[existing.kind]}`,
          statement.span,
        );
      }
    }
  }

  /** Names later statements will bind, for use-before-bind detection. */
  private prescanPending(statements: Statement[], scope: Scope): void {
    for (const statement of statements) {
      if (statement.kind === 'assign') {
        if (!scope.symbols.has(statement.name)) scope.pending.add(statement.name);
      } else if (statement.kind === 'import') {
        for (const { name, alias } of statement.names) {
          const local = alias ?? name;
          if (!scope.symbols.has(local)) scope.pending.add(local);
        }
      }
    }
  }

  private checkStatement(statement: Statement, scope: Scope): void {
    switch (statement.kind) {
      case 'import':
        this.checkImport(statement, scope);
        return;
      case 'assign':
        this.checkAssign(statement, scope);
        return;
      case 'type':
        // Hoisted by `hoistDeclarations` (before nodes, which may annotate a
        // field with one). Nothing else to check: a closed set of text values
        // says all of itself.
        return;
      case 'shape': {
        // Hoisted normally. When reached outside a hoisted list (e.g. as a
        // parallel sibling), declare here with its derived schema.
        if (!scope.symbols.has(statement.name)) {
          this.declareAuthored(
            scope,
            {
              name: statement.name,
              kind: 'shape',
              span: statement.span,
              schema: shapeToSchema(statement, name => this.declaredTypeIn(name, scope)),
            },
            statement.span,
          );
        }
        // Borrowed field types (`crm_stage: crm.companies.funding_stage`)
        // resolve at the declaration's source position — the same dotted
        // paths extract annotations take — and patch the hoisted schema in
        // place (positions/writableRoots/resultShape alias one object).
        const symbol = scope.symbols.get(statement.name);
        if (symbol?.kind === 'shape' && symbol.schema) {
          this.resolveShapeBorrows(statement.root, statement.name, symbol.schema, scope);
        }
        return;
      }
      case 'movement':
        this.checkMovement(statement, scope);
        return;
      case 'listen':
        this.checkListen(statement, scope);
        return;
      case 'write':
        this.checkWrite(statement.write, scope);
        return;
      case 'call':
        this.checkCall(statement, scope);
        return;
      case 'block':
        this.checkTraversalBlock(statement.block, scope, undefined);
        return;
      case 'link':
        this.checkLink(statement.link, scope);
        return;
      case 'unlink':
        // Mirror name checks, plus the one edge fact a system can state: an
        // edge it only creates along cannot be severed between two records
        // that already exist. The rest of graph/edge validation stays the
        // runtime's (the inverse of the bare-handle `link`).
        this.resolveName(statement.from, statement.span, scope);
        this.resolveName(statement.to, statement.span, scope);
        this.checkBareLinkEdge(
          { from: statement.from, edge: statement.edge, span: statement.span, verb: 'unlink' },
          scope,
        );
        this.noteNamedEffect('write', statement.from, scope);
        return;
      case 'delete':
        this.recordNode({
          kind: 'delete',
          span: statement.span,
          scope,
          subject: statement.name,
        });
        this.resolveName(statement.name, statement.span, scope);
        this.noteNamedEffect('write', statement.name, scope);
        return;
      case 'refresh':
        this.checkRefresh(statement, scope);
        return;
      case 'if':
        this.checkIf(statement, scope);
        return;
      case 'await':
        this.checkAwait(statement.await, scope, undefined);
        return;
      case 'return':
        this.checkReturn(statement, scope);
        return;
      case 'combinator':
        this.reportCombinatorNeedsAwait(statement.combinator);
        this.checkCombinator(statement.combinator, scope, undefined);
        return;
      case 'error':
        this.checkExprSlot(statement.message, scope);
        return;
    }
  }

  // ── Imports ──

  /** The current file's resolved file-imports (root program vs library). */
  private fileImportsMap(): Map<string, LinkedExport> | undefined {
    if (!this.options.linkContext) return undefined;
    return this.options.currentFile?.imports ?? this.options.linkContext.link.imports;
  }

  /**
   * Check (and memoize) one imported library in its OWN scope: same
   * catalog, library mode (no invoker advice), its imports resolved
   * through its own `LinkedFile`. The library's ERROR diagnostics surface
   * ONCE, prefixed with the import path, at the import site that first
   * pulled it in; its info diagnostics belong to the library's own
   * editing session and are dropped here.
   */
  private checkLibrary(file: LinkedFile, at: Span): CheckedLibrary {
    const context = this.options.linkContext;
    if (!context) throw new Error('checkLibrary without a link context');
    const cached = context.checked.get(file.path);
    if (cached) return cached;
    const checker = new Checker(this.catalog, {
      linkContext: context,
      currentFile: file,
      library: true,
    });
    const scope = checker.run(file.program);
    const errors = checker.diagnostics.filter(d => diagnosticSeverity(d) === 'error');
    const result: CheckedLibrary = { scope, errors };
    context.checked.set(file.path, result);
    for (const error of errors) {
      this.report(
        error.code,
        `"${file.path}" line ${error.span.start.line}: ${error.message}`,
        at,
      );
    }
    return result;
  }

  /** An imported name's local symbol — a real movement/declaration symbol when
   *  the link resolved it, an opaque `fileImport` otherwise (the linker
   *  already reported why). */
  private fileImportSymbol(input: {
    local: string;
    name: string;
    span: Span;
    imports: Map<string, LinkedExport>;
  }): ScopeSymbol {
    const opaque: ScopeSymbol = {
      name: input.local,
      importedName: input.name,
      kind: 'fileImport',
      span: input.span,
    };
    const exported = input.imports.get(input.local);
    if (!exported) return opaque;
    const library = this.checkLibrary(exported.file, input.span);
    const librarySymbol = library.scope.symbols.get(exported.name);
    if (exported.kind === 'movement' && librarySymbol?.kind === 'movement') {
      return {
        name: input.local,
        importedName: input.name,
        kind: 'movement',
        span: input.span,
        ...(librarySymbol.arity !== undefined ? { arity: librarySymbol.arity } : {}),
        // The library's own movement info: decl + declScope (the library
        // file scope), so call-fit types parameters against the library's
        // instances and shapes.
        ...(librarySymbol.movement ? { movement: librarySymbol.movement } : {}),
      };
    }
    if (exported.kind === 'shape' && librarySymbol?.kind === 'shape') {
      return {
        name: input.local,
        importedName: input.name,
        kind: 'shape',
        span: input.span,
        ...(librarySymbol.schema ? { schema: librarySymbol.schema } : {}),
        // Graph identity stays the LIBRARY's declaring symbol, so positions
        // made through this import fit the library movements' parameters.
        graphToken: librarySymbol.graphToken ?? librarySymbol,
      };
    }
    return opaque;
  }

  private checkImport(statement: ImportStatement, scope: Scope): void {
    const fileImports = this.fileImportsMap();
    if (statement.source.kind === 'file' && fileImports === undefined) {
      this.report(
        DiagnosticCodes.IMPORT_FILE_UNSUPPORTED,
        `File imports are not resolved here — "${statement.source.path}" needs a file resolver; its names are treated as opaque`,
        statement.span,
      );
    }
    const kindByNamespace: Record<string, SymbolKind> = {
      adapters: 'adapter',
      credentials: 'credential',
      plugins: 'plugin',
    };
    for (const { name, alias } of statement.names) {
      const local = alias ?? name;
      let symbol: ScopeSymbol;
      if (statement.source.kind === 'file') {
        const resolved = fileImports
          ? this.fileImportSymbol({ local, name, span: statement.span, imports: fileImports })
          : { name: local, importedName: name, kind: 'fileImport' as const, span: statement.span };
        symbol = { ...resolved, importPath: statement.source.path };
      } else {
        const namespace = statement.source.namespace;
        const known =
          namespace === 'adapters'
            ? this.catalog.adapter(name) !== undefined
            : namespace === 'credentials'
              ? this.catalog.credential(name) !== undefined
              : this.catalog.plugin(name) !== undefined;
        if (!known) {
          this.report(
            DiagnosticCodes.IMPORT_UNKNOWN,
            `Unknown ${namespace === 'adapters' ? 'adapter' : namespace === 'credentials' ? 'credential' : 'plugin'} '${name}' in '${namespace}'`,
            statement.span,
          );
        }
        // A bare adapter import is NOT an instance — instantiation is
        // explicit (`go = manual()`). The import name carries no schema; using
        // it in a type slot or `listen to` is an error guiding the
        // named-construction fix (spec §"What is removed").
        symbol = {
          name: local,
          importedName: name,
          kind: kindByNamespace[namespace],
          span: statement.span,
          ...(namespace === 'credentials' ? { adapters: this.catalog.credential(name)?.adapters } : {}),
        };
      }
      const existing = this.declareAuthored(scope, symbol, statement.span);
      if (existing) {
        this.report(
          DiagnosticCodes.IMPORT_DUPLICATE,
          `Duplicate import '${local}' — already declared as ${describeKind[existing.kind]}`,
          statement.span,
        );
      }
    }
  }

  // ── Assignment ──

  private checkAssign(statement: AssignStatement, scope: Scope): void {
    // `#` marks the engine's own names (`#resources` is the other one), and the
    // engine binds a body's `return` under such a name so it survives a park.
    // Refusing the prefix here is what makes that slot uncollidable — a
    // backtick-quoted name could otherwise spell anything.
    if (statement.name.startsWith(RESERVED_NAME_PREFIX)) {
      this.report(
        DiagnosticCodes.RESERVED_NAME,
        `'${statement.name}' starts with '${RESERVED_NAME_PREFIX}', which marks the engine's own names — pick a name of your own`,
        statement.span,
      );
    }
    const shape = this.checkRValue(statement.value, scope, statement.name, statement.span);
    const symbol: ScopeSymbol = {
      name: statement.name,
      kind: 'binding',
      span: statement.span,
      ...shape,
    };
    const existing = this.declareAuthored(scope, symbol, statement.span);
    // Bindings are immutable: a name means one thing for the whole scope it is
    // visible in. The cross-scope half of that rule is SHADOWED_NAME; this is
    // the same-scope half. A NARROWING re-declaration never reaches here — it
    // goes through `scope.declare` directly, because it is the same symbol
    // sharpened, not a second binding.
    if (existing !== undefined) {
      this.report(
        DiagnosticCodes.REBOUND_NAME,
        `'${statement.name}' is already ${describeKind[existing.kind]} at line ${existing.span.start.line} — a binding never changes, so this second one would make the name mean two things. Give it a different name.`,
        statement.span,
      );
    }
  }

  /**
   * The right-hand side of a binding — and, since `return <value>` takes the
   * same grammar, of a return. Returns the SHAPE the value carries: its plane
   * and its type, plus (for a construction) the instance facts a graph symbol
   * needs. `name` is the binding's name where there is one, for the sites that
   * label their result with it; a `return` has none.
   */
  private checkRValue(
    value: RValue,
    scope: Scope,
    name: string | undefined,
    span: Span,
  ): Partial<ScopeSymbol> {
    let symbol: Partial<ScopeSymbol> = {};
    switch (value.kind) {
      case 'construct': {
        // `name(args)` is ONE surface form, and only RESOLUTION can say what it
        // means: an adapter TYPE constructs an instance, a movement RUNS and
        // its value is what it returned. The grammar cannot tell them apart —
        // they are spelled identically — so it does not try.
        const called = this.callInConstructPosition(value.construct, scope);
        if (called !== undefined) {
          symbol = { ...symbol, ...this.boundCallShape(called, scope, name, span) };
          break;
        }
        const { adapter, credential, schema } = this.checkConstruction(value.construct, scope);
        if (name === undefined) {
          // A construction DECLARES an instance, so it needs the name it
          // declares. Returning one is meaningless twice over: an instance
          // stands for a live system and its schema is per-credential, so it
          // cannot travel between movements.
          this.report(
            DiagnosticCodes.RETURN_NOT_A_VALUE,
            `'${value.construct.callee}(…)' constructs an instance, and an instance is not a value to hand back — its schema belongs to the credential it was built with. Construct it in the movement that uses it.`,
            span,
          );
          break;
        }
        this.recordNode({
          kind: 'instance',
          span,
          scope,
          name,
          ...(adapter !== undefined ? { adapterType: adapter } : {}),
        });
        // The non-credential args, raw — the instance's entry position rides
        // here, and a listen's required address hops read it (`checkListen`).
        const constructionArgs: Record<string, string> = {};
        for (const arg of value.construct.args) {
          if (arg.name === 'credentials') continue;
          constructionArgs[arg.name] = arg.value.raw;
        }
        symbol = {
          ...symbol,
          kind: 'instance',
          ...(adapter ? { adapter } : {}),
          ...(credential !== undefined ? { credential } : {}),
          ...(schema ? { schema } : {}),
          ...(Object.keys(constructionArgs).length > 0 ? { constructionArgs } : {}),
        };
        break;
      }
      case 'write': {
        const handle = this.checkWrite(value.write, scope, {
          isBound: true,
          binding: name,
        });
        symbol = { ...symbol, ...(handle ? { posType: handle } : {}), bindingPlane: 'node' };
        break;
      }
      case 'link': {
        const handle = this.checkLink(value.link, scope, name);
        symbol = { ...symbol, ...(handle ? { posType: handle } : {}), bindingPlane: 'node' };
        break;
      }
      case 'extract': {
        const result = this.checkExtract(value.extract, scope, name);
        symbol = { ...symbol, posType: result, bindingPlane: 'node' };
        break;
      }
      case 'block': {
        // A bound block's value is what each iteration RETURNED, collected: a
        // list of values on the dot plane, or the returned POSITION on the
        // arrow plane (positions are many-valued already, so plurality lives in
        // the traversal, not in a second type).
        const returned = this.checkTraversalBlock(value.block, scope, name);
        if (!returned.returns) {
          this.report(
            DiagnosticCodes.BLOCK_RETURNS_NOTHING,
            `this block hands nothing back, so there is nothing to bind — 'return' the value you want out of it (\`${name ?? 'names'} = ${rawPath(value.block.head)} { … return <value> }\`), or drop the binding and let it run for its effects`,
            value.block.span,
          );
          break;
        }
        symbol =
          returned.fieldType !== undefined
            ? {
                ...symbol,
                fieldType: listOf(returned.fieldType, returned.headOrdering),
                bindingPlane: 'scalar',
              }
            : { ...symbol, ...(returned.posType ? { posType: returned.posType } : {}), bindingPlane: 'node' };
        break;
      }
      case 'await': {
        const result = this.checkAwait(value.await, scope, name);
        // A traversal / maybe-empty landing binds a NODE (arrow plane); an
        // `until` that resolves a scalar condition binds a SCALAR (dot plane).
        symbol =
          result.fieldType !== undefined
            ? { ...symbol, fieldType: result.fieldType, bindingPlane: 'scalar' }
            : { ...symbol, ...(result.posType ? { posType: result.posType } : {}), bindingPlane: 'node' };
        break;
      }
      case 'combinator': {
        this.reportCombinatorNeedsAwait(value.combinator);
        const receipt = this.checkCombinator(value.combinator, scope, name);
        symbol = {
          ...symbol,
          ...(receipt !== undefined ? { fieldType: receipt } : {}),
          bindingPlane: 'scalar',
        };
        break;
      }
      case 'collection': {
        const result = this.checkCollectionOp(value.collection, scope);
        symbol = {
          ...symbol,
          ...(result !== undefined ? { fieldType: result } : {}),
          bindingPlane: 'scalar',
        };
        break;
      }
      case 'members': {
        const members = this.checkMembers(value.members, scope);
        symbol = {
          ...symbol,
          ...(members !== undefined ? { fieldType: members } : {}),
          bindingPlane: 'scalar',
        };
        break;
      }
      case 'inlineBlock': {
        this.reportInlineBlockRetired(value.inlineBlock, scope);
        break;
      }
      case 'closure': {
        const { params, returns, effects } = this.checkClosure(value.closure, scope, {
          label: name !== undefined ? `the closure '${name}'` : 'this closure',
        });
        symbol = {
          ...symbol,
          posType: closureType(params, returns, effects),
          bindingPlane: 'node',
        };
        break;
      }
      case 'callback': {
        symbol = {
          ...symbol,
          posType: this.checkCallback(value.callback, scope),
          bindingPlane: 'node',
        };
        break;
      }
      case 'call': {
        // The other route to a bound call — the one the parser could tell apart
        // (an argument only a call accepts). Same check, same value.
        symbol = { ...symbol, ...this.boundCallShape(value.call, scope, name, span) };
        break;
      }
      case 'node': {
        symbol = {
          ...symbol,
          posType: this.checkNodeLiteral(value.node, scope),
          bindingPlane: 'node',
        };
        break;
      }
      case 'lazy': {
        // Laziness is evaluation TIME, not type: a deferred traversal binds
        // exactly what the same traversal binds eagerly — the landed node(s),
        // on the arrow plane, awaitability and absence rules included.
        const landed = this.checkLazyTraversal(value.lazy, scope);
        symbol = { ...symbol, ...(landed ? { posType: landed } : {}), bindingPlane: 'node' };
        break;
      }
      case 'expr': {
        const { valueType, parsed } = this.checkExprSlot(value.expr, scope);
        // `channel = ONLY(chat-[ch:Channels WHERE …]->)` picks a POSITION, not
        // a value: it binds the landed node (arrow plane), maybe-empty because
        // the selection may match nothing. The same absence an awaited
        // `resolvesEmpty` landing carries, from the other direction.
        const landed =
          parsed !== undefined
            ? this.landedAggregatePosition(parsed, scope, span)
            : undefined;
        if (landed !== undefined) {
          symbol = { ...symbol, posType: landed, bindingPlane: 'node' };
          break;
        }
        // `btn = a` where `a` is a node: a second NAME for the same position —
        // an alias, carrying the type. Falling through to the scalar plane
        // would bind the name with NO type and everything downstream (chains,
        // awaits) would check silently dark.
        const aliased = this.bareNodeSymbol(value.expr.raw, parsed, scope);
        if (aliased !== undefined) {
          symbol = {
            ...symbol,
            ...(aliased.posType !== undefined ? { posType: aliased.posType } : {}),
            bindingPlane: 'node',
          };
          break;
        }
        // A plain value binding is a SCALAR (F13, dot plane) — capture its type
        // so a race receipt / block meta can type its property read. Bare
        // literals (`done = true`) short-circuit name resolution in
        // checkExprSlot and yield no valueType, so type them directly here.
        const fieldType = valueType ?? scalarLiteralType(value.expr.raw);
        symbol = {
          ...symbol,
          bindingPlane: 'scalar',
          ...(fieldType !== undefined ? { fieldType } : {}),
        };
        break;
      }
    }
    return symbol;
  }

  /**
   * A call whose value is USED — bound to a name, or returned. A call's value
   * IS the callee's return value, so a callee that returns nothing has nothing
   * to give: that is an error here rather than a name bound to nothing.
   */
  private boundCallShape(
    call: CallStatement,
    scope: Scope,
    name: string | undefined,
    span: Span,
  ): Partial<ScopeSymbol> {
    const returned = this.checkCall(call, scope, name);
    if (!returned.returns) {
      // Silent when the callee is unknown (an unresolved name, a file import
      // the linker could not follow): nobody here knows what it returns, and
      // unknown is not a claim.
      if (this.calleeReturnKnown(call, scope)) {
        this.report(
          DiagnosticCodes.CALL_RETURNS_NOTHING,
          `'${call.callee}' returns nothing, so there is no value to bind — a call's value is what it returns. Add a 'return' to '${call.callee}', or call it as a statement.`,
          span,
        );
      }
      return {};
    }
    return returned.fieldType !== undefined
      ? { fieldType: returned.fieldType, bindingPlane: 'scalar' }
      : { ...(returned.posType ? { posType: returned.posType } : {}), bindingPlane: 'node' };
  }

  /** Whether we can vouch for what a callee returns — a movement declared (or
   *  imported and linked) in this program. An unresolved callee has already
   *  been reported as unresolved; saying it "returns nothing" on top would be
   *  a second, wrong accusation. */
  private calleeReturnKnown(call: CallStatement, scope: Scope): boolean {
    const resolution = scope.resolve(call.callee);
    return resolution.kind === 'found' && resolution.symbol.movement !== undefined;
  }

  /** `{ … }.name` — the retired inline block. Its body is still walked, so the
   *  names inside it are checked and the author sees every problem at once. */
  private reportInlineBlockRetired(inline: InlineBlockExpression, scope: Scope): void {
    const blockScope = new Scope('branch', scope);
    this.checkStatementList(inline.body, blockScope);
    this.report(
      DiagnosticCodes.INLINE_BLOCK_RETIRED,
      `reading a block's inner binding by name ('{ … }.${inline.binding}') is retired — a body hands its value back with 'return'. Bind the value directly, or write a closure ('() => { … return ${inline.binding} }') where the body should run later.`,
      inline.span,
    );
  }

  /**
   * `(d: <date>) => { … }` — an anonymous closure. Its body is checked in a
   * CHILD of the enclosing scope (JS closure semantics, which is also the
   * park's capture rule: whatever an `await` park carries, a closure captures),
   * with its parameters bound inside; its `return`s are its own, so the
   * closure's type carries what calling it yields.
   *
   * `valueParamsOnly` is the CALLBACK's extra rule, not the closure's: what a
   * platform sends at fire time is a value, never a record.
   */
  private checkClosure(
    closure: ClosureExpression,
    scope: Scope,
    options: {
      label: string;
      valueParamsOnly?: boolean;
      /**
       * The types the CALLER supplies, by position — a collection op knows
       * what it hands its function. An annotation still wins where one is
       * written (it is the author saying something narrower); an unannotated
       * parameter takes this, and one with neither is refused.
       */
      suppliedParams?: ReadonlyArray<PlaneType>;
    },
  ): { params: ClosureParam[]; returns: ReturnShape; effects: EffectRow } {
    const bodyScope = new Scope('branch', scope);
    this.recordFrame('branch', closure.span, bodyScope);
    const params: ClosureParam[] = [];
    for (const [index, param] of closure.params.entries()) {
      const supplied = options.suppliedParams?.[index];
      const shape: PlaneType = param.type === undefined && supplied !== undefined
        ? this.asShape(supplied)
        : options.valueParamsOnly === true
        ? this.asShape({ fieldType: this.checkCallbackParamType(param.type, param.name, scope) })
        : this.closureParamShape(param, scope);
      if (param.type === undefined && supplied === undefined) {
        this.reportParamNeedsType(param.name, param.span, options.label);
      }
      params.push({ name: param.name, ...shape });
      const existing = this.declareAuthored(
        bodyScope,
        {
          name: param.name,
          kind: 'param',
          span: param.span,
          ...(shape.posType !== undefined
            ? { posType: shape.posType }
            : {
                bindingPlane: 'scalar' as const,
                ...(shape.fieldType !== undefined ? { fieldType: shape.fieldType } : {}),
              }),
        },
        param.span,
      );
      if (existing) {
        this.report(DiagnosticCodes.DUPLICATE_DECL, `Duplicate parameter '${param.name}'`, param.span);
      }
    }
    // The body is its OWN function: what it does belongs to the closure's type,
    // not to whoever wrote it down. Writing a closure has no effects; calling
    // one has the closure's.
    const { value: returns, row: effects } = this.withEffectFrame(() =>
      this.checkBody(closure.body, bodyScope, { what: options.label, returns: [] }),
    );
    return { params, returns, effects };
  }

  /** Drops the undefined halves of a shape, so an absent type never reaches a
   *  symbol as a present-but-undefined key. */
  private asShape(shape: PlaneType): PlaneType {
    return {
      ...(shape.posType !== undefined ? { posType: shape.posType } : {}),
      ...(shape.fieldType !== undefined ? { fieldType: shape.fieldType } : {}),
    };
  }

  /** A closure parameter's type — the same two things a movement parameter may
   *  be: a scalar, or an address into a graph in scope. */
  private closureParamShape(param: MovementParam, scope: Scope): PlaneType {
    const written = param.type;
    // No annotation ⇒ nothing written to resolve. The caller decides whether
    // something SUPPLIES the type (a collection op does) or the parameter is
    // simply missing one.
    if (written === undefined) return {};
    const scalar = written.hopsRaw === undefined ? parseFieldTypeName(written.graph) : undefined;
    if (scalar !== undefined) return { fieldType: scalar };
    const graphSymbol = this.resolveName(written.graph, written.span, scope);
    if (graphSymbol === undefined || graphSymbol.kind === 'adapter') return {};
    const posType = this.positionFromTypeRefStrict(graphSymbol, written, written.span);
    return posType !== undefined ? { posType } : {};
  }

  /**
   * The symbol a bare-name slot refers to, when that name is bound on the NODE
   * plane — the `btn = a` / `btn: a` shapes. Bare plain names short-circuit
   * `checkExprSlot`'s parse, so the raw spelling is checked first; backtick
   * names only exist parsed, so the bridged expression is the fallback.
   */
  private bareNodeSymbol(
    raw: string,
    parsed: Expression | undefined,
    scope: Scope,
  ): ScopeSymbol | undefined {
    const trimmed = raw.trim();
    const name =
      BARE_IDENT.test(trimmed) && !EXPR_LITERALS.has(trimmed.toUpperCase())
        ? trimmed
        : parsed !== undefined
          ? bareName(parsed)
          : undefined;
    if (name === undefined) return undefined;
    const resolution = scope.resolve(name);
    if (resolution.kind !== 'found') return undefined;
    const { symbol } = resolution;
    return symbol.posType !== undefined || symbol.bindingPlane === 'node' ? symbol : undefined;
  }

  /**
   * The position `ONLY(<bare traversal>)` / `FIRST(…)` / `LAST(…)` lands on, as a
   * maybe-empty node — undefined for every other expression (which binds a
   * scalar as before). The walk is the ordinary hop walk; the only new fact is
   * WHICH plane the result belongs to, which the aggregate's shape decides:
   * a bare path aggregates POSITIONS (the bridge's sentinel terminal), a
   * property path aggregates values.
   *
   * Walked silently — `checkExprSlot` has already reported everything this walk
   * would say.
   */
  private landedAggregatePosition(
    expr: Expression,
    scope: Scope,
    span: Span,
  ): PositionTypeRef | undefined {
    const path = aggregatedBarePath(expr);
    if (path === undefined) return undefined;
    const rootSymbol =
      path.aliasRoot !== undefined ? scope.resolve(path.aliasRoot) : undefined;
    const start =
      rootSymbol?.kind === 'found' ? this.symbolPositionType(rootSymbol.symbol) : undefined;
    if (start === undefined) return undefined;
    const landed = this.silentTyping(scope, span).walkSteps(start, path.steps);
    return landed !== undefined ? { kind: 'maybeEmpty', of: landed } : undefined;
  }

  /**
   * `lazy <traversal>` — the walk, deferred. There is nothing type-side to
   * defer: this is `checkAwait`'s traversal branch with the wake removed, so
   * the hop chain is walked, its WHERE is typed, an awaitable edge still
   * demands `await` (the walk reports that), and the result is the landed
   * position. Every downstream rule — FIRST over it, `== null`, emptiness as
   * a gate — is then the ordinary traversal rule, because the type is the
   * ordinary traversal's type.
   *
   */
  private checkLazyTraversal(lazy: LazyTraversal, scope: Scope): PositionTypeRef | undefined {
    const head = this.checkPathHead(lazy.head, scope);
    const typing = this.slotTyping(scope, lazy.head.span);
    const landed =
      head.steps && head.rootType !== undefined
        ? typing.walkSteps(head.rootType, head.steps)
        : undefined;
    if (lazy.mapping === undefined) return landed;
    // PER-ITEM synthesis: the tail is a node literal typed in the LANDING's
    // scope, so the hop's alias names what the walk reached and its fields read
    // there. The mapped landing IS the literal's structure — the source's names
    // are gone by construction, which is the whole point (a callee couples to
    // the mapping, never to the source).
    return this.checkNodeLiteral(lazy.mapping, this.landingScope(lazy, head, typing, scope));
  }

  /**
   * The scope a per-item tail is written in: a child of where the traversal was
   * written, carrying the head's hop aliases and nothing else. Exactly the
   * scope a traversal BLOCK gives its body — the tail is that body, written as
   * a position instead of statements — so the alias is in scope inside the tail
   * and nowhere outside it.
   */
  private landingScope(
    lazy: LazyTraversal,
    head: HeadInfo,
    typing: ExpressionTyping,
    scope: Scope,
  ): Scope {
    const landing = new Scope('traversal', scope);
    this.recordFrame('traversal', lazy.mapping?.span ?? lazy.span, landing);
    for (const alias of head.aliases) {
      const aliasType = typing.locals.get(alias);
      this.declareAuthored(
        landing,
        {
          name: alias,
          kind: 'alias',
          span: lazy.head.span,
          ...(aliasType ? { posType: aliasType } : {}),
        },
        lazy.head.span,
      );
    }
    return landing;
  }

  // ── await (asks-as-adapter wake primitive) ──

  /**
   * `await <traversal>` / `await sleep(<duration>)` — the wake primitive
   * (asks-as-adapter §A, P18). A traversal await must target an AWAITABLE edge
   * (else MOV_NOT_AWAITABLE); a bare traversal of one is the inverse error
   * (MOV_AWAIT_REQUIRED, fired in the walk), and its WHERE must be pure
   * (MOV_AWAIT_IMPURE_WHERE, also in the walk). The bound result types as the
   * landed node(s) — `r.answer` reads a field, `r-[x:E]->` traverses — and an
   * empty resolution binds an empty match (downstream runs zero times; the
   * `T | absent` typing that difference wants is chunk C). `await sleep(…)`
   * binds nothing (the branch waits, then continues).
   */
  private checkAwait(
    awaitExpr: AwaitExpression,
    scope: Scope,
    binding: string | undefined,
  ): { posType?: PositionTypeRef; fieldType?: FieldType } {
    const source = awaitExpr.source;
    // Every spelling of `await` parks the run. Where it parks is an address in
    // the body, which is why `suspend` is a flag and not a set.
    this.effects?.flag('suspend');
    /** Filled in below, once the source is known well enough to describe. */
    const record = (recorded: RecordedAwaitSource): void => {
      this.recordNode({
        kind: 'await',
        span: awaitExpr.span,
        scope,
        ...(binding !== undefined ? { binding } : {}),
        source: recorded,
      });
    };
    if (source.kind === 'sleep') {
      record({ kind: 'sleep', duration: source.duration.raw });
      if (!isValidDuration(source.duration.raw)) {
        this.report(
          DiagnosticCodes.AWAIT_BAD_DURATION,
          `'${source.duration.raw}' is not a valid duration — use unit-suffixed literals like 4h, 2d, 90m, 1h30m`,
          source.duration.span,
        );
      }
      return {};
    }
    if (source.kind === 'until') {
      record({ kind: 'until', ...(source.every !== undefined ? { every: source.every.raw } : {}) });
      return this.checkUntil(source, scope);
    }
    // The combinators (core calculus v2 R5): `race`/`parallel` compose the
    // wait, and the `await` is what parks. The value is the positional receipt.
    if (source.kind === 'combinator') {
      const receipt = this.checkCombinator(source.combinator, scope, binding);
      return receipt !== undefined ? { fieldType: receipt } : {};
    }
    // The bare-walk spelling is retired: the park IS the FIRST read, parked,
    // and the language spells it that way. Refuse with the rewrite, then keep
    // typing as the FIRST form would — one error, no cascade.
    if (source.kind === 'traversal') {
      this.report(
        DiagnosticCodes.AWAIT_BARE_WALK,
        `'await ${rawPath(source.head)}' — a bare walk under 'await' is retired. The park is the FIRST read, parked: write 'await FIRST(${rawPath(source.head)})'`,
        source.span,
      );
    }
    const head = this.checkPathHead(source.head, scope);
    if (!head.steps || head.rootType === undefined) {
      record({
        kind: 'traversal',
        ...(source.head.root !== undefined ? { root: source.head.root } : {}),
      });
      return {};
    }
    const typing = this.slotTyping(scope, source.head.span);
    const landed = typing.walkSteps(head.rootType, head.steps, { awaited: true });
    const finalEdge = typing.lastEdgeSchema;
    const lastStep = head.steps[head.steps.length - 1];
    record({
      kind: 'traversal',
      ...(source.head.root !== undefined ? { root: source.head.root } : {}),
      ...(lastStep?.type === 'edge' ? { edge: lastStep.edgeTypeId } : {}),
      // An undescribed edge claims nothing — the flags stay ABSENT rather than
      // defaulting to false, so "we didn't look" reads differently from "no".
      ...(finalEdge !== undefined
        ? { awaitable: finalEdge.awaitable === true, resolvesEmpty: finalEdge.resolvesEmpty === true }
        : {}),
    });
    // Only error when the final edge is KNOWN and non-awaitable; an undescribed
    // or untyped edge stays silent (the checker's honesty rule — unknown is not
    // a claim).
    if (finalEdge !== undefined && finalEdge.awaitable !== true) {
      this.report(
        DiagnosticCodes.AWAIT_NOT_AWAITABLE,
        `'FIRST(${rawPath(source.head)})' can't be awaited — 'await' waits on an edge whose resolution resumes the run (an ask's Response). This is an ordinary edge; read it live, without 'await'.`,
        source.head.span,
      );
    } else if (finalEdge?.awaitable === true && finalEdge.watchable !== true) {
      // A bare `await FIRST(…)` states no cadence, which is only honest where
      // the source WAKES the run. Where it doesn't, the cadence is the author's
      // and the language has one spelling for it.
      const edgeName = lastStep?.type === 'edge' ? lastStep.edgeTypeId : undefined;
      this.report(
        DiagnosticCodes.AWAIT_NEEDS_CADENCE,
        `${edgeName !== undefined ? `'-[:${edgeName}]->'` : 'This edge'} resolves, but nothing tells the run when — this source sends no event, so a bare 'await' would wait forever. Say how often to look: \`await until(() => { return EXISTS(${rawPath(source.head)}) }, every: 15m)\`.`,
        source.head.span,
      );
    }
    // F19/F20: an edge that declares `resolvesEmpty` (an ask `Response` a cancel
    // can settle empty) lands a MAYBE-EMPTY node — its field reads type
    // `T | absent`. A traversal-as-gate INTO it (`r-[x:E]-> { … }`) discharges
    // that (the block runs zero times when empty). Slack `Replies` (a reply
    // always has content) does not declare it, so its landing is plain.
    if (landed !== undefined && finalEdge?.resolvesEmpty === true) {
      return { posType: { kind: 'maybeEmpty', of: landed } };
    }
    return landed !== undefined ? { posType: landed } : {};
  }

  /**
   * `await until(<condition>, every: <duration>)` (F12) — the recurring-clock
   * wake source. The condition is evaluated each tick; the await resolves when it
   * holds, binding the condition's value. Checks: the cadence is a valid duration
   * ≥ 1m (floor); the condition is READ-ONLY (an inline-block body may only read /
   * `refresh` — a write/ask/await/race inside is MOV_AWAIT_IMPURE_CONDITION).
   * Returns the condition's type so the binding types correctly.
   */
  private checkUntil(
    source: Extract<AwaitSource, { kind: 'until' }>,
    scope: Scope,
  ): ReturnShape {
    if (source.every !== undefined) {
      if (!isValidDuration(source.every.raw)) {
        this.report(
          DiagnosticCodes.AWAIT_BAD_DURATION,
          `'${source.every.raw}' is not a valid cadence — use unit-suffixed literals like 5m, 1h, 2d`,
          source.every.span,
        );
      } else if (durationToMs(source.every.raw) < UNTIL_CADENCE_FLOOR_MS) {
        this.report(
          DiagnosticCodes.UNTIL_CADENCE_TOO_SHORT,
          `'${source.every.raw}' re-checks faster than the 1m floor — an 'until' condition is re-evaluated on a timer, so its cadence must be at least 1m. Use a longer interval (5m, 1h).`,
          source.every.span,
        );
      }
    }
    const conditionSpan =
      source.condition.kind === 'expr' ? source.condition.expr.span : source.condition.closure.span;
    const outer = this.polledWatchableEdges;
    this.polledWatchableEdges = new Set();
    try {
      return this.checkUntilCondition(source, scope);
    } finally {
      const watchable = [...this.polledWatchableEdges];
      this.polledWatchableEdges = outer;
      if (watchable.length > 0) {
        // The rewrite is the AUTHOR's — an adapter growing webhooks must not
        // quietly change when a saved movement wakes up.
        this.reportWarning(
          DiagnosticCodes.UNTIL_EDGE_WATCHABLE,
          `${watchable.map(edge => `'-[:${edge}]->'`).join(', ')} now arrives as it happens, so this doesn't have to be checked on a timer — 'await FIRST(…)' on it waits without polling.`,
          conditionSpan,
        );
      }
    }
  }

  /** The condition itself: a bound closure, a plain boolean expression, or a
   *  closure written inline. Split out so the watchable-edge nudge can bracket
   *  all three from one place. */
  private checkUntilCondition(
    source: Extract<AwaitSource, { kind: 'until' }>,
    scope: Scope,
  ): ReturnShape {
    if (source.condition.kind === 'expr') {
      // A NAMED closure is the same condition, bound earlier: what it returns
      // is what the tick tests. Anything else is the boolean expression form —
      // the closure with its ceremony elided.
      const named = this.bareNodeSymbol(source.condition.expr.raw, undefined, scope);
      if (named?.posType?.kind === 'closure') {
        this.checkExprSlot(source.condition.expr, scope);
        // The clock CALLS this condition, so its effects are the movement's —
        // naming it earlier changed where it was written, not what it does.
        this.effects?.absorb(named.posType.effects);
        return named.posType.returns;
      }
      const { valueType } = this.checkExprSlot(source.condition.expr, scope);
      return { returns: true, ...(valueType !== undefined ? { fieldType: valueType } : {}) };
    }
    // A CLOSURE condition: an ordinary closure, plus the two things being a
    // condition adds — its body must be read-only (it runs every tick) and it
    // must take no parameters (nothing supplies them; the clock just calls it).
    const closure = source.condition.closure;
    if (closure.params.length > 0) {
      this.report(
        DiagnosticCodes.AWAIT_IMPURE_CONDITION,
        `an 'until' condition is called by the clock, so nothing can supply '${closure.params[0].name}' — write it with no parameters: 'until(() => { … }, every: …)'`,
        closure.params[0].span,
      );
    }
    this.checkUntilPurity(closure.body);
    const condition = this.checkClosure(closure, scope, { label: "this 'until' condition" });
    this.effects?.absorb(condition.effects);
    return condition.returns;
  }

  /**
   * An `await until(…)` condition is re-evaluated on a timer, so its inline-block
   * body must be READ-ONLY (extends the MOV_AWAIT_IMPURE_WHERE family). Allowed:
   * value reads (`ok = …`), `refresh` (a read that moves a snapshot to now), and
   * `if` over the same (recursed). Refused: any effect — a write, an ask, a
   * nested await/race, a link/unlink/delete. Each offending statement is flagged
   * where it sits.
   */
  private checkUntilPurity(body: Statement[]): void {
    for (const statement of body) {
      switch (statement.kind) {
        case 'refresh':
          break;
        case 'return':
          // Handing the answer back IS the condition; what it hands back is
          // checked as an ordinary value.
          break;
        case 'assign':
          // A read binding (`ok = expr`) or a nested inline block is fine; an
          // effectful RValue is not.
          if (statement.value.kind !== 'expr' && statement.value.kind !== 'inlineBlock') {
            this.reportImpureCondition(statement.value.kind, statement.span);
          }
          break;
        case 'if':
          statement.arms.forEach((arm) => this.checkUntilPurity(arm.body));
          if (statement.elseArm) this.checkUntilPurity(statement.elseArm.body);
          break;
        default:
          this.reportImpureCondition(statement.kind, statement.span);
      }
    }
  }

  private reportImpureCondition(what: string, span: Span): void {
    this.report(
      DiagnosticCodes.AWAIT_IMPURE_CONDITION,
      `an 'until' condition is re-evaluated on a timer, so it must be read-only — a '${what}' here would act every tick. Keep the condition to reads and 'refresh'; do the effect after the await resolves.`,
      span,
    );
  }

  // ── refresh (asks-as-adapter F5) ──

  /**
   * `refresh <handle>` — re-fetch the record behind a STABLE handle, moving its
   * field snapshot to now. Refresh needs a re-fetchable record id, so the head
   * must be a write handle or a traversed record (`handle` / `position` /
   * `union`). Refusing (MOV_REFRESH_UNSTABLE): the EVENT payload (a movement
   * `param` — inline event data with no stored record to re-read) and an
   * EXTRACTED node (`extract` — synthesized, not stored). A graph root / receipt
   * / block-meta is not a record either. Untyped heads stay silent (the honesty
   * rule). The since-deleted case is a RUN error, not an author-time one (F22).
   */
  private checkRefresh(statement: RefreshStatement, scope: Scope): void {
    this.recordNode({
      kind: 'refresh',
      span: statement.span,
      scope,
      subject: statement.name,
    });
    // `refresh` re-FETCHES the record behind a handle — it moves a snapshot to
    // now and changes nothing at the source, so it rows as a read. (The engine
    // resolves its adapter with role 'source', and an `until` condition, which
    // must be read-only, admits it.)
    this.noteNamedEffect('read', statement.name, scope);
    const resolution = scope.resolve(statement.name);
    if (resolution.kind !== 'found') {
      this.reportResolutionFailure(statement.name, statement.nameSpan, resolution);
      return;
    }
    const symbol = resolution.symbol;
    if (symbol.kind === 'param') {
      this.report(
        DiagnosticCodes.REFRESH_UNSTABLE,
        `'${statement.name}' is the event payload — 'refresh' re-fetches a stored record by its id, and the event has none. Refresh a write handle or a traversed record instead.`,
        statement.nameSpan,
      );
      return;
    }
    const posType = this.symbolPositionType(symbol);
    if (posType === undefined) return; // untyped — stay silent
    if (posType.kind === 'handle' || posType.kind === 'position' || posType.kind === 'union') {
      return; // a re-fetchable record
    }
    const what =
      posType.kind === 'extract'
        ? 'an extracted node — synthesized during extraction, not a stored record'
        : `${describePosition(posType)} — not a re-fetchable record`;
    this.report(
      DiagnosticCodes.REFRESH_UNSTABLE,
      `'${statement.name}' is ${what}. 'refresh' re-fetches a stored record by its id — refresh a write handle or a traversed record instead.`,
      statement.nameSpan,
    );
  }

  // ── the collection ops (core calculus v2, wave 4b) ──

  /** A parameter with no type, where nothing supplies one. */
  private reportParamNeedsType(name: string, span: Span, what: string): void {
    this.report(
      DiagnosticCodes.PARAM_NEEDS_TYPE,
      `'${name}' needs a type — ${what} declares what it accepts, so a caller can be checked against it: write '${name}: <text>' (or whatever it takes). A parameter goes untyped only where the caller supplies the type, which is the function a collection op is given.`,
      span,
    );
  }

  /**
   * `MAP(xs, f)` / `FILTER(xs, f)` / `REDUCE(xs, init, f)` / `GROUPBY(xs, key)`
   * / `KEYBY(xs, key)` — iteration over a VALUE collection.
   *
   * The function is called once per element, so the element's type is the
   * parameter's (TypeScript's contextual typing, and the reason the annotation
   * is optional there); its row folds in, exactly as a combinator arm's does,
   * because what a movement causes to run is what it does.
   *
   * Ordering (wave 4a) propagates rather than being decided here: `MAP` and
   * `FILTER` hand back a list ordered exactly as far as the input was, because
   * neither reorders anything. `REDUCE` is order-SENSITIVE — it reads the
   * elements one after another and the answer changes when they are permuted —
   * so it is refused over a collection whose order means nothing, the same
   * refusal `JOIN` gets. `GROUPBY`'s groups each keep the source's ordering;
   * the dict around them has none, because a dict is looked up, not folded.
   */
  private checkCollectionOp(expr: CollectionOpExpression, scope: Scope): FieldType | undefined {
    const spelling = COLLECTION_OP_SPELLING[expr.op];
    const source = this.checkExprSlot(expr.source, scope);
    const init = expr.init !== undefined ? this.checkExprSlot(expr.init, scope) : undefined;
    // A name bound on the NODE plane is a position (or several) — the one
    // mistake worth naming, since the reflex is to reach for MAP over a
    // traversal and the language's answer is a block.
    const asPosition = this.bareNodeSymbol(expr.source.raw, source.parsed, scope);
    if (asPosition !== undefined) {
      this.reportNotACollection(spelling, describeKind[asPosition.kind], expr.source.span);
      return undefined;
    }
    const element = this.collectionElementType(source.valueType, spelling, expr.source.span);
    const ordering = collectionOrderOf(source.valueType);

    // The order-sensitive one, held to the same rule every order-sensitive fold
    // is held to.
    if (expr.op === 'reduce' && ordering === 'unordered') {
      this.report(
        DiagnosticCodes.FOLD_NEEDS_ORDER,
        `'REDUCE' reads the members one after another, so the answer depends on the order they are in — and nothing has given this collection one. Order the traversal it came from ('ORDER BY'), or fold it with something that answers the same over any order ('COUNT', 'SUM', 'MIN', 'MAX', 'ONLY').`,
        expr.source.span,
      );
    }

    const carried = expr.op === 'reduce' ? (init?.valueType) : undefined;
    const shape = this.checkCollectionFunction(expr, spelling, scope, element, carried);

    switch (expr.op) {
      case 'map':
        return shape.fieldType !== undefined ? listOf(shape.fieldType, ordering) : undefined;
      case 'filter':
        // What survives is what went in, in the order it was in.
        return element !== undefined ? listOf(element, ordering) : undefined;
      case 'reduce':
        // The carried value's type, which is the function's return where it
        // typed and the starting value's where it did not.
        return shape.fieldType ?? carried;
      case 'groupby':
        this.requireDictKeyIn(scope, expr.fn, shape.fieldType, `filed under by '${spelling}'`);
        return element !== undefined
          ? { kind: 'dict', of: listOf(element, ordering) }
          : undefined;
      case 'keyby':
        this.requireDictKeyIn(scope, expr.fn, shape.fieldType, `filed under by '${spelling}'`);
        return element !== undefined ? { kind: 'dict', of: element } : undefined;
    }
  }

  /** What one member of the collection an op reads is. */
  private collectionElementType(
    source: FieldType | undefined,
    spelling: string,
    span: Span,
  ): FieldType | undefined {
    if (source === undefined) return undefined; // unknown stays silent
    const element = collectionElementOf(source);
    if (element === undefined) this.reportNotACollection(spelling, describeFieldType(source), span);
    return element;
  }

  private reportNotACollection(spelling: string, what: string, span: Span): void {
    this.report(
      DiagnosticCodes.COLLECTION_OP_NOT_A_COLLECTION,
      `'${spelling}' reads a collection of values, and this is ${what}. A traversal's landings are POSITIONS and have their own form — the traversal-headed block ('root-[x:edge]-> { … }'); return the values you want out of one and read those.`,
      span,
    );
  }

  /**
   * The function a collection op is given: checked as an arm (a closure in
   * place, or a name bound to one), but CALLED WITH arguments — so its
   * parameters take their types from the collection where the author left them
   * unwritten.
   */
  private checkCollectionFunction(
    expr: CollectionOpExpression,
    spelling: string,
    scope: Scope,
    element: FieldType | undefined,
    carried: FieldType | undefined,
  ): ReturnShape {
    const supplied = expr.op === 'reduce'
      ? [{ fieldType: carried }, { fieldType: element }]
      : [{ fieldType: element }];
    const arity = supplied.length;
    if (expr.fn.kind === 'closure') {
      const params = expr.fn.closure.params;
      if (params.length !== arity) {
        this.reportArmArity(spelling, arity, params.length, params[0]?.name, expr.fn.span);
      }
      const { returns, effects } = this.checkClosure(expr.fn.closure, scope, {
        label: `the function for '${spelling}'`,
        suppliedParams: supplied,
      });
      this.absorbCollectionRow(effects, spelling, expr.fn.span);
      this.requireCollectionReturn(returns, spelling, expr.fn.span);
      return returns;
    }
    const named = this.checkArm(expr.fn, spelling, scope, undefined, arity);
    this.requireCollectionReturn(named, spelling, expr.fn.span);
    return named;
  }

  /** A collection op runs its function to completion, once per member. */
  private absorbCollectionRow(row: EffectRow, spelling: string, span: Span): void {
    if (row.suspend) {
      this.report(
        DiagnosticCodes.COLLECTION_OP_SUSPENDS,
        `the function for '${spelling}' waits ('await'), and '${spelling}' runs it over every member to build one value — there is no answer for what the collection is while it waits. Wait outside it: walk the positions in a traversal-headed block, or run the waits together with 'await parallel([…])'.`,
        span,
      );
    }
    this.effects?.absorb(row);
  }

  private requireCollectionReturn(shape: ReturnShape, spelling: string, span: Span): void {
    if (shape.returns) return;
    this.report(
      DiagnosticCodes.COLLECTION_OP_RETURNS_NOTHING,
      `the function for '${spelling}' hands nothing back, so there is nothing for '${spelling}' to do with each member — 'return' the answer for one.`,
      span,
    );
  }

  /** A key function's answer, held to the dict key rule. */
  private requireDictKeyIn(
    scope: Scope,
    fn: ArmExpression,
    key: FieldType | undefined,
    where: string,
  ): void {
    this.slotTyping(scope, fn.span).requireDictKey(key, where);
  }

  /**
   * `MEMBERS(<Thesis>)` — a closed type's values, as an ORDERED list: the order
   * they were declared in, which is a fact about the type and is exactly why
   * this exists (sections in a report come from the declaration, not from a
   * hand-kept list beside it).
   *
   * An OPEN known-values set is refused: its options are what could be listed,
   * not all there are, so there is no complete membership to walk.
   */
  private checkMembers(expr: MembersExpression, scope: Scope): FieldType | undefined {
    const type = this.resolveNamedType(expr.type, expr.typeSpan, scope);
    if (type === undefined) return undefined;
    const named = stripAbsent(type);
    if (typeof named !== 'object' || named.kind !== 'enum') {
      this.report(
        DiagnosticCodes.MEMBERS_NOT_CLOSED,
        `'MEMBERS' lists the values of a closed set, and '${expr.type}' is ${describeFieldType(named)} — there is nothing to list. Declare the set ('type ${expr.type} = <"A" | "B">'), or name a field whose options the system holds.`,
        expr.typeSpan,
      );
      return undefined;
    }
    if (named.open !== undefined) {
      this.report(
        DiagnosticCodes.MEMBERS_NOT_CLOSED,
        `'${expr.type}' is a known-values field: those options are the ones we could read, and other values are legal there too — so there is no complete list of them to walk. Declare the set you mean ('type Thesis = <"A" | "B">') and iterate that.`,
        expr.typeSpan,
      );
      return undefined;
    }
    // Ordered by construction: declaration order is the whole point.
    return { kind: 'list', of: named };
  }

  // ── the concurrency combinators (core calculus v2 R5) ──

  /** A combinator composes a wait; `await` is what parks. */
  private reportCombinatorNeedsAwait(expr: CombinatorExpression): void {
    this.report(
      DiagnosticCodes.COMBINATOR_NEEDS_AWAIT,
      `'${expr.kind}([…])' does not park by itself — it composes a wait, and 'await' is what parks: write 'await ${expr.kind}([…])'`,
      expr.span,
    );
  }

  /**
   * `await race([…])` / `await parallel([…])` — and the retired unawaited
   * spellings, which type identically for recovery.
   *
   * The arms are FUNCTION values and the combinator calls them, so an arm's
   * effects are this movement's (the callback-folding rule: what a movement
   * causes to run is what it does) and a combinator always adds `suspend`.
   *
   * The value is POSITIONAL — one slot per arm, in the order written:
   * - `parallel` joins everything, so each slot holds what its arm returned.
   * - `race` settles on the first arm to settle, so each slot is `T | null`;
   *   an arm that hands nothing back (a bare `sleep`) is an always-null slot,
   *   which is a different fact from "we could not type this arm" and typed
   *   differently (`absent` vs an untyped slot).
   *
   * Literal arms are a fixed, written-down set, so the receipt is a TUPLE and a
   * literal-index read types exactly. Arms built at run time are same-typed by
   * construction but nothing here can see their type — the receipt is untyped
   * and the row says the row is a lower bound.
   */
  private checkCombinator(
    expr: CombinatorExpression,
    scope: Scope,
    binding: string | undefined,
  ): FieldType | undefined {
    const recorded = this.recordNode<RecordedCombinator>({
      kind: 'combinator',
      combinator: expr.kind,
      span: expr.span,
      scope,
      ...(binding !== undefined ? { binding } : {}),
      arms: [],
    });
    // Running arms concurrently is still running them: the combinator waits,
    // so it parks. Where it parks is an address in the body, which is why
    // `suspend` is a flag.
    this.effects?.flag('suspend');

    if (expr.arms.kind === 'dynamic') {
      this.checkExprSlot(expr.arms.expr, scope);
      // A collection built at run time holds functions, and a function is not a
      // value type here — so what its arms return cannot be seen from the
      // collection. Untyped, and the row says so; claiming a shape would be the
      // lie this checker never tells.
      this.effects?.markPartial();
      return undefined;
    }

    const slots = expr.arms.arms.map(arm => this.checkArm(arm, expr.kind, scope, recorded));
    return {
      kind: 'tuple',
      of: slots.map(slot => {
        // An arm that hands nothing back is an always-null slot under BOTH
        // combinators — `parallel` introduces no nulls, but it cannot invent a
        // value the arm never produced.
        if (!slot.returns) return 'absent';
        if (slot.fieldType === undefined) return null;
        return (expr.kind === 'race' ? maybeAbsent(slot.fieldType) : slot.fieldType) ?? null;
      }),
    };
  }

  /**
   * One arm: a closure written in place, or the name of a function bound
   * earlier. Either way the combinator CALLS it, so the arm's row folds into
   * this movement's and its return shape becomes the slot.
   *
   * An arm that returns a record POSITION types its slot as unknown: a tuple
   * joins the VALUE sorts, and there is no honest slot type for a position.
   * The run still carries it; the checker simply says nothing about it.
   */
  private checkArm(
    arm: ArmExpression,
    kind: string,
    scope: Scope,
    recorded: RecordedCombinator | undefined,
    /** How many arguments the caller supplies. A combinator supplies none —
     *  there is no caller to take them from — and a collection op supplies the
     *  member (and, for `REDUCE`, the value carried so far). */
    expectedArity = 0,
  ): ReturnShape {
    if (arm.kind === 'closure') {
      const armScope = new Scope('branch', scope);
      const { params, returns, effects } = this.checkClosure(arm.closure, scope, {
        label: `an arm of '${kind}'`,
      });
      recorded?.arms.push({ span: arm.span, ...(armScope ? { scope: armScope } : {}) });
      if (params.length !== expectedArity) {
        this.reportArmArity(kind, expectedArity, params.length, params[0]?.name, arm.span);
      }
      this.effects?.absorb(effects);
      return returns;
    }

    recorded?.arms.push({ span: arm.span });
    const resolution = scope.resolve(arm.name);
    if (resolution.kind !== 'found') {
      this.reportResolutionFailure(arm.name, arm.span, resolution);
      this.effects?.markPartial();
      return UNKNOWN_RETURN;
    }
    const symbol = resolution.symbol;
    if (symbol.kind === 'movement') {
      if (symbol.arity !== undefined && symbol.arity !== expectedArity) {
        this.reportArmArity(
          kind,
          expectedArity,
          symbol.arity,
          this.movementParams(symbol)?.keys().next().value,
          arm.span,
        );
      }
      this.effects?.absorb(this.movementEffects(symbol));
      return this.movementReturnType(symbol);
    }
    if (symbol.posType?.kind === 'closure') {
      const closure = symbol.posType;
      if (closure.params.length !== expectedArity) {
        this.reportArmArity(
          kind,
          expectedArity,
          closure.params.length,
          closure.params[0]?.name,
          arm.span,
        );
      }
      this.effects?.absorb(closure.effects);
      return closure.returns;
    }
    if (symbol.kind === 'fileImport') {
      // A file import may be a movement — M3 resolves it; give it the benefit
      // of the doubt, exactly as a call site does.
      this.effects?.markPartial();
      return UNKNOWN_RETURN;
    }
    this.effects?.markPartial();
    this.report(
      DiagnosticCodes.COMBINATOR_ARM_NOT_FUNCTION,
      `'${arm.name}' is ${describeKind[symbol.kind]}, and '${kind}' RUNS its arms — an arm has to be a function. Name a movement, or write the work as a closure: \`() => { … }\`.`,
      arm.span,
    );
    return UNKNOWN_RETURN;
  }

  /** The function's parameters and what the caller supplies disagree. A caller
   *  that supplies NOTHING is the combinators' case and gets their message —
   *  a parameter there could only ever arrive null. */
  private reportArmArity(
    kind: string,
    expected: number,
    got: number,
    param: string | undefined,
    span: Span,
  ): void {
    if (expected === 0) {
      this.report(
        DiagnosticCodes.COMBINATOR_ARM_TAKES_NOTHING,
        `'${kind}' calls its arms with nothing, so ${param !== undefined ? `'${param}'` : 'a parameter'} could only ever arrive null. Take no parameters — a closure already sees everything in scope where it is written.`,
        span,
      );
      return;
    }
    this.report(
      DiagnosticCodes.COLLECTION_OP_ARITY,
      expected === 1
        ? `'${kind}' calls its function with one member at a time, and this one takes ${got}: write '(member) => { … }'`
        : `'${kind}' calls its function with two things — the value carried so far and the next member — and this one takes ${got}: write '(carried, member) => { … }'`,
      span,
    );
  }

  // ── callback (the deferred, addressable invocation) ──

  /**
   * `callback(<subject>)` / `callback(<subject>, { once, ttl })` — mints a
   * deferred invocation and types the binding it yields.
   *
   * The binding is a CHECKER-LOCAL node (`kind: 'local'`): `.id` / `.url`
   * reads, plus a `Called` edge whose landing carries `At` and one field per
   * FIRE-TIME parameter — derived here, at the construction site, from the
   * subject's own signature. Nothing is grafted and nothing is looked up: a
   * callback belongs to no system.
   *
   * The body is checked in a CHILD of the enclosing scope — JS closure
   * semantics, which is also the park's capture rule: whatever an `await` park
   * carries across a park, a callback body captures, and every existing capture
   * diagnostic (use-before-bind, a `parallel` sibling's binding, an escaped
   * block alias) applies inside the body unchanged. The body produces no value:
   * there is no `.binding` accessor to read one with.
   *
   */
  private checkCallback(callback: CallbackExpression, scope: Scope): PositionTypeRef {
    const subject = callback.subject;
    const fireTimeParams =
      subject.kind === 'inline'
        ? this.checkCallbackInline(subject, scope)
        : this.checkCallbackNamed(subject, scope);
    this.checkCallbackConfig(callback.config, scope);
    return callbackType(fireTimeParams);
  }

  /** The inline subject IS an ordinary closure — the deferred body a callback
   *  wraps. Its parameters are the FIRE-TIME signature (none is supplied here),
   *  and what the body returns goes nowhere: firing a callback resumes a run,
   *  it does not hand a value to whoever minted it. */
  private checkCallbackInline(
    subject: Extract<CallbackSubject, { kind: 'inline' }>,
    scope: Scope,
  ): CallbackParams {
    const { params, effects } = this.checkClosure(subject.closure, scope, {
      label: 'a callback body',
      valueParamsOnly: true,
    });
    // Minting a callback SCHEDULES the body — the platform calls it, but this
    // movement is what causes the call, so the body's effects are the
    // movement's. A row that said "writes nothing" for a movement whose
    // callback writes to the CRM would be the silent-degradation failure.
    this.effects?.absorb(effects);
    return params.map((param) => ({ name: param.name, type: param.fieldType }));
  }

  /**
   * The named subject — the ONE position where a movement is a value.
   * Arguments type against the movement's parameters exactly as a listen types
   * against a signature (parameter vs argument), with one difference that IS
   * the feature: only the FIXED arguments are supplied here, so a parameter the
   * author leaves out is not missing — it is the callback's fire-time
   * signature, bound by the router from what the platform sends.
   */
  private checkCallbackNamed(
    subject: Extract<CallbackSubject, { kind: 'named' }>,
    scope: Scope,
  ): CallbackParams {
    const resolution = scope.resolve(subject.movement);
    const callee = resolution.kind === 'found' ? resolution.symbol : undefined;
    if (callee === undefined || (callee.kind !== 'movement' && callee.kind !== 'fileImport')) {
      // A file import may be a movement — the linker resolves it; benefit of
      // the doubt, exactly as a call site gives.
      this.report(
        DiagnosticCodes.CALLBACK_NOT_MOVEMENT,
        callee === undefined
          ? `'${subject.movement}' is not a movement in this file${didYouMean(subject.movement, movementNamesInScope(scope))} — a callback defers an inline body ('callback({ … })') or a movement by name`
          : `'${subject.movement}' is ${describeKind[callee.kind]}, not a movement — a callback defers an inline body ('callback({ … })') or a movement by name`,
        subject.nameSpan,
      );
    }
    // Deferring a movement by name schedules the same run a call would — same
    // reasoning as the inline body above.
    if (callee?.kind === 'movement') this.effects?.absorb(this.movementEffects(callee));
    else if (callee?.kind === 'fileImport') this.effects?.markPartial();
    const declared = callee?.kind === 'movement' ? this.movementParams(callee) : undefined;
    const paramTypeOf = this.checkNamedArgs({
      callee: subject.movement,
      args: subject.args.map(arg => ({ name: arg.name, span: callArgSpan(arg) })),
      params: declared,
      span: subject.span,
      // Unsupplied parameters are the fire-time signature, not omissions.
      partial: true,
    });
    for (const arg of subject.args) {
      this.checkCallArg(subject.movement, arg, paramTypeOf.get(arg.name), scope);
    }
    if (declared === undefined || callee?.movement === undefined) return [];
    const supplied = new Set(subject.args.map(arg => arg.name));
    const params: Array<{ name: string; type: FieldType | undefined }> = [];
    for (const param of callee.movement.decl.params) {
      if (supplied.has(param.name)) continue;
      params.push({
        name: param.name,
        // The declaration checked its own parameter types; here we only ask
        // whether what is LEFT can come from a platform.
        type: this.checkCallbackParamType(param.type, param.name, undefined, subject.nameSpan),
      });
    }
    return params;
  }

  /**
   * A callback's fire-time parameter is a VALUE a platform sends (a picked
   * date, entered text) — so its declared type must be a scalar. A record
   * position is a legitimate movement parameter and an impossible callback one:
   * no platform can hand us a record, so say so at the callback rather than
   * letting the `Called` landing quietly lose the field.
   */
  private checkCallbackParamType(
    type: TypeRef | undefined,
    name: string,
    /** The DECLARING scope, when this callback declares the parameter itself
     *  (the inline form) — a named movement already checked its own. */
    scope: Scope | undefined,
    at?: Span,
  ): FieldType | undefined {
    // No annotation: reported where the parameter was DECLARED (a closure's
    // by `checkClosure`, a movement's by its declaration), so this only has to
    // say it has no type to offer.
    if (type === undefined) return undefined;
    const scalar = type.hopsRaw === undefined ? parseFieldTypeName(type.graph) : undefined;
    if (scalar !== undefined) return scalar;
    // Keep the graph name honest (an unresolvable one is still reported), then
    // refuse it as a fire-time value.
    if (scope !== undefined) this.resolveName(type.graph, at ?? type.span, scope);
    this.report(
      DiagnosticCodes.CALLBACK_PARAM_NOT_VALUE,
      `a callback's parameter '${name}' is a value the platform sends when the callback fires, so it has to be a scalar type (<text>, <number>, <boolean>, <date>, <datetime>, <json>, <file>) — '<${type.graph}${type.hopsRaw ?? ''}>' is a record position, which nothing can hand us. Supply it as a fixed argument instead.`,
      at ?? type.span,
    );
    return undefined;
  }

  /**
   * `{ once: <boolean>, ttl: <duration> }` — a CLOSED vocabulary, so an unknown
   * key is an enum error with a did-you-mean rather than a silently-ignored
   * setting. `once` defaults TRUE (a callback fires once unless it says
   * otherwise); the default lives in the engine, not here.
   */
  private checkCallbackConfig(config: NamedArg[], scope: Scope): void {
    const seen = new Set<string>();
    for (const entry of config) {
      if (seen.has(entry.name)) {
        this.report(
          DiagnosticCodes.CALLBACK_BAD_CONFIG,
          `Duplicate callback config '${entry.name}' — each setting is given once`,
          entry.value.span,
        );
      }
      seen.add(entry.name);
      switch (entry.name) {
        case 'once': {
          const literal = scalarLiteralType(entry.value.raw);
          if (literal !== undefined && literal !== 'boolean') {
            this.report(
              DiagnosticCodes.CALLBACK_BAD_CONFIG,
              `'once' says whether the callback may fire more than once — write TRUE or FALSE, not ${entry.value.raw.trim()}`,
              entry.value.span,
            );
            break;
          }
          if (literal === undefined) this.checkExprSlot(entry.value, scope);
          break;
        }
        case 'ttl':
          if (!isValidDuration(entry.value.raw.trim())) {
            this.report(
              DiagnosticCodes.CALLBACK_BAD_CONFIG,
              `'${entry.value.raw.trim()}' is not a valid ttl — use unit-suffixed duration literals like 4h, 2d, 90m, 1h30m`,
              entry.value.span,
            );
          }
          break;
        default:
          this.report(
            DiagnosticCodes.CALLBACK_BAD_CONFIG,
            `'${entry.name}' is not a callback setting${didYouMean(entry.name, CALLBACK_CONFIG_KEYS)} — a callback takes: ${CALLBACK_CONFIG_KEYS.join(', ')}`,
            entry.value.span,
          );
      }
    }
  }

  // ── Construction ──

  /** `doc = email_to_doc(m: msg)` — the construction-shaped form, when the name
   *  it invokes is a FUNCTION. One sort, so one test: a movement and a plugin
   *  are both called here, and only an adapter type constructs. Undefined for
   *  everything else, which is the construction the parser recorded. */
  private callInConstructPosition(
    construct: ConstructionCall,
    scope: Scope,
  ): CallStatement | undefined {
    const resolution = scope.resolve(construct.callee);
    if (resolution.kind !== 'found') return undefined;
    const kind = resolution.symbol.kind;
    if (kind !== 'movement' && kind !== 'plugin') return undefined;
    return constructionAsCall(construct);
  }

  /** Returns the adapter name (when the callee is a known adapter import), the
   *  credential the construction names (catalog-side), and the instance schema. */
  private checkConstruction(
    construct: ConstructionCall,
    scope: Scope,
  ): { adapter?: string; credential?: string; schema?: InstanceSchema } {
    const resolution = scope.resolve(construct.callee);
    if (resolution.kind !== 'found') {
      this.reportResolutionFailure(construct.callee, construct.span, resolution);
      return {};
    }
    const callee = resolution.symbol;
    if (callee.kind !== 'adapter') {
      this.report(
        DiagnosticCodes.CONSTRUCT_NOT_ADAPTER,
        callee.kind === 'fileImport'
          ? `'${construct.callee}' is imported from a file (a movement or a node declaration) — only adapter types are constructed`
          : `'${construct.callee}' is ${describeKind[callee.kind]}, not an adapter type — only adapter types are constructed`,
        construct.span,
      );
      return {};
    }

    const adapterName = callee.importedName ?? construct.callee;
    const spec = this.catalog.adapter(adapterName);
    if (!spec) return { adapter: adapterName }; // unknown import already reported

    const credArg = credentialArgOf(spec);

    const instantiate = (): InstanceSchema | undefined => {
      const args: Record<string, string> = {};
      for (const arg of construct.args) {
        if (arg.name === DRY_RUN_ARG) continue; // platform arg, not adapter config
        const raw = arg.value.raw.trim();
        args[arg.name] = arg.name === credArg?.name ? this.importedCredentialName(raw, scope) : raw;
      }
      return this.catalog.instantiate(adapterName, args);
    };

    // Resolve the credential name up front — an enum-typed arg's options
    // depend on it (which spreadsheets THIS connection can see), and the
    // credential arg may appear after the position arg in source order.
    const credArgRaw = credArg
      ? construct.args.find((a) => a.name === credArg.name)?.value.raw.trim()
      : undefined;
    const credentialName =
      credArgRaw !== undefined ? this.importedCredentialName(credArgRaw, scope) : undefined;

    let sawCredentialArg = false;
    for (const arg of construct.args) {
      if (arg.name === DRY_RUN_ARG) {
        if (!BOOLEAN_LITERAL.test(arg.value.raw.trim())) {
          this.report(
            DiagnosticCodes.CONSTRUCT_BAD_ARG,
            `'${DRY_RUN_ARG}' takes a boolean literal — write ${DRY_RUN_ARG}: true (or false)`,
            arg.value.span,
          );
        }
        continue;
      }
      if (!spec.constructionArgs.some((a) => a.name === arg.name)) {
        this.report(
          DiagnosticCodes.CONSTRUCT_BAD_ARG,
          `'${construct.callee}' does not accept a construction argument '${arg.name}' — it accepts: ${spec.constructionArgs
            .map((a) => a.name)
            .join(', ')}`,
          arg.value.span,
        );
        continue;
      }
      if (credArg && arg.name === credArg.name) {
        sawCredentialArg = true;
        this.checkCredentialArg(adapterName, arg.value, scope);
      } else {
        this.checkExprSlot(arg.value, scope);
        // Enum-typed (entry-position) arg: warn on a value this connection
        // can't see. Soft — grants change, so it never blocks a save.
        const options = this.catalog.constructionArgOptions?.({
          adapter: adapterName,
          ...(credentialName !== undefined ? { credentialName } : {}),
          arg: arg.name,
        });
        const literal = staticStringLiteralOf(arg.value);
        if (options && options.length > 0 && literal !== undefined && !options.includes(literal)) {
          this.reportWarning(
            DiagnosticCodes.CONSTRUCT_UNKNOWN_OPTION,
            `'${arg.name}' value "${literal}" isn't one this connection can see — try: ${options
              .map((o) => `"${o}"`)
              .join(', ')}`,
            arg.value.span,
          );
        }
      }
    }
    if (credArg?.required && !sawCredentialArg) {
      this.report(
        DiagnosticCodes.CONSTRUCT_MISSING_CRED,
        `'${construct.callee}' requires a '${credArg.name}' argument naming an imported ${construct.callee} credential`,
        construct.span,
      );
    }
    return {
      adapter: adapterName,
      ...(credentialName !== undefined ? { credential: credentialName } : {}),
      schema: instantiate(),
    };
  }

  /** The catalog-side name of a credential referenced by a (possibly aliased or backtick-quoted) local name. */
  private importedCredentialName(local: string, scope: Scope): string {
    // Unwrap backtick-quoted names before scope lookup — the scope registers
    // credentials by their verbatim (backtick-stripped) name.
    const name = unwrapCredentialArg(local) ?? local;
    const resolution = scope.resolve(name);
    return resolution.kind === 'found' && resolution.symbol.kind === 'credential'
      ? (resolution.symbol.importedName ?? name)
      : name;
  }

  private checkCredentialArg(adapter: string, slot: ExprSlot, scope: Scope): void {
    const raw = slot.raw.trim();
    const name = unwrapCredentialArg(raw);
    if (name === null) {
      this.report(
        DiagnosticCodes.CRED_WRONG_ADAPTER,
        `The credential argument must be an imported credential name, not an expression`,
        slot.span,
      );
      return;
    }
    const resolution = scope.resolve(name);
    if (resolution.kind !== 'found') {
      this.reportResolutionFailure(name, slot.span, resolution);
      return;
    }
    const symbol = resolution.symbol;
    if (symbol.kind !== 'credential') {
      this.report(
        DiagnosticCodes.CRED_WRONG_ADAPTER,
        `'${name}' is ${describeKind[symbol.kind]}, not a credential`,
        slot.span,
      );
      return;
    }
    if (symbol.adapters !== undefined && !symbol.adapters.includes(adapter)) {
      const served = symbol.adapters.join(', ');
      this.report(
        DiagnosticCodes.CRED_WRONG_ADAPTER,
        `'${name}' is a ${served} credential — '${adapter}' needs a ${adapter} credential`,
        slot.span,
      );
    }
  }

  // ── Writes ──

  /**
   * `write a { … }` — update the record bound at alias `a` in place. The
   * alias must resolve to a record position (a traversal alias or a prior
   * write result — both are positions), and that position's adapter must be
   * able to update records by id (`supportsInPlaceUpdate`). No entity
   * resolution happens: the record is already identified, so the
   * required-field/edge create-gates don't apply and `unique by` is rejected
   * (handled by the caller). Returns the position itself as the result type —
   * a written position is still a position.
   */
  /**
   * `write … bind other { … }` — the engine-owned correspondence
   * declaration. Three rules (3b_explicit_link_model.md):
   *   - `bind` is meaningless on a position write — that write already
   *     holds the exact record; reject.
   *   - `unique by` and `bind` don't compose — the binding IS the identity;
   *     reject the `unique by`.
   *   - `other` must resolve to a stable record position (a traversal
   *     alias, a prior write handle, the event position, an extracted /
   *     traversed record) — the same record-shaped binding correspondence
   *     keys on. A meta/block/value/import binding has no single record.
   * One bind per write is structural (the AST holds a single clause), so
   * compound binding can't be expressed — no diagnostic needed.
   */
  private checkBindClause(
    write: WriteExpression,
    scope: Scope,
    target: PositionTypeRef | undefined,
  ): void {
    const bind = write.bind;
    if (bind === undefined) return;
    if (write.target.kind === 'position') {
      this.report(
        DiagnosticCodes.WRITE_BIND_POSITION,
        `'bind' has no meaning on a position write — 'write ${write.target.alias} { … }' already holds the exact record, so there is no counterpart to establish. Drop the 'bind ${bind.name}'`,
        bind.span,
      );
      return;
    }
    // A bound write re-fires as `updateRecord` when the counterpart recurs — so
    // the TARGET system must support update-by-id. An append-only / write-only
    // target (`supportsInPlaceUpdate` false) would typecheck and then throw on
    // the second fire; reject it at author time instead.
    if (
      target !== undefined &&
      'instance' in target &&
      target.instance.schema.supportsInPlaceUpdate !== true
    ) {
      this.report(
        DiagnosticCodes.WRITE_BIND_NO_UPDATE,
        `'${target.instance.name}' can't update records in place — but a 'bind' write re-fires as an update when '${bind.name}' recurs, so the target needs update-by-id. Drop the 'bind ${bind.name}' (a plain create/append), or bind to a system that supports updates`,
        bind.span,
      );
      return;
    }
    if (write.uniqueBy.length > 0) {
      this.report(
        DiagnosticCodes.WRITE_BIND_UNIQUE,
        `'unique by' and 'bind ${bind.name}' don't combine — a bound write's identity IS the binding, so field uniqueness has no role. Drop the 'unique by' clause (it applies only to writes without a bind)`,
        write.uniqueBy[0].span,
      );
    }
    const resolution = scope.resolve(bind.name);
    if (resolution.kind !== 'found') {
      this.reportResolutionFailure(bind.name, bind.span, resolution);
      return;
    }
    const posType = this.symbolPositionType(resolution.symbol);
    // Schema-less / untyped binding: unknown never errors (consistent with
    // position writes) — stay silent.
    if (posType === undefined) return;
    if (posType.kind !== 'position' && posType.kind !== 'handle' && posType.kind !== 'union') {
      this.report(
        DiagnosticCodes.WRITE_BIND_NOT_RECORD,
        `'${bind.name}' is ${describePosition(posType)} — 'bind' names the counterpart RECORD this write corresponds to, so it needs a record position: a traversal alias, a prior write result, or the event position`,
        bind.span,
      );
    }
  }

  private checkPositionWriteTarget(
    target: Extract<WriteExpression['target'], { kind: 'position' }>,
    scope: Scope,
  ): { root?: WritableRootSchema; handle?: PositionTypeRef; description: string } {
    const resolution = scope.resolve(target.alias);
    if (resolution.kind !== 'found') {
      this.reportResolutionFailure(target.alias, target.span, resolution);
      return { description: `'${target.alias}'` };
    }
    const posType = this.symbolPositionType(resolution.symbol);
    // Schema-less / untyped binding: unknown never errors — stay silent and
    // type-check the body against nothing.
    if (posType === undefined) return { description: `'${target.alias}'` };
    if (posType.kind !== 'position' && posType.kind !== 'handle' && posType.kind !== 'union') {
      this.report(
        DiagnosticCodes.WRITE_POSITION_NOT_RECORD,
        `'${target.alias}' is ${describePosition(posType)} — 'write ${target.alias} { … }' updates an already-identified record in place, so it needs a record position: a traversal alias or a prior write result`,
        target.span,
      );
      return { description: `'${target.alias}'` };
    }
    if (!posType.instance.schema.supportsInPlaceUpdate) {
      this.report(
        DiagnosticCodes.WRITE_POSITION_NO_UPDATE,
        `'${posType.instance.name}' can't update records in place — its system has no update-by-id. To change ${describePosition(posType)}, create a new record (a graph-root, linked, or tuple-path write) instead of 'write ${target.alias} { … }'`,
        target.span,
      );
      return { description: describePosition(posType) };
    }
    const recordType =
      posType.kind === 'union' ? posType.union : posType.position;
    const root = recordType !== undefined ? posType.instance.schema.writableRoots[recordType] : undefined;
    return { root, handle: posType, description: describePosition(posType) };
  }

  /**
   * Selects the variant of a DISCRIMINATED write shape from the body's
   * discriminant literal — the write-side dual of read narrowing (a literal
   * picks a variant). Returns the selected variant as the effective root (its
   * `fields`/`requiredFields` govern the rest of the check) and a description
   * that names the variant, so a wrong-variant field reads clearly ("no 'Stage'
   * on … (listName: \"Pipeline\")"). Falls back to the enclosing schema —
   * unchanged root and description — for a non-discriminated write, or when the
   * discriminant can't select a variant:
   *
   *  - MISSING → the fallback's `requiredFields` (the discriminant is required)
   *    reports the missing-field error; nothing to select.
   *  - present but NOT a compile-time literal → ERROR here (a create must know
   *    its shape at author time), then fall back.
   *  - a literal that names no variant → the fallback's enum discriminant field
   *    reports MOV_ENUM_UNKNOWN_VALUE (the typo); nothing to select.
   */
  private selectWriteVariant(
    root: WritableRootSchema | undefined,
    write: WriteExpression,
    rootDescription: string,
  ): { root: WritableRootSchema | undefined; description: string; variant?: WritableRootSchema } {
    const discriminated = root?.discriminated;
    if (root === undefined || discriminated === undefined) {
      return { root, description: rootDescription };
    }
    const discBody = write.fields.find((f) => f.name === discriminated.discriminant);
    if (discBody === undefined) return { root, description: rootDescription };
    const literal = staticStringLiteralOf(discBody.value);
    if (literal === undefined) {
      this.report(
        DiagnosticCodes.WRITE_DISCRIMINANT_NOT_LITERAL,
        `'${discriminated.discriminant}' selects what ${rootDescription} can carry, so it must be a fixed value known here — name it with a literal (e.g. ${discriminated.discriminant}: "${Object.keys(discriminated.variants)[0] ?? '…'}"), not an expression. A create names its target; it can't discover the shape at run time`,
        discBody.value.span,
      );
      return { root, description: rootDescription };
    }
    const variant = discriminated.variants[literal];
    if (variant === undefined) return { root, description: rootDescription };
    return {
      root: variant,
      variant,
      description: `${rootDescription} (${discriminated.discriminant}: "${literal}")`,
    };
  }

  /**
   * The handle a DISCRIMINATED write hands back stands on the VARIANT, not on
   * the collection the write was addressed through. `entry = write org-[:List
   * Entries]-> { listName: "Master Deals List", … }` is addressed at the
   * membership collection — which publishes nothing but the discriminant,
   * because it is the intersection of every list — while the record it created
   * is a row of one named list, and that type is the one carrying `Owners`. So
   * a chained write or a `link` off `entry` resolves its edge against the list's
   * own type, exactly as a READ narrowed by the same literal already does
   * (layer 1b). One literal, one type, both directions.
   *
   * The variant's `position` is the type name; when the variant mints no
   * position at all its fields and edges still ride the handle, which is what a
   * writable-only landing already does.
   */
  private handleOfVariant(
    handle: PositionTypeRef | undefined,
    variant: WritableRootSchema,
  ): PositionTypeRef | undefined {
    if (handle === undefined || handle.kind !== 'handle') return handle;
    const position = variant.position;
    const minted = position !== undefined && handle.instance.schema.positions[position] !== undefined;
    return {
      ...handle,
      ...(minted ? { position: position! } : {}),
      resultShape: variant.resultShape,
      ...(variant.edges !== undefined ? { edges: variant.edges } : {}),
    };
  }

  /**
   * An UNTAGGED write union (`WritableRootSchema.writeUnion`): the fields the
   * body MAPS must be a subset of at least one variant. Plain assignability —
   * nothing discriminates the variants, so there is nothing to select and
   * nothing to narrow; a body that fits several (only shared fields set) is
   * fine, and a body that fits none is an error naming the shapes.
   *
   * Only fields the root DECLARES count: an unknown name is
   * MOV_WRITE_UNKNOWN_FIELD's to report, and counting it here would blame the
   * union for a typo. Requiredness is untouched and orthogonal.
   */
  private checkWriteUnion(input: {
    write: WriteExpression;
    root: WritableRootSchema | undefined;
    rootDescription: string;
  }): void {
    const { root, write, rootDescription } = input;
    const union = root?.writeUnion;
    if (root === undefined || union === undefined || union.variants.length === 0) return;
    const authored = [...new Set(write.fields.map((f) => f.name).filter((n) => n in root.fields))];
    if (union.variants.some((v) => authored.every((n) => v.fields.includes(n)))) return;

    // What forced each shape out, in body order: the union of every variant's
    // EXCESS. Two fields at minimum whenever the host's rule holds (every
    // writable field is in some variant), and exactly the pair an author needs
    // to see — "File and Blocks", not the whole body.
    const forcing = new Set(
      union.variants.flatMap((v) => authored.filter((n) => !v.fields.includes(n))),
    );
    const conflict = authored.filter((n) => forcing.has(n));
    const shapes = union.variants.map((v) => `${v.name} (${v.fields.join(', ')})`);
    this.report(
      DiagnosticCodes.WRITE_UNION_UNSATISFIED,
      `${rootDescription} is either ${orList(shapes)} — ${writeUnionClash(conflict)}. Set the fields of one shape only, or split this into separate writes`,
      write.target.span,
    );
  }

  /**
   * A landing type GENERIC OVER THIS CONSTRUCTION SITE (asks-as-adapter layer
   * 5, chunk B). An edge may declare that the literal value(s) a body gives one
   * field fix what it lands on (`EdgeSchema.genericOver`): an ask's `Response`
   * is generic over the `Options` it offered, so `Choose` with
   * `["Seed","Series A"]` answers an enum of exactly those two.
   *
   * The checker DECIDES nothing, mirroring `refineSelected`. The host resolved
   * every write it could see and grafted the synthesized position under
   * `genericLandingKey`; here we derive the same key from the same literals and
   * look it up. Both sides read the body through `literalStringValuesOf`, so
   * they cannot disagree about what a literal is.
   *
   * A parameter that ISN'T a literal is the "I can't see it" case, and what that
   * costs is the edge's own declaration (`genericOver.onNonLiteral`): nothing
   * for computed options, which are legitimate and promised nothing;
   * MOV_WRITE_GENERIC_NOT_LITERAL where the adapter refuses a computed value at
   * run time anyway; MOV_WRITE_GENERIC_UNTYPED — a warning — where the write
   * still runs but the author has just traded a typed landing for an opaque one.
   * A guarantee lost in silence is lost twice.
   */
  private applyGenericLandings(
    handle: PositionTypeRef | undefined,
    write: WriteExpression,
    root: WritableRootSchema | undefined,
    rootDescription: string,
  ): PositionTypeRef | undefined {
    if (handle === undefined || handle.kind !== 'handle') return handle;
    const edges = handle.edges ?? positionSchemaOfRef(handle)?.edges;
    if (edges === undefined) return handle;

    const landings: Record<string, string> = {};
    for (const [edgeName, edgeSchema] of Object.entries(edges)) {
      const generic = edgeSchema.genericOver;
      if (generic === undefined) continue;
      const slot = write.fields.find((f) => f.name === generic.field)?.value;
      // An ABSENT parameter is the required-field check's business, not ours —
      // reporting it here too would blame the landing for a missing body field.
      if (slot === undefined) continue;
      const values = literalStringValuesOf(slot.raw);
      if (values === undefined) {
        if (generic.onNonLiteral === 'error') {
          this.report(
            DiagnosticCodes.WRITE_GENERIC_NOT_LITERAL,
            `'${generic.field}' fixes the type of what '-[:${edgeName}]->' delivers on ${rootDescription}, so it must be a fixed value known here — name it with a literal${literalExampleFor(generic.field, root?.fields[generic.field])}, not an expression. The type is decided when the record is written; it can't be discovered at run time`,
            slot.span,
          );
        } else if (generic.onNonLiteral === 'warn') {
          this.reportWarning(
            DiagnosticCodes.WRITE_GENERIC_UNTYPED,
            `'${generic.field}' is built at run time, so what '-[:${edgeName}]->' delivers on ${rootDescription} cannot be typed here — it stays one opaque value you cannot read a part out of. Name '${generic.field}' with a literal${literalExampleFor(generic.field, root?.fields[generic.field])} to read the answer back by name`,
            slot.span,
          );
        }
        continue;
      }
      const key = genericLandingKey({ target: edgeSchema.target, values });
      const landed = handle.instance.schema.genericLandings?.[key];
      // A key nobody registered means the host couldn't synthesize this one (a
      // different adapter, an unresolvable instance) — the base type stands.
      if (landed !== undefined && handle.instance.schema.positions[landed] !== undefined) {
        landings[edgeName] = landed;
      }
    }
    if (Object.keys(landings).length === 0) return handle;
    return { ...handle, genericLandings: landings };
  }

  /** Checks the write and returns the resulting handle's type, when derivable (check 8). */
  /**
   * The shape-WRITE construct, retired.
   *
   * `write Lead-[:item]-> { … }` was the only way to build a record out of
   * nothing, so it was spelled as a write to a graph that stores nothing — a
   * write with no target system, which is not a write. `node { … }` says the
   * same thing without the pretence, and says more: a literal carries edges,
   * pass-through traversals and `lazy`, none of which a shape write could
   * express.
   *
   * Refused HERE, where a program is checked — at save, and in the editor as
   * it is typed. The engine's own path outlives this by one wave, so a program
   * saved before the retirement keeps running while its author is told, once,
   * what to write instead. Silence and a runtime surprise were the two things
   * the layer-7 audit ruled out.
   *
   * The DECLARATION survives: it is the nominal annotation a callee's parameter
   * may wear, checked structurally against whatever the caller synthesises.
   *
   */
  private refuseShapeWrite(write: WriteExpression, scope: Scope): boolean {
    const roots =
      write.target.kind === 'linked'
        ? [write.target.path.root]
        : write.target.kind === 'tuple'
          ? write.target.paths.map((path) => path.root)
          : [];
    const shapeRoot = roots.find((root) => {
      if (root === undefined) return false;
      const resolution = scope.resolve(root);
      return resolution.kind === 'found' && resolution.symbol.kind === 'shape';
    });
    if (shapeRoot === undefined) return false;
    // The replacement, spelled with THIS write's own entries — the correction
    // is the program the author meant, not a grammar rule to go and look up.
    const entries = write.fields.map((field) => `${field.name}: …`).join(', ');
    this.report(
      DiagnosticCodes.WRITE_SHAPE_RETIRED,
      `'${shapeRoot}' is a declared node — the structure a parameter is checked against, not a system that stores anything, so this write has nowhere to land. Synthesise the record instead: 'node { ${entries.length > 0 ? entries : '…'} }' — the same entries, and it can carry what a write to a declaration never could: a nested 'node { … }' for a related record, or a traversal off a position you hold ('files: lazy a-[f:…]->') to pass real records through untouched. Keep the declaration if the callee's parameter names it`,
      write.span,
    );
    return true;
  }

  private checkWrite(
    write: WriteExpression,
    scope: Scope,
    options?: { isBound?: boolean; binding?: string },
  ): PositionTypeRef | undefined {
    if (this.refuseShapeWrite(write, scope)) return undefined;
    const isBound = options?.isBound === true;
    let root: WritableRootSchema | undefined;
    let rootDescription = 'the write target';
    let handle: PositionTypeRef | undefined;
    /** The write form's parent paths (linked / tuple) — required-edge satisfaction. */
    const parents: Array<{ type?: string; edge: string }> = [];

    if (write.target.kind === 'linked') {
      const linked = this.checkLinkedPath(
        {
          path: write.target.path,
          explicitType: write.target.explicitType,
          span: write.target.span,
          purpose: 'write',
          isBound,
        },
        scope,
      );
      root = linked.root;
      handle = linked.handle;
      if (linked.description !== undefined) rootDescription = linked.description;
      if (linked.resolved) {
        parents.push({
          ...(linked.resolved.parentType !== undefined ? { type: linked.resolved.parentType } : {}),
          edge: linked.resolved.edgeName,
        });
      }
    } else if (write.target.kind === 'tuple') {
      const tuple = this.checkTupleWriteTarget(write.target, scope, parents, isBound);
      root = tuple.root;
      handle = tuple.handle;
      if (tuple.description !== undefined) rootDescription = tuple.description;
    } else {
      const position = this.checkPositionWriteTarget(write.target, scope);
      root = position.root;
      handle = position.handle;
      rootDescription = position.description;
    }

    // A DISCRIMINATED write shape (the write-side dual of read narrowing): the
    // body's shape varies by the LITERAL of a required discriminant field. Read
    // the literal, select the variant, and validate everything below —
    // required fields/edges, `unique by`, the body — against THAT variant, on a
    // handle that stands on the variant's own type. When no variant is
    // selectable (discriminant missing/typo'd/non-literal), `root` stays the
    // fallback shape: a missing discriminant surfaces as the required-field
    // error, a typo'd one as MOV_ENUM_UNKNOWN_VALUE (both off the fallback's own
    // `requiredFields`/enum field), and a non-literal one is the caught-not-
    // silent error inside `selectWriteVariant`.
    //
    // FIRST, before anything reads the handle: the effect row, the bind clause
    // and the generic landings all ask what type this write lands on, and the
    // variant is the answer to that question.
    const selected = this.selectWriteVariant(root, write, rootDescription);
    root = selected.root;
    rootDescription = selected.description;
    if (selected.variant !== undefined) handle = this.handleOfVariant(handle, selected.variant);

    // This write's own literals decide what its generic edges LAND on (an ask's
    // `Options` fixing its `Response`'s enum). Done here, where the body and the
    // handle are both in hand, and carried on the handle so `await a-[:Response]->`
    // steps onto the specialized position.
    handle = this.applyGenericLandings(handle, write, root, rootDescription);

    // The write's own effect: whichever graph the handle lands in. An ask is a
    // write like any other — its adapter is the one it is addressed to.
    this.noteTypedEffect('write', handle);

    if (write.bind !== undefined) this.checkBindClause(write, scope, handle);

    // The OTHER write-side union — untagged, so assignability decides rather
    // than a literal. Independent of everything below: it constrains WHICH
    // fields may appear together, and leaves their types, requiredness and
    // edges to the checks that follow.
    this.checkWriteUnion({ write, root, rootDescription });

    if (!this.typeOnly) {
      const target = recordedTargetOf(handle);
      this.options.recording?.writes.push({
        span: write.span,
        ...(root ? { root } : {}),
        description: rootDescription,
        declaredFields: new Set(write.fields.map(f => f.name)),
        hasUniqueBy: write.uniqueBy.length > 0,
        scope,
        ...(options?.binding !== undefined ? { binding: options.binding } : {}),
        ...(target ? { target } : {}),
        action: write.target.kind === 'position' ? 'update' : 'create',
        parents: [...parents],
      });
    }

    // A position write updates an already-identified record: the
    // required-field / required-edge create-gates don't apply, and there is
    // nothing to resolve, so `unique by` is rejected outright.
    if (write.target.kind === 'position') {
      if (write.uniqueBy.length > 0) {
        this.report(
          DiagnosticCodes.WRITE_POSITION_UNIQUE,
          `'unique by' has no meaning on a position write — 'write ${write.target.alias} { … }' already holds the exact record. Drop the 'unique by' clause`,
          write.uniqueBy[0].span,
        );
      }
    } else if (write.bind !== undefined) {
      // A bound write's identity IS the binding — `unique by` doesn't
      // compose with it (3b: bind wins outright). The required-field /
      // required-edge create-gates still apply: a create can still happen
      // (self-heal mints a fresh record), so the body must satisfy them.
      this.checkRequiredEdges({ write, root, rootDescription, parents, handle });
      this.checkRequiredFields({ write, root, rootDescription, parents });
    } else {
      this.checkRequiredEdges({ write, root, rootDescription, parents, handle });
      this.checkRequiredFields({ write, root, rootDescription, parents });

      // Some targets decide identity themselves and don't accept author-defined
      // uniqueness (the adapter declared `uniquenessAuthorable: false` — e.g.
      // Affinity, whose org/person matching is native). Reject the clause
      // outright rather than silently ignore it; native matching still happens.
      if (root?.uniquenessAuthorable === false && write.uniqueBy.length > 0) {
        this.report(
          DiagnosticCodes.UNIQUE_NOT_AUTHORABLE,
          `${rootDescription} decides record identity itself — 'unique by' isn't configurable here. Drop the clause; matching on the system's own keys happens automatically`,
          write.uniqueBy[0].span,
        );
      } else {
      // The clause is a predicate that finds the existing record. Each name it
      // references must be a field of the written record (`\`email\``,
      // `\`stage\` == "Open"`) or a bound handle in scope (edge-scoped
      // identity). A literal RHS / operators need no resolution.
      for (const clause of write.uniqueBy) {
        // A FUZZY modifier rides on a textual component, so split first and
        // strip it before parsing each part as an ordinary expression.
        for (const part of splitUniquenessConjuncts(clause.predicate.raw)) {
          let parsed: Expression;
          try {
            parsed = parseMovementExpression(part.raw);
          } catch (e) {
            if (!(e instanceof BridgeError)) throw e;
            this.report(
              DiagnosticCodes.EXPR_PARSE,
              e.message,
              spanWithin(clause.predicate, part.offset + (e.pos ?? 0)),
            );
            continue;
          }
          if (root === undefined) continue; // schema unknown ⇒ stay silent
          // FUZZY is adapter-specific: only targets that resolve by similarity
          // (the KG's pg_trgm, Attio's $contains) may carry it.
          if (part.fuzzy && root.fuzzyResolution !== true) {
            this.report(
              DiagnosticCodes.UNIQUE_FUZZY_UNSUPPORTED,
              `FUZZY isn't available on ${rootDescription} — it matches identity exactly, not by similarity. Drop FUZZY and identify by an exact field, or pick a target that supports fuzzy matching`,
              spanWithin(clause.predicate, part.offset),
            );
          }
          const names = collectExpressionNames(parsed);
          for (const ref of new Set(names.refs)) {
            if (names.aliases.has(ref)) continue; // bound by a step within the predicate
            if (ref in root.fields) continue;
            if (scope.resolve(ref).kind === 'found') continue; // a bound handle
            this.report(
              DiagnosticCodes.UNIQUE_UNKNOWN_FIELD,
              `'${ref}' is not a field of ${rootDescription} or a bound handle — a 'unique by' predicate identifies by fields of the written record or by a bound parent`,
              clause.span,
            );
          }
        }
      }
      this.checkNativeUniqueness(write, root, rootDescription);
      }
    }
    const writtenSchema = handle !== undefined ? positionSchemaOfRef(handle) : undefined;
    // Empty-write watch (chunk D): count fields that can DISCHARGE TO OMISSION —
    // a `?:` fill whose value may be absent writes nothing when the value isn't
    // there. If EVERY field is such, the write can reach the adapter empty.
    let omittableFields = 0;
    for (const field of write.fields) {
      const targetType = root?.fields[field.name];
      if (root && targetType === undefined) {
        const available = Object.keys(root.fields);
        this.report(
          DiagnosticCodes.WRITE_UNKNOWN_FIELD,
          `${rootDescription} has no field '${field.name}'${available.length ? ` — it has: ${available.join(', ')}` : ''}`,
          field.span,
        );
      }
      // `+:` / `+?:` (append) only make sense for a multi-valued (list) field —
      // there is no list to append to on a scalar. `replace` and `?:` apply to
      // both, so they're unrestricted.
      if (
        (field.semantics === 'append' || field.semantics === 'append-missing') &&
        targetType !== undefined &&
        !(typeof targetType === 'object' && targetType.kind === 'list')
      ) {
        const op = field.semantics === 'append' ? '+:' : '+?:';
        this.report(
          DiagnosticCodes.WRITE_APPEND_NOT_MULTI,
          `'${field.name}' on ${rootDescription} is ${describeFieldType(targetType)}, not a list — '${op}' (append) applies only to multi-valued fields. Use ':' to set it, or '?:' to set it only when empty`,
          field.span,
        );
      }
      // A handle assigned directly to a reference-named field — legal where
      // the target exposes the reference as a writable field, but the
      // idiomatic spelling is structural: nudge toward the link forms.
      const handleValue = this.bareHandleName(field.value, scope);
      if (writtenSchema?.edges[field.name] !== undefined && handleValue !== undefined) {
        this.reportInfo(
          DiagnosticCodes.WRITE_LINK_FIELD_NUDGE,
          `'${field.name}' is a relationship of ${rootDescription} — rather than assigning the handle '${handleValue}' to a field, establish the connection structurally: put the parent in the write target (a linked or tuple-path write) or assert it afterwards with a link statement`,
          field.span,
        );
      }
      // The borrowable spelling of this target field — `crm.companies.stage`
      // — when the target graph is known (`rootDescription` is `graph.type`).
      const writeTarget: WriteTargetRef | undefined =
        targetType !== undefined
          ? {
              type: targetType,
              ...(rootDescription.includes('.')
                ? { path: `${rootDescription}.${field.name}` }
                : {}),
            }
          : undefined;
      const { valueType } = this.checkExprSlot(field.value, scope, {
        ...(writeTarget !== undefined ? { writeTarget } : {}),
      });
      // A possibly-absent value (a partial-receipt read, a maybe-empty node's
      // field) can't fill a PLAIN write field — the `?:` (fill) marker is its
      // one legal home (S21): fill tolerates a missing source (it only writes
      // when the value is there). A traversal-as-gate discharges it upstream
      // instead. This is the checker firing at the REQUIRED-VALUE site, per F13.
      if (isMaybeAbsent(valueType) && field.semantics !== 'fill') {
        this.report(
          DiagnosticCodes.ABSENT_REQUIRED,
          `'${field.name}' on ${rootDescription} needs a value, but this expression may be absent (${describeFieldType(valueType!)}) — it comes from a branch that might not have run, or an answer that might not be there. Discharge it: test it with '==' and write inside that branch, gate on it first ('r-[x:…]-> { write … }'), default it with '?:', or fall back to something that always answers ('COALESCE(…, "unknown")')`,
          field.value.span,
        );
      }
      if (field.semantics === 'fill' && isMaybeAbsent(valueType)) omittableFields += 1;
      if (targetType !== undefined && valueType !== undefined && !fieldTypeCompatible(valueType, targetType)) {
        this.report(
          DiagnosticCodes.WRITE_FIELD_TYPE,
          `'${field.name}' on ${rootDescription} is ${describeFieldType(targetType)}, but this expression produces ${describeFieldType(valueType)}`,
          field.value.span,
        );
      }
      this.checkEnumLiteralWrite(field.value, {
        targetType,
        subject: `'${field.name}' on ${rootDescription}`,
      });
    }
    if (write.fields.length > 0 && omittableFields === write.fields.length) {
      this.reportWarning(
        DiagnosticCodes.WRITE_MAY_BE_EMPTY,
        `every field of this write to ${rootDescription} is a '?:' fill of a possibly-absent value, so at runtime they can all be omitted and the write reaches the system empty. Gate the write on presence instead (e.g. 'r-[x:…]-> { write … }'), so it only runs when there's something to write.`,
        write.target.span,
      );
    }
    return handle;
  }

  /**
   * A string LITERAL written into an enum field must be one of its options —
   * the write-side use of the shared membership helper (a typo'd value parses
   * fine and is text-compatible with the enum, so only the option set catches
   * it). Silent for a non-enum target, and for a non-literal value UNLESS the
   * enum's domain is empty: "the value isn't known at author time" is only a
   * reason for silence while some value could still have been right.
   */
  private checkEnumLiteralWrite(
    value: ExprSlot,
    options: { targetType: FieldType | undefined; subject?: string },
  ): void {
    const { targetType, subject } = options;
    if (targetType === undefined || typeof targetType !== 'object' || targetType.kind !== 'enum') {
      return;
    }
    const literal = staticStringLiteralOf(value);
    const diagnostic =
      checkEnumDomain(targetType, subject)
      ?? (literal !== undefined ? checkEnumLiteral(literal, targetType) : null);
    if (diagnostic) {
      if (diagnostic.severity === 'warning') {
        this.reportWarning(diagnostic.code, diagnostic.message, value.span);
      } else {
        this.report(diagnostic.code, diagnostic.message, value.span);
      }
    }
  }

  /**
   * Authored `unique by` vs the target's declared native identity
   * (`WritableRootSchema.nativeUniqueness` — what the adapter enforces
   * regardless of authoring):
   *
   *   - REDUNDANT (info): an authored field-only clause whose field set
   *     exactly equals a native AND-group — the target already matches by
   *     it, so the clause can be dropped.
   *
   * The CONFLICT case (an authored identity disjoint from the native rules)
   * is EXPECTED, not a problem — the native layer matching on its own fields
   * is the target doing its job, not a mistake to warn about. The editor
   * surfaces the native rules as an overlay HINT on the write target instead
   * (see the service's `getHoverInfo` → `nativeUniquenessHint`), so the author
   * sees "matched natively by …" without a diagnostic.
   *
   * Clauses with handle (`ref`) components express edge-scoped identity
   * the native layer can't see; they never count as a duplicate.
   */
  private checkNativeUniqueness(
    write: WriteExpression,
    root: WritableRootSchema | undefined,
    rootDescription: string,
  ): void {
    const native = root?.nativeUniqueness;
    if (!native || native.length === 0 || write.uniqueBy.length === 0) return;
    const describeRule = (group: string[]): string => group.map(f => `\`${f}\``).join(' + ');

    for (const clause of write.uniqueBy) {
      const refs = uniqueClauseRefs(clause);
      if (refs === undefined) continue; // unparseable — the expr check reports it
      const fieldComponents = refs.filter(r => root !== undefined && r in root.fields);
      if (fieldComponents.length !== refs.length) continue; // handle/edge-scoped — not comparable
      const authored = new Set(fieldComponents);
      const duplicated = native.find(
        group => group.length === authored.size && group.every(f => authored.has(f)),
      );
      if (duplicated) {
        this.reportInfo(
          DiagnosticCodes.UNIQUE_NATIVE_REDUNDANT,
          `${rootDescription} already matches records by ${describeRule(duplicated)} natively — this 'unique by' duplicates the built-in rule and can be dropped`,
          clause.span,
        );
      }
    }
  }

  /**
   * A linked path's destination (check 5) — shared by linked writes, every
   * tuple-write path, and the criteria-form `link`: the path must start
   * from a typed handle/position, every hop must be a declared edge, and
   * the target type is inferred from the final edge (explicit only for
   * polymorphic edges). The effect lands in the path root's graph.
   */
  private checkLinkedPath(
    input: {
      path: PathHead;
      explicitType: string | undefined;
      span: Span;
      /** Diagnostics phrasing — what the path establishes. */
      purpose: 'write' | 'link';
      /** Whether this path's result is bound to a name (`x = write …`) —
       *  the only form an ephemeral final edge rejects. Bare statements and
       *  criteria `link`s never trip the gate. */
      isBound?: boolean;
    },
    scope: Scope,
  ): {
    root?: WritableRootSchema;
    handle?: PositionTypeRef;
    description?: string;
    /** The fully-typed resolution — tuple agreement and required-edge satisfaction. */
    resolved?: {
      instanceToken: object;
      instanceName: string;
      written: string;
      parentType?: string;
      edgeName: string;
    };
  } {
    const head = this.checkPathHead(input.path, scope);
    if (!head.steps || head.steps.length === 0 || head.rootType === undefined) return {};
    // A write/link needs a record that IS there. Traversing INTO a maybe-empty
    // node is gate-discharged (the block runs zero times), but a write is not a
    // block: nothing about the statement says it might not happen, and the
    // engine has no record to parent it to. This is the require-present site for
    // the node plane, mirroring a plain write FIELD on the scalar plane.
    if (head.rootType.kind === 'maybeEmpty' && input.path.root !== undefined) {
      this.report(
        DiagnosticCodes.ABSENT_REQUIRED,
        `'${input.path.root}' is ${describePosition(head.rootType.of)} that may not be there, so a ${input.purpose} off it can't be guaranteed to happen — and nothing in this statement says it might be skipped. Test it first ('if ${input.path.root} == null { ERROR("…") }', or 'if EXISTS(${input.path.root})'), or gate on it with a traversal block ('${input.path.root}-[x:…]-> { … }'), which runs zero times when it's empty.`,
        input.span,
      );
      return {};
    }

    const typing = this.slotTyping(scope, input.span);
    const parent = typing.walkSteps(head.rootType, head.steps.slice(0, -1));
    if (parent === undefined) return {};
    const linkStep = head.steps[head.steps.length - 1];
    if (linkStep.type !== 'edge') return {}; // a meta-edge is not a linkable reference
    const edgeName = linkStep.edgeTypeId;

    // A write handle to a WRITABLE-ONLY type mints no position (an ask family:
    // you can raise one, you can never enumerate them), so its relationship
    // table lives on the handle. `TypeWalker.stepEdge` makes exactly this
    // fallback for the read side; without its twin here, `write a-[:Response]->`
    // off a fresh ask resolves to nothing and checks NOTHING — silence where a
    // type error belongs.
    const parentSchema =
      positionSchemaOfRef(parent) ??
      (parent.kind === 'handle' && parent.edges !== undefined
        ? { properties: {}, edges: parent.edges }
        : undefined);
    if (parent.kind === 'meta') {
      // A meta parent — the instance's OWN position. It resolves via its
      // synthesized collection edges (positionSchemaOfRef), so a top-level write
      // `<instance>-[:Collection]-> { … }` validates like any linked write. The
      // one exception is the instance-param door: a meta-typed name that stands
      // for a whole system (an instance-typed PARAMETER, not a constructed
      // instance) — schemas are per-credential, so instances don't travel
      // between movements; error rather than resolve.
      const root = input.path.root;
      if (root !== undefined) {
        const resolution = scope.resolve(root);
        if (resolution.kind === 'found' && !isGraphSymbol(resolution.symbol)) {
          this.report(
            DiagnosticCodes.WRITE_TARGET_NOT_GRAPH,
            `'${root}' is ${describeKind[resolution.symbol.kind]} standing for a whole system, not a record — a ${input.purpose === 'write' ? 'linked write' : 'link'} starts from a record handle or the instance's own edge: construct the instance in this file — instances don't pass between movements`,
            input.span,
          );
          return {};
        }
      }
    } else if (!parentSchema || (parent.kind !== 'position' && parent.kind !== 'handle')) {
      return {};
    }
    if (!parentSchema) return {};
    const instance = parent.instance;

    const edge = parentSchema.edges[edgeName];
    if (!edge) {
      // The parent's edge surface isn't enumerated — open (wider than
      // declared) or undescribed (nothing looked). Neither licenses 'it has no
      // edge X', so unknown stays silent; the undescribed handle is reported
      // where it is READ, not here.
      if (surfaceNotEnumerated(parentSchema)) return {};
      const available = Object.keys(parentSchema.edges);
      this.report(
        DiagnosticCodes.LINKED_UNKNOWN_EDGE,
        `${describePosition(parent)} has no edge '${edgeName}' — ${
          input.purpose === 'write'
            ? "a linked write creates the record AND the edge, so the parent's type must declare it"
            : "a link asserts an edge the source's type declares"
        }${available.length ? `; it declares: ${available.join(', ')}` : ''}`,
        input.span,
      );
      return {};
    }

    // THE write gate (layer 13): one explicit promise. Absent ⇒ read-only —
    // an edge that never declared a write promise makes none, so a write OR a
    // link is rejected here rather than on the target's writability.
    //
    // But "no write promise" arrives here as one value standing for three
    // different facts, and only the first is the source's fault:
    //
    //   - the edge is genuinely a read-only collection (the instance fills it);
    //   - the target was DESCRIBED and has no writable fields — the system
    //     accepts writes to it in principle, but there is nothing to set;
    //   - the target was never described at all, so nobody has looked.
    //
    // Reporting all three as "the instance fills it itself" sent an author
    // hunting for a missing capability when the real answer was, for a bare
    // Google Sheets tab, that row 1 was blank. The target's own position says
    // which case this is; the message now asks.
    if (edge.writable !== true) {
      const available = writableEdgesOf(instance.schema).map((e) => `${e.parent}-[:${e.edge}]->`);
      const target = edge.target;
      const targetSchema = target !== undefined ? instance.schema.positions[target] : undefined;
      const targetName = target ?? edgeName;
      const cause =
        target !== undefined && (targetSchema === undefined || targetSchema.undescribed === true)
          ? `nothing has described '${targetName}' yet, so its writable fields aren't known here`
          : targetSchema !== undefined && Object.keys(targetSchema.properties).length === 0
            ? `'${targetName}' has no fields to write`
            : `'${instance.name}' fills it itself`;
      this.report(
        DiagnosticCodes.WRITE_READ_ONLY_EDGE,
        `'-[:${edgeName}]->' is read-only on ${describePosition(parent)} — ${cause}, so a ${input.purpose} can't create or attach along it${available.length ? `; '${instance.name}' writes along: ${available.join(', ')}` : ''}`,
        input.span,
      );
      return {};
    }

    if (input.purpose === 'link' && edge.linkable === false) {
      this.reportUnlinkableEdge({
        edgeName,
        parent,
        instanceName: instance.name,
        root: input.path.root,
        span: input.span,
      });
      return {};
    }

    if (edge.ephemeral === true && input.purpose === 'write' && input.isBound === true) {
      this.report(
        DiagnosticCodes.WRITE_EPHEMERAL_BOUND,
        `nothing to bind — 'write …-[:${edgeName}]->' is an action, not a record; ` +
          'drop the binding and write it as a bare statement',
        input.span,
      );
    }

    let written: string;
    if (edge.polymorphic) {
      if (input.explicitType === undefined) {
        this.report(
          DiagnosticCodes.LINKED_NEEDS_TYPE,
          `'${edgeName}' is polymorphic — say which type this ${input.purpose === 'write' ? 'write creates' : 'link finds'}: ${input.purpose === 'write' ? `write …-[:${edgeName}]-><type> { … }` : `link …-[:${edgeName}]-><type> { … }`}`,
          input.span,
        );
        return {};
      }
      const variants = instance.schema.unions?.[edge.target];
      if (variants ? !variants.includes(input.explicitType) : !instance.schema.positions[input.explicitType]) {
        this.report(
          DiagnosticCodes.LINKED_TYPE_MISMATCH,
          variants
            ? // The target may be a DERIVED union key (the adapter projection's
              // shape) — opaque, and never something to read back to an author.
              `'${edgeName}' targets ${instance.schema.unionDisplayNames?.[edge.target] ?? edge.target} (${variants.join(' | ')}) — '${input.explicitType}' is not one of its types`
            : `'${instance.name}' has no position type '${input.explicitType}'`,
          input.span,
        );
        return {};
      }
      written = input.explicitType;
    } else {
      if (input.explicitType !== undefined && input.explicitType !== edge.target) {
        this.report(
          DiagnosticCodes.LINKED_TYPE_MISMATCH,
          `'${edgeName}' targets ${instance.name}.${edge.target} — the explicit type '${input.explicitType}' contradicts it`,
          input.span,
        );
        return {};
      }
      // A landing the PARENT's own construction fixed (an ask's `Options`
      // narrowing its `Response` to those exact options) is the same landing
      // whichever direction you travel it — `TypeWalker.stepEdge` reads it for
      // the read side, and this reads it for the write side, off the same
      // handle. So writing `Answer: "Sead"` to a Choose offering "Seed" is the
      // enum did-you-mean AT THE WRITE, not a surprise at the read.
      written =
        (parent.kind === 'handle' ? parent.genericLandings?.[edgeName] : undefined) ?? edge.target;
    }

    const root =
      instance.schema.writableRoots[written] ?? instance.schema.createShapes?.[written];
    // No second gate. Layer 13 collapsed the two promises into one: reaching
    // here means the edge declared `writable: true`, which IS the permission to
    // write along it — there is no separate create fact to re-check, and no
    // fallback onto the target's own writability (an edge that makes no promise
    // was already rejected above, rather than inheriting one from its target).
    // The link-vs-create distinction is PARKED: an edge that can only link
    // over-promises create and fails loudly at run time.
    const handle: PositionTypeRef = {
      kind: 'handle',
      instance,
      ...(instance.schema.positions[written] ? { position: written } : {}),
      resultShape: root?.resultShape ?? instance.schema.positions[written]?.properties ?? {},
      // The write shape's relationship table, so a handle to a writable-only
      // type (no minted position) can still traverse its edges — `await
      // a-[:Response]->` off an ask's `Check`. When a position IS minted the
      // hop resolves through it first; these are the same edges either way.
      ...(root?.edges !== undefined ? { edges: root.edges } : {}),
    };
    // The meta position isn't a record type, so a meta-rooted write has no
    // parent record type for required-edge satisfaction.
    const parentType = parent.kind === 'meta' ? undefined : parent.position;
    return {
      root,
      handle,
      description: `${instance.name}.${written}`,
      resolved: {
        instanceToken: instance.token,
        instanceName: instance.name,
        written,
        ...(parentType !== undefined ? { parentType } : {}),
        edgeName,
      },
    };
  }

  /**
   * A tuple-path write target: every path resolves like a linked write's,
   * the inferred written types must AGREE across paths (one record at the
   * convergence of N edges), and each path contributes a parent for
   * identity (`unique by` handle components) and required-edge
   * satisfaction. `parents` is appended in path order.
   */
  private checkTupleWriteTarget(
    target: Extract<WriteExpression['target'], { kind: 'tuple' }>,
    scope: Scope,
    parents: Array<{ type?: string; edge: string }>,
    isBound?: boolean,
  ): { root?: WritableRootSchema; handle?: PositionTypeRef; description?: string } {
    let agreed:
      | { root?: WritableRootSchema; handle?: PositionTypeRef; description?: string; instanceToken: object; written: string; pathIndex: number }
      | undefined;
    let mismatched = false;
    for (let i = 0; i < target.paths.length; i++) {
      const path = target.paths[i];
      const linked = this.checkLinkedPath(
        { path, explicitType: target.explicitType, span: path.span, purpose: 'write', isBound },
        scope,
      );
      const resolved = linked.resolved;
      if (!resolved) continue; // untyped path — stays silent (its own diagnostics already fired)
      parents.push({
        ...(resolved.parentType !== undefined ? { type: resolved.parentType } : {}),
        edge: resolved.edgeName,
      });
      if (agreed === undefined) {
        agreed = {
          ...(linked.root !== undefined ? { root: linked.root } : {}),
          ...(linked.handle !== undefined ? { handle: linked.handle } : {}),
          ...(linked.description !== undefined ? { description: linked.description } : {}),
          instanceToken: resolved.instanceToken,
          written: resolved.written,
          pathIndex: i,
        };
      } else if (
        agreed.instanceToken !== resolved.instanceToken ||
        agreed.written !== resolved.written
      ) {
        if (!mismatched) {
          mismatched = true;
          const first = target.paths[agreed.pathIndex];
          this.report(
            DiagnosticCodes.WRITE_TUPLE_MISMATCH,
            `the tuple's paths must converge on ONE written type — '${rawPath(first)}' infers ${agreed.description ?? agreed.written}, but '${rawPath(path)}' infers ${linked.description ?? resolved.written}`,
            target.span,
          );
        }
      }
    }
    if (mismatched || agreed === undefined) return {};
    return {
      ...(agreed.root !== undefined ? { root: agreed.root } : {}),
      ...(agreed.handle !== undefined ? { handle: agreed.handle } : {}),
      ...(agreed.description !== undefined ? { description: agreed.description } : {}),
    };
  }

  /**
   * The written type's declared required edges vs what this write form
   * establishes (the tuple paths / the linked-write parent / a body field
   * carrying the reference). A write that satisfies none of an entry's
   * spellings errors, listing the missing edges with the tuple spelling.
   */
  private checkRequiredEdges(input: {
    write: WriteExpression;
    root: WritableRootSchema | undefined;
    rootDescription: string;
    parents: Array<{ type?: string; edge: string }>;
    /** The graph the write lands in — the required edges' `from` types are ITS
     *  type names, and one of them may be a union. */
    handle: PositionTypeRef | undefined;
  }): void {
    const required = input.root?.requiredEdges;
    if (!required || required.length === 0) return;
    const schema = input.handle !== undefined && 'instance' in input.handle
      ? input.handle.instance.schema
      : undefined;
    // A required edge whose landing is a UNION is satisfied by a parent of ANY
    // member — that is what the union means, and `from` holds the union's
    // derived key, which no parent type can equal.
    const isFrom = (parentType: string, from: string): boolean =>
      parentType === from || schema?.unions?.[from]?.includes(parentType) === true;
    /** `from` as an author reads it — never the derived key. */
    const fromDisplay = (from: string): string => schema?.unionDisplayNames?.[from] ?? from;
    const fieldNames = new Set(input.write.fields.map((f) => f.name));
    // A parent satisfies an entry by TYPE (the primary rule — two scoping
    // parents may share an outbound edge name, so the name alone can't
    // distinguish them); an UNTYPED parent gets the benefit of an
    // edge-name match. A body field named like the edge is the field
    // spelling of the same connection.
    const missing = required.filter(
      (entry) =>
        !input.parents.some(
          (p) =>
            (p.type !== undefined && isFrom(p.type, entry.from))
            || (p.type === undefined && p.edge === entry.edge),
        ) && !fieldNames.has(entry.edge),
    );
    if (missing.length === 0) return;
    const describeMissing = missing
      .map((m) => `'${m.edge}' (a ${fromDisplay(m.from)} parent)`)
      .join(', ');
    const spelling = missing.map((m) => `<${fromDisplay(m.from)} handle>-[:${m.edge}]->`).join(', ');
    this.report(
      DiagnosticCodes.WRITE_MISSING_REQUIRED_EDGE,
      `${input.rootDescription} requires ${missing.length === 1 ? 'an edge' : 'edges'} this write doesn't establish: ${describeMissing} — write the record at the convergence of its required edges, e.g. write (${spelling}) { … }`,
      input.write.target.span,
    );
  }

  /**
   * Required FIELDS (scalars — required edges are the sibling check):
   * a write that can create must give every target-required field a
   * value, or the target rejects the create at runtime. A required
   * reference satisfied structurally (parent link, tuple path) is the
   * edge check's business and excluded here by name.
   *
   * Missing entirely → error (the run WILL fail on the create branch). A field
   * PRESENT but possibly-absent (an unguarded `DATE.PARSE`, a partial-receipt
   * read) is no longer a bespoke source-regex heuristic here — typed absence
   * (`T | absent`) propagates and fires MOV_ABSENT_REQUIRED at the write-field
   * value site (checkWriteFields), discharged by `?:`, a gate, or an `==` guard
   * (F13/P20; layer 6).
   */
  private checkRequiredFields(input: {
    write: WriteExpression;
    root: WritableRootSchema | undefined;
    rootDescription: string;
    parents: Array<{ type?: string; edge: string }>;
  }): void {
    const required = input.root?.requiredFields;
    if (!required || required.length === 0) return;
    const bodyFields = new Map(input.write.fields.map((f) => [f.name, f]));
    const parentEdges = new Set(input.parents.map((p) => p.edge));
    const missing = required.filter(
      (name) => !bodyFields.has(name) && !parentEdges.has(name),
    );
    if (missing.length > 0) {
      this.report(
        DiagnosticCodes.WRITE_MISSING_REQUIRED_FIELD,
        `${input.rootDescription} requires ${missing.length === 1 ? 'a field' : 'fields'} this write never sets: ${missing
          .map((m) => `'${m}'`)
          .join(', ')} — the target rejects creates without ${missing.length === 1 ? 'it' : 'them'}; add ${missing.length === 1 ? 'it' : 'them'} to the write body`,
        input.write.target.span,
      );
    }
  }

  /** A slot that is exactly one bare name bound to a write handle — the
   *  handle-into-reference-field nudge's trigger. */
  private bareHandleName(slot: ExprSlot, scope: Scope): string | undefined {
    const trimmed = slot.raw.trim();
    if (!BARE_IDENT.test(trimmed)) return undefined;
    const resolution = scope.resolve(trimmed);
    if (resolution.kind !== 'found') return undefined;
    return resolution.symbol.posType?.kind === 'handle' ? trimmed : undefined;
  }

  // ── Link statements (the edge-only write) ──

  /**
   * `link`/`unlink` along an edge that only CREATES its target. The edge's
   * write promise covers making the relationship as part of writing the
   * record; it does not cover joining two that already exist, and the system
   * is the only thing that knows which — so it says so here rather than
   * letting the run discover it.
   */
  private reportUnlinkableEdge(input: {
    edgeName: string;
    parent: PositionTypeRef;
    instanceName: string;
    root: string | undefined;
    span: Span;
    verb?: 'link' | 'unlink';
  }): void {
    const from = input.root ?? 'the record';
    this.report(
      DiagnosticCodes.LINK_UNSUPPORTED_EDGE,
      `'${input.instanceName}' makes '-[:${input.edgeName}]->' on ${describePosition(input.parent)} by WRITING along it — 'write ${from}-[:${input.edgeName}]-> { … }' creates the record and the relationship together — so there is nothing to ${input.verb ?? 'link'} two records that already exist with`,
      input.span,
    );
  }

  /**
   * The same gate for the BARE-HANDLE forms (`link a -[:e]-> b`, `unlink a
   * -[:e]-> b`), which resolve no path: look the edge up on the from side's
   * own position and refuse it where the system says it cannot be linked.
   * Everything else about those forms stays the runtime's, as before.
   */
  private checkBareLinkEdge(
    input: { from: string; edge: string; span: Span; verb: 'link' | 'unlink' },
    scope: Scope,
  ): void {
    const symbol = scope.resolve(input.from);
    if (symbol.kind !== 'found') return;
    const fromType = this.symbolPositionType(symbol.symbol);
    // Only a type that BELONGS to an instance can carry a system's promise —
    // a run-local node or an extract node has no adapter to have made one.
    if (fromType === undefined || !('instance' in fromType)) return;
    const edge = positionSchemaOfRef(fromType)?.edges[input.edge];
    if (edge?.linkable !== false) return;
    this.reportUnlinkableEdge({
      edgeName: input.edge,
      parent: fromType,
      instanceName: fromType.instance.name,
      root: input.from,
      span: input.span,
      verb: input.verb,
    });
  }

  /**
   * `link a -[:e]-> b` / `p = link c-[:portfolio]-> { …criteria… }`.
   * The bare-handle form gets mirror name checks only (the runtime owns
   * graph/edge validation, as it does for `unlink`). The criteria form
   * infers the FOUND type from the edge exactly like a linked write, then
   * validates the criteria fields against it — the criteria ARE the
   * identity (resolved via adapter candidate search + arbitration), the
   * target is never created and never written. Returns the found target's
   * handle type for an optional binding.
   */
  private checkLink(
    link: LinkExpression,
    scope: Scope,
    binding?: string,
  ): PositionTypeRef | undefined {
    const fromSymbol = this.resolveName(link.from, link.span, scope);
    const fromType = fromSymbol !== undefined ? this.symbolPositionType(fromSymbol) : undefined;
    if (fromType?.kind === 'local') {
      this.checkLocalLink(link, fromType, scope);
      return undefined;
    }
    // A link writes an EDGE, so it writes the graph the edge's source is in —
    // the same graph either form of target lives in.
    this.noteNamedEffect('write', link.from, scope);
    if (link.target.kind === 'handle') {
      this.resolveName(link.target.name, link.span, scope);
      this.checkBareLinkEdge(
        { from: link.from, edge: link.edge, span: link.span, verb: 'link' },
        scope,
      );
      this.recordNode({
        kind: 'link',
        span: link.span,
        scope,
        from: link.from,
        edge: link.edge,
        target: { kind: 'handle', name: link.target.name },
      });
      return undefined;
    }
    const path: PathHead = { root: link.from, hopsRaw: `-[:${link.edge}]->`, span: link.span };
    const linked = this.checkLinkedPath(
      { path, explicitType: link.target.explicitType, span: link.span, purpose: 'link' },
      scope,
    );
    const root = linked.root;
    const description = linked.description ?? 'the link target';
    this.recordNode({
      kind: 'link',
      span: link.span,
      scope,
      from: link.from,
      edge: link.edge,
      target: { kind: 'criteria', ...(recordedTargetOf(linked.handle) ?? {}) },
      ...(binding !== undefined ? { binding } : {}),
    });
    for (const field of link.target.fields) {
      const targetType = root?.fields[field.name];
      if (root && targetType === undefined) {
        const available = Object.keys(root.fields);
        this.report(
          DiagnosticCodes.WRITE_UNKNOWN_FIELD,
          `${description} has no field '${field.name}' — link criteria are identity fields of the record being found${available.length ? `; it has: ${available.join(', ')}` : ''}`,
          field.span,
        );
      }
      const { valueType } = this.checkExprSlot(field.value, scope);
      if (targetType !== undefined && valueType !== undefined && !fieldTypeCompatible(valueType, targetType)) {
        this.report(
          DiagnosticCodes.WRITE_FIELD_TYPE,
          `'${field.name}' on ${description} is ${describeFieldType(targetType)}, but this expression produces ${describeFieldType(valueType)}`,
          field.value.span,
        );
      }
      this.checkEnumLiteralWrite(field.value, {
        targetType,
        subject: `'${field.name}' on ${description}`,
      });
    }
    return linked.handle;
  }

  /**
   * `link sent -[:messages]-> one` where `sent` is a node this run built — the
   * landing is APPENDED to an edge the literal declared.
   *
   * The literal is the whole of what the node has, so an edge it never declared
   * is a typo, and a `lazy` entry has no array to append to. The landing itself
   * is checked STRUCTURALLY against what the edge says it lands on, exactly as
   * an argument is checked against a parameter: a local node belongs to no
   * graph, so there is no instance to compare and nothing nominal to compare it
   * by.
   *
   * NO EFFECT ROW ENTRY. The row carries the graphs a run touches, and this one
   * touches none: run-local mutation is not an effect on the world.
   *
   */
  private checkLocalLink(
    link: LinkExpression,
    from: Extract<PositionTypeRef, { kind: 'local' }>,
    scope: Scope,
  ): void {
    if (link.target.kind !== 'handle') {
      this.report(
        DiagnosticCodes.NODE_LINK_CRITERIA,
        `'${link.from}' is ${from.label} this run built, and a criteria body finds a record in a SYSTEM — link a position you already have instead: 'link ${link.from} -[:${link.edge}]-> <name>'`,
        link.target.span,
      );
      return;
    }
    const toSymbol = this.resolveName(link.target.name, link.span, scope);
    const edge = from.edges?.[link.edge];
    if (edge === undefined) {
      const declared = Object.keys(from.edges ?? {});
      this.report(
        DiagnosticCodes.NODE_EDGE_UNDECLARED,
        `'${link.from}' declares no edge '${link.edge}'${declared.length > 0 ? ` — it has: ${declared.join(', ')}` : ` — declare it on the literal ('${link.edge}: <source-[:Edge]->>')`}`,
        link.span,
      );
      return;
    }
    if (edge.deferred === true) {
      this.report(
        DiagnosticCodes.NODE_EDGE_DEFERRED,
        `'${link.edge}' is a lazy entry — its landings come from a walk that runs again at every read, so an appended one would be gone by the next. Declare a separate edge for what this run writes ('${link.edge}Written: <source-[:Edge]->>')`,
        link.span,
      );
      return;
    }
    this.recordNode({
      kind: 'link',
      span: link.span,
      scope,
      from: link.from,
      edge: link.edge,
      target: { kind: 'handle', name: link.target.name },
    });
    const toType = toSymbol !== undefined ? this.symbolPositionType(toSymbol) : undefined;
    const target = edge.target;
    if (toType === undefined || target === undefined) return;
    const misfit =
      toType.kind === 'local' ? synthesisedNodeMisfit(toType, target) : undefined;
    if (misfit !== undefined) {
      this.report(
        DiagnosticCodes.NODE_LINK_SHAPE,
        `'${link.edge}' lands on ${describePosition(target)}, and ${misfit}`,
        link.span,
      );
      return;
    }
    if (toType.kind !== 'local' && positionsMatch(toType, target) === false) {
      this.report(
        DiagnosticCodes.NODE_LINK_SHAPE,
        `'${link.edge}' lands on ${describePosition(target)}, but '${link.target.name}' is ${describePosition(toType)}`,
        link.span,
      );
    }
  }

  // ── Traversal heads & blocks ──

  /** Validates the head path, resolves its references, returns its hop aliases and probe steps. */
  private checkPathHead(head: PathHead, scope: Scope): HeadInfo {
    const aliases = extractHopAliases(head.hopsRaw);
    let rootSymbol: ScopeSymbol | undefined;
    if (head.root !== undefined) {
      rootSymbol = this.resolveName(head.root, head.span, scope);
    }
    const probeText = `${spellPathHead(head)}.\`__movement_head_probe__\``;
    let parsed: Expression | undefined;
    try {
      parsed = parseMovementExpression(probeText);
    } catch (e) {
      if (!(e instanceof BridgeError)) throw e;
      this.report(DiagnosticCodes.EXPR_PARSE, `Invalid traversal path: ${e.message}`, head.span);
    }
    let steps: TraversalStep[] | undefined;
    if (parsed) {
      const names = collectExpressionNames(parsed);
      const local = new Set([...aliases, ...names.aliases]);
      if (head.root !== undefined) local.add(head.root); // already resolved above
      for (const ref of new Set(names.refs)) {
        if (!local.has(ref)) this.resolveName(ref, head.span, scope);
      }
      // The arrow half of the retired block read-back (`orgs-[o:co]->`).
      this.reportBlockReadBack(names, scope, head.span);
      // A `_resources`-headed path parses to resource_traverse (no steps) —
      // it stays untyped; a plain hop chain yields the steps to type-walk.
      if (parsed.type === 'traverse') steps = parsed.steps;
    }
    // A BARE ADAPTER as a path root — `write kg-[:Company]-> { … }` against an
    // import nobody constructed. It used to degrade to silence: the root has no
    // position type, so the walk and every field check below simply skipped,
    // and a movement written against the ambient graph passed the checker while
    // meaning nothing. Silent degradation is the absence of a guarantee, so it
    // is reported at the root the author wrote — the same diagnosis a parameter
    // type and a `listen to` already give, now at the third place an instance
    // name can appear.
    if (rootSymbol?.kind === 'adapter' && head.root !== undefined) {
      const adapterName = rootSymbol.importedName ?? rootSymbol.name;
      this.report(
        DiagnosticCodes.ADAPTER_NOT_CONSTRUCTED,
        `'${head.root}' is an adapter, not an instance — construct and name an instance first, then walk or write from the name: 'go = ${this.constructionCall(adapterName)}' … 'go${head.hopsRaw ?? ''}'`,
        head.span,
      );
    }
    const rootType = rootSymbol ? this.symbolPositionType(rootSymbol) : undefined;
    // The head, recorded HERE — the one place the compiler reads a path — so a
    // renderer never has to read the syntax back. Landings are attached by the
    // caller that walks the chain; it is the only one that knows them.
    const recorded = this.recordNode<RecordedTraversal>({
      kind: 'traversal',
      span: head.span,
      scope,
      ...(head.root !== undefined ? { root: head.root } : {}),
      ...(traversalFrom(rootType) !== undefined ? { from: traversalFrom(rootType) } : {}),
      steps: steps ?? [],
      landings: [],
    });
    return {
      aliases,
      steps,
      rootType,
      ...(recorded !== undefined ? { recorded } : {}),
    };
  }

  /**
   * Finishes a recorded head with where its hops landed. An ALIASED hop's
   * landing is the one the walk bound the alias to; the last hop's is the walk's
   * own destination. Anything else stays absent — the walk never named it, and
   * inventing a landing would be the story claiming a fact the checker has not
   * got.
   */
  private attachLandings(
    head: HeadInfo,
    typing: ExpressionTyping,
    landed: PositionTypeRef | undefined,
  ): void {
    const { recorded, steps } = head;
    if (recorded === undefined || steps === undefined) return;
    recorded.landings = steps.map((step, index) => {
      const alias = step.type === 'edge' || step.type === 'meta_edge' ? step.alias : undefined;
      if (alias !== undefined) return recordedLanding(typing.locals.get(alias));
      return index === steps.length - 1 ? recordedLanding(landed) : undefined;
    });
  }

  /**
   * Checks the block and returns what ONE iteration of it hands back. A bound
   * block's value is those returns collected (`checkRValue`'s `block` case);
   * an unbound one runs for its effects and its returns go nowhere.
   */
  private checkTraversalBlock(
    block: TraversalBlock,
    scope: Scope,
    assignedName: string | undefined,
  ): ReturnShape & { headOrdering: CollectionOrder } {
    const head = this.checkPathHead(block.head, scope);
    // Type the hop chain (check 4) and harvest per-alias position types.
    // Rootless heads are relative to the enclosing position, which M2b does
    // not track — they walk untyped.
    const typing = this.slotTyping(scope, block.head.span);
    const landed =
      head.steps && head.rootType !== undefined
        ? typing.walkSteps(head.rootType, head.steps)
        : undefined;
    // The head decides what the block's collected returns are: iterations run
    // in the order the head yields positions, so the collection is ordered iff
    // the head is.
    const headOrdering = typing.lastOrdering;
    this.attachLandings(head, typing, landed);
    const blockScope = new Scope('traversal', scope);
    this.recordFrame('traversal', block.span, blockScope);
    for (const alias of head.aliases) {
      const aliasType = typing.locals.get(alias);
      this.declareAuthored(
        blockScope,
        {
          name: alias,
          kind: 'alias',
          span: block.head.span,
          ...(aliasType ? { posType: aliasType } : {}),
        },
        block.head.span,
      );
    }
    const returned = this.checkBody(block.body, blockScope, {
      what: assignedName !== undefined ? `the block bound to '${assignedName}'` : 'this block',
      returns: [],
    });
    // Bindings made inside the block are NOT visible outside it; remember them
    // so a later read of one is diagnosed as out-of-scope rather than unknown.
    // Nothing else escapes: the ONE way a value leaves a block is `return`.
    for (const [name, symbol] of blockScope.symbols) {
      if (symbol.kind === 'alias') continue;
      scope.escaped.set(name, assignedName);
    }
    for (const [name, blockName] of blockScope.escaped) {
      if (!scope.escaped.has(name)) scope.escaped.set(name, blockName);
    }
    return { ...returned, headOrdering };
  }

  // ── Calls ──

  /**
   * A call — and its value, which is what the callee RETURNS. A callee with no
   * `return` hands nothing back: its call is a statement, and the sites that
   * USE a call's value (`boundCallShape`) refuse it there rather than binding a
   * name to nothing.
   */
  private checkCall(
    statement: CallStatement,
    scope: Scope,
    binding?: string,
  ): ReturnShape {
    const resolution = scope.resolve(statement.callee);
    this.recordNode({
      kind: 'call',
      span: statement.span,
      scope,
      ...(binding !== undefined ? { binding } : {}),
      callee: statement.callee,
      isMovement: resolution.kind === 'found' && resolution.symbol.kind === 'movement',
    });
    let params: NamedParams | undefined;
    let value: ReturnShape = UNKNOWN_RETURN;
    if (resolution.kind !== 'found') {
      this.reportResolutionFailure(statement.callee, statement.span, resolution);
      // Something runs here and nobody can say what: the row is a lower bound.
      this.effects?.markPartial();
    } else {
      const callee = resolution.symbol;
      if (callee.kind === 'movement') {
        value = this.movementReturnType(callee);
        // Bottom-up over the call graph: a call adds what the callee does.
        this.effects?.absorb(this.movementEffects(callee));
        if (callee.arity !== undefined && statement.args.length !== callee.arity) {
          this.report(
            DiagnosticCodes.CALL_ARITY,
            `'${statement.callee}' takes ${callee.arity} argument${callee.arity === 1 ? '' : 's'}, got ${statement.args.length}`,
            statement.span,
          );
        }
        params = this.movementParams(callee);
      } else if (callee.kind === 'plugin') {
        // One function sort: a plugin is a function whose body isn't visible.
        value = this.checkPluginApplication(statement, callee);
      } else {
        // Either an unlinked file import (a body nobody parsed) or a name that
        // is not callable at all. Both leave the row a lower bound.
        this.effects?.markPartial();
        if (callee.kind !== 'fileImport') {
          // A file import may be a movement — M3 resolves it; give it the benefit of the doubt.
          this.report(
            DiagnosticCodes.CALL_NOT_MOVEMENT,
            `'${statement.callee}' is ${describeKind[callee.kind]}, not a movement — only movements are called`,
            statement.span,
          );
        }
      }
    }
    const paramTypeOf = this.checkNamedArgs({
      callee: statement.callee,
      args: statement.args.map(arg => ({ name: arg.name, span: callArgSpan(arg) })),
      params,
      span: statement.span,
    });
    for (const arg of statement.args) {
      this.checkCallArg(statement.callee, arg, paramTypeOf.get(arg.name), scope);
    }
    return value;
  }

  /** One argument: check it in its own right, then check that it FITS the
   *  parameter. The three forms differ only in how the argument's position type
   *  is arrived at. */
  private checkCallArg(
    callee: string,
    arg: CallArg,
    paramType: PositionTypeRef | undefined,
    scope: Scope,
  ): void {
    switch (arg.kind) {
      case 'expr': {
        this.checkExprSlot(arg.expr, scope);
        const argType = this.bareSlotPositionType(arg.expr, scope);
        this.checkCallArgFit(callee, argType, paramType, arg.expr.span);
        return;
      }
      case 'write': {
        const handle = this.checkWrite(arg.write, scope, { isBound: true });
        this.checkCallArgFit(callee, handle, paramType, arg.write.span);
        return;
      }
      case 'node': {
        const synthesised = this.checkNodeLiteral(arg.node, scope);
        this.checkCallArgFit(callee, synthesised, paramType, arg.node.span);
        return;
      }
      case 'call': {
        // The utility idiom: one movement's value is another's argument. Its
        // value is a synthesised node like any other, so it fits the parameter
        // by the same STRUCTURAL road — a node belongs to no graph, and there
        // is no third rule for one that came out of a call.
        const value = this.checkCall(arg.call, scope);
        this.checkCallArgFit(callee, value.posType, paramType, arg.call.span);
        return;
      }
    }
  }

  /**
   * Named-argument matching (check 7, by NAME): every argument names a
   * parameter, every parameter is supplied, no name repeats. Returns the
   * parameter type per matched argument name for the per-argument fit
   * checks. Unknown signatures (unresolved callees, file imports the
   * linker didn't resolve) skip name checks entirely.
   */
  private checkNamedArgs(input: {
    callee: string;
    args: Array<{ name: string; span: Span }>;
    params: NamedParams | undefined;
    span: Span;
    /** PARTIAL application (a callback's fixed arguments): an unsupplied
     *  parameter is not missing — it is what the caller supplies later. */
    partial?: boolean;
  }): Map<string, PositionTypeRef | undefined> {
    const { callee, args, params, span } = input;
    const seen = new Set<string>();
    for (const arg of args) {
      if (seen.has(arg.name)) {
        this.report(
          DiagnosticCodes.CALL_ARG_DUPLICATE,
          `Duplicate argument '${arg.name}' — each of '${callee}'s parameters is supplied once`,
          arg.span,
        );
      }
      seen.add(arg.name);
    }
    const types = new Map<string, PositionTypeRef | undefined>();
    if (!params) return types;
    const paramNames = params.map(p => p.name);
    for (const param of params) {
      types.set(param.name, param.type);
    }
    for (const arg of args) {
      if (!types.has(arg.name)) {
        this.report(
          DiagnosticCodes.CALL_ARG_UNKNOWN,
          `'${arg.name}' is not a parameter of '${callee}' — its parameters are: ${paramNames.join(', ') || '(none)'}`,
          arg.span,
        );
      }
    }
    const missing = input.partial === true ? [] : paramNames.filter(name => !seen.has(name));
    if (missing.length > 0) {
      this.report(
        DiagnosticCodes.CALL_ARG_MISSING,
        `'${callee}' is missing ${missing.length === 1 ? 'the argument' : 'arguments'} ${missing.map(n => `'${n}'`).join(', ')} — supply every parameter by name`,
        span,
      );
    }
    return types;
  }

  /**
   * `node { … }` — in-memory node synthesis. The type IS the literal: a
   * checker-local node (no graph, no schema to re-resolve) whose dot plane is
   * the value entries and whose arrow plane is the entries that wrote
   * literals.
   *
   * Ruling 1: nothing marks which is which — the entry's KIND decides. That is
   * why there are two entry shapes in the AST and no modifier in the grammar.
   *
   */
  private checkNodeLiteral(literal: NodeLiteral, scope: Scope): PositionTypeRef {
    const reads: Record<string, FieldType | undefined> = {};
    const edges: Record<string, LocalEdge> = {};
    const seen = new Set<string>();
    for (const entry of literal.entries) {
      if (seen.has(entry.name)) {
        this.report(
          DiagnosticCodes.NODE_ENTRY_DUPLICATE,
          `'${entry.name}' is written twice in this node — each entry names one thing`,
          entry.span,
        );
      }
      seen.add(entry.name);
      switch (entry.kind) {
        case 'value': {
          const { valueType, parsed } = this.checkExprSlot(entry.value, scope);
          // A NODE in a field slot is an error, not a silent untyped read —
          // the value plane is scalar, and the author meant an edge. Two
          // discernible shapes: a bare name bound on the node plane, and
          // ONLY/FIRST/LAST over a bare walk (which pick a position).
          const nodeRef = this.bareNodeSymbol(entry.value.raw, parsed, scope);
          if (nodeRef !== undefined) {
            this.report(
              DiagnosticCodes.NODE_ENTRY_NODE_VALUE,
              `'${entry.name}: ${nodeRef.name}' puts a node in a field — an entry value is a scalar. A node becomes a child by synthesis ('${entry.name}: node { … }') or by a walk ('${entry.name}: ${nodeRef.name}-[:Edge]->')`,
              entry.span,
            );
          } else if (parsed !== undefined && aggregatedBarePath(parsed) !== undefined) {
            this.report(
              DiagnosticCodes.NODE_ENTRY_NODE_VALUE,
              `'${entry.name}' is given a record — ONLY/FIRST/LAST over a bare walk pick a NODE, and an entry value is a scalar. Walk the edge instead ('${entry.name}: <source>-[:Edge]->') or aggregate a field ('ONLY(….\`Field\`)')`,
              entry.span,
            );
          }
          // The name lands on the read plane whether or not we could type it:
          // "I haven't typed this" and "there is no such entry" are different
          // facts, and only the second is an error at the read.
          reads[entry.name] = valueType ?? scalarLiteralType(entry.value.raw);
          break;
        }
        case 'nodes': {
          const landings = entry.nodes.map(node => this.checkNodeLiteral(node, scope));
          edges[entry.name] = {
            // A synthesised edge promises exactly what it is: readable, and
            // nothing else. It is not writable (there is no system behind it),
            // not awaitable (nothing will ever land later).
            schema: { target: entry.name, readable: true },
            target: this.mergeLandings(landings, entry),
          };
          break;
        }
        case 'declared': {
          // The DECLARED edge: no landings yet, and a type that says what the
          // ones `link` appends have to be. Same promises as any other
          // synthesised edge — readable, and nothing else.
          const target = this.declaredEdgeTarget(entry.type, scope);
          edges[entry.name] = {
            schema: { target: entry.name, readable: true },
            ...(target !== undefined ? { target } : {}),
          };
          break;
        }
        case 'traversal': {
          // The PASS-THROUGH edge: its landings are the walked source's own
          // positions, so the edge's type IS the traversal's landing type —
          // the source's field names, unrenamed. A per-item MAPPING replaces
          // that landing with the tail literal's structure instead. `lazy`
          // changes neither; it is the same walk at a different moment.
          const landed = this.checkLazyTraversal(
            {
              head: entry.head,
              ...(entry.mapping ? { mapping: entry.mapping } : {}),
              span: entry.span,
            },
            scope,
          );
          const target =
            landed?.kind === 'local' && entry.mapping !== undefined
              ? { ...landed, label: `a '${entry.name}' landing` }
              : landed;
          edges[entry.name] = {
            schema: { target: entry.name, readable: true },
            // A head we couldn't type leaves the landing UNKNOWN — the entry is
            // still declared, so traversing it is a guess, not a bad name.
            ...(target !== undefined ? { target } : {}),
            ...(entry.lazy ? { deferred: true } : {}),
          };
          break;
        }
      }
    }
    return { kind: 'local', label: 'a node', reads, edges };
  }

  /**
   * Where a declared edge's landings live: the address marker, WALKED — the
   * same hop chain a traversal head walks, so `<slack-[:Channels]->-[:Messages]->>`
   * means in a declaration exactly what it means in a movement.
   *
   * Nothing is read here and nothing is recorded: a declaration is a type, and
   * the run never walks it. The hop chain is still reported on, because a
   * declared edge nobody could type would accept every `link` in silence.
   */
  private declaredEdgeTarget(type: TypeRef, scope: Scope): PositionTypeRef | undefined {
    const symbol = this.resolveName(type.graph, type.span, scope);
    if (symbol === undefined) return undefined;
    if (symbol.kind === 'adapter') {
      const adapterName = symbol.importedName ?? symbol.name;
      this.report(
        DiagnosticCodes.ADAPTER_NOT_CONSTRUCTED,
        `'${type.graph}' is an adapter, not an instance — construct and name an instance first, then declare the edge off the name: 'go = ${this.constructionCall(adapterName)}' … '<go${type.hopsRaw ?? ''}>'`,
        type.span,
      );
      return undefined;
    }
    const start = this.symbolPositionType(symbol);
    const steps = type.hopsRaw !== undefined ? parseTraversalPath(type.hopsRaw) : undefined;
    if (start === undefined || steps === undefined) return undefined;
    return this.reportingTyping(scope, type.span).walkSteps(start, steps);
  }

  /**
   * The ONE landing type a plural synthesised edge exposes. A traversal yields
   * one type however many landings it has, so the edge carries what EVERY
   * landing carries — the rest is unreadable through the edge, exactly as it
   * would be through a union.
   *
   * Landings that disagree about an entry's TYPE are an error rather than a
   * first-one-wins silence: nothing would tell the author which literal typed
   * the read.
   */
  private mergeLandings(
    landings: PositionTypeRef[],
    entry: Extract<NodeEntry, { kind: 'nodes' }>,
  ): PositionTypeRef {
    const [first, ...rest] = landings;
    if (first === undefined || first.kind !== 'local') {
      return { kind: 'local', label: `a '${entry.name}' landing`, reads: {} };
    }
    if (rest.length === 0) return { ...first, label: `a '${entry.name}' landing` };

    const reads: Record<string, FieldType | undefined> = {};
    for (const name of Object.keys(first.reads)) {
      // PRESENCE first: an entry only some landings wrote isn't on the edge's
      // type at all (reading it through the traversal is the ordinary
      // unknown-name error, which is the true statement).
      if (!rest.every(l => l.kind === 'local' && Object.hasOwn(l.reads, name))) continue;
      const types = [first.reads[name], ...rest.map(l => (l.kind === 'local' ? l.reads[name] : undefined))];
      const known = types.filter((t): t is FieldType => t !== undefined);
      const clash = known.find(t => !fieldTypeEquals(t, known[0]));
      if (clash !== undefined) {
        this.report(
          DiagnosticCodes.NODE_LANDING_MISMATCH,
          `the landings of '${entry.name}' disagree about \`${name}\` (${describeFieldType(known[0])} and ${describeFieldType(clash)}) — a traversal lands on one type, so they must agree`,
          entry.span,
        );
      }
      // One landing we couldn't type leaves the read untyped: the edge can't
      // promise a type no landing agreed to.
      reads[name] = known.length === types.length ? known[0] : undefined;
    }
    const edges: Record<string, LocalEdge> = {};
    for (const [name, edge] of Object.entries(first.edges ?? {})) {
      if (rest.every(l => l.kind === 'local' && l.edges?.[name] !== undefined)) {
        edges[name] = edge;
      }
    }
    return { kind: 'local', label: `a '${entry.name}' landing`, reads, edges };
  }

  /** The position type of an argument slot that is a single bare name. */
  private bareSlotPositionType(slot: ExprSlot, scope: Scope): PositionTypeRef | undefined {
    const trimmed = slot.raw.trim();
    if (!BARE_IDENT.test(trimmed)) return undefined;
    const resolution = scope.resolve(trimmed);
    return resolution.kind === 'found' ? this.symbolPositionType(resolution.symbol) : undefined;
  }

  /**
   * Check 7: the argument's (graph, position) must match the parameter's.
   *
   * A SYNTHESISED node takes the structural road instead — it belongs to no
   * graph, so there is no instance token to compare and the nominal test would
   * only ever say no. Every other argument kind goes through `positionsMatch`
   * exactly as before: a real instance's position still matches nominally.
   */
  private checkCallArgFit(
    callee: string,
    argType: PositionTypeRef | undefined,
    paramType: PositionTypeRef | undefined,
    span: Span,
  ): void {
    if (argType === undefined || paramType === undefined) return;
    if (argType.kind === 'local') {
      const misfit = synthesisedNodeMisfit(argType, paramType);
      if (misfit !== undefined) {
        this.report(
          DiagnosticCodes.NODE_ARG_SHAPE,
          `'${callee}' expects ${describePosition(paramType)}, and ${misfit}`,
          span,
        );
      }
      return;
    }
    if (positionsMatch(argType, paramType) === false) {
      this.report(
        DiagnosticCodes.CALL_ARG_TYPE,
        `'${callee}' expects ${describePosition(paramType)}, but this argument is ${describePosition(argType)}`,
        span,
      );
    }
  }

  // ── Branching & concurrency ──

  private checkIf(statement: IfStatement, scope: Scope): void {
    // Reaching the statement AFTER the `if` means the arm that ran (if any)
    // fell through. So an arm that always FAILS proves its condition false
    // below — but only while every EARLIER arm fails too: otherwise the run
    // could have arrived here through one of those, with this arm's condition
    // never evaluated. That ordering is the whole subtlety, and it is why this
    // accumulates rather than testing each arm alone.
    let allPriorTerminate = true;
    // Arriving at arm k — or at the `else` — already proves every EARLIER arm's
    // condition false, because one `if`'s arms are tried in order. So a bare
    // `IS` that failed rules its variant out of the subject's union, and the
    // eliminations accumulate down the chain: the `else` sees the union minus
    // everything tested above, exactly as TypeScript's else-arm narrowing does.
    // (The guard-clause negation below is the OTHER direction — out into the
    // enclosing scope — which is why that one needs termination and this
    // doesn't.)
    const ruledOut = new Map<string, Set<string>>();
    const recorded = this.recordNode<RecordedBranch>({
      kind: 'branch',
      span: statement.span,
      scope,
      arms: [],
    });
    for (const arm of statement.arms) {
      // Positive IS conjuncts narrow into the arm's scope (check 6) — for
      // the arm body AND for the condition's later conjuncts
      // (`rec IS crm.person AND EXISTS(rec-[:Company]->)`).
      const armScope = new Scope('branch', scope);
      this.recordFrame('branch', arm.span, armScope);
      recorded?.arms.push({ span: arm.span, scope: armScope, conditionSpan: arm.condition.span });
      // Before the condition, so a later arm's own test narrows what the
      // earlier arms already left rather than the original union.
      this.declareEliminated(ruledOut, scope, armScope);
      this.checkConditionSlot(arm.condition, armScope, armScope);
      this.checkStatementList(arm.body, armScope);
      this.collectIsElimination(arm.condition, scope, ruledOut);
      const terminating = terminates(arm.body);
      if (allPriorTerminate && terminating) {
        this.narrowConditionNegation(arm.condition, scope, statement.span.end);
      }
      allPriorTerminate = allPriorTerminate && terminating;
    }
    if (statement.elseArm) {
      const elseScope = new Scope('branch', scope);
      this.recordFrame('branch', statement.elseArm.span, elseScope);
      if (recorded) recorded.otherwise = { span: statement.elseArm.span, scope: elseScope };
      this.declareEliminated(ruledOut, scope, elseScope);
      this.checkStatementList(statement.elseArm.body, elseScope);
    }
  }

  /** The union type a name carries, or undefined if it carries anything else.
   *  Elimination is a fact about unions only — narrowing a single-typed
   *  position by a failed test leaves it exactly where it was, same as TS. */
  private unionSymbolType(
    name: string,
    scope: Scope,
  ): Extract<PositionTypeRef, { kind: 'union' }> | undefined {
    const resolution = scope.resolve(name);
    if (resolution.kind !== 'found') return undefined;
    const posType = positionTypeOf(resolution.symbol);
    return posType?.kind === 'union' ? posType : undefined;
  }

  /** What a FAILED `IS` rules out of its subject's union. Only a BARE `IS`
   *  contributes: a conjunction proves nothing when false (only that one of its
   *  conjuncts was), the same rule the guard-clause negation follows.
   *
   *  Both planes contribute, and by the same move — the variant a PASSING test
   *  would have narrowed to is the one a failing test rules out. Only the way
   *  that variant is named differs: a record union names it directly, an event
   *  union names it by ADDRESS, and the address's key is the variant. (The
   *  address plane sat out until the engine stopped answering `false` to a test
   *  it cannot decide; a silent false routed an undiscriminated event into an
   *  arm typed "none of the above", which is elimination reading a silence as a
   *  fact. It now fails the run — see `evaluateIsTest` — so the else is sound
   *  here for exactly the reason it is sound there.) */
  private collectIsElimination(
    slot: ExprSlot,
    scope: Scope,
    ruledOut: Map<string, Set<string>>,
  ): void {
    let condition: MovementCondition;
    try {
      condition = parseMovementCondition(slot.raw);
    } catch {
      return; // the parse failure is reported by the arm's own check
    }
    if (condition.kind !== 'isTest') return;
    const subject = condition.subjectRaw.trim();
    if (!BARE_IDENT.test(subject)) return;
    const union = this.unionSymbolType(subject, scope);
    if (union === undefined) return;
    const graph = scope.resolve(condition.type.graph);
    if (graph.kind !== 'found') return;
    const eliminated = ruledOut.get(subject) ?? new Set<string>();
    // A STRUCTURAL test names no graph at all — a declared node belongs to
    // none. What a passing test would have narrowed to is every member that
    // CONFORMS, so failing it rules out exactly those, and the third plane
    // joins the other two on the same move.
    if (graph.symbol.kind === 'shape') {
      if (condition.type.position !== undefined || condition.type.hopsRaw !== undefined) return;
      for (const variant of union.variants) {
        // Only a member we PROVED conforms is ruled out by the failure.
        if (conformsToDeclaredNode(union.instance, variant, graph.symbol) === true) {
          eliminated.add(variant);
        }
      }
      ruledOut.set(subject, eliminated);
      return;
    }
    // Every other test has to name THIS union's graph before it rules anything
    // out — two instances can spell the same position name, and identity is the
    // token, never the spelling.
    if (union.instance.token !== graph.symbol) return;
    const variant = ruledOutVariant(condition.type, union);
    if (variant === undefined) return;
    eliminated.add(variant);
    ruledOut.set(subject, eliminated);
  }

  /** Shadows each subject with its union MINUS everything the arms above ruled
   *  out — the same scope move the positive `IS` makes, into the arm's own
   *  scope, so the arm's extent already bounds it. */
  private declareEliminated(
    ruledOut: Map<string, Set<string>>,
    scope: Scope,
    into: Scope,
  ): void {
    for (const [name, eliminated] of ruledOut) {
      const resolution = scope.resolve(name);
      if (resolution.kind !== 'found') continue;
      const union = this.unionSymbolType(name, scope);
      if (union === undefined) continue;
      const remaining = union.variants.filter(v => !eliminated.has(v));
      if (remaining.length === union.variants.length) continue;
      into.declare({ ...resolution.symbol, posType: residualUnion(union, remaining) });
    }
  }

  /** The guard-clause narrowing: an arm that always fails declares its
   *  condition's negation into the ENCLOSING scope, for the statements after
   *  the `if`. A conjunction proves nothing when false (only that one of its
   *  conjuncts is), so only a plain expression condition contributes.
   *  `guardEnd` is where that narrowing starts to hold — the end of the `if`
   *  statement, since only its continuation is proved. */
  private narrowConditionNegation(slot: ExprSlot, scope: Scope, guardEnd: Loc): void {
    let condition: MovementCondition;
    try {
      condition = parseMovementCondition(slot.raw);
    } catch {
      return; // the parse failure is reported by the arm's own check
    }
    if (condition.kind !== 'expr') return;
    this.narrowNegatedPresence(condition.expr, scope, scope, slot.span, {
      visibleFrom: guardEnd,
    });
  }

  // ── Movements ──

  private checkMovement(statement: MovementDeclaration, scope: Scope): void {
    if (!scope.symbols.has(statement.name)) {
      // Normally hoisted by checkStatementList; reached directly only as a
      // parallel sibling.
      this.declareAuthored(
        scope,
        {
          name: statement.name,
          kind: 'movement',
          span: statement.span,
          arity: statement.params.length,
          movement: { decl: statement, declScope: scope },
        },
        statement.span,
      );
    }
    const movementScope = new Scope('movement', scope);
    this.recordFrame('movement', statement.span, movementScope);
    for (const param of statement.params) {
      // A movement's parameter type is what it promises its callers, and there
      // is no caller to read it from — a listen, a call and a callback all
      // check against it. So it is written, always.
      if (param.type === undefined) {
        this.reportParamNeedsType(param.name, param.span, `'${statement.name}'`);
        continue;
      }
      const paramTypeRef = param.type;
      const graphSymbol = this.resolveName(paramTypeRef.graph, paramTypeRef.span, scope);
      // A bare adapter import used as a position source (`<manual-[:invocation]->>`)
      // — instantiation is explicit now, so the parameter's graph must be a
      // CONSTRUCTED instance. Guide the author to construct + name it first.
      if (graphSymbol?.kind === 'adapter') {
        const adapterName = graphSymbol.importedName ?? param.type.graph;
        const positionExample = param.type.position ?? (adapterName === 'cron' ? 'tick' : 'invocation');
        this.report(
          DiagnosticCodes.ADAPTER_NOT_CONSTRUCTED,
          `'${param.type.graph}' is an adapter, not an instance — construct an instance and name it first: 'go = ${this.constructionCall(adapterName)}', then type the parameter against the name ('<go-[:${positionExample}]->>') and listen to it ('listen to go {}')`,
          param.type.span,
        );
      }
      if (scope.kind === 'file' && statement.params.length === 1 && graphSymbol?.kind === 'instance') {
        // Dispatchable: a listener could fire it. Zero-width span so the
        // LISTEN_MISSING squiggle lands on the declaration word, not the body.
        this.dispatchables.push({
          movement: statement.name,
          instanceName: param.type.graph,
          ...(graphSymbol.adapter !== undefined ? { adapter: graphSymbol.adapter } : {}),
          ...(param.type.position !== undefined ? { position: param.type.position } : {}),
          ...(graphSymbol.schema?.eventNarrowingKeys !== undefined
            ? { narrowingKeys: [...graphSymbol.schema.eventNarrowingKeys] }
            : {}),
          span: { start: statement.span.start, end: statement.span.start },
        });
      }
      const posType =
        graphSymbol && graphSymbol.kind !== 'adapter'
          ? this.positionFromTypeRefStrict(graphSymbol, param.type, param.type.span)
          : undefined;
      const existing = this.declareAuthored(
        movementScope,
        {
          name: param.name,
          kind: 'param',
          span: param.span,
          ...(posType ? { posType } : {}),
        },
        param.span,
      );
      if (existing) {
        this.report(
          DiagnosticCodes.DUPLICATE_DECL,
          `Duplicate parameter '${param.name}'`,
          param.span,
        );
      }
    }
    this.recordMovementRow(scope.symbols.get(statement.name), () =>
      this.checkBody(statement.body, movementScope, {
        what: `'${statement.name}'`,
        returns: [],
      }),
    );
  }

  // ── Listeners ──

  /**
   * `listen to <instance> { <config> } fire <movement>` — the file-level
   * statement trigger rows are derived from. Checks:
   *   - file-level only;
   *   - the listened name is a constructed adapter instance, or the
   *     ambient `kg` (whose event channel is record mutations);
   *   - config keys match the adapter's trigger-config vocabulary (when the
   *     catalog declares one; absent vocabulary stays silent), and config
   *     VALUES match the adapter's declared value vocabulary where one
   *     exists (`triggerConfigOptions` — the subscribable-event surface);
   *   - kg listens carry the mutation vocabulary: a required `type`
   *     (angle-bracketed — it names a kg node type), optional `changes`
   *     (⊆ create/update/delete) and `fields` (properties of the type);
   *   - the fired name is a movement with exactly one parameter, typed
   *     against the listened instance (the event position) — for kg, the
   *     kg position the `type` config names;
   *   - no duplicate identical (instance, config) listens.
   */
  private checkListen(statement: ListenDeclaration, scope: Scope): void {
    // A TYPE-ONLY walk (`movementValueType`) must leave no trace on the
    // checker: it is the same body seen twice, and counting its listeners
    // twice would answer a file-level question with a callee's re-reading.
    if (this.typeOnly) return;
    this.listenCount++; // any listen — even a broken one — suppresses LISTEN_MISSING
    if (scope.kind !== 'file') {
      this.report(
        DiagnosticCodes.LISTEN_FILE_LEVEL,
        "'listen' is a file-level statement — it declares the file's listeners, so move it out of this block",
        statement.span,
      );
      return;
    }

    const instanceSymbol = this.resolveName(statement.instance, statement.span, scope);

    // Recorded here, where the listened name has resolved and before any of the
    // config checks can return early: a listen that fires nothing is still a
    // listen the author wrote, and the story renders the truth. What the config
    // decides — the selection, the address, the derived event types — is filled
    // in below as the same walk learns it.
    const firesResolution = scope.resolve(statement.movement);
    const recorded = this.recordNode<RecordedListen>({
      kind: 'listen',
      span: statement.span,
      scope,
      instance: statement.instance,
      ...(instanceSymbol?.kind === 'instance' && instanceSymbol.adapter !== undefined
        ? { adapterType: instanceSymbol.adapter }
        : {}),
      fires: statement.movement,
      firesMovement:
        firesResolution.kind === 'found' && firesResolution.symbol.kind === 'movement',
      narrowing: {},
      eventTypes: [],
    });
    // `listen to manual() {} fire …` — the now-rejected inline construction
    // form. Instantiation is explicit: construct + name the instance first,
    // then `listen to <name>`. Reject it with the named-construction fix.
    const isInlineConstruct = statement.construct !== undefined;
    if (isInlineConstruct) {
      const adapterName =
        instanceSymbol?.kind === 'adapter'
          ? (instanceSymbol.importedName ?? instanceSymbol.name)
          : statement.construct?.callee ?? statement.instance;
      this.report(
        DiagnosticCodes.ADAPTER_NOT_CONSTRUCTED,
        `'listen to ${statement.instance}(…)' constructs an instance inline — construct and name it first, then listen by name: 'go = ${this.constructionCall(adapterName)}' … 'listen to go {} fire ${statement.movement}'`,
        statement.span,
      );
    } else if (instanceSymbol && instanceSymbol.kind === 'adapter') {
      // A bare adapter import — not a constructed instance.
      const adapterName = instanceSymbol.importedName ?? instanceSymbol.name;
      this.report(
        DiagnosticCodes.ADAPTER_NOT_CONSTRUCTED,
        `'${statement.instance}' is an adapter, not an instance — construct and name an instance first, then listen to it by name: 'go = ${this.constructionCall(adapterName)}' … 'listen to go {} fire ${statement.movement}'`,
        statement.span,
      );
    } else if (instanceSymbol && instanceSymbol.kind !== 'instance') {
      this.report(
        DiagnosticCodes.LISTEN_NOT_INSTANCE,
        `'${statement.instance}' is ${describeKind[instanceSymbol.kind]} — 'listen to' names a constructed adapter instance (e.g. inbox = email(credentials: …))`,
        statement.span,
      );
    }

    // The universal listen-config key (see SUPPRESS_SELF_KEY). It is NOT
    // adapter vocabulary — it's a platform 2-way-sync semantic, valid on
    // every listener (kg or adapter), so it's validated HERE (boolean
    // literal only) and excluded from both the adapter-vocabulary check and
    // the kg-config check below.
    const suppressSelfArg = statement.config.find(arg => arg.name === SUPPRESS_SELF_KEY);
    if (suppressSelfArg) {
      if (suppressSelfArg.isType || !BOOLEAN_LITERAL.test(suppressSelfArg.value.raw.trim())) {
        this.report(
          DiagnosticCodes.LISTEN_BAD_CONFIG,
          `'${SUPPRESS_SELF_KEY}' takes a boolean literal — write ${SUPPRESS_SELF_KEY}: true to ignore this system's own writes echoing back (the 2-way-sync case), or omit it (the default is off)`,
          suppressSelfArg.value.span,
        );
      }
    }

    // The literal config values that select which events fire — the
    // adapter's `events: [...]`, captured from the option-bearing config
    // below. They drive the derived event type (see derivedEventTypes).
    let selectedConfigValues: string[] | undefined;
    // Every SINGLE-literal config value the listen states, by key — the address
    // it subscribes to (`base: "appDevLoop"`), which is what narrows the type it
    // fires. A non-literal (a list, an expression) is not an address and simply
    // isn't here.
    const listenConfigValues: Record<string, string | undefined> = {};
    // A `'fields'`-format key's bare names, held until the address has landed.
    let fieldsFilter: { names: string[]; span: Span } | undefined;
    const adapterName =
      instanceSymbol?.kind === 'instance' ? instanceSymbol.adapter : undefined;
    const spec = adapterName !== undefined ? this.catalog.adapter(adapterName) : undefined;
    const vocabulary = spec?.triggerConfig;
    // Keys the adapter REQUIRES (the cron `schedule`) — a listen
    // missing one would provision a listener that can never fire.
    //
    // THE POSITION SUPPLIES THE LEADING HOPS: a required key is also
    // satisfied when the instance's construction pins a POSITION arg of the
    // same name (`at = airtable(credentials: c, base: "Dev Base")` supplies
    // `base`, so its listens name only `table`). A listen's address is
    // relative to the instance's position, not absolute from the meta node.
    for (const required of spec?.triggerConfigRequired ?? []) {
      if (statement.config.some(arg => arg.name === required)) continue;
      const positionSupplies =
        spec?.constructionArgs.some(a => a.kind === 'position' && a.name === required) === true
        && instanceSymbol?.kind === 'instance'
        && typeof instanceSymbol.constructionArgs?.[required] === 'string'
        && instanceSymbol.constructionArgs[required].trim() !== '';
      if (positionSupplies) continue;
      const example =
        spec?.triggerConfigFormats?.[required] === 'cron' ? '"0 9 * * 1"' : '"…"';
      this.report(
        DiagnosticCodes.LISTEN_BAD_CONFIG,
        `a '${adapterName}' listener requires a '${required}' config — e.g. listen to ${statement.instance} { ${required}: ${example} } fire ${statement.movement}`,
        statement.span,
      );
    }
    for (const arg of statement.config) {
      if (arg.name === SUPPRESS_SELF_KEY) continue; // universal key, validated above
      // Reject any config key the adapter doesn't accept. A resolved adapter
      // with NO declared config vocabulary accepts NONE — an unknown key is an
      // error, not silently passed. (An unresolved adapter — no `spec` — stays
      // silent: the unknown-stays-silent contract.)
      if (spec && !(vocabulary ?? []).includes(arg.name)) {
        const accepted = vocabulary ?? [];
        this.report(
          DiagnosticCodes.LISTEN_BAD_CONFIG,
          `'${adapterName}' listeners do not accept a config key '${arg.name}'${accepted.length ? ` — they accept: ${accepted.join(', ')}` : ' — they take no config'}`,
          arg.value.span,
        );
        continue;
      }
      if (arg.isType) {
        // No listen config takes a type. The graph's `type: <company>` was
        // the last one, and it is a quoted value now like every other pin —
        // a listen names things by the address's own currency, not by a
        // type reference (D25).
        this.report(
          DiagnosticCodes.LISTEN_BAD_CONFIG,
          `'${arg.name}' takes a plain value — '<${arg.value.raw.trim()}>' is a type reference, and listen config is quoted values: ${arg.name}: "${arg.value.raw.trim()}"`,
          arg.value.span,
        );
        continue;
      }
      const literal = staticStringValues(arg.value);
      if (literal?.length === 1 && !isListSlot(arg.value)) {
        listenConfigValues[arg.name] = literal[0];
      }
      const options = spec?.triggerConfigOptions?.[arg.name];
      if (options !== undefined) {
        const values = staticStringValues(arg.value);
        if (values === undefined || !isListSlot(arg.value)) {
          // Event selections are always a list of quoted strings — even a
          // single event — so the authored shape is uniform and every reader
          // sees an array.
          const example = options.length > 0 ? `"${options[0]}"` : '"…"';
          this.report(
            DiagnosticCodes.LISTEN_BAD_CONFIG,
            `'${arg.name}' is a list of events${options.length > 0 ? ` — one of: ${options.join(', ')}` : ''} — e.g. ${arg.name}: [${example}]`,
            arg.value.span,
          );
        } else {
          // The selected events — the source of the listener's event type.
          selectedConfigValues = values;
          for (const value of values) {
            if (!options.includes(value)) {
              this.report(
                DiagnosticCodes.LISTEN_BAD_CONFIG,
                `'${value}' is not an event '${adapterName}' can subscribe to — one of: ${options.join(', ')}`,
                arg.value.span,
              );
            }
          }
        }
      }
      // Static value formats — the SAME parser/probe the platform scheduler
      // runs, so check time and fire time can never disagree about what is
      // valid.
      const format = spec?.triggerConfigFormats?.[arg.name];
      if (format === 'cron') {
        // The cron adapter's `schedule`.
        const values = staticStringValues(arg.value);
        if (values === undefined || values.length !== 1) {
          this.report(
            DiagnosticCodes.LISTEN_BAD_CONFIG,
            `'${arg.name}' takes one quoted cron expression — e.g. ${arg.name}: "0 9 * * 1" (minute hour day-of-month month day-of-week, UTC unless a timezone is set)`,
            arg.value.span,
          );
        } else {
          const scheduleError = cronScheduleError(values[0]);
          if (scheduleError !== null) {
            this.report(
              DiagnosticCodes.LISTEN_BAD_CONFIG,
              `'${values[0]}' is not a valid schedule — ${scheduleError}. Five fields: minute hour day-of-month month day-of-week, e.g. "0 9 * * 1" is 09:00 every Monday`,
              arg.value.span,
            );
          }
        }
      } else if (format === 'timezone') {
        // The cron adapter's optional `timezone` — an IANA id.
        const values = staticStringValues(arg.value);
        if (values === undefined || values.length !== 1) {
          this.report(
            DiagnosticCodes.LISTEN_BAD_CONFIG,
            `'${arg.name}' takes one quoted IANA time zone — e.g. ${arg.name}: "Europe/London"`,
            arg.value.span,
          );
        } else {
          const tzError = cronTimezoneError(values[0]);
          if (tzError !== null) {
            this.report(
              DiagnosticCodes.LISTEN_BAD_CONFIG,
              `${tzError}. The schedule then fires at that local wall-clock time, with daylight-savings handled for you`,
              arg.value.span,
            );
          }
        }
      } else if (format === 'fields') {
        // The changed-attribute filter — bare property names of whatever the
        // listen's address lands on. The SHAPE is checkable here; the NAMES
        // need the landed position, so they are held for the check below.
        const names = bareNameValues(arg.value);
        if (names === undefined) {
          this.report(
            DiagnosticCodes.LISTEN_BAD_CONFIG,
            `'${arg.name}' is a list of the watched type's properties, bare — e.g. ${arg.name}: [domains]`,
            arg.value.span,
          );
        } else {
          fieldsFilter = { names, span: arg.value.span };
        }
        continue; // bare names are not an expression slot
      }
      this.checkExprSlot(arg.value, scope);
    }

    if (recorded) {
      for (const [key, value] of Object.entries(listenConfigValues)) {
        if (value !== undefined) recorded.narrowing[key] = value;
      }
      if (selectedConfigValues !== undefined) recorded.events = [...selectedConfigValues];
    }

    // The type(s) this listen fires, derived from its config alone. Computed
    // HERE — before `fire` is resolved — because a listen that fires nothing
    // is still a listen the author wrote: the story renders what it watches,
    // and a `fields:` filter is checkable whether or not the movement is.
    const instanceRef =
      instanceSymbol !== undefined ? instanceRefOf(instanceSymbol) : undefined;
    // A listen with no `events:` selection is subscribed to the adapter's own
    // dispatch DEFAULT (whatsapp: messages only), not necessarily everything.
    const listenSpec =
      instanceSymbol?.kind === 'instance' && instanceSymbol.adapter !== undefined
        ? this.catalog.adapter(instanceSymbol.adapter)
        : undefined;
    const subscribed = selectedConfigValues ?? listenSpec?.defaultEvents;
    if (recorded && subscribed !== undefined) recorded.events = [...subscribed];
    // A typo'd hop dies HERE, at the pin the author wrote, with a did-you-mean
    // — not downstream as a parameter mismatch against a signature that may
    // carry the same typo, and not silently when the address is wide.
    if (instanceRef !== undefined) {
      this.checkHopPins(
        instanceRef,
        listenConfigValues,
        key =>
          statement.config.find(arg => arg.name === key)?.value.span ?? statement.span,
      );
    }
    const eventTypes =
      instanceRef !== undefined
        ? this.derivedEventTypes(instanceRef, subscribed, listenConfigValues)
        : undefined;
    if (recorded && eventTypes !== undefined) {
      recorded.eventTypes = eventTypes.map(ref =>
        ref.kind === 'union'
          ? { key: ref.union, ...(ref.display !== undefined ? { display: ref.display } : {}) }
          : ref.kind === 'position'
            ? { key: ref.position, ...(ref.display !== undefined ? { display: ref.display } : {}) }
            : { key: describePosition(ref) },
      );
    }

    // `fields: [domains]` — the names, now that the address has landed. One
    // landed type is the checkable case: where a listen fires several, a name
    // valid on any of them is valid (the filter is applied per event).
    //
    // The names belong to whatever the listen is FILTERING, and the two event
    // shapes disagree about what that is. Where the landed position declares a
    // SUBJECT edge — the hop from an event to the record it is about — the
    // record is one hop away and its properties are what `fields:` names; the
    // event node's own `action`/`type` are not filterable fields, they are the
    // address. Where no subject edge is declared the listen fires the record
    // itself and the landed position is already the right surface.
    //
    // The marker is the adapter's, not this checker's: recognising an edge by
    // its name would be parsing a display string an adapter is free to spell
    // differently.
    if (fieldsFilter !== undefined && instanceRef !== undefined && eventTypes !== undefined) {
      const known = new Set<string>();
      let described = false;
      for (const type of eventTypes) {
        const key = type.kind === 'position' ? type.position : undefined;
        const landed = key !== undefined ? instanceRef.schema.positions[key] : undefined;
        if (landed === undefined) continue;
        const position = subjectOf(instanceRef, landed)?.position ?? landed;
        if (position.undescribed === true) continue;
        described = true;
        for (const name of Object.keys(position.properties)) known.add(name);
      }
      if (described) {
        for (const name of fieldsFilter.names) {
          if (known.has(name)) continue;
          this.report(
            DiagnosticCodes.LISTEN_BAD_CONFIG,
            `'${name}' is not a property of what this listener watches`
              + `${known.size > 0 ? ` — one of: ${[...known].sort().join(', ')}` : ''}`,
            fieldsFilter.span,
          );
        }
      }
    }

    const configIdentity = statement.config
      .map(arg => `${arg.name}=${arg.value.raw.trim()}`)
      .sort()
      .join(',');
    const identity = `${statement.instance}::${configIdentity}`;
    if (this.listenIdentities.has(identity)) {
      this.report(
        DiagnosticCodes.LISTEN_DUPLICATE,
        `Duplicate listener — an identical 'listen to ${statement.instance}${statement.config.length > 0 ? ' { … }' : ''}' already exists; two listens on the same instance must differ in config`,
        statement.span,
      );
    }
    this.listenIdentities.add(identity);

    if (statement.alias !== undefined) {
      const aliasKey = `${statement.movement}::${statement.alias}`;
      if (this.listenAliases.has(aliasKey)) {
        this.report(
          DiagnosticCodes.LISTEN_ALIAS_DUPLICATE,
          `Two lanes of '${statement.movement}' are both named "${statement.alias}" — give each listen a distinct alias`,
          statement.span,
        );
      } else {
        this.listenAliases.add(aliasKey);
      }
    }

    const movementSymbol = this.resolveName(statement.movement, statement.span, scope);
    if (!movementSymbol) return;
    if (movementSymbol.kind === 'fileImport') return; // may be a movement — M3 resolves it
    if (movementSymbol.kind !== 'movement') {
      this.report(
        DiagnosticCodes.CALL_NOT_MOVEMENT,
        `'${statement.movement}' is ${describeKind[movementSymbol.kind]}, not a movement — 'fire' names a movement declared in this file`,
        statement.span,
      );
      return;
    }
    const info = movementSymbol.movement;
    if (!info) return;
    if (info.decl.params.length !== 1) {
      this.report(
        DiagnosticCodes.LISTEN_PARAM_MISMATCH,
        `'${statement.movement}' takes ${info.decl.params.length} parameters — a movement fired by a listener takes exactly one, the event position`,
        statement.span,
      );
      return;
    }
    if (instanceSymbol?.kind !== 'instance') return;

    // Can this system notify us AT ALL? A manifest naming zero trigger types
    // (Sheets, Drive, Dropbox — write targets) has no inbound surface, so a
    // listener on it provisions cleanly and then stays silent forever, which
    // reads to the author as "it works, nothing has happened yet".
    //
    // This is deliberately gated on a spec we HAVE: an unknown adapter stays
    // leniently unchecked, a known one without the flag is a definite no. The
    // downstream event-type check can't make that call — it sees an empty
    // event surface and can't tell "this system has none" from "we haven't
    // introspected one yet", so it correctly stays lenient and the listener
    // sails through.
    if (instanceSymbol?.kind === 'instance' && instanceSymbol.adapter !== undefined) {
      const spec = this.catalog.adapter(instanceSymbol.adapter);
      if (spec !== undefined && spec.canFire !== true) {
        this.report(
          DiagnosticCodes.LISTEN_CANNOT_FIRE,
          `'${statement.instance}' can't start an automation — it has no way to tell us when `
            + `something changes there. Use it as somewhere to write to, and start this from `
            + `something that can notify us (a schedule, an inbox, a chat message, or a record `
            + `change in a system that reports one)`,
          statement.span,
        );
        return;
      }
    }

    const param = info.decl.params[0];
    const declared = param.type;
    if (declared === undefined) return; // already reported at the declaration
    const paramGraph = info.declScope.resolve(declared.graph);
    if (paramGraph.kind !== 'found') return; // already reported at the declaration

    // Shape-typed params keep the structural conformance path (unchanged).
    if (paramGraph.symbol.kind === 'shape' && instanceSymbol?.kind === 'instance') {
      this.checkListenShapeConformance(paramGraph.symbol, instanceSymbol, param, statement);
      return;
    }

    // The fired movement's parameter must be typed against the SAME
    // constructed instance this listener names — `go = manual()` /
    // `movement m(run: <go-[:invocation]->>)` / `listen to go {} fire m`.
    if (paramGraph.symbol !== instanceSymbol) {
      const paramType = `${declared.graph}${declared.hopsRaw ?? ''}`;
      this.report(
        DiagnosticCodes.LISTEN_PARAM_MISMATCH,
        `'${statement.movement}' takes '${param.name}: <${paramType}>', but this listener fires with an event position of '${statement.instance}' — the parameter's type must equal the listened instance's event position type (a '<${statement.instance}-[:…]->>' position, not '<${paramType}>')`,
        statement.span,
      );
      return;
    }

    // Derived above, before the fired movement resolved: the type(s) this
    // listen fires — the event node each selected kind is delivered on, at
    // the address the config states, with the `events:` selection as `action`
    // pins where the node declares that axis. The parameter must satisfy
    // EVERY one (a listen calls the movement on every matching event, so each
    // delivered type is an argument). Same assignability primitive as any
    // call. An adapter that declares no event edges stays leniently
    // unchecked.
    if (instanceRef === undefined || eventTypes === undefined) return;
    const paramType = this.positionFromTypeRef(paramGraph.symbol, declared);
    if (paramType === undefined) return; // unknown position already reported at the decl
    const mismatch = eventTypes.find((t) => positionsMatch(t, paramType) === false);
    if (mismatch !== undefined) {
      // The parameter as the AUTHOR WROTE IT — never the key it resolved to.
      // A signature and a listen disagreeing is a disagreement about an
      // address, so both sides must read as addresses.
      const wrote = `<${declared.graph}${declared.hopsRaw ?? ''}>`;
      // The signature names the RECORD this event is about — the shape every
      // movement written against an ambient graph has, and the one case where
      // "what to change" is fully determined. Say it, exactly.
      const rewrite = this.recordSignatureRewrite({
        instance: instanceRef,
        instanceName: statement.instance,
        fires: mismatch,
        paramName: param.name,
        paramType,
      });
      if (rewrite !== undefined) {
        this.report(
          DiagnosticCodes.LISTEN_PARAM_MISMATCH,
          `'${statement.movement}' takes '${param.name}: ${wrote}', but this listener fires `
            + `${describeEventType(mismatch)} — the EVENT, not the record it is about. `
            + `Type the parameter against the event and reach the record in one hop: `
            + `'${statement.movement}(${rewrite.eventParam}: ${rewrite.signature})', `
            + `then wrap the body in '${rewrite.binding}'.`,
          statement.span,
        );
        return;
      }
      const example = this.eventTraversalExample(instanceRef, param.name, statement.instance);
      this.report(
        DiagnosticCodes.LISTEN_PARAM_MISMATCH,
        `'${statement.movement}' takes '${param.name}: ${wrote}' (${describePosition(paramType)}), but `
          + `this listener fires ${describeEventType(mismatch)}. Every listen firing a movement must `
          + `satisfy its signature — either narrow this listen to what '${statement.movement}' accepts, `
          + `or widen the signature`
          + (example === undefined ? '.' : ` — e.g. \`${example}\` `)
          + (example === undefined ? '' : `(a delete event has no record to read).`),
        statement.span,
      );
    }
  }

  /**
   * The construction an adapter actually takes, as an author writes it —
   * `kg()`, `attio(credentials: …)`, `airtable(credentials: …, base: …)`.
   *
   * DERIVED from the declared signature, because "here is how to construct it"
   * is only worth saying if it is true for THIS adapter: telling the author of
   * a credential-free system to pass credentials sends them looking for a
   * connection that does not exist, and showing `()` for one that needs a
   * credential fails on paste. An adapter the catalog does not know gets the
   * bare call — the honest answer when nothing was declared.
   */
  private constructionCall(adapterName: string): string {
    const args = this.catalog.adapter(adapterName)?.constructionArgs ?? [];
    const required = args.filter((a) => a.required).map((a) => `${a.name}: …`);
    return `${adapterName}(${required.join(', ')})`;
  }

  /**
   * The EXACT rewrite for a signature typed against the record when the listen
   * fires the event — the shape every movement written against an ambient
   * graph has, once the graph publishes an event entry like every other
   * adapter (D40(a)).
   *
   * It fires only when the diagnosis is certain: the fired event declares a
   * SUBJECT edge, and that edge lands on the very position the signature
   * named. Then the new signature is the address this listen actually fires
   * and the body regains the author's own name one hop along. Anything less
   * certain falls through to the general advice — a rewrite that doesn't
   * compile is worse than none, which is the same rule `eventTraversalExample`
   * follows.
   *
   * Every identifier comes from the schema: the event's name and pins from the
   * address, the hop from the edge the adapter marked. Nothing is spelled here,
   * so a fixture shaped like one adapter cannot make a hardcoded string look
   * derived.
   *
   */
  private recordSignatureRewrite(input: {
    instance: InstanceRef;
    instanceName: string;
    fires: PositionTypeRef;
    paramName: string;
    paramType: PositionTypeRef;
  }): { signature: string; binding: string; eventParam: string } | undefined {
    const { fires, paramType } = input;
    if (fires.kind !== 'position' && fires.kind !== 'union') return undefined;
    if (fires.address === undefined) return undefined;
    if (paramType.kind !== 'position') return undefined;
    const landed = fires.kind === 'union' ? fires.variants : [fires.position];
    for (const key of landed) {
      const position = input.instance.schema.positions[key];
      if (position === undefined) continue;
      const subject = subjectOf(input.instance, position);
      if (subject === undefined || subject.target !== paramType.position) continue;
      // The author's name still means the record, so it keeps it; the event
      // needs one of its own, and only has to differ from the name in hand.
      const eventParam = input.paramName === 'event' ? 'change' : 'event';
      return {
        signature: eventAddressSource(input.instanceName, fires.address),
        // The BLOCK traversal, because that is the form the language has: a
        // bare `x = a-[:E]->` binding does not parse, and a suggestion that
        // does not compile sends the author somewhere that isn't there.
        binding: `${eventParam}-[${input.paramName}:${subject.edge}]-> { … }`,
        eventParam,
      };
    }
    return undefined;
  }

  /**
   * A worked example of reaching the record, built from THIS instance's own
   * event surface.
   *
   * It used to be hardcoded to Attio's shape (`e-[r:Companies]-> { … r.Name }`),
   * which is a real edge there and a fiction anywhere else — an Airtable author
   * reads it and goes looking for a `Companies` edge on an event whose only edge
   * is `record`. A suggestion that doesn't execute in the instance it's aimed at
   * is worse than no suggestion: it sends the author somewhere that isn't there,
   * which is the same failure `AdapterNameDriftError` makes in
   * `7_readable_means_readable.md`.
   *
   * So take a live action's variant, an edge it really has, and a field really
   * on that edge's target. Anything we can't name, we don't claim: no example
   * beats a wrong one.
   */
  private eventTraversalExample(
    instance: InstanceRef,
    paramName: string,
    instanceName: string,
  ): string | undefined {
    const schema = instance.schema;
    for (const { position: eventName } of schema.eventPositions ?? []) {
      const position = schema.positions[eventName];
      if (position === undefined) continue;
      const actionType = position.properties[EVENT_ACTION_FIELD];
      const actions =
        typeof actionType === 'object' && actionType.kind === 'enum' ? actionType.options : [];
      const action = actions.find((a) => a !== RECORD_DELETED_ACTION);
      if (action === undefined) continue; // no change-kind axis — nothing to narrow by
      const edge = Object.keys(position.edges).find(
        (e) => position.edges[e].requiresLiveRecord !== true || action !== RECORD_DELETED_ACTION,
      );
      if (edge === undefined) continue;
      const target = position.edges[edge].target;
      const field = Object.keys(schema.positions[target]?.properties ?? {})[0];
      const read = field === undefined ? '…' : `… r.\`${field}\``;
      return (
        `if ${paramName} IS <${instanceName}-[:\`${eventName}\` WHERE \`${EVENT_ACTION_FIELD}\` == "${action}"]->> `
        + `{ ${paramName}-[r:${edge}]-> { ${read} } }`
      );
    }
    return undefined;
  }

  /**
   * The type(s) a listen produces, as a function of its config. Returns the
   * PositionTypeRefs the param is matched against (one per delivered event
   * node), or undefined when the instance declares no event edges (lenient:
   * caller skips the check).
   *
   * THE EVENT IS JUST A NODE. Each `events:` value is delivered along one of
   * the instance's declared event edges (`eventPositions[].on`); the type it
   * fires is that node at the address the config states — the hop pins from
   * `eventNarrowingKeys`, plus the value itself as an `action` pin where the
   * node declares that axis (an ordinary enum field — ONE namespace, the
   * retired `configValueToAction` translation table has nothing to translate).
   * A selection covering the node's whole action enum — or no selection at
   * all — is the unnarrowed node: not a mechanism, a wider type.
   *
   * Position-per-listen falls out: two listens, two addresses, two keys, two
   * types — no per-listen mechanism anywhere.
   *
   */
  private derivedEventTypes(
    instance: InstanceRef,
    selectedConfigValues: string[] | undefined,
    listenConfigValues: Record<string, string | undefined>,
  ): PositionTypeRef[] | undefined {
    const eventPositions = instance.schema.eventPositions;
    if (eventPositions === undefined || eventPositions.length === 0) return undefined;

    // The address this listen's config states. A listen that doesn't name the
    // whole address narrows nothing — the wide event type stands, so an
    // adapter with no addressable events is untouched.
    const narrowing =
      listenNarrowing({ keys: instance.schema.eventNarrowingKeys, config: listenConfigValues })
      ?? {};

    const refFor = (event: string, pins: Record<string, string>): PositionTypeRef => {
      const narrowed = Object.keys(pins).length > 0;
      const address: EventAddress = { event, narrowing: pins };
      const key = eventAddressKey(address);
      // Resolve through the schema where the position/union is grafted (so the
      // ref's KIND mirrors what the param resolves to); construct the ref
      // directly where it isn't — a listen's address is a real type even where
      // no signature named it, so the ref carries its own display.
      const resolved = positionRefIn(instance, key);
      const base: PositionTypeRef =
        resolved !== undefined && (resolved.kind === 'position' || resolved.kind === 'union')
          ? resolved
          : { kind: 'position', instance, position: key };
      if (base.kind !== 'position' && base.kind !== 'union') return base;
      return {
        ...base,
        address,
        ...(narrowed ? { narrowsEvent: event, display: eventAddressDisplay(address) } : {}),
      };
    };

    const derived: PositionTypeRef[] = [];
    for (const { position: event, on } of eventPositions) {
      // The `events:` values this edge delivers, of those the listen selected.
      // No selection ⇒ the edge fires on all its kinds.
      const deliveredHere =
        selectedConfigValues === undefined
          ? undefined
          : selectedConfigValues.filter((v) => (on === undefined ? true : on.includes(v)));
      if (deliveredHere !== undefined && deliveredHere.length === 0) continue;

      const actionType = instance.schema.positions[event]?.properties[EVENT_ACTION_FIELD];
      const actionEnum =
        typeof actionType === 'object' && actionType.kind === 'enum'
          ? actionType.options
          : undefined;

      if (actionEnum === undefined || deliveredHere === undefined) {
        derived.push(refFor(event, narrowing));
        continue;
      }
      const pinnable = [...new Set(deliveredHere.filter((v) => actionEnum.includes(v)))];
      if (pinnable.length === 0 || actionEnum.every((v) => pinnable.includes(v))) {
        // Nothing this node's axis recognises (checked as listen config
        // separately), or the whole axis — the unnarrowed node either way.
        derived.push(refFor(event, narrowing));
        continue;
      }
      if (pinnable.length === 1) {
        derived.push(refFor(event, { ...narrowing, [EVENT_ACTION_FIELD]: pinnable[0] }));
        continue;
      }
      // A config-scoped union over the selected action pins (NOT the full
      // static union), keyed by the node's own address so a param naming the
      // node matches while a too-narrow single-action param does not.
      const unionAddress: EventAddress = { event, narrowing };
      derived.push({
        kind: 'union',
        instance,
        union: eventAddressKey(unionAddress),
        variants: pinnable.map((v) =>
          eventAddressKey({ event, narrowing: { ...narrowing, [EVENT_ACTION_FIELD]: v } }),
        ),
        address: unionAddress,
        narrowsEvent: event,
        ...(Object.keys(narrowing).length > 0
          ? { display: eventAddressDisplay(unionAddress) }
          : {}),
      });
    }
    return derived.length > 0 ? derived : undefined;
  }

  private checkListenShapeConformance(
    shapeSymbol: ScopeSymbol,
    instanceSymbol: ScopeSymbol,
    param: MovementDeclaration['params'][number],
    statement: ListenDeclaration,
  ): void {
    const shapeSchema = shapeSymbol.schema;
    const instanceSchema = instanceSymbol.schema;
    // The declaration IS its root node, so that is what the lane must conform to.
    const shapeNodeName = shapeSymbol.name;
    if (!shapeSchema) return;
    const shapeNode = shapeSchema.positions[shapeNodeName];
    if (!shapeNode) return; // unknown root — reported at the param decl

    // The instance's event position; unknown ⇒ unverifiable ⇒ info, not error.
    const eventPos = instanceSchema?.eventPosition;
    const instancePos = eventPos ? instanceSchema!.positions[eventPos] : undefined;
    if (!instancePos) {
      this.reportInfo(
        DiagnosticCodes.LISTEN_SHAPE_MISMATCH,
        `'${statement.instance}' isn't connected (or its event schema is unknown) — conformance to the declaration '${param.type?.graph ?? param.name}' is unchecked for this lane`,
        statement.span,
      );
      return;
    }

    if (surfaceNotEnumerated(instancePos)) {
      this.reportInfo(
        DiagnosticCodes.LISTEN_SHAPE_MISMATCH,
        `'${statement.instance}'s event schema can't be introspected — conformance to the declaration '${param.type?.graph ?? param.name}' is unchecked for this lane`,
        statement.span,
      );
      return;
    }

    this.conformShapeNode({
      shapeSchema,
      shapeNodeName,
      instanceSchema: instanceSchema!,
      instancePosName: eventPos!,
      statement,
      param,
      visited: new Set(),
      path: '',
    });
  }

  private conformShapeNode(input: {
    shapeSchema: InstanceSchema;
    shapeNodeName: string;
    instanceSchema: InstanceSchema;
    instancePosName: string;
    statement: ListenDeclaration;
    param: MovementDeclaration['params'][number];
    visited: Set<string>;
    path: string;
  }): void {
    const visitKey = `${input.shapeNodeName}::${input.instancePosName}`;
    if (input.visited.has(visitKey)) return;
    input.visited.add(visitKey);

    const shapeNode = input.shapeSchema.positions[input.shapeNodeName];
    const instancePos = input.instanceSchema.positions[input.instancePosName];
    if (!shapeNode || !instancePos) return;
    if (surfaceNotEnumerated(instancePos)) return;

    for (const [fieldName, shapeType] of Object.entries(shapeNode.properties)) {
      const sourceType = instancePos.properties[fieldName];
      if (sourceType === undefined) {
        this.report(
          DiagnosticCodes.LISTEN_SHAPE_MISMATCH,
          input.path === ''
            ? `'${input.statement.instance}' has no field \`${fieldName}\` that the declaration '${input.shapeNodeName}' requires — this lane can't fire '${input.statement.movement}'`
            : `'${input.statement.instance}' ${input.path}has no field \`${fieldName}\` that the declaration '${input.shapeNodeName}' requires`,
          input.statement.span,
        );
        continue;
      }
      if (!fieldAssignable(sourceType, shapeType)) {
        this.report(
          DiagnosticCodes.LISTEN_SHAPE_MISMATCH,
          input.path === ''
            ? `'${input.statement.instance}'.\`${fieldName}\` (${describeFieldType(sourceType)}) doesn't fit declared field \`${fieldName}\` (${describeFieldType(shapeType)})`
            : `'${input.statement.instance}' ${input.path}\`${fieldName}\` (${describeFieldType(sourceType)}) doesn't fit declared field \`${fieldName}\` (${describeFieldType(shapeType)})`,
          input.statement.span,
        );
      }
    }

    for (const [edgeName, shapeEdge] of Object.entries(shapeNode.edges)) {
      const instanceEdge = instancePos.edges[edgeName];
      if (!instanceEdge) {
        this.report(
          DiagnosticCodes.LISTEN_SHAPE_MISMATCH,
          input.path === ''
            ? `'${input.statement.instance}' has no relationship '${edgeName}' that the declaration '${input.shapeNodeName}' requires`
            : `'${input.statement.instance}' ${input.path}has no relationship '${edgeName}' that the declaration '${input.shapeNodeName}' requires`,
          input.statement.span,
        );
        continue;
      }
      this.conformShapeNode({
        ...input,
        shapeNodeName: shapeEdge.target,
        instancePosName: instanceEdge.target,
        path: `${input.path}${edgeName} → `,
      });
    }
  }

  // ── Extraction ──

  /** Checks the tree and returns the inferred result graph's root type (check 9). */
  private checkExtract(
    extract: ExtractExpression,
    scope: Scope,
    binding?: string,
  ): PositionTypeRef {
    // Extraction IS the typed model read — the row's `ai`. Its sources are
    // ordinary expressions and raise their own reads.
    this.effects?.flag('ai');
    // The tier reads by the same rule as `AI(prompt, "…")`'s — one vocabulary,
    // one judgement, reported here at the statement that carries it.
    for (const d of aiTierDiagnostics(extract.tier)) {
      if (d.severity === 'info') this.reportInfo(d.code, d.message, extract.span);
      else this.report(d.code, d.message, extract.span);
    }
    for (const slot of extract.from) {
      this.checkExprSlot(slot, scope);
    }
    this.checkExtractStages(extract.stages, scope, new Set());
    const node = buildExtractGraph(EXTRACT_ROOT_NAME, extract.stages, field =>
      this.resolveExtractFieldType(field, scope),
    );
    this.recordNode({
      kind: 'extract',
      span: extract.span,
      scope,
      ...(binding !== undefined ? { binding } : {}),
      node,
    });
    return { kind: 'extract', node };
  }

  /**
   * An extract field's explicit annotation: a primitive type name, or a
   * BORROWED `<instance>.<root>.<field>` path resolved against the named
   * graph's schema (union of its writable-root fields and position
   * properties; writable wins — enums live on the write surface). Borrowing
   * is THE mechanism for typing extraction against another system's field:
   * the checker resolves it from the catalog here, and the engine
   * re-resolves the same path live at every firing — option lists are
   * never copied out. Unknown segments are MOV_BORROW_*; a graph in scope
   * without a schema stays silent (unknown never false-positives).
   */
  private resolveExtractFieldType(field: ExtractField, scope: Scope): FieldType | undefined {
    if (field.type === undefined) return undefined;
    return this.resolveNamedType(field.type, field.span, scope);
  }

  /**
   * An annotation, resolved: a primitive type name, a refinement the program
   * declares, or a BORROWED `<instance>.<root>.<field>` path into another
   * graph's field. One resolver, because they are one surface — an extract
   * field's annotation and `MEMBERS(<…>)`'s argument are the same written
   * thing, and nothing downstream can tell a written option set from a
   * fetched one.
   */
  private resolveNamedType(written: string, span: Span, scope: Scope): FieldType | undefined {
    const segments = borrowedTypeSegments(written);
    if (segments === undefined) {
      const primitive = parseFieldTypeName(written);
      if (primitive !== undefined) return primitive;
      const declared = this.declaredTypeIn(written, scope);
      if (declared !== undefined) return declared;
      // A bare annotation that names neither a primitive nor a declared type
      // constrains nothing, and used to say so to nobody — the typo that
      // silently un-types a field.
      this.report(
        DiagnosticCodes.UNKNOWN_TYPE_NAME,
        `'${written}' is not a type — annotate with a primitive (${PRIMITIVE_TYPE_NAMES.join(', ')}), a type you declare (\`type ${written} = <"A" | "B">\`), or another field's type by path (<crm-[:companies]->.\`funding_stage\`>)${didYouMean(written, typeNamesInScope(scope))}`,
        span,
      );
      return undefined;
    }
    if (segments.length !== 3) {
      this.report(
        DiagnosticCodes.BORROW_MALFORMED,
        `'${written}' is not a borrowable path — a borrowed type names another graph's field: an edge, then the field (e.g. <crm-[:companies]->.\`funding_stage\`>)`,
        span,
      );
      return undefined;
    }
    const [graphName, rootName, fieldName] = segments;
    const resolution = scope.resolve(graphName);
    if (resolution.kind !== 'found') {
      if (resolution.kind === 'unknown') {
        this.report(
          DiagnosticCodes.BORROW_UNKNOWN_GRAPH,
          `Unknown name '${graphName}' in the borrowed type '${written}' — a borrowed type starts at a constructed instance, a declared node, or kg`,
          span,
        );
      } else {
        this.reportResolutionFailure(graphName, span, resolution);
      }
      return undefined;
    }
    const symbol = resolution.symbol;
    if (!isGraphSymbol(symbol)) {
      this.report(
        DiagnosticCodes.BORROW_UNKNOWN_GRAPH,
        `'${graphName}' is ${describeKind[symbol.kind]} — a borrowed type starts at a constructed instance, a declared node, or kg`,
        span,
      );
      return undefined;
    }
    const schema = symbol.schema;
    if (!schema) return undefined; // no schema → every typed check stays silent
    const fields = borrowableFieldsOf(schema, rootName);
    if (!fields) {
      const available = [
        ...new Set([...Object.keys(schema.writableRoots), ...Object.keys(schema.positions)]),
      ];
      this.report(
        DiagnosticCodes.BORROW_UNKNOWN_ROOT,
        `'${graphName}' has no '${rootName}' to borrow from${available.length ? ` — it has: ${available.join(', ')}` : ''}`,
        span,
      );
      return undefined;
    }
    const type = fields[fieldName];
    if (type === undefined) {
      const available = Object.keys(fields);
      this.report(
        DiagnosticCodes.BORROW_UNKNOWN_FIELD,
        `'${graphName}.${rootName}' has no field '${fieldName}'${available.length ? ` — it has: ${available.join(', ')}` : ''}`,
        span,
      );
      return undefined;
    }
    return type;
  }

  /**
   * A declared node's fields take the same explicit types extract annotations
   * do: primitive names or BORROWED dotted paths into another graph's field
   * (`crm_stage: crm.companies.funding_stage`). `shapeToSchema` degraded
   * dotted names to text at hoist time (the borrow's graph may not be
   * bound yet); here — at the declaration's source position — each borrow
   * resolves through the same path logic, reports the same MOV_BORROW_*
   * diagnostics, and patches the schema in place.
   */
  private resolveShapeBorrows(
    node: ShapeNode,
    key: string,
    schema: InstanceSchema,
    scope: Scope,
  ): void {
    for (const field of node.fields) {
      if (borrowedTypeSegments(field.type) === undefined) continue;
      const resolved = this.resolveExtractFieldType(
        { name: field.name, type: field.type, description: '', span: field.span },
        scope,
      );
      if (resolved !== undefined) {
        const properties = schema.positions[key]?.properties;
        if (properties) properties[field.name] = resolved;
      }
    }
    for (const child of node.children) {
      this.resolveShapeBorrows(child, `${key}.${child.name}`, schema, scope);
    }
  }

  /**
   * `through` arguments may reference inherited context (ancestor nodes'
   * fields along the path) plus the node's PRIOR stages' fields; a stage's
   * own or later fields are a forward reference — the pipeline runs before
   * they are extracted. Children declared in a stage inherit fields up to
   * and including that stage.
   */
  private checkExtractStages(stages: ExtractStage[], scope: Scope, inherited: Set<string>): void {
    const stageFields = stages.map(stage => stage.fields.map(f => f.name));
    const prior = new Set(inherited);
    for (let k = 0; k < stages.length; k++) {
      const stage = stages[k];
      const ownOrLater = new Set(stageFields.slice(k).flat());
      for (const plugin of stage.through ?? []) {
        this.checkPluginCall(plugin, scope, { prior: new Set(prior), ownOrLater });
      }
      for (const name of stageFields[k]) prior.add(name);
      for (const child of stage.children) {
        this.checkExtractStages(child.stages, scope, new Set(prior));
      }
    }
  }

  private checkPluginCall(plugin: PluginCall, scope: Scope, fields: ThroughFieldsContext): void {
    const resolution = scope.resolve(plugin.plugin);
    let spec;
    if (resolution.kind !== 'found') {
      this.reportResolutionFailure(plugin.plugin, plugin.span, resolution);
    } else if (resolution.symbol.kind !== 'plugin') {
      this.report(
        DiagnosticCodes.THROUGH_NOT_PLUGIN,
        `'${plugin.plugin}' is ${describeKind[resolution.symbol.kind]}, not a plugin — 'through […]' takes imported plugins`,
        plugin.span,
      );
    } else {
      spec = this.catalog.plugin(resolution.symbol.importedName ?? plugin.plugin);
    }
    // A stage is plain function application — the same call, in the position
    // that feeds the extraction. So it folds the same row.
    this.absorbPluginRow(spec);
    const supplied = new Set(plugin.args.map(arg => arg.name));
    this.reportPluginMissingArgs(plugin.plugin, spec, supplied, plugin.span);
    for (const arg of plugin.args) {
      this.reportPluginBadArg(plugin.plugin, spec, arg.name, arg.value.span);
      this.checkExprSlot(arg.value, scope, { fields });
    }
  }

  /**
   * Calling a plugin adds what the plugin does — the declared row folded in
   * exactly as an inferred one is. Nobody having declared leaves the row a
   * LOWER BOUND: a stage runs, and what it reached is not a claim this checker
   * can make.
   */
  private absorbPluginRow(spec: PluginSpec | undefined): void {
    if (spec?.effects === undefined) this.effects?.markPartial();
    else this.effects?.absorb(rowFromDeclaration(spec.effects));
  }

  /** An argument the plugin's registry entry doesn't list. One fact, one code,
   *  whether it was written in a stage or at an ordinary call. */
  private reportPluginBadArg(
    name: string,
    spec: PluginSpec | undefined,
    arg: string,
    span: Span,
  ): void {
    if (spec === undefined || spec.args.includes(arg)) return;
    this.report(
      DiagnosticCodes.THROUGH_BAD_ARG,
      `'${name}' does not accept an argument '${arg}'${spec.args.length ? ` — it accepts: ${spec.args.join(', ')}` : ''}`,
      span,
    );
  }

  /**
   * A `spec.requiredArgs` entry the call never supplies. One fact, one code,
   * whether it was written in a stage or at an ordinary call — the missing-arg
   * sibling of `reportPluginBadArg`.
   *
   * Only OMISSION is checked here. A supplied argument whose value resolves
   * absent at run time is a different, legal case — the engine's
   * skip-on-absent sentinel is the honest cover for that (a source field that
   * came back empty), and this diagnostic must never re-litigate it.
   */
  private reportPluginMissingArgs(
    name: string,
    spec: PluginSpec | undefined,
    supplied: Set<string>,
    span: Span,
  ): void {
    const missing = (spec?.requiredArgs ?? []).filter(arg => !supplied.has(arg));
    if (missing.length === 0) return;
    this.report(
      DiagnosticCodes.THROUGH_ARG_MISSING,
      `'${name}' is missing ${missing.length === 1 ? 'the required argument' : 'required arguments'} ${missing.map(a => `'${a}'`).join(', ')}`,
      span,
    );
  }

  /**
   * `vc_url_retrieval(email: @user_email)` written as an ordinary call — the
   * one-function-sort ruling, where a plugin is a function whose body isn't
   * visible and whose DECLARED row says what calling it does.
   *
   * Where it may be called is decided by that row, not by a syntactic slot: a
   * declared row folds into the caller and the call is legal anywhere a call
   * is. An UNDECLARED row keeps today's legality exactly — a `through [ … ]`
   * stage and nowhere else — because a call nobody can describe would silently
   * widen what the movement does.
   */
  private checkPluginApplication(statement: CallStatement, symbol: ScopeSymbol): ReturnShape {
    const spec = this.catalog.plugin(symbol.importedName ?? statement.callee);
    this.absorbPluginRow(spec);
    if (spec !== undefined && spec.effects === undefined) {
      this.report(
        DiagnosticCodes.PLUGIN_ROW_UNDECLARED,
        `'${statement.callee}' is a plugin that hasn't declared what it does, so it can only run as an extraction stage — write it in a 'through [ … ]' (\`extract from [ … ] through [${statement.callee}] { … }\`).`,
        statement.span,
      );
    } else if (spec?.fedByExtraction === true) {
      this.report(
        DiagnosticCodes.PLUGIN_FED_BY_EXTRACTION,
        `'${statement.callee}' runs on what an extraction gives it, so it only makes sense as a stage of one — write it in a 'through [ … ]' (\`extract from [ … ] through [${statement.callee}] { … }\`).`,
        statement.span,
      );
    }
    const supplied = new Set(statement.args.map(arg => arg.name));
    this.reportPluginMissingArgs(statement.callee, spec, supplied, statement.span);
    for (const arg of statement.args) {
      this.reportPluginBadArg(statement.callee, spec, arg.name, callArgSpan(arg));
    }
    // Nothing describes a plugin's OUTPUT — the registry declares what it adds
    // to an extraction, not a value. So the call's value is unknown, which is
    // true and refuses nothing: binding one is silent rather than
    // MOV_CALL_RETURNS_NOTHING, which would be a claim.
    return UNKNOWN_RETURN;
  }

  // ── Expression slots ──

  /**
   * Name-resolves and (where rootable) type-checks an expression slot.
   * Returns the slot's shallow value type when inferable — write-field
   * compatibility (check 2) consumes it.
   */
  private checkExprSlot(
    slot: ExprSlot,
    scope: Scope,
    options?: SlotOptions,
  ): { valueType?: FieldType; parsed?: Expression } {
    const trimmed = slot.raw.trim();
    if (BARE_IDENT.test(trimmed)) {
      if (EXPR_LITERALS.has(trimmed.toUpperCase())) return {};
      this.resolveNameWithFields(trimmed, slot.span, scope, options?.fields);
      // A bare name short-circuits the parse, but it still HAS a value type —
      // the binding's own. Without this its absence would die here, at the very
      // sites (a plain write field) that require presence.
      const valueType = this.symbolScalarType(scope, trimmed);
      return valueType !== undefined ? { valueType } : {};
    }
    let parsed: Expression;
    try {
      parsed = parseMovementExpression(slot.raw);
    } catch (e) {
      if (!(e instanceof BridgeError)) throw e;
      this.report(DiagnosticCodes.EXPR_PARSE, e.message, spanWithin(slot, e.pos));
      return {};
    }
    const names = collectExpressionNames(parsed);
    for (const ref of new Set(names.refs)) {
      if (names.aliases.has(ref)) continue; // bound by a step within this expression
      this.resolveNameWithFields(ref, slot.span, scope, options?.fields);
    }
    this.reportBlockReadBack(names, scope, slot.span);
    const valueType = this.slotTyping(scope, slot.span).infer(parsed, options?.writeTarget);
    return { parsed, ...(valueType !== undefined ? { valueType } : {}) };
  }

  /**
   * The RETIRED block read-back: `orgs.name`, `orgs-[o:co]->` — reaching into
   * the block that `orgs` was bound to for a name bound INSIDE it. Naming is
   * not exporting any more, so the name never left; the block hands one value
   * back with `return`.
   *
   * Diagnosed off the fact the checker already records: closing a block writes
   * each of its bindings into the enclosing scope's `escaped` map, against the
   * name the block was bound to. Nothing is marked for this — the read is
   * matched against what actually escaped.
   */
  private reportBlockReadBack(names: CollectedNames, scope: Scope, span: Span): void {
    for (const { root, members } of names.rooted) {
      for (const member of members) {
        if (!escapedFromBlock(scope, member, root)) continue;
        this.report(
          DiagnosticCodes.BLOCK_READ_BACK_RETIRED,
          `'${member}' is bound INSIDE the block '${root}' came from, and a block's bindings do not escape it — return the value from the block instead: '${root} = … { … return ${member} }'`,
          span,
        );
        return;
      }
    }
  }

  /** `narrowInto`: the scope IS-test narrowings are declared into (the if-arm's scope). */
  private checkConditionSlot(slot: ExprSlot, scope: Scope, narrowInto?: Scope): void {
    let condition: MovementCondition;
    try {
      condition = parseMovementCondition(slot.raw);
    } catch (e) {
      if (!(e instanceof BridgeError)) throw e;
      this.report(DiagnosticCodes.EXPR_PARSE, e.message, spanWithin(slot, e.pos));
      return;
    }
    this.checkCondition(condition, slot, scope, narrowInto);
  }

  private checkCondition(
    condition: MovementCondition,
    slot: ExprSlot,
    scope: Scope,
    narrowInto: Scope | undefined,
  ): void {
    switch (condition.kind) {
      case 'and':
        // In order, so an IS conjunct narrows the conjuncts after it.
        condition.conjuncts.forEach(c => this.checkCondition(c, slot, scope, narrowInto));
        return;
      case 'isTest': {
        const subject = condition.subjectRaw.trim();
        let subjectSymbol: ScopeSymbol | undefined;
        if (BARE_IDENT.test(subject)) {
          subjectSymbol = this.resolveName(subject, slot.span, scope);
        } else {
          this.checkExprSlot({ raw: condition.subjectRaw, span: slot.span }, scope);
        }
        const graphSymbol = this.resolveName(condition.type.graph, slot.span, scope);
        // A DECLARED NODE is a structure, not a graph, so the test it names is
        // a different question — asked and answered on its own.
        if (graphSymbol?.kind === 'shape') {
          this.checkDeclaredNodeTest(condition, graphSymbol, subjectSymbol, slot.span, narrowInto);
          return;
        }
        // An IS test naming a position the graph's known schema lacks can
        // never be true — same strictness as a parameter's TypeRef.
        if (graphSymbol && condition.type.position !== undefined) {
          const instance = isGraphSymbol(graphSymbol) ? instanceRefOf(graphSymbol) : undefined;
          if (instance && positionRefIn(instance, condition.type.position) === undefined) {
            this.reportUnknownPosition(
              graphSymbol,
              condition.type.graph,
              condition.type.position,
              slot.span,
            );
          }
        }
        // Narrowing (check 6): a positive IS test on a union-typed position
        // narrows it to the named variant inside the arm.
        if (
          narrowInto
          && subjectSymbol?.posType?.kind === 'union'
          && graphSymbol
          && condition.type.position !== undefined
        ) {
          const union = subjectSymbol.posType;
          if (
            union.instance.token === graphSymbol
            && union.variants.includes(condition.type.position)
          ) {
            narrowInto.declare({
              ...subjectSymbol,
              posType: {
                kind: 'position',
                instance: union.instance,
                position: condition.type.position,
              },
            });
          }
        }
        // An ADDRESS test — `e IS <at-[:`Record Change` WHERE `action` ==
        // "record.deleted"]->>`. A type guard is an INTERSECTION: the narrowed
        // type is the subject's own address extended by the test's pins (TS's
        // `A & B`), so the test never has to restate what the signature
        // already pinned. Its typos die at the pins (`checkAddressPins`); an
        // address that resolves to no grafted position narrows nothing —
        // `never` errors at the USE, not at the narrow.
        if (condition.type.hopsRaw !== undefined && graphSymbol) {
          const instance = isGraphSymbol(graphSymbol) ? instanceRefOf(graphSymbol) : undefined;
          const testAddress = addressOfTypeRef(condition.type.hopsRaw);
          if (instance !== undefined && testAddress !== undefined) {
            this.checkAddressPins(instance, testAddress, slot.span);
            const subject = subjectSymbol !== undefined ? subjectSymbol.posType : undefined;
            if (
              narrowInto
              && subjectSymbol !== undefined
              && subject !== undefined
              && (subject.kind === 'position' || subject.kind === 'union')
              && subject.instance.token === instance.token
            ) {
              const subjectAddress: EventAddress = subject.address ?? {
                event: subject.kind === 'position' ? subject.position : subject.union,
                narrowing: {},
              };
              if (subjectAddress.event === testAddress.event) {
                const merged: Record<string, string> = { ...subjectAddress.narrowing };
                let consistent = true;
                for (const [key, value] of Object.entries(testAddress.narrowing)) {
                  if (merged[key] !== undefined && merged[key] !== value) {
                    consistent = false; // pins two values — `never`; runtime is falsy
                    break;
                  }
                  merged[key] = value;
                }
                if (consistent) {
                  const mergedAddress: EventAddress = {
                    event: testAddress.event,
                    narrowing: merged,
                  };
                  const resolved = positionRefIn(
                    subject.instance,
                    eventAddressKey(mergedAddress),
                  );
                  if (resolved?.kind === 'position' || resolved?.kind === 'union') {
                    narrowInto.declare({
                      ...subjectSymbol,
                      posType: {
                        ...resolved,
                        address: mergedAddress,
                        ...(Object.keys(merged).length > 0
                          ? { narrowsEvent: mergedAddress.event }
                          : {}),
                      },
                    });
                  }
                }
              }
            }
          }
        }
        return;
      }
      case 'expr': {
        const names = collectExpressionNames(condition.expr);
        for (const ref of new Set(names.refs)) {
          if (names.aliases.has(ref)) continue;
          this.resolveName(ref, slot.span, scope);
        }
        const type = this.slotTyping(scope, slot.span).infer(condition.expr);
        // Gating on a STRUCTURED value is always-true, never a decision — the
        // one shape whose truthiness carries no information. Every other type
        // is left to its own truthiness, as before.
        const opaque = checkJsonOpaque(type, 'used as a condition');
        if (opaque !== null) this.report(opaque.code, opaque.message, slot.span);
        // Narrowing (layer 6): an `==` against a present value proves its
        // subject present inside the arm — the comparison joins `?:` fill and
        // traversal-as-gate as a guard form. Runs AFTER the walk above so the
        // condition itself is typed unnarrowed.
        if (narrowInto) this.narrowPresence(condition.expr, scope, narrowInto, slot.span);
        return;
      }
    }
  }

  /**
   * `rec IS <Doc>` — a STRUCTURAL test. The other `IS` forms ask "is this
   * position THAT one", by name or by address; a declared node names no
   * position at all, so the question is the one the language already answers
   * when a node literal reaches a `<Doc>` parameter: does what this position
   * OFFERS carry everything `Doc` declares? Same comparator, asked as a
   * predicate — which is why the test is decidable from the schema and needs no
   * data read.
   *
   * It follows that a single-typed subject is decided at CHECK time (its
   * structure is fully known, so the answer cannot vary per record) and there
   * is nothing to narrow: the arm's type is the type it already had. A UNION
   * subject is where the test does work — some members conform and some do not,
   * so the arm keeps the conforming ones and the `else` (via
   * `collectIsElimination`) keeps the rest, which is the record plane's
   * machinery verbatim with the comparator standing in for the name match.
   *
   */
  private checkDeclaredNodeTest(
    condition: Extract<MovementCondition, { kind: 'isTest' }>,
    declaration: ScopeSymbol,
    subjectSymbol: ScopeSymbol | undefined,
    span: Span,
    narrowInto: Scope | undefined,
  ): void {
    // The retired meta-node hop, said in the predicate's own vocabulary.
    if (condition.type.position !== undefined || condition.type.hopsRaw !== undefined) {
      const subject = condition.subjectRaw.trim();
      this.report(
        DiagnosticCodes.SHAPE_HOP_RETIRED,
        `'${condition.type.graph}' is a declared node — it IS the record it describes, so there is nothing to hop through: write '${subject} IS <${quoteName(condition.type.graph)}>'. Its nested nodes are edges you traverse off the value instead ('${subject}-[x:${quoteName(condition.type.position ?? 'name')}]->')`,
        span,
      );
      return;
    }
    if (narrowInto === undefined || subjectSymbol === undefined) return;
    const subject = positionTypeOf(subjectSymbol);
    if (subject?.kind !== 'union') return;
    const conforming = subject.variants.filter(
      variant => conformsToDeclaredNode(subject.instance, variant, declaration) !== false,
    );
    if (conforming.length === subject.variants.length) return; // proves nothing new
    narrowInto.declare({ ...subjectSymbol, posType: residualUnion(subject, conforming) });
  }

  /**
   * Declares the presence narrowings a true condition earns into the arm's
   * scope. `presenceProofs` owns which comparisons prove what; this side owns
   * only the scope mechanics — resolve the proven root, discharge that field's
   * absence on its position type, shadow the symbol with the narrowed one (the
   * same move an IS test makes).
   */
  private narrowPresence(
    expr: Expression,
    scope: Scope,
    narrowInto: Scope,
    span: Span,
  ): void {
    const typing = this.silentTyping(scope, span);
    this.declarePresence(presenceProofs(expr, operand => typing.infer(operand)), scope, narrowInto);
  }

  /**
   * The narrowings a condition's FALSITY earns, declared into `narrowInto` —
   * the guard clause `if x == null { ERROR(…) }`, whose continuation knows `x`
   * is present. Same mechanics as the positive side; only the proof set differs.
   */
  private narrowNegatedPresence(
    expr: Expression,
    scope: Scope,
    narrowInto: Scope,
    span: Span,
    options: { visibleFrom: Loc },
  ): void {
    const typing = this.silentTyping(scope, span);
    this.declarePresence(
      negativePresenceProofs(expr, operand => typing.infer(operand)),
      scope,
      narrowInto,
      options,
    );
  }

  /** Shadow each proven name with its narrowed self — the same scope move an
   *  `IS` test makes. The two planes discharge differently because they carry
   *  the absence differently, and a proof that discharges nothing declares
   *  nothing (so "unnarrowed" never collapses into "narrowed to nothing").
   *  `visibleFrom` bounds a narrowing declared into a scope the shadowed
   *  binding OUTLIVES (the guard clause's continuation); narrowing into an
   *  arm's own scope needs none — the arm's extent already bounds it. */
  private declarePresence(
    proofs: PresenceProof[],
    scope: Scope,
    narrowInto: Scope,
    options: { visibleFrom?: Loc } = {},
  ): void {
    for (const proof of proofs) {
      const resolution = scope.resolve(proof.root);
      if (resolution.kind !== 'found') continue;
      const symbol = resolution.symbol;
      if (proof.kind === 'field') {
        const posType = this.symbolPositionType(symbol);
        if (posType === undefined) continue;
        const narrowed = narrowPresent(posType, proof.propertyId);
        if (narrowed !== undefined) narrowInto.declare({ ...symbol, posType: narrowed }, options);
        continue;
      }
      if (symbol.bindingPlane === 'scalar') {
        if (symbol.fieldType === undefined || !isMaybeAbsent(symbol.fieldType)) continue;
        narrowInto.declare({ ...symbol, fieldType: stripAbsent(symbol.fieldType) }, options);
        continue;
      }
      const posType = this.symbolPositionType(symbol);
      if (posType === undefined) continue;
      const narrowed = narrowPresentNode(posType);
      if (narrowed !== undefined) narrowInto.declare({ ...symbol, posType: narrowed }, options);
    }
  }

  // ── Name resolution & failure reporting ──

  private resolveNameWithFields(
    name: string,
    span: Span,
    scope: Scope,
    fields: ThroughFieldsContext | undefined,
  ): void {
    if (fields) {
      if (fields.prior.has(name)) return;
      if (fields.ownOrLater.has(name)) {
        this.report(
          DiagnosticCodes.THROUGH_FORWARD_REF,
          `'${name}' is extracted by this stage (or a later one) — a 'through' pipeline runs before its stage, so it can only read fields from the node's earlier stages`,
          span,
        );
        return;
      }
    }
    this.resolveName(name, span, scope);
  }

  private resolveName(name: string, span: Span, scope: Scope): ScopeSymbol | undefined {
    const resolution = scope.resolve(name);
    if (resolution.kind === 'found') return resolution.symbol;
    this.reportResolutionFailure(name, span, resolution);
    return undefined;
  }

  private reportResolutionFailure(
    name: string,
    span: Span,
    resolution: Exclude<ReturnType<Scope['resolve']>, { kind: 'found' }>,
  ): void {
    switch (resolution.kind) {
      case 'pending':
        this.report(
          DiagnosticCodes.USE_BEFORE_BIND,
          `'${name}' is read before its binding statement — statements run in source order, so move this after the statement that binds '${name}'`,
          span,
        );
        return;
      case 'escaped': {
        // The ONE way a value leaves a block is `return`, so the hint is that
        // rewrite — not a reach back into the block, which no longer exists.
        const hint =
          resolution.blockName !== undefined
            ? ` — return it from the block instead ('${resolution.blockName} = … { … return ${name} }')`
            : " — return it from the block and bind the block ('names = … { … return " + name + " }')";
        this.report(
          DiagnosticCodes.NAME_UNRESOLVED,
          `'${name}' is not in scope — it was bound inside a traversal block, and a block's bindings do not escape it${hint}`,
          span,
        );
        return;
      }
      case 'unknown': {
        // The name IS a system we know — it was just never brought into
        // scope. Two lines short of working, so the message is both of them.
        // (This is the whole migration story for the graph, which stopped
        // being ambient: `kg` resolves here like any other adapter now.)
        if (this.catalog.adapter(name) !== undefined) {
          this.report(
            DiagnosticCodes.NAME_UNRESOLVED,
            `'${name}' is not in scope — import it and construct an instance first: `
              + `import { ${name} } from adapters, then '<name> = ${this.constructionCall(name)}'`,
            span,
          );
          return;
        }
        this.report(
          DiagnosticCodes.NAME_UNRESOLVED,
          `Unknown name '${name}' — every name must be imported, bound by '=', a movement parameter, or a traversal alias in scope`,
          span,
        );
        return;
      }
    }
  }
}

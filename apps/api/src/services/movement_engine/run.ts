// The movement engine (E1) — direct execution of the checked movement
// AST, no TG lowering. An interpreter walks the movement body in program
// order with an Environment of bindings → runtime values; the TG
// data-model (action trees, sibling roots, action_result nodes) never
// appears in the path.
//
// The engine is new; the platform isn't. Reused substrate:
//   - the adapter layer wholesale, resolved through the SAME
//     `resolveAdapter` seam `evaluateTranslationGraph` / provision use
//     (so simulate / tests inject fakes identically);
//   - the dry-run wrapper (`engine/dry_run_adapter.ts`) — CapturedWrite
//     output is the same currency as M4b/M5 dry runs;
//   - the entity-resolution split: the adapter returns a candidate
//     shortlist, the shared arbitration module
//     (`engine/entity_match.ts:arbitrateEntityCandidates`, extracted
//     from `applyActionPlan` for exactly this reuse) decides
//     create-vs-update;
//   - the trigger seed: the event position mirrors the TG engine's
//     `seedRootSourcePosition` webhook branch, so source-property reads
//     hit the adapter with an identical position.
//
// E1 statement subset: assignment (construction / write / expression),
// unbound writes, instance-target writes with `unique by`, `if` with
// expression conditions. E2 adds extraction (`extract … { }` planned +
// materialised by `./extraction.ts`) and traversal-headed blocks (per-
// emission iteration over extract edges and `#resources`, meta-node
// accumulation). E3 makes the knowledge graph an ordinary write target
// (the KG adapter resolves through the same seam — see `./kg.ts`), adds
// linked writes (`write h-[:edge]-> { … }` — create the record AND the
// connecting edge in one effect, written type inferred from the parent's
// graph schema) with edge-scoped compound identity (`unique by (h,
// `field`)` folds the parent's record into the resolve as the edge-scoped
// neighbour). E4 makes
// provenance the value model: every evaluation is `(value, provenance)`
// (see ./provenance.ts), writes translate faithful trails into
// `WriteInput.evidence` (the KG adapter persists them as its native
// evidence rows — closing the E3 parity gap with the TG path), and
// every write's per-field trails land summarised on
// `MovementRunResult.writes` for trigger_run recording. E5 adds
// composition (§G): same-file movement calls with lexical callee
// environments (a fresh child of FILE scope — caller locals invisible
// by construction), argument adaptation via in-memory shape writes
// (shapes are configuration-free graphs — no adapter, no firing-record
// write; the position carries its fields' trails), AI() through the
// LlmClient seam (see ./expression.ts), and runtime IS tests against
// the runtime position's type where the engine knows it. E6 adds the
// source-graph traversal slice: meta-rooted movements (`movement
// backfill(root: crm)` under a `snapshot` event seed the adapter's meta
// position — the manual_run.ts backfill shape), traversal-headed blocks
// over ADAPTER edges (`root-[c:companies]-> { … }` streams positions
// through the source adapter's iterateRelated/getRelated — the same
// seam the TG engine's snapshot fan-out walks; event schema-edge heads
// ride it too), per-hop WHERE filters evaluated position-scoped, and
// runtime EXISTS() (see ./expression.ts). Writes inside an adapter-edge
// iteration stand on the iterated record, so KG creates bridge to it
// exactly as the TG engine's collection fan-out does. E7 lifts standalone
// edge statements (`edge a -[:e]-> b`, §B "the rare case"): both names
// must be write handles in the SAME graph, the edge resolves against the
// from-side's type, and the assert goes through the new optional
// `Adapter.linkRecords` seam (KG: edge-only insert mirroring parentLink;
// Attio: reference-field set/append) — adapters without the capability
// are rejected by name. E8 lifts file imports (movement libraries, §H):
// `RunMovementInput.resolveFile` is the one injection point — resolution
// lives in movement-lang (`checkProgramWithLink` validates and returns
// the link), imported movements execute against their library's OWN file
// environment (built once per path), imported shapes bind as
// declarations. Everything still outside the slice (kg-seeded movements)
// raises a clean MOVENG_UNSUPPORTED naming the construct.

import {
  BridgeError,
  DiagnosticCodes,
  MovementParseError,
  checkProgramWithLink,
  credentialArgOf,
  aggregatedBarePath,
  bareName,
  spellPathHead,
  EVENT_ACTION_FIELD,
  eventAddressKey,
  eventAddressOfHops,
  parseMovementCondition,
  parseMovementExpression,
  parseProgram,
  resolveBorrowedField,
  borrowedTypeSegments,
  splitUniquenessConjuncts,
  durationToMs,
  unwrapCredentialArg,
  CALLBACK_CALLED_EDGE,
  CALLBACK_CALL_AT,
  constructionAsCall,
  schemaSurface,
  declaredTypesIn,
  shapeToSchema,
  surfaceMisfit,
} from 'movement-lang';
import type {
  AwaitExpression,
  AwaitSource,
  ClosureExpression,
  DurationLiteral,
  RValue,
  RefreshStatement,
  CombinatorExpression,
  CollectionOpExpression,
  MembersExpression,
  ArmExpression,
  CallArg,
  Catalog,
  ConstructionCall,
  ExprSlot,
  CallbackExpression,
  CallbackSubject,
  ExtractExpression,
  FieldType,
  InstanceSchema,
  LinkExpression,
  LinkedExport,
  LinkedFile,
  EventAddress,
  MovementCondition,
  MovementDeclaration,
  NodeLiteral,
  PathHead,
  Program,
  ProgramLink,
  ResolveFile,
  Statement,
  TraversalBlock,
  WriteExpression,
  FieldWriteMode,
  SuppliedSurface,
} from 'movement-lang';
import type { Expression } from '#shared/expression/types';
import {
  evaluatePredicate,
  isPurePredicate,
  leafReadKey,
  pureLeafReads,
} from '#shared/expression/filter';
import type { TeamId } from '../../generated/kysely/core/Team';
import type { LinkedObject } from '../../generated/kysely/knowledge/LinkedObject';
import type {
  Adapter,
  FieldEvidence,
  FileRef,
  ParentLink,
  Resource,
  WriteInput,
  WriteResult,
} from '../translation_graph/adapter';
import { updateRecordSucceeded } from '../translation_graph/adapter';
import { resolveAdapter as resolveAdapterDefault } from '../translation_graph/adapters/resolve';
import {
  recordBinding,
  findBoundCounterpart,
  deleteBinding,
  type BindingEndpoint,
} from './record_binding';
import {
  wrapAdapterForDryRun,
  type DryRunWriteSink,
} from '../translation_graph/engine/dry_run_adapter';
import { arbitrateEntityCandidates } from '../translation_graph/engine/entity_match';
import { applicableRequiredFields } from '../translation_graph/required_fields';
import type { MutationContext } from '../translation_graph/mutation_context';
import type { TriggerEvent } from '../translation_graph/triggers/types';
import {
  META_RECORD_TYPE,
  makeMetaPosition,
  makeStablePosition,
  makeUnstablePosition,
  positionData,
  positionRecordId,
  type SchemaFieldDescriptor,
  type SourcePosition,
} from '../translation_graph/types';
import { mergeUniqueness, type UniquenessConstraints } from '../translation_graph/uniqueness';
import type { LlmClient } from '../translation_graph/engine/batched_extraction';
import {
  matchesResourceFilter,
  resolvePositionResources,
} from '../translation_graph/engine/files/resources';
import {
  Environment,
  MovementEngineError,
  applyHopOrderLimit,
  closedHopPushdown,
  describeBinding,
  evalMovementExpr,
  evaluateMovementExpression,
  hopOrderKeyReader,
  nodeEdgeLandings,
  unsupported,
  type Binding,
  type DeferredWalk,
  type NodeEdge,
  type HandleGraph,
  type MovementEvalResult,
  type MovementExprContext,
  type MovementMetaContext,
  type MovementTraceEntry,
  type SourceRead,
  type TracedEntity,
  type WriteRecord,
} from './expression';
import {
  NO_PROVENANCE,
  ProvenanceSummariser,
  transformed,
  fieldEvidenceFromProvenance,
  unionProvenance,
  type ExtractSiteSummary,
  type Provenance,
  type SummarisedOrigin,
} from './provenance';
import { surfaceReadAdapter } from './kg';
import {
  buildExtractSpec,
  makeAnthropicLlmClient,
  materializeExtract,
  registryTransformInvoker,
  type ExtractEmission,
  type FileTextResult,
  type MovementTransformInvoker,
} from './extraction';
import { RunCancelledSignal } from './cancel_gate';
import { getErrorMessage } from '../../lib/utils/error';
import { logger } from '../logger';
import { emitOpsEvent } from '../../lib/ops/emit';
import { OpsEventType, OpsSeverity } from '../../lib/ops/types';
import { makeFileTextResolver } from './file_text';
import {
  ROOT_ADDRESS,
  childBranch,
  childIter,
  childStmt,
  encodeAddress,
  parseAddress,
  type Address,
  type AddressStep,
} from './address';
import {
  rehydrateBinding,
  serializeBinding,
  serializeScopeChain,
  type BindingDescriptor,
  type FileRefDescriptor,
  type InstanceIdentityDescriptor,
  type ParkedScopeState,
  type RehydrationContext,
} from './serialize';
import type { CallbackSink } from './callback_sink';
import type { CallbackCall, CallbackParamSpec } from './callback_store';
import { isCallbackParamType } from './callback_store';

/** The in-memory graph a `Called` landing belongs to. A callback belongs to no
 *  SYSTEM, so this names the construct, never an adapter — it is what an `IS`
 *  test would compare against, and it is derived in one place. */
const CALLBACK_LANDING_SHAPE = 'callback';
// ── Public surface ──────────────────────────────────────────────────────────

export interface RunMovementInput {
  /** The movement program text (`.mvt` source). */
  source: string;
  /** Which movement to run; optional when the program declares exactly one. */
  movementName?: string;
  /** The triggering event — the movement parameter's position. */
  event: TriggerEvent;
  teamId: TeamId;
  /**
   * When this run FIRED — the instant every clock read in it answers from
   * (`@current_date`, `@current_timestamp`, `DATE.TODAY(zone)`). The host
   * passes the run row's `started_at`, which a resume reads back unchanged, so
   * a run that parks for a day still computes the window it started with.
   *
   * Absent ⇒ the interpreter pins `new Date()` once at construction: still one
   * instant for the whole run, just not one that survives a park. Every path
   * that can park supplies it.
   */
  firedAt?: Date;
  /** The checker's catalog (adapters / credentials / instance schemas). */
  catalog: Catalog;
  /**
   * Adapter resolution — the SAME seam `evaluateTranslationGraph` and
   * provision use. Defaults to the production resolver; simulate / tests
   * inject fakes per adapterType + role.
   */
  resolveAdapter?: (input: {
    adapterType: string;
    teamId: TeamId;
    credentialsId?: string;
    /** Non-credential construction args (unquoted) — the instance's entry
     *  position (Sheets' `spreadsheet:`). Position-free adapters ignore it. */
    constructionArgs?: Record<string, string>;
    role: 'source' | 'target';
  }) => Adapter | Promise<Adapter>;
  /** Imported credential name → `external_service_credentials.id` (the
   *  team catalog's `resolveCredentialId`). Absent → no credentialsId. */
  resolveCredentialId?: (credentialName: string) => string | undefined;
  /** Wrap every target adapter so writes are captured, not performed. */
  dryRun?: boolean;
  /** Receives each would-be write under `dryRun` — same `CapturedWrite`
   *  currency as the TG engine's dry runs. */
  writeSink?: DryRunWriteSink;
  /**
   * The extraction module's LLM client — the SAME pluggable interface
   * the TG batched-extraction pipeline takes. Defaults to the
   * anthropic-backed production client; tests inject a deterministic
   * stub.
   */
  llm?: LlmClient;
  /** `through` plugin dispatch. Defaults to the TG transform registry;
   *  tests inject a deterministic stub. */
  transformInvoker?: MovementTransformInvoker;
  /**
   * Source `FileRef` → extracted TEXT (the knowledge-pipeline parity path,
   * §3a). Defaults to the production resolver (owner-adapter byte fetch →
   * OCR/text → RawText); tests inject a deterministic stub mocking the
   * resolve + OCR boundary. */
  resolveFileText?: (ref: FileRef) => Promise<FileTextResult | null>;
  /**
   * File-import resolution (movement libraries, §H) — the ONE seam the
   * engine takes for imports. Resolution itself lives in movement-lang
   * (`linkImports`, the same structure `checkProgramWithLink` validates):
   * the engine consumes the already-resolved link — imported movements
   * execute against their library's own file environment, imported
   * shapes bind as declarations. Absent → file imports raise
   * MOVENG_UNSUPPORTED (the pre-library behavior). apps/api passes the
   * team catalog's storage-backed resolver
   * (`movementCatalogForTeam(...).resolveFile`).
   */
  resolveFile?: ResolveFile;
  /**
   * The durable-park sink. The interpreter hands this a park's details — the
   * lexical address + serialized scope — for a cost / timer / await park; the
   * sink persists the `parked_run` row and flips the run to `parked`
   * (§5.2/§5.5). Absent ⇒ a run that reaches a park raises MOVENG_UNSUPPORTED
   * (no durable substrate — e.g. a dry run / test harness with no recorder).
   */
  parkSink?: ParkSink;
  /**
   * The callback seam (callback-primitive layer 2): minting a `callback(…)`,
   * reading its call ledger, and correlating an `await cb-[:Called]->` park.
   * Absent ⇒ a movement that mints a callback raises MOVENG_UNSUPPORTED (no
   * durable substrate — a dry run / test harness with no recorder).
   */
  callbackSink?: CallbackSink;
  /**
   * The cooperative cancel gate (runs-and-cancel spec §cancel). Consulted at each
   * statement boundary (debounced DB read) and at each LLM-call boundary (sync
   * cached value): a user-requested cancel throws `RunCancelledSignal`, caught at
   * the top of `run()`/`resume()` so the run settles `failed` (never mid-write).
   * Absent ⇒ the run is never cancel-gated.
   */
  cancelGate?: CancelGate;
  /**
   * The array the run appends its decision trace to. Supplied by a caller that
   * wants to READ the trace while the run is still going — the run holds it by
   * reference, so a flusher watching the same array sees each entry as it
   * lands. Absent ⇒ the run keeps its own, and the trace is visible only on the
   * result.
   */
  trace?: MovementTraceEntry[];
}

/**
 * The durable-park seam — injected so the pure interpreter never touches the
 * DB directly (mirrors `resolveAdapter`/`writeSink`). The recorder-backed
 * production sink lives in `runMovementFiring`.
 */
export interface ParkSink {
  /**
   * Record (or top up) a JOIN frame's pending-count (§5.4, 3.2b) — the number of
   * its child branches that PARKED. `interpretParallel` / `interpretBlock` call
   * this when they re-throw `RunParked` after firing all N children: the frame
   * (a parallel / fan-out) is itself pending until every parked child resolves.
   * Idempotent on (run_id, frame_address) — a re-run that re-reaches the same
   * frame OVERWRITES the count to the same value (the frontier is deterministic
   * under P11), so a crashed-then-re-run firing never double-counts.
   */
  recordJoin(input: { frameAddress: string; parkedChildren: number }): Promise<void>;
  /**
   * Record a TIMER park (`sleep` statement): UPSERTs a `parked_run` row with
   * `park_reason='timer'` and `wake_at` set to the absolute resume instant, then
   * marks the run `parked`. No `interaction_request` is created and no token is
   * minted — the wake driver resumes without a human answer. Idempotent on
   * `(run_id, address)`.
   */
  commitTimerPark(input: { address: string; state: unknown; wakeAt: Date }): Promise<void>;
  /**
   * Record an AWAIT park (`await x-[:E]->` untilNonEmpty, asks-as-adapter §A):
   * a `parked_run` row with `park_reason='await'` + the serialized scope. Unlike
   * `commitPark` there is NO `interaction_request` and NO token — the awaitable
   * adapter's own correlation map (registered via `correlate`, which the sink
   * hands the run id) drives resume, which RE-ENTERS at the await (`reenter`)
   * and re-checks live. Idempotent on `(run_id, address)`.
   */
  commitAwaitPark(input: {
    address: string;
    state: unknown;
    /** Register the awaitable adapter's correlation for this park — invoked with
     *  the sink's run id (the interpreter supplies the adapter + record). */
    correlate: (runId: string) => Promise<void>;
  }): Promise<void>;
  /** Resume-unwind join decrement (§6.1). Returns { closed } — true for the unique
   *  branch that closes the frame (runs the post-join continuation). Crash-safe closer
   *  identity via join_pending.closed_by_address. Per-leaf EXACTLY-ONCE via the
   *  `branchAddress` decrement claim (join_branch_export.decremented, §7): a branch
   *  re-scanned after a crash between its decrement and its leaf delete does NOT
   *  decrement the join a second time. */
  decrementJoin(input: {
    frameAddress: string;
    branchAddress: string;
    leafAddress: string;
  }): Promise<{ closed: boolean }>;
  /** Persist a completed branch's exports at its join frame (§12.1), before decrement. */
  persistBranchExport(input: {
    frameAddress: string;
    branchAddress: string;
    branchIndex: number;
    exports: unknown;
  }): Promise<void>;
  /** Collect all branches' persisted exports for a frame, ordered by branchIndex (§12.4). */
  collectBranchExports(input: { frameAddress: string }): Promise<
    Array<{ branchAddress: string; branchIndex: number; exports: unknown }>
  >;
  /**
   * Cancel every park under the given subtree prefixes (asks-as-adapter chunk C
   * — the race cascade, P17). For each parked leaf whose address is at-or-below
   * a prefix: deliver the one cancellation signal (drop its awaitable-adapter
   * correlation so a late resolution lands as data, F7), delete its `parked_run`
   * row, and clear any `join_pending` frame within the cancelled subtree (S19 —
   * no dangling bookkeeping). Idempotent (a re-scan finds the rows gone).
   */
  cancelSubtrees(input: { subtreeAddresses: string[]; excludeLeaf?: string }): Promise<void>;
}

/**
 * The cooperative cancel gate (runs-and-cancel spec §cancel). A user-requested
 * cancel stops the run at the next STATEMENT boundary, and — because one
 * statement can be minutes of work — at the boundaries INSIDE a statement too:
 * every LLM call and every plugin invocation of an extraction
 * (`extraction.ts`). Cancel means "stop doing things", not just "stop spending".
 *
 * Every one of those is the same debounced async read, which is the point: a
 * gate whose in-statement reading was a cached value could only ever repeat what
 * the statement boundary already knew, and a statement that is the movement's
 * last one has no next boundary to learn from. The recorder-backed production
 * gate is `makeDbCancelGate` (`cancel_gate.ts`), which debounces to one DB read
 * per few seconds across all of them. Fail-open: a read fault reads as
 * not-cancelled (a DB blip must never stop a healthy run). Absent ⇒ the run is
 * never cancel-gated (dry runs, bare `runMovement`).
 */
export interface CancelGate {
  /** Debounced async check — every boundary's gate, statement and in-statement
   *  alike. Latches once true, and one read serves them all. */
  cancelled(): Promise<boolean>;
  /** The same check with the debounce skipped, for the run's FINAL boundary —
   *  where a stale "no" is not a few seconds' latency but a cancel discarded
   *  forever, because there is no later boundary to notice it at. */
  cancelledNow(): Promise<boolean>;
  /** The stamped human-readable reason, once cancelled. */
  reason(): string | null;
}

// The cancel signal lives beside the gate that raises it (cancel_gate.ts) so
// both the interpreter and the extraction seam import it cycle-free;
// re-exported here for the engine's public surface, alongside `CancelGate`.
export { RunCancelledSignal };

/**
 * One applied (or dry-run-captured) write, in program order — the
 * firing-record entry. This IS the `WriteRecord` a write handle binds to
 * (see `expression.ts`): producing the adapter write and recording it
 * onto the firing log are one act, so the binding value and the firing
 * entry are the same object. The alias preserves the firing-log name at
 * the call sites that recorded the run's writes.
 */
export type MovementWriteRecord = WriteRecord;

export interface MovementRunResult {
  movementName: string;
  /** Writes in program order — the firing record's raw material. */
  writes: MovementWriteRecord[];
  /** The extraction call sites the writes' provenance references,
   *  interned by site id (refs in `provenance`, detail here, once). */
  extractionSites: Record<string, ExtractSiteSummary>;
  /** Decision-point trace, in program order — why the run did (or did
   *  not do) what it did. See `MovementTraceEntry`. */
  trace: MovementTraceEntry[];
  /**
   * The run PARKED at an `ask` (async user interaction) rather than running
   * to completion — its parked frontier + the `interaction_request`(s) are
   * persisted, the `trigger_run` is `parked`, and the firing caller must NOT
   * finalise it as a terminal run (it resumes when the answer arrives). Absent
   * / false ⇒ an ordinary completed run.
   */
  parked?: boolean;
  /**
   * The lexical address the run (re-)parked at — present iff `parked`. The
   * await-resume driver (`await_resume.ts`) compares it to the leaf it re-entered:
   * a DEEPER/different address means the leaf's await RESOLVED and the resumed
   * body parked forward (drop the now-stale leaf); the SAME address means the
   * await RE-ARMED without resolving (a WHERE-narrowed await whose live landings
   * still don't match) — its park rows were just re-committed, so leave them be.
   * Without this the driver can't distinguish the two and destroys a re-armed
   * park, stranding the run parked forever.
   */
  parkedAddress?: string;
  /**
   * The run was CANCELLED by a user request (runs-and-cancel spec §cancel): the
   * interpreter hit the cancel gate at a statement / LLM-call boundary and threw
   * `RunCancelledSignal`. Exactly parallel to `parked` — the firing caller must
   * NOT finalise it as success/partial; it settles the run `failed` (via
   * `failRunAndCancelRequests`). Earlier writes stand (P14). Absent / false ⇒ not
   * cancelled.
   */
  cancelled?: boolean;
  /**
   * Race frames whose settlement was DEFERRED under batch resume (asks-as-adapter
   * chunk C, F18/F21): a branch completed but the race was not settled inline, so
   * the resume worker can drive every resolvable branch of the batch to
   * completion first and then settle ONCE with all winners. The worker calls
   * `settleRaceFrame` for each after the batch pass. Absent under inline
   * (timer/cost/ask) resume.
   */
  deferredRaceFrames?: string[];
}

/**
 * A run that DIED mid-way, carrying out the ledger of what it had already done.
 *
 * Writes hit external systems inline, so a throw after the third write leaves
 * three real records behind. Before this channel the ledger died with the stack
 * and the firing record claimed nothing happened — users re-ran and collided
 * with their own writes.
 *
 * Deliberately transparent: `message`, `name` and `stack` are the original
 * error's and it hangs off `cause`, so logs and failure reasons read exactly as
 * they did. Only genuine failures are wrapped — `RunParked`,
 * `RunCancelledSignal` and `ScopeEndedQuietly` are control flow and never reach
 * here.
 */
export class MovementRunFailed extends Error {
  constructor(
    cause: unknown,
    /** Everything the run had done when it died: writes in program order, the
     *  extraction sites their provenance references, and the decision trace. */
    readonly partial: MovementRunResult,
  ) {
    super(getErrorMessage(cause), { cause });
    this.name = cause instanceof Error ? cause.name : 'MovementRunFailed';
    if (cause instanceof Error && cause.stack !== undefined) this.stack = cause.stack;
  }
}

/**
 * The error a run really died of. `MovementRunFailed` is a transparent CARRIER
 * for the partial ledger, so anything that discriminates on the error itself —
 * its class, its `MovementEngineError` code — must look THROUGH it. Errors
 * raised before the interpreter starts (parse / check) are never wrapped and
 * pass straight back.
 */
export function runFailureCause(error: unknown): unknown {
  return error instanceof MovementRunFailed ? error.cause : error;
}

export async function runMovement(input: RunMovementInput): Promise<MovementRunResult> {
  // Error severity only: info diagnostics (MOV_LISTEN_MISSING — a
  // dispatchable movement with no listen) never block a run; the engine is
  // routinely handed library movements to execute directly. With a
  // resolveFile, the check RESOLVES file imports and the returned link is
  // the engine's import structure — validation and execution consume one
  // resolution.
  const { program, link } = parseAndCheck(input);
  return new Interpreter(input, link).run(program);
}

/**
 * Diagnostics an author may no longer WRITE, but a saved program may still
 * RUN. A retirement refuses the construct where a program is authored; it must
 * not stop automations that were saved while the construct was legal, so the
 * run gate lets exactly these through and the engine still executes them.
 *
 * Empties out at the wave that deletes each construct's engine path — see the
 * deploy block in
 * plans/2026-06-10-data-movement-language/9_node_synthesis_build.md.
 */
const RETIRED_BUT_STILL_RUNNABLE = new Set<string>([DiagnosticCodes.WRITE_SHAPE_RETIRED]);

/** Parse + check the program, throwing the same MOVENG_PARSE / MOVENG_CHECK
 *  errors `runMovement` does. Shared by run + resume so a resume re-validates
 *  the pinned source exactly as a fresh run did. */
function parseAndCheck(input: RunMovementInput): { program: Program; link?: ProgramLink } {
  let program: Program;
  try {
    program = parseProgram(input.source);
  } catch (e) {
    if (e instanceof MovementParseError) {
      throw new MovementEngineError('MOVENG_PARSE', e.message);
    }
    throw e;
  }
  const { diagnostics: allDiagnostics, link } = checkProgramWithLink(
    program,
    input.catalog,
    input.resolveFile !== undefined ? { resolveFile: input.resolveFile } : undefined,
  );
  const diagnostics = allDiagnostics.filter(
    (d) => (d.severity ?? 'error') === 'error' && !RETIRED_BUT_STILL_RUNNABLE.has(d.code),
  );
  if (diagnostics.length > 0) {
    throw new MovementEngineError(
      'MOVENG_CHECK',
      `the movement program failed checking:\n${diagnostics
        .map((d) => `  ${d.code} (line ${d.span.start.line}): ${d.message}`)
        .join('\n')}`,
      diagnostics,
    );
  }
  return { program, ...(link !== undefined ? { link } : {}) };
}

export interface ResumeMovementInput extends RunMovementInput {
  /** The parked leaf's serialised scope state (`parked_run.state`) — chunk 4's
   *  `ParkedScopeState`. Re-parsed source + this rebuild the env. */
  state: ParkedScopeState;
  /** The validated answer value (already checked against the ask's result type
   *  by `recordAnswer`). For a scalar result (`Check<boolean>` / an enum) this
   *  is the JSON scalar; it binds as the ask's result `r` at the ask's binding
   *  name (§4.4 — scalar answer → a value binding). Absent under `reenter` (a
   *  cost / error park has no answer to bind). */
  answer?: unknown;
  /**
   * Resume-at-statement mode (the GENERAL re-enter primitive, §4.4). Optional,
   * DEFAULTING to the ask behaviour (false):
   *
   *   - false / absent (ASK resume): the parked leaf's address is the ASK's own
   *     statement; the ask's effect IS the answer, so resume binds `answer` at the
   *     ask's binding name and steps FORWARD from the statement AFTER it
   *     (`stmtIndex + 1`). Every existing caller (`interaction/resume.ts`) keeps
   *     this behaviour unchanged.
   *   - true (RE-ENTER resume): the parked leaf's address is a statement whose
   *     effect must be RE-EVALUATED rather than stepped past — an `await` that
   *     re-checks live, or a recurring `until` timer. Resume binds NO answer and
   *     RE-ENTERS AT that statement (`stmtIndex`), running it and the rest of its
   *     branch forward.
   */
  reenter?: boolean;
  /** Batch mode (F18/F21): the await-resume worker sets this so a race branch's
   *  completion is DEFERRED (recorded in the result's `deferredRaceFrames`)
   *  instead of settling inline — the worker settles once, post-batch, with every
   *  winner. Inline resumers (timer/ask) omit it. */
  deferRaceSettlement?: boolean;
}

/**
 * Resume a parked movement run forward from its parked `ask` leaf (async user
 * interaction §4.7 stage 3). The `source` MUST be the version-pinned source the
 * run parked against (P11), so the re-parsed AST — and every lexical address —
 * is byte-identical. Single-ask linear body only (chunk 5).
 */
export async function resumeMovement(input: ResumeMovementInput): Promise<MovementRunResult> {
  const { program, link } = parseAndCheck(input);
  // The answer graph `r` (§4.4): for the single-ask scalar case it's a value
  // binding (the validated answer); the post-ask body reads it as a value. A
  // `Correct` answer is a curated position-SET (the edited + surviving rows) —
  // re-materialise it into a TRAVERSABLE extract-result binding so the resumed
  // body iterates it (`clean-[c:T]-> { … c.\`field\` … }`) and reads each row's
  // edited fields off the synthetic emission (chunk 6c). Under `reenter` there is
  // no answer to bind (cost / error resume re-enters AT the un-run statement).
  const answer: Binding | undefined = input.reenter ? undefined : rematerialiseAnswer(input.answer);
  return new Interpreter(input, link).resume({
    program,
    state: input.state,
    ...(answer !== undefined ? { answer } : {}),
    ...(input.reenter !== undefined ? { reenter: input.reenter } : {}),
    ...(input.deferRaceSettlement !== undefined
      ? { deferRaceSettlement: input.deferRaceSettlement }
      : {}),
  });
}

/**
 * Settle a race frame whose branches completed under batch resume (asks-as-
 * adapter chunk C, F18/F21). Called by the await-resume worker ONCE per deferred
 * frame after the whole batch pass: it builds the receipt from EVERY completed
 * branch's exports (all winners), cancels the still-parked losing branches (the
 * one signal, P17), binds the receipt, and runs the race's continuation forward.
 * `state` is any completed branch's parked state (its scope chain covers the
 * race's parent — the settlement re-enters at the race statement, not the leaf).
 */
export async function settleRaceFrame(
  input: ResumeMovementInput & { frameAddress: string },
): Promise<MovementRunResult> {
  const { program, link } = parseAndCheck(input);
  return new Interpreter(input, link).settleRaceFrame({
    program,
    state: input.state,
    frameAddress: input.frameAddress,
  });
}

/**
 * Run a fired callback's body against its captured continuation (callback-
 * primitive layer 2). `state` is the callback row's stored state — the same
 * `ParkedScopeState` a park writes, whose `address` is the callback expression's
 * entry point. `source` MUST be the run's version-pinned source (P11), so the
 * address resolves to the same expression it was minted from.
 */
export async function fireCallbackBody(
  input: ResumeMovementInput & { values: Record<string, unknown>; callIndex: number },
): Promise<MovementRunResult> {
  const { program, link } = parseAndCheck(input);
  return new Interpreter(input, link).fireCallback({
    program,
    state: input.state,
    values: input.values,
    callIndex: input.callIndex,
  });
}

/** The shape `validateAnswer` produces for a `Correct` answer — the curated +
 *  edited rows, tagged so resume knows to re-materialise a position-set (vs a
 *  scalar). Interaction-scoped; never persisted beyond the answer. */
interface CorrectAnswer {
  __correct: { type: string; rows: Array<{ fields: Record<string, unknown> }> };
}

function isCorrectAnswer(value: unknown): value is CorrectAnswer {
  return (
    value !== null &&
    typeof value === 'object' &&
    '__correct' in value &&
    typeof (value as { __correct: unknown }).__correct === 'object'
  );
}

/**
 * Turn a validated answer into the binding the resumed body reads as `r`. A
 * `Correct` answer (the curated row-set) re-materialises into a synthetic
 * `extractRoot` emission: one child emission per SURVIVING row under the
 * Correct type's edge, each carrying the row's edited `fields`. A later
 * `clean-[c:<type>]->` walks `emission.children.get('<type>')` (the same path an
 * extract result is traversed) and `c.\`field\`` reads `emission.fields[field]`
 * — so the edited values flow into the downstream write; dropped rows are simply
 * absent (unreachable → unwritten, 3i). Any other answer binds as a value.
 */
function rematerialiseAnswer(answer: unknown): Binding {
  if (isCorrectAnswer(answer)) {
    const { type, rows } = answer.__correct;
    const children = new Map<string, ExtractEmission[]>();
    children.set(
      type,
      rows.map((row) => ({
        nodeName: type,
        fields: row.fields,
        provenance: {},
        // A curated row-set is user-edited data, not file-fed extraction — no
        // source resources to carry forward.
        resources: [],
        children: new Map<string, ExtractEmission[]>(),
      })),
    );
    return {
      kind: 'extractRoot',
      emission: { nodeName: type, fields: {}, provenance: {}, resources: [], children },
    };
  }
  return { kind: 'value', value: answer, provenance: NO_PROVENANCE };
}

/**
 * What a body did when it finished. `returned` is the fact a caller acts on —
 * a call's value IS its callee's return, and a body that fell off the end has
 * none. Kept as a discriminated pair rather than `Binding | undefined` so
 * "returned nothing" and "returned something we could not build" can never
 * read the same.
 */
type BodyOutcome = { returned: false } | { returned: true; value: Binding };

const FELL_THROUGH: BodyOutcome = { returned: false };

/**
 * The slot a `return` binds into, on the returning body's own scope.
 *
 * It exists for ONE reason: a parked iteration's return has to survive the
 * park, and what survives a park is a scope's bindings. So the return rides
 * out as one — under the `#` prefix that marks the engine's own names
 * (`#resources` is the other), which the checker refuses to authored bindings.
 * That is what makes it an identity rather than a name an author could
 * collide with: compared, never parsed.
 */
const RETURN_SLOT = '#return';

/**
 * A flat snapshot of everything in lexical scope — what a deferred walk and a
 * closure both capture. Flat because bindings are single-assignment and nothing
 * declared later is in scope here, so a chain and its flattening say the same
 * thing; flat is also what serialises.
 */
function captureScope(env: Environment): Map<string, Binding> {
  const captured = new Map<string, Binding>();
  for (const scope of env.chainFromRoot()) {
    for (const [name, binding] of scope.ownBindings()) captured.set(name, binding);
  }
  return captured;
}

/** A call's value where one is REQUIRED — bound, or passed on. The checker
 *  refuses a callee that returns nothing at every such site, so reaching here
 *  means the saved program and the checker disagree. */
function requireCallValue(callee: string, value: Binding | undefined): Binding {
  if (value !== undefined) return value;
  throw new MovementEngineError(
    'MOVENG_RUNTIME',
    `'${callee}' returned nothing, so there is no value to bind — the checker should have caught this`,
  );
}

/** A bound block's value: what its iterations returned, in iteration order.
 *  All values ⇒ one value binding holding the list, so zero, one and many
 *  iterations read the same shape; positions ⇒ the landings, plural exactly as
 *  a traversal's are.
 *
 *  ZERO returns has no plane to pick — nothing came back to have one. The two
 *  representations agree there, and `positions` is the one that says so on both
 *  planes at once: read as a value it is the empty list (`COUNT` is 0, `JOIN`
 *  is ""), and hopped it yields no landings, which is the traversal gate. A
 *  value binding would answer the first and throw on the second, so the block a
 *  hop follows would work or fail on how many items its head happened to
 *  yield. */
function blockValue(returned: Binding[]): Binding {
  if (returned.length > 0 && returned.every((b) => b.kind === 'value')) {
    return {
      kind: 'value',
      value: returned.map((b) => (b.kind === 'value' ? b.value : null)),
      provenance: unionProvenance(
        returned.map((b) => (b.kind === 'value' ? (b.provenance ?? NO_PROVENANCE) : NO_PROVENANCE)),
      ),
    };
  }
  return { kind: 'positions', landings: returned };
}

/** The value a slot holds when its arm handed nothing back — a filled slot and
 *  an empty one are the same shape, so a null check is the only difference. */
const NULL_SLOT: Binding = { kind: 'value', value: null, provenance: NO_PROVENANCE };

/** What a `link` may append to a run-local node's edge: the binding kinds that
 *  ARE positions. A value, an instance or a closure is not one, and landing it
 *  would make the next traversal off the edge meaningless. */
const APPENDABLE_LANDING_KINDS: ReadonlySet<Binding['kind']> = new Set([
  'event',
  'handle',
  'sourcePosition',
  'nodePosition',
  'shapePosition',
  'extractRoot',
  'extractPosition',
]);

/** One arm, ready to run: the body, and the bindings it brings with it (a
 *  closure's capture, a movement's file scope). Absent ⇒ it sees only the scope
 *  the arm frame is a child of, which is where it was written. */
interface ArmInvocation {
  body: Statement[];
  captured?: Map<string, Binding>;
}

function isClosureBinding(value: unknown): value is Extract<Binding, { kind: 'closure' }> {
  return (
    typeof value === 'object'
    && value !== null
    && (value as { kind?: unknown }).kind === 'closure'
  );
}

/**
 * Build a race RECEIPT from the completed branches' environments (asks-as-adapter
 * chunk C, F13/F18). Reused at runtime as a `blockMeta`: every branch's
 * iff-executed bindings go in `edges` — NODE bindings traversed by arrow
 * (`r-[x:name]->`), SCALAR bindings read by dot (`r.name`, via
 * `readBindingField`'s blockMeta path). The checker already routed each name to
 * its plane, so both accesses resolve off the one map; a name completed by more
 * than one branch accumulates (union). */
/** A call written at FILE scope: there is no event there to call it about, so
 *  the callee's parameter could never be supplied with anything real. The
 *  static scan refuses it at save time (`interpretable.ts`); this is the same
 *  refusal at run time, for a program saved before it. */
function fileLevelCall(): MovementEngineError {
  return unsupported(
    'file-level calls',
    'a call runs inside a movement body, where the event is in scope',
  );
}

/**
 * The combinator receipt (layer 13 C3/C4). race: the winner's bindings, raw —
 * singular, so reads are bare. all: block constituents raw; a FAN-OUT's
 * scalar buckets PRE-COLLAPSE to one array value per name (stable cardinality
 * — the checker's list type reads the same for 1 and N iterations), its node
 * buckets stay raw (a plural receipt edge). Hop aliases are loop variables,
 * not exports.
 */
function buildCombinatorReceipt(
  contributions: Array<{
    constituentIndex: number;
    fanout: boolean;
    bindings: Iterable<[string, Binding]>;
  }>,
  mode: 'race' | 'all',
): Binding {
  const edges = new Map<string, Binding[]>();
  const push = (name: string, binding: Binding): void => {
    const bucket = edges.get(name) ?? [];
    bucket.push(binding);
    edges.set(name, bucket);
  };
  const byConstituent = new Map<number, typeof contributions>();
  for (const contribution of contributions) {
    const group = byConstituent.get(contribution.constituentIndex) ?? [];
    group.push(contribution);
    byConstituent.set(contribution.constituentIndex, group);
  }
  for (const group of byConstituent.values()) {
    if (!group[0].fanout || mode === 'race') {
      for (const contribution of group) {
        for (const [name, binding] of contribution.bindings) push(name, binding);
      }
      continue;
    }
    const grouped = new Map<string, Binding[]>();
    for (const contribution of group) {
      for (const [name, binding] of contribution.bindings) {
        const bucket = grouped.get(name) ?? [];
        bucket.push(binding);
        grouped.set(name, bucket);
      }
    }
    for (const [name, bucket] of grouped) {
      if (bucket.every((b) => b.kind === 'value')) {
        push(name, {
          kind: 'value',
          value: bucket.map((b) => (b.kind === 'value' ? b.value : null)),
          provenance: unionProvenance(
            bucket.map((b) =>
              b.kind === 'value' ? (b.provenance ?? NO_PROVENANCE) : NO_PROVENANCE,
            ),
          ),
        });
        continue;
      }
      for (const binding of bucket) push(name, binding);
    }
  }
  return { kind: 'blockMeta', edges };
}

function buildRaceReceipt(envs: Environment[]): Binding {
  const edges = new Map<string, Binding[]>();
  for (const branchEnv of envs) {
    for (const [name, binding] of branchEnv.ownBindings()) {
      const bucket = edges.get(name) ?? [];
      bucket.push(binding);
      edges.set(name, bucket);
    }
  }
  return { kind: 'blockMeta', edges };
}

/** The child bindings reached by traversing edge `edge` off a meta-node binding
 *  (a race receipt / block meta) — mirrors expression.ts `walkMetaSteps`. A
 *  block-meta edge yields its accumulated bindings; a nested extract node yields
 *  its children; anything else yields nothing (an absent edge = the gate). */
function metaEdgeBindings(binding: Binding, edge: string): Binding[] {
  if (binding.kind === 'blockMeta') return binding.edges.get(edge) ?? [];
  if (binding.kind === 'nodePosition') {
    // A DEFERRED edge needs a walk, and this seam has no way to run one — say
    // so rather than yield nothing, which would read as an empty edge.
    if (binding.edges[edge]?.kind === 'deferred') {
      throw unsupported(
        `traversing the deferred edge '${edge}' of a synthesised node reached through a block meta-node`,
        'bind the node itself and traverse from there',
      );
    }
    return nodeEdgeLandings(binding, edge);
  }
  if (binding.kind === 'extractPosition' || binding.kind === 'extractRoot') {
    return (binding.emission.children.get(edge) ?? []).map(
      (emission): Binding => ({ kind: 'extractPosition', emission }),
    );
  }
  return [];
}

/**
 * The `race([…])` / `parallel([…])` a container carries — awaited (the living
 * form) or bare (refused by the checker, still run for recovery). Undefined for
 * every other statement.
 */
function combinatorOf(container: Statement): CombinatorExpression | undefined {
  if (container.kind === 'combinator') return container.combinator;
  if (container.kind === 'assign' && container.value.kind === 'combinator') {
    return container.value.combinator;
  }
  const source =
    container.kind === 'await'
      ? container.await.source
      : container.kind === 'assign' && container.value.kind === 'await'
        ? container.value.await.source
        : undefined;
  return source?.kind === 'combinator' ? source.combinator : undefined;
}

/** The literal arms a combinator was written with — the resume descent's
 *  branch-navigation currency. Arms built at run time have no static list, so
 *  nothing can be navigated into and this is empty. */
function literalArmsOf(expr: CombinatorExpression | undefined): ArmExpression[] {
  return expr !== undefined && expr.arms.kind === 'literal' ? expr.arms.arms : [];
}

/** The edge name of an awaited traversal's single hop — `-[:Response]->` and
 *  `-[got:Response]->` both yield `Response`. Backtick-quoted names are
 *  unwrapped. The checker has already validated the hop; this only extracts the
 *  name the awaitable capability keys on. */
function awaitEdgeName(hopsRaw: string): string {
  // -[ <alias>? : <name> <WHERE …>? ]-> — the alias (if any) precedes the FIRST
  // colon; the edge name follows it (optionally backtick-quoted).
  const inner = hopsRaw.replace(/^-\[/, '').replace(/\]->\s*$/, '');
  const colon = inner.indexOf(':');
  const afterColon = (colon >= 0 ? inner.slice(colon + 1) : inner).trim();
  const nameMatch = /^`([^`]+)`|^([^\s\]]+)/.exec(afterColon);
  return (nameMatch?.[1] ?? nameMatch?.[2] ?? afterColon).trim();
}

/** The pure WHERE predicate of an awaited hop (`q-[r:Response WHERE r.answer]->`)
 *  as an Expression — parsed off the head by probing the traversal with a
 *  sentinel terminal (the formula parser needs one). Undefined when the hop
 *  carries no WHERE or doesn't parse to a traversal. */
function awaitHopFilter(head: PathHead): Expression | undefined {
  const traverse = parseMovementExpression(
    `${spellPathHead(head)}.\`__await_where_probe__\``,
  );
  if (traverse.type !== 'traverse') return undefined;
  const last = traverse.steps[traverse.steps.length - 1];
  return last !== undefined && last.type === 'edge' ? last.expressionFilter : undefined;
}

// The awaited-hop WHERE (B.1) is evaluated per candidate in
// `AbstractMovementInterpreter.awaitLandingMatches` — THROUGH the adapter's
// getFieldValue, so a candidate reads exactly as it will post-bind.

// ── The interpreter ─────────────────────────────────────────────────────────

/** Per-body interpretation context. `atAnchor` is true while statements
 *  execute at the trigger's seeded root (the movement body and its `if`
 *  arms) and false inside traversal-block iterations — the W3-Y1
 *  anchor-only rule for bridge synthesis rides on it. `position` is the
 *  source position the body's writes stand on: the seeded root at the
 *  anchor, the iterated record inside an adapter-edge block, absent in
 *  extract/resource iterations and callee bodies — the bridge-synthesis
 *  currency (mirrors the TG engine, where every action carries its
 *  resolved source position). */
interface BodyContext {
  atAnchor: boolean;
  position?: SourcePosition;
  /** The lexical address of THIS statement sequence (§4.3) — the movement
   *  body root is `ROOT_ADDRESS`; an `if` arm / parallel branch / fan-out
   *  iteration descends a `branch`/`iter` step. The interpreter appends a
   *  `stmt i` step per statement as it walks, so an `ask` knows the stable
   *  address its `interaction_request`/`parked_run` key on. */
  address: Address;
}

/** One traversal-block iteration: the hop aliases' bindings, plus the
 *  yielded record itself when the head walked ADAPTER edges (the
 *  iteration's write-bridge currency — extract/resource iterations have
 *  no stable external record to stand on). */
interface BlockIteration {
  bindings: Map<string, Binding>;
  position?: SourcePosition;
  /** WHERE the head landed, as a binding — the iteration's last hop. A block
   *  body reaches it through the hop alias; a construct that BINDS the walk
   *  rather than entering a block (a node literal's pass-through edge, a
   *  `lazy` traversal read) takes it from here, alias or no alias. */
  landing?: Binding;
}

/**
 * One ancestor (container) level the resume descent passed through — captured so
 * the leaf-block completion can UNWIND back out, running each ancestor's
 * post-container continuation exactly as normal execution's return-from-block
 * (plans/2026-07-01-movement-sleep/4_resume_unwind_fix.md §3/§4/§12.1). A JOIN
 * frame (fan-out iteration / parallel branch) persists this branch's exports and
 * decrements the join; the closer folds all branches and runs the continuation.
 */
interface ResumeAncestorFrame {
  /** The ENCLOSING sequence — the level the container lives in. */
  parentStatements: Statement[];
  /** That level's env, already rehydrated with pre-container bindings. */
  parentEnv: Environment;
  /** That level's frame address. */
  parentFrameAddress: Address;
  parentAtAnchor: boolean;
  parentPosition: SourcePosition;
  /** `parentStatements[containerIndex]` — the if / parallel / fan-out node. */
  container: Statement;
  containerIndex: number;
  /** `childStmt(parentFrameAddress, containerIndex)` — the JOIN frame address. */
  containerAddress: Address;
  /** How we descended into the container (`address[i+1].kind`). */
  descentKind: AddressStep['kind'];
  /** The forked env we descended INTO (its `ownBindings()` are the exports). */
  childEnv: Environment;
  /** This branch's own address (the childIter/childBranch of the frame, §12.1). */
  branchAddress: Address;
  /** The branch/iteration ordinal — the deterministic fold order (§12.1/§12.4). */
  branchIndex: number;
}

/** A write's resolved destination (see `resolveWriteTarget`). */
interface ResolvedWriteTarget {
  adapter: Adapter;
  /** The written type, in the adapter's NATURAL name — what `describe`,
   *  `resolveEntity` and the write calls now receive (the adapter translates
   *  to its own id internally). Also the env/schema currency (handle
   *  bindings, edge inference against the instance/kg schema). */
  recordType: string;
  /** The graph the resulting handle lives in (threads onto the handle
   *  binding so later linked writes can chain off it). */
  graph: HandleGraph;
  /** Linked / tuple-path writes — the parent handles' contexts, in path
   *  order (ONE entry for a linked write, N for a tuple). `recordType` is the
   *  parent's NATURAL type and `edgeName` the NATURAL edge name (the adapter
   *  resolves both); `externalId` is absent when a parent write produced no
   *  record (the adapter then gets no link for it, mirroring the TG engine).
   *  Empty for instance-target writes. */
  parents: Array<{
    handleName: string;
    edgeName: string;
    recordType: string;
    externalId?: string;
    /** The parent's payload — see `ParentLink.data`. */
    data?: Record<string, unknown>;
  }>;
}

/** A standalone link statement's resolved shape (see `resolveLinkStatement`)
 *  — adapter + engine-currency endpoints, plus the endpoint handles for the
 *  firing record's provenance. */
interface ResolvedLinkStatement {
  adapter: Adapter;
  /** The edge in the adapter's NATURAL name — the adapter's `linkRecords`
   *  resolves it against the FROM side's type internally. */
  edgeName: string;
  from: { recordType: string; externalId: string };
  to: { recordType: string; externalId: string };
  fromHandle: WriteRecord;
  toHandle: WriteRecord;
}

/**
 * Control-flow sentinel — the documented find-on-missing semantics: a
 * criteria-form `link` found no target, so the ENCLOSING SCOPE ends
 * quietly. Caught at scope boundaries (a fan-out iteration skips, a
 * callee body returns, the movement body simply stops); nothing throws
 * outward, because transactionality across systems can't be guaranteed.
 */
class ScopeEndedQuietly extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScopeEndedQuietly';
  }
}

/**
 * Control-flow signal — an `ask` was reached, so the enclosing branch is now
 * durably PARKED (its `interaction_request` + `parked_run` are persisted). It
 * mirrors `ScopeEndedQuietly` (caught at the same scope boundaries) but means
 * the opposite: the branch did not complete, it is waiting on an answer. For
 * the single-ask milestone it propagates to `run()` top → the whole run is
 * parked. (3.2 adds the per-sibling catches so a fan-out parks N leaves while
 * its other branches run on.)
 */
class RunParked extends Error {
  constructor(readonly address: string) {
    super(`run parked at ${address}`);
    this.name = 'RunParked';
  }
}

/** `await until(…)`'s default cadence when the author writes none (F12 ops
 *  ruling: default 1h). The 1m floor is a checker error, so anything reaching
 *  the engine is already ≥ 1m. */
const UNTIL_DEFAULT_EVERY_MS = 60 * 60 * 1000;

/** Does an `until` condition HOLD? The condition is a boolean in practice (a
 *  quorum test, a `.ok` flag), so this is identity against TRUE — with a
 *  stringified fallback for the sources that hand booleans back as `"true"`,
 *  and never a deep-equal against a node. */
function untilConditionMet(value: unknown): boolean {
  if (value === true) return true;
  if (value == null || typeof value === 'object') return false;
  return String(value) === 'true';
}

/** The block head as the author wrote it — `mentions-[c:company]->`. */
function blockRootLabel(block: TraversalBlock): string {
  return spellPathHead(block.head);
}

/** How much of an extract's output a run keeps for inspection. The trace
 *  rides `trigger_run.steps` (jsonb), so the sample is bounded per alias
 *  and per value — and whatever the cap drops is counted, never dropped
 *  silently. */
const TRACE_ENTITY_CAP = 20;
const TRACE_VALUE_CHARS = 200;

/**
 * Hang the extract's emitted entities off the trace, so a reader can open
 * "3 companies" and see WHICH three — and, the case this exists for, that
 * one of them came back with a null name. Attaches the whole tree (the
 * root's own fields plus every child alias) to the LAST extraction entry
 * of this extract: an extract reads as one step, and only after its final
 * region has run is the tree complete.
 */
function recordExtractedEntities(
  trace: MovementTraceEntry[],
  from: number,
  root: ExtractEmission,
): void {
  let target: Extract<MovementTraceEntry, { kind: 'extraction' }> | undefined;
  for (let i = trace.length - 1; i >= from; i--) {
    const entry = trace[i];
    // A per-entity stage skipped for want of anything new to read describes a
    // call that never happened — often the LAST entry of a staged extract. The
    // tree belongs to the last call that did happen.
    if (entry.kind === 'extraction' && entry.skipped !== 'no_enrichment') {
      target = entry;
      break;
    }
  }
  // A skipped extract never called out — its "root" is the engine's
  // synthetic all-null stand-in, not something that was read.
  if (!target || target.skipped) return;
  const entities: Record<string, TracedEntity[]> = {};
  const truncatedCount: Record<string, number> = {};
  collectTracedEntities(root, entities, truncatedCount);
  if (Object.keys(entities).length > 0) target.entities = entities;
  if (Object.keys(truncatedCount).length > 0) target.truncatedCount = truncatedCount;
}

/** Depth-first over the emission tree, bucketing entities by node alias.
 *  A fieldless node (a pure container) contributes nothing to show. */
function collectTracedEntities(
  emission: ExtractEmission,
  into: Record<string, TracedEntity[]>,
  truncated: Record<string, number>,
): void {
  const fields = Object.entries(emission.fields);
  if (fields.length > 0) {
    const alias = emission.nodeName;
    const bucket = (into[alias] ??= []);
    if (bucket.length < TRACE_ENTITY_CAP) {
      bucket.push({
        fields: Object.fromEntries(fields.map(([name, value]) => [name, tracedValue(value)])),
      });
    } else {
      truncated[alias] = (truncated[alias] ?? 0) + 1;
    }
  }
  for (const children of emission.children.values()) {
    for (const child of children) collectTracedEntities(child, into, truncated);
  }
}

/** An extracted value as the trace shows it — absent stays `null` (an
 *  unfilled field must read as unfilled), everything else becomes a
 *  bounded string. */
function tracedValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text =
    typeof value === 'string'
      ? value
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);
  return text.length > TRACE_VALUE_CHARS ? `${text.slice(0, TRACE_VALUE_CHARS)}…` : text;
}

/** Whether an instance was constructed with the universal `dry_run: true`
 *  argument — the per-instance rehearse-this-target switch. Read straight
 *  from the instance's own construction config so no upstream derivation
 *  can misjudge it (`6_engine.md`: per-instance capture). */
function instanceIsDryRun(instance: Extract<Binding, { kind: 'instance' }>): boolean {
  return instance.constructionConfig?.dry_run?.trim().toLowerCase() === 'true';
}

/** Unwrap a raw string-literal value (`'"Pipeline"'` → `Pipeline`); other raws
 *  pass through trimmed. */
function unquoteConstructionArg(raw: string): string {
  const t = raw.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return t;
}

/** The instance's non-credential construction args (unquoted), for construction
 *  — the entry position (`spreadsheet:`) plus any other config. `dry_run` is a
 *  platform arg, resolved separately, so it's dropped. */
function constructionArgsOf(
  instance: Extract<Binding, { kind: 'instance' }>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, raw] of Object.entries(instance.constructionConfig ?? {})) {
    if (name === 'dry_run') continue;
    out[name] = unquoteConstructionArg(raw);
  }
  return out;
}

/** The top-level AND-ed conjuncts of a predicate (a bare predicate is one). */
function flattenAndConjuncts(expr: Expression): Expression[] {
  if (expr.type === 'logical' && expr.op === 'and') {
    return expr.operands.flatMap(flattenAndConjuncts);
  }
  return [expr];
}

class Interpreter {
  private readonly writes: MovementWriteRecord[] = [];
  /** Set when the run parked at an `ask` (caught at run() top → the result
   *  carries `parked: true`, the firing caller skips finalisation). */
  private parked = false;
  /** The address the run (re-)parked at, captured from `RunParked` alongside
   *  `parked`. The await-resume driver compares it to the leaf it re-entered to
   *  tell a resolved-then-parked-DEEPER leaf (drop the stale leaf) from an await
   *  that RE-ARMED at the SAME address (a WHERE-narrowed await whose landings
   *  still don't match — leave its freshly re-committed park rows intact). */
  private parkedAddress?: string;
  /** Set when the user requested cancellation (RunCancelledSignal caught at
   *  run()/resume() top → the result carries `cancelled: true`, the firing caller
   *  settles the run `failed` rather than finalising it as success). */
  private cancelled = false;
  /** Batch mode (asks-as-adapter chunk C, F18/F21): when a race branch completes
   *  under `await`-resume, the race is NOT settled inline — its frame is DEFERRED
   *  here so the resume worker can run EVERY resolvable branch of the batch first,
   *  then settle once with ALL winners. Set from `resume({ deferRaceSettlement })`;
   *  timer/cost/ask resume leave it false (inline single-winner, unchanged). */
  private deferRaceSettlement = false;
  /** Race frame addresses a batch resume completed a branch into (dedup at the
   *  worker) — the post-batch settlement list. */
  private readonly deferredRaceFrames = new Set<string>();
  /** The run's decision-point trace (gates, blocks, AI() outcomes,
   *  field misses, extraction yields) — persisted on the firing record
   *  so a run with no writes still explains itself. Adopted from the caller
   *  when it supplied one, so the entries are readable AS THEY LAND rather
   *  than only at settle (a slow run showing an empty trace is exactly how it
   *  comes to read as a hung one). */
  private readonly trace: MovementTraceEntry[];
  /** Interns extraction sites + projects trails to refs for the
   *  firing record (E4 — refs not blobs). */
  private readonly summariser = new ProvenanceSummariser();
  /** Aliased imports: local name → name in the source namespace (catalog / workspace key). */
  private readonly importOriginals = new Map<string, string>();
  private readonly targetAdapterCache = new Map<string, Adapter>();
  /** Source-role adapters for graph-rooted traversals (see graphReadFor). */
  private readonly sourceAdapterCache = new Map<string, Adapter>();
  private readonly resolveAdapterFn: NonNullable<RunMovementInput['resolveAdapter']>;
  /** Rebuilt in run() for snapshot seeds, where the event envelope's
   *  adapterType is a placeholder and the source instance is canonical. */
  private mutationContext: MutationContext;
  /** Set once the movement's source instance is known. */
  private source?: MovementExprContext['source'];
  /** The seeded event node's canonical address, when the source's schema
   *  declares event edges — what a runtime IS on an event subject compares
   *  against (test pins ⊆ seed pins), and the same derivation that typed the
   *  seed (`eventSeedAddress`), so the two can never disagree. */
  private sourceEventAddress?: EventAddress;
  /** The constructed instance binding the entry movement's parameter is
   *  typed against — runtime IS tests on the event compare graph
   *  identity against it (binding objects are declared once, so object
   *  identity IS graph identity, alias-safe). */
  private sourceInstance?: Extract<Binding, { kind: 'instance' }>;
  /** File scope — callee environments fork from HERE, not from the
   *  caller's locals (lexical scoping, §G). */
  private fileEnv?: Environment;
  /** Movement declarations currently executing (object identity — names
   *  may repeat across library files) — a call cycle would otherwise
   *  loop forever. */
  private readonly callStack: MovementDeclaration[] = [];
  /** The running movement's body — the extraction module's backward
   *  type adoption scans it for writes the extracted fields flow into. */
  private movementBody: Statement[] = [];
  /** The program's author-declared refinements (`type Thesis = <"A" | "B">`),
   *  by name. File-level, so one map answers everywhere the checker's scope
   *  resolution would. */
  private declaredTypes: Map<string, FieldType> = new Map();
  private defaultLlm?: LlmClient;
  /** Run-wide caches for `@user_*` / `@actor_*` resolution (mutated in
   *  place by the evaluator's meta resolvers — one chain per run). */
  private readonly actingUserCache: MovementMetaContext['actingUserCache'] = {};
  private readonly actorCache: MovementMetaContext['actorCache'] = {};
  /** The run's pinned instant — see `RunMovementInput.firedAt`. Read once,
   *  here, so nothing downstream can reach a live clock instead. */
  private readonly pinnedNow: Date;
  /** The file whose import statements are being interpreted (the root
   *  program's resolved imports, or — while a library env builds — that
   *  library's own). */
  private currentImports?: Map<string, LinkedExport>;
  /** One environment per library file, memoized — diamonds share it, and
   *  its instance constructions stay per-file. */
  private readonly libraryEnvs = new Map<string, Environment>();

  constructor(
    private readonly input: RunMovementInput,
    private readonly link?: ProgramLink,
  ) {
    this.trace = input.trace ?? [];
    this.pinnedNow = input.firedAt ?? new Date();
    this.resolveAdapterFn =
      input.resolveAdapter ??
      (({ adapterType, teamId, credentialsId, constructionArgs }) =>
        resolveAdapterDefault({
          adapterType,
          teamId,
          credentialsId,
          ...(constructionArgs !== undefined ? { constructionArgs } : {}),
        }));
    this.currentImports = link?.imports;
    // The firing that started this run rides along in the provenance of every
    // graph write it makes. `suppress_self` — the 2-way-sync flag — is answered
    // from that marker alone (`didWeAuthor`), and without it an automated write
    // is indistinguishable from a human's: the flag reads "can't tell", nothing
    // fails, and every 2-way sync echoes itself. The marker went missing when
    // translation graphs died and their ids stopped being stamped; the trigger
    // event has carried it all along.
    this.mutationContext = {
      source: {
        type: 'structured_input',
        adapterType: input.event.adapterType,
        pipelineInputId: input.event.pipelineInputId,
      },
      // The event's own time when it reported one; otherwise the firing's —
      // "when the thing happened" falling back to "when we heard about it".
      occurredAt: input.event.occurredAt ?? this.pinnedNow.toISOString(),
    };
  }

  async run(program: Program): Promise<MovementRunResult> {
    this.declaredTypes = declaredTypesIn(program);
    const { movement, movementEnv } = await this.prepareMovement(program);
    this.movementBody = movement.body;
    this.callStack.push(movement);
    try {
      await this.interpretBody(movement.body, movementEnv, {
        atAnchor: true,
        position: this.source!.position,
        address: ROOT_ADDRESS,
      });
    } catch (e) {
      if (e instanceof RunCancelledSignal) {
        // User-requested cancel — settle handled by the caller (the firing
        // outcome carries cancelled: true → the run is failed + its open
        // requests cancelled). Earlier writes stand (P14).
        this.cancelled = true;
      } else if (e instanceof RunParked) {
        // The run reached an `ask` and is now durably parked — the park rows
        // are persisted and the trigger_run is `parked`. Earlier writes stand;
        // the run resumes when the answer arrives (chunk 5).
        this.parked = true;
        this.parkedAddress = e.address;
      } else if (!(e instanceof ScopeEndedQuietly)) {
        // A real failure — carry the ledger of what already landed out with it.
        throw new MovementRunFailed(e, this.assembleResult(movement.name));
      }
      // The swallowed case is find-on-missing at the top scope: the movement
      // body simply stops — earlier writes stand, the run completes normally.
    }

    await this.checkCancelBeforeFinishing();
    return this.assembleResult(movement.name);
  }

  /**
   * The run's LAST cancel check. Every boundary the run crosses consults the
   * gate, but a cancel stamped while the FINAL boundary's work was in flight has
   * no later boundary to be discovered at — and without this the run finalises
   * as a plain success: the operator pressed Stop, watched the run report that
   * it finished fine, and got no record that they had ever asked. A movement
   * whose whole body is one `extract` has exactly that shape, and it is the
   * common one.
   *
   * This does not undo anything. What already landed stands (P14) — all that
   * changes is what the run is RECORDED as, which is the part that was untrue.
   * Skipped when the run already knows it is cancelled or parked: a parked run's
   * cancel is settled by the park sink's own tail check.
   */
  private async checkCancelBeforeFinishing(): Promise<void> {
    if (this.cancelled || this.parked) return;
    if (this.input.cancelGate && (await this.input.cancelGate.cancelledNow())) {
      this.cancelled = true;
    }
  }

  /**
   * Resume a parked run forward from its parked leaf (async user interaction
   * §4.4/§4.7). The pinned program is the SAME `input.source` (the caller
   * re-parses the version-pinned source — P11 — so the AST is byte-identical);
   * `prepareMovement` re-derives the live source adapter + file scope exactly
   * as `run()` does. `resumeAlongAddress` then descends the body along the leaf's
   * lexical address — rehydrating each lexical scope (the shared ancestor spine +
   * the leaf's own local scope) and entering ONLY the named branch/iteration —
   * binds the answer `r`, and runs FORWARD from the statement after the ask
   * (forward-from-leaf, no re-run of prior statements — their effects committed,
   * their results are in the rehydrated scope). Handles a single linear ask AND
   * a fan-out / parallel / if-nested ask (chunk 3.2c). A re-park deeper throws
   * `RunParked` and the run stays parked.
   */
  async resume(input: {
    program: Program;
    state: ParkedScopeState;
    /** The validated answer graph `r` to bind at the ask's binding name. Absent
     *  under `reenter` (cost / error resume binds nothing). */
    answer?: Binding;
    /** Re-enter AT the parked statement (§4.4) instead of stepping past it.
     *  Defaults to the ask behaviour (false). */
    reenter?: boolean;
    /** Batch mode (F18/F21): defer race settlement so the worker settles once
     *  post-batch with all winners. Set by the await-resume worker only. */
    deferRaceSettlement?: boolean;
  }): Promise<MovementRunResult> {
    this.deferRaceSettlement = input.deferRaceSettlement ?? false;
    const { movement, movementEnv } = await this.prepareMovement(input.program);
    this.movementBody = movement.body;
    this.callStack.push(movement);

    const address = parseAddress(input.state.address);
    try {
      await this.resumeAlongAddress({
        body: movement.body,
        address,
        state: input.state,
        movementEnv,
        ...(input.answer !== undefined ? { answer: input.answer } : {}),
        reenter: input.reenter ?? false,
      });
    } catch (e) {
      if (e instanceof RunCancelledSignal) {
        // User-requested cancel during a resume — the caller settles the run
        // failed (cancelled: true). Earlier writes stand (P14).
        this.cancelled = true;
      } else if (e instanceof RunParked) {
        // The resumed branch hit ANOTHER ask — re-park at the deeper address.
        this.parked = true;
        this.parkedAddress = e.address;
      } else if (!(e instanceof ScopeEndedQuietly)) {
        throw new MovementRunFailed(e, this.assembleResult(movement.name));
      }
    }

    await this.checkCancelBeforeFinishing();
    return this.assembleResult(movement.name);
  }

  /**
   * Post-batch race settlement (asks-as-adapter chunk C, F18/F21). Builds the
   * receipt from EVERY completed branch's persisted exports (all winners),
   * cancels the still-parked losers (the one signal, P17), binds the receipt, and
   * runs the race's continuation forward. Re-enters PAST the race STATEMENT (not a
   * leaf): `input.state` is any completed branch's parked state — its scope chain
   * covers the race's parent, which is all the continuation needs.
   */
  /**
   * Run a fired callback's body as a SEGMENT of its owning run (callback-
   * primitive layer 2). The run keeps its identity, its team, its billing and
   * its step ledger — no new run identity anywhere. The main continuation stays
   * parked throughout: this entry runs the body and returns, and if the body
   * itself parks that is a leaf of its own.
   */
  async fireCallback(input: {
    program: Program;
    state: ParkedScopeState;
    values: Record<string, unknown>;
    callIndex: number;
  }): Promise<MovementRunResult> {
    const { movement, movementEnv } = await this.prepareMovement(input.program);
    this.movementBody = movement.body;
    this.callStack.push(movement);
    try {
      await this.resumeAlongAddress({
        body: movement.body,
        address: parseAddress(input.state.address),
        state: input.state,
        movementEnv,
        reenter: false,
        fireCallback: { values: input.values, callIndex: input.callIndex },
      });
    } catch (e) {
      if (e instanceof RunCancelledSignal) this.cancelled = true;
      else if (e instanceof RunParked) {
        this.parked = true;
        this.parkedAddress = e.address;
      } else if (!(e instanceof ScopeEndedQuietly)) {
        throw new MovementRunFailed(e, this.assembleResult(movement.name));
      }
    }
    await this.checkCancelBeforeFinishing();
    return this.assembleResult(movement.name);
  }

  async settleRaceFrame(input: {
    program: Program;
    state: ParkedScopeState;
    frameAddress: string;
  }): Promise<MovementRunResult> {
    const { movement, movementEnv } = await this.prepareMovement(input.program);
    this.movementBody = movement.body;
    this.callStack.push(movement);
    const frameAddr = parseAddress(input.frameAddress);
    const race = this.raceStatementAt(movement.body, frameAddr);
    if (race === undefined) {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `settleRace: no race statement at frame '${input.frameAddress}'`,
      );
    }

    // 1. The receipt = every arm that settled in this batch, in slot order —
    //    ties included, which is what makes more than one filled slot legal.
    const rows = await this.input.parkSink!.collectBranchExports({
      frameAddress: input.frameAddress,
    });
    const receipt = await this.receiptFromExports(
      rows,
      race.branchCount,
      this.rehydrationContext(),
    );

    // 2. Stop listening on the arms still parked (an arm that settled already
    //    dropped its parked_run + correlation, so this is a no-op on those).
    const loserSubtrees: string[] = [];
    for (let j = 0; j < race.branchCount; j++) {
      loserSubtrees.push(encodeAddress(childBranch(frameAddr, j)));
    }
    await this.input.parkSink!.cancelSubtrees({ subtreeAddresses: loserSubtrees });

    // 3. Run the continuation: re-enter PAST the race statement, binding the
    //    receipt at the race's name (a bare race binds nothing).
    const continuationState: ParkedScopeState = {
      version: 1,
      address: input.frameAddress,
      bindingName: race.bindingName ?? null,
      scopeChain: input.state.scopeChain,
    };
    try {
      await this.resumeAlongAddress({
        body: movement.body,
        address: frameAddr,
        state: continuationState,
        movementEnv,
        ...(race.bindingName !== undefined ? { answer: receipt } : {}),
        reenter: false,
      });
    } catch (e) {
      if (e instanceof RunCancelledSignal) this.cancelled = true;
      else if (e instanceof RunParked) {
        this.parked = true;
        this.parkedAddress = e.address;
      } else if (!(e instanceof ScopeEndedQuietly)) {
        throw new MovementRunFailed(e, this.assembleResult(movement.name));
      }
    }
    return this.assembleResult(movement.name);
  }

  /** Resolve the combinator statement at a frame address (its arm count +
   *  binding name) by walking the address' container spine — the settlement
   *  needs these before it can build the receipt and run the continuation. */
  private raceStatementAt(
    body: Statement[],
    address: Address,
  ): { branchCount: number; bindingName?: string } | undefined {
    let statements = body;
    let i = 0;
    while (i < address.length) {
      const step = address[i];
      if (step.kind !== 'stmt') return undefined;
      const stmt = statements[step.index];
      if (stmt === undefined) return undefined;
      if (i === address.length - 1) {
        const combinator = combinatorOf(stmt);
        if (combinator === undefined) return undefined;
        return {
          branchCount: literalArmsOf(combinator).length,
          ...(stmt.kind === 'assign' ? { bindingName: stmt.name } : {}),
        };
      }
      const childBody = this.containerBody(stmt, address[i + 1]);
      if (childBody === undefined) return undefined;
      statements = childBody;
      i += 2;
    }
    return undefined;
  }

  /** The child statement list a descent step enters (fan-out body / if-arm /
   *  combinator arm) — the pure navigation half of `descendForResume`, used by
   *  `raceStatementAt`. */
  private containerBody(container: Statement, step: AddressStep): Statement[] | undefined {
    if (step.kind === 'iter') {
      const block =
        container.kind === 'block'
          ? container.block
          : container.kind === 'assign' && container.value.kind === 'block'
            ? container.value.block
            : undefined;
      return block?.body;
    }
    if (container.kind === 'if') {
      const arm = container.arms[step.index];
      return arm ? arm.body : container.elseArm?.body;
    }
    return this.armBodyAt(container, step.index);
  }

  /**
   * The body of one combinator arm, by position. A closure arm carries its own
   * body; an arm that is a NAME carries a movement's, which resume finds the
   * same way the checker resolved it — by name in this program. An arm from an
   * imported library, or one built at run time, has no body to navigate to from
   * here: resume says so rather than guessing.
   */
  private armBodyAt(container: Statement, index: number): Statement[] | undefined {
    const arm = literalArmsOf(combinatorOf(container))[index];
    if (arm === undefined) return undefined;
    if (arm.kind === 'closure') return arm.closure.body;
    const declaration = this.movementDeclaration(arm.name);
    return declaration?.body;
  }

  /** A movement declared in the running program, by name. */
  private movementDeclaration(name: string): MovementDeclaration | undefined {
    const binding = this.fileEnv?.resolve(name);
    return binding?.kind === 'movement' ? binding.declaration : undefined;
  }

  /**
   * Forward-from-the-leaf resume (§4.4, chunk 3.2c). Descends the movement body
   * along the parked leaf's lexical ADDRESS — entering ONLY the branch/iteration
   * the address names (never re-running siblings), rehydrating each lexical
   * scope as it descends (the shared ancestor spine + the leaf's own local scope,
   * §4.6) — until it reaches the leaf's enclosing statement sequence. There it
   * binds the answer and runs FORWARD from the statement AFTER the ask, executing
   * the rest of THAT branch (e.g. a fan-out iteration's `if ok { write }`) to its
   * end. A re-park deeper re-throws `RunParked`.
   *
   * The address structure does the routing: `stmt i` selects a statement (the
   * final `stmt` is the ask's — resume at `i+1`); `iter j` descends a fan-out
   * body; `branch k` descends a parallel branch / if-arm. Each `iter`/`branch`
   * step corresponds to one child scope in the parked chain (the interpreter
   * forks a child env at exactly those points), so the chain is consumed in
   * lockstep with the descent.
   */
  private async resumeAlongAddress(input: {
    body: Statement[];
    address: Address;
    state: ParkedScopeState;
    movementEnv: Environment;
    /** The answer to bind at the ask's binding name. Absent under `reenter`. */
    answer?: Binding;
    /** Re-enter AT the parked (un-run) statement rather than past the ask (§4.4). */
    reenter: boolean;
    /**
     * CALLBACK FIRE (callback-primitive layer 2) — a THIRD leaf rule. The leaf
     * statement is a `callback(…)` mint, already run; what this entry runs is
     * its BODY, in a child scope carrying the fire-time values. It deliberately
     * does NOT continue the enclosing sequence and does NOT unwind the spine:
     * that continuation is the MAIN one, still parked, and it wakes only through
     * its own mechanism. One run, multiple entry points.
     */
    fireCallback?: { values: Record<string, unknown>; callIndex: number };
  }): Promise<void> {
    const { address, state } = input;
    if (address.length === 0 || address[address.length - 1].kind !== 'stmt') {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `malformed parked address '${state.address}' — a parked leaf ends at a statement`,
      );
    }
    // The parked scope chain is root-first: [fileEnv, movementEnv, <scope per
    // iter/branch step>…]. The file scope + movement param are rebuilt live by
    // prepareMovement; index 1 (the movement-body scope) carries the body locals
    // declared before the ask. Re-layer those onto the live movementEnv.
    await this.rehydrateScopeInto(state, 1, input.movementEnv);

    // Walk the address: descend into the named container at each non-final
    // statement, forking + rehydrating a child scope at each iter/branch, until
    // the leaf's own statement sequence. `chainIndex` tracks the next scope to
    // consume (2 = the first iter/branch scope after the movement body).
    let statements = input.body;
    let env = input.movementEnv;
    let frameAddress: Address = ROOT_ADDRESS;
    let position = this.source!.position;
    let atAnchor = true;
    let chainIndex = 2;
    // The descent spine (§3): one frame per container level we pass through, so
    // the leaf-block completion can UNWIND back out and run each ancestor's
    // post-container continuation (§4). Empty for a linear leaf (no-op unwind).
    const spine: ResumeAncestorFrame[] = [];

    for (let i = 0; i < address.length; i++) {
      const stmtStep = address[i];
      if (stmtStep.kind !== 'stmt') {
        throw new MovementEngineError(
          'MOVENG_RUNTIME',
          `parked address '${state.address}' step ${i} is '${stmtStep.kind}', expected a statement`,
        );
      }
      const stmtAddress = childStmt(frameAddress, stmtStep.index);

      // The FINAL step is the parked leaf's own statement. Two modes (§4.4):
      //   - ASK resume (reenter=false): the leaf IS the ask; bind the answer at
      //     its binding name and step FORWARD from the statement AFTER it.
      //   - RE-ENTER resume (reenter=true): the leaf's statement must be
      //     RE-EVALUATED (an `await`, a recurring `until` timer); bind nothing
      //     and RE-ENTER AT it, running it and the rest of this branch forward.
      if (i === address.length - 1) {
        if (input.fireCallback !== undefined) {
          await this.runCallbackBody({
            statement: statements[stmtStep.index],
            stmtAddress,
            env,
            atAnchor,
            position,
            values: input.fireCallback.values,
            callIndex: input.fireCallback.callIndex,
          });
          return;
        }
        if (!input.reenter && state.bindingName !== null && input.answer !== undefined) {
          env.declare(state.bindingName, input.answer);
        } else if (!input.reenter && state.presenceBind && state.bindingName !== null) {
          // A bound `await sleep(…)` woke: inject the presence marker (no answer
          // channel — the clock is the wake source) so `expired` escapes onto the
          // race receipt (chunk C, S4).
          env.declare(state.bindingName, { kind: 'value', value: true, provenance: NO_PROVENANCE });
        }
        const resumeIndex = input.reenter ? stmtStep.index : stmtStep.index + 1;
        // Run the parked leaf's OWN remaining statements. May throw RunParked (a
        // re-park deeper) — that propagates to `resume()`'s catch (§8), and the
        // unwind below never runs (the branch is parked, not complete).
        await this.interpretBody(
          statements,
          env,
          { atAnchor, position, address: frameAddress },
          resumeIndex,
        );
        // The leaf block completed — UNWIND the spine, rebuilding normal
        // execution's return-from-block (§4), and return.
        await this.unwindSpine(spine, state.address);
        return;
      }

      // A non-final statement: it is a container; the NEXT step descends into it.
      const container = statements[stmtStep.index];
      const descent = address[i + 1];
      const descended = this.descendForResume({
        container,
        step: descent,
        stmtAddress,
        state,
      });
      // Fork a child env carrying the rehydrated scope for this iter/branch.
      const childEnv = env.child();
      await this.rehydrateScopeInto(state, chainIndex, childEnv);
      chainIndex += 1;
      // Remember this container level so the leaf-block completion can unwind back
      // out and run its post-container continuation (§3). Captured with the CURRENT
      // (parent) level, BEFORE the reassignment below overwrites it.
      spine.push({
        parentStatements: statements,
        parentEnv: env,
        parentFrameAddress: frameAddress,
        parentAtAnchor: atAnchor,
        parentPosition: position,
        container,
        containerIndex: stmtStep.index,
        containerAddress: stmtAddress,
        descentKind: descent.kind,
        childEnv,
        branchAddress: descended.frameAddress,
        branchIndex: descent.index,
      });
      statements = descended.statements;
      env = childEnv;
      frameAddress = descended.frameAddress;
      atAnchor = descended.atAnchor;
      if (descended.position !== undefined) position = descended.position;
      i += 1; // consumed the descent step
    }
  }

  /**
   * The join-aware unwind (§4). Deepest ancestor first, rebuild normal
   * execution's return-from-block: for a JOIN frame (fan-out iteration / parallel
   * branch) persist THIS branch's exports (§12.1), decrement the join, and — only
   * for the unique branch that closes it — merge every branch's exports into the
   * parent (§12.4) and run the post-container continuation. For a non-join (`if`
   * arm) frame just run the continuation. A `RunParked` thrown by a continuation
   * (a trailing sleep/ask/cost re-exhaustion) propagates naturally (§8).
   */
  private async unwindSpine(spine: ResumeAncestorFrame[], leafAddress: string): Promise<void> {
    // The join-aware unwind coordinates durable joins through the park sink
    // (persist / decrement / collect). A resume with no sink is a degenerate
    // test-only mode with no durable join to close — complete only the leaf block,
    // exactly as before the unwind existed. Production resume always has a sink.
    if (this.input.parkSink === undefined) return;
    for (let f = spine.length - 1; f >= 0; f--) {
      const frame = spine[f];

      // A combinator ARM is a `branch k` frame. `race` settles on the first
      // completer (pending 1); `parallel` is an ordinary join (pending N).
      const combinator =
        frame.descentKind === 'branch' ? combinatorOf(frame.container) : undefined;
      const isRace = combinator?.kind === 'race';
      const isJoin = frame.descentKind === 'iter' || combinator?.kind === 'parallel';

      if (isRace) {
        // A race ARM completed. Persist its export, then claim the race frame
        // (pending 1 — FIRST completer wins). The winner stops listening on the
        // still-parked arms (one signal per park), builds the receipt, and runs
        // the continuation; a non-winner (already claimed) did its writes and
        // stops — the run stays parked on the winner's continuation, if any.
        await this.input.parkSink!.persistBranchExport({
          frameAddress: encodeAddress(frame.containerAddress),
          branchAddress: encodeAddress(frame.branchAddress),
          branchIndex: frame.branchIndex,
          exports: this.serializeBranchExport(frame),
        });
        const { closed } = await this.input.parkSink!.decrementJoin({
          frameAddress: encodeAddress(frame.containerAddress),
          branchAddress: encodeAddress(frame.branchAddress),
          leafAddress,
        });
        if (this.deferRaceSettlement) {
          // Batch mode (F18/F21): this branch WON, but other branches of the same
          // batch may still complete. Record the export (done above) and defer the
          // settlement — the worker runs every resolvable branch first, then
          // settles once via `settleRaceFrame` with ALL winners. The branch's
          // writes stand; the run stays parked until the post-batch settle.
          this.deferredRaceFrames.add(encodeAddress(frame.containerAddress));
          return;
        }
        if (!closed) return; // a sibling already won this race (inline mode)
        await this.settleRaceWinner(frame, leafAddress);
        await this.interpretBody(
          frame.parentStatements,
          frame.parentEnv,
          {
            atAnchor: frame.parentAtAnchor,
            position: frame.parentPosition,
            address: frame.parentFrameAddress,
          },
          frame.containerIndex + 1,
        );
        continue;
      }

      if (isJoin) {
        // Persist THIS branch's export contribution durably, keyed by the join
        // frame + this branch, BEFORE decrementing (§12.1) — so by the time ANY
        // branch observes `closed`, every sibling's export row is committed.
        await this.input.parkSink!.persistBranchExport({
          frameAddress: encodeAddress(frame.containerAddress),
          branchAddress: encodeAddress(frame.branchAddress),
          branchIndex: frame.branchIndex,
          exports: this.serializeBranchExport(frame),
        });
        const { closed } = await this.input.parkSink!.decrementJoin({
          frameAddress: encodeAddress(frame.containerAddress),
          branchAddress: encodeAddress(frame.branchAddress),
          leafAddress,
        });
        if (!closed) {
          // Not the last branch — this branch is done (its writes stand), the join
          // stays pending, the run stays parked. Do NOT run the continuation.
          return;
        }
        // We ARE the closer — fold ALL branches' exports into the parent (§12.4),
        // then fall through to run the deferred post-container continuation.
        await this.mergeJoinBranch(frame);
      }
      // Non-join (`if` arm): arm bindings are block-scoped — nothing to merge.

      await this.interpretBody(
        frame.parentStatements,
        frame.parentEnv,
        {
          atAnchor: frame.parentAtAnchor,
          position: frame.parentPosition,
          address: frame.parentFrameAddress,
        },
        frame.containerIndex + 1,
      );
    }
  }

  /**
   * Fold a closed JOIN frame's branch exports into the parent env exactly as
   * normal execution's join (§5/§12.4) — reconstructing the aggregate from ALL
   * branches' persisted exports (not just the closer's live env), so a
   * continuation that reads a non-closer sibling's binding, or the full fan-out
   * `blockMeta` across every iteration, sees the same data a never-parked run
   * would.
   */
  private async mergeJoinBranch(frame: ResumeAncestorFrame): Promise<void> {
    const rows = await this.input.parkSink!.collectBranchExports({
      frameAddress: encodeAddress(frame.containerAddress),
    });
    const ctx = this.rehydrationContext();

    // `await parallel([…])`: the receipt from every arm's export — the same
    // positional value the never-parked path builds, so a run that parked and a
    // run that did not read identically.
    const combinator = combinatorOf(frame.container);
    if (combinator !== undefined) {
      const bindingName = frame.container.kind === 'assign' ? frame.container.name : undefined;
      if (bindingName === undefined) return;
      frame.parentEnv.declare(
        bindingName,
        await this.receiptFromExports(rows, literalArmsOf(combinator).length, ctx),
      );
      return;
    }

    // Assigned fan-out: the block's value is what its iterations RETURNED, in
    // iteration order — mirrors interpretBlock. A return rides out of a parked
    // iteration as the reserved slot in its export, which is the whole reason
    // it is bound into the scope rather than only carried as an outcome. A bare
    // (unbound) fan-out declares nothing.
    const bindingName = frame.container.kind === 'assign' ? frame.container.name : undefined;
    if (bindingName === undefined) return;
    const returned: Binding[] = [];
    for (const row of rows) {
      const exports = row.exports as Record<string, BindingDescriptor>;
      const descriptor = exports[RETURN_SLOT];
      if (descriptor !== undefined) returned.push(await rehydrateBinding(descriptor, ctx));
    }
    frame.parentEnv.declare(bindingName, blockValue(returned));
  }

  /**
   * The race winner's settlement (asks-as-adapter chunk C): cancel every LOSER
   * branch's subtree (the one signal to each still-parked leaf, P17), then bind
   * the RECEIPT on the parent env from the completed branches' persisted exports
   * (only the winner(s) completed; parked losers persisted nothing). A bare
   * `race` binds nothing. Mirrors `mergeJoinBranch`'s rehydrate-from-exports so a
   * resumed receipt reads exactly as a never-parked one would.
   */
  private async settleRaceWinner(frame: ResumeAncestorFrame, leafAddress: string): Promise<void> {
    const armCount = literalArmsOf(combinatorOf(frame.container)).length;
    // Every arm's subtree is withdrawn — the winner's own parked row may still
    // exist mid-resume, so it is spared by ADDRESS, never by ordering.
    const loserSubtrees: string[] = [];
    for (let j = 0; j < armCount; j++) {
      loserSubtrees.push(encodeAddress(childBranch(frame.containerAddress, j)));
    }
    if (loserSubtrees.length > 0) {
      await this.input.parkSink!.cancelSubtrees({
        subtreeAddresses: loserSubtrees,
        excludeLeaf: leafAddress,
      });
    }

    const bindingName = frame.container.kind === 'assign' ? frame.container.name : undefined;
    if (bindingName === undefined) return;
    const rows = await this.input.parkSink!.collectBranchExports({
      frameAddress: encodeAddress(frame.containerAddress),
    });
    frame.parentEnv.declare(
      bindingName,
      await this.receiptFromExports(rows, armCount, this.rehydrationContext()),
    );
  }

  /**
   * The receipt, rebuilt from the arms' persisted exports: slot i is what arm i
   * RETURNED, which rode out of its park in the reserved return slot of its
   * branch export. An arm that never completed left no row, so its slot is null
   * — which for a race is exactly "this one did not win".
   */
  private async receiptFromExports(
    rows: Array<{ branchIndex: number; exports: unknown }>,
    armCount: number,
    ctx: RehydrationContext,
  ): Promise<Binding> {
    const slots: Binding[] = new Array(armCount).fill(NULL_SLOT);
    for (const row of rows) {
      const exports = row.exports as Record<string, BindingDescriptor>;
      const descriptor = exports[RETURN_SLOT];
      if (descriptor === undefined) continue;
      if (row.branchIndex < 0 || row.branchIndex >= slots.length) continue;
      slots[row.branchIndex] = await rehydrateBinding(descriptor, ctx);
    }
    return { kind: 'tuple', slots };
  }

  /**
   * Serialize a completed branch's exports (§12.3) — its child env's own
   * bindings, via `serializeBinding`. A fan-out iteration EXCLUDES the head's
   * hop-alias names (the loop variables are not exports — mirrors interpretBlock's
   * `iteration.bindings.has(name)` skip). The alias names are static in the block
   * head, derived I/O-free from the container shape; over-inclusion (a leaked loop
   * var) is fail-safe, a dropped export is not.
   */
  private serializeBranchExport(frame: ResumeAncestorFrame): Record<string, BindingDescriptor> {
    const out: Record<string, BindingDescriptor> = {};
    const skip = frame.descentKind === 'iter' ? this.hopAliasNamesOf(frame.container) : undefined;
    for (const [name, binding] of frame.childEnv.ownBindings()) {
      if (skip?.has(name)) continue;
      out[name] = serializeBinding(binding);
    }
    return out;
  }

  /** The static hop-alias names of a fan-out container's block head (§12.3) —
   *  exactly the alias slots `resolveBlockIterations` binds per iteration. Parsed
   *  from the head text (no I/O), matching the runtime `iteration.bindings` keys. */
  private hopAliasNamesOf(container: Statement): Set<string> {
    const block =
      container.kind === 'block'
        ? container.block
        : container.kind === 'assign' && container.value.kind === 'block'
          ? container.value.block
          : undefined;
    const names = new Set<string>();
    if (!block) return names;
    const resourceAlias = RESOURCES_HEAD_ALIAS.exec(block.head.hopsRaw)?.[1];
    if (resourceAlias !== undefined) names.add(resourceAlias);
    const probe = this.probeHead(block.head);
    if (probe?.type === 'traverse') {
      for (const step of probe.steps) {
        if ('alias' in step && step.alias !== undefined) names.add(step.alias);
      }
    }
    return names;
  }

  /**
   * Resolve one descent step (`iter j` / `branch k`) into the AST node + the
   * frame address it lands on. Mirrors `interpretIf` / `interpretParallel` /
   * `interpretBlock`'s branch/iteration structure exactly (so the address the
   * firing computed re-resolves to the same sequence).
   */
  private descendForResume(input: {
    container: Statement;
    step: AddressStep;
    stmtAddress: Address;
    state: ParkedScopeState;
  }): {
    statements: Statement[];
    frameAddress: Address;
    atAnchor: boolean;
    position?: SourcePosition;
  } {
    const { container, step, stmtAddress, state } = input;
    if (step.kind === 'iter') {
      const block =
        container.kind === 'block'
          ? container.block
          : container.kind === 'assign' && container.value.kind === 'block'
            ? container.value.block
            : undefined;
      if (!block) {
        throw new MovementEngineError(
          'MOVENG_RUNTIME',
          `resume: address descends 'iter' into a non-fan-out statement (parked '${state.address}')`,
        );
      }
      // The iteration body; its position (the yielded record) is NOT re-derived —
      // the rehydrated iteration scope already holds the iteration's bindings.
      return {
        statements: block.body,
        frameAddress: childIter(stmtAddress, step.index),
        atAnchor: false,
      };
    }
    // branch k — an if-arm or a combinator arm.
    if (container.kind === 'if') {
      const arm = container.arms[step.index];
      const armBody = arm ? arm.body : container.elseArm?.body;
      if (!armBody) {
        throw new MovementEngineError(
          'MOVENG_RUNTIME',
          `resume: if branch ${step.index} has no body (parked '${state.address}')`,
        );
      }
      return {
        statements: armBody,
        frameAddress: childBranch(stmtAddress, step.index),
        atAnchor: true,
      };
    }
    if (combinatorOf(container) !== undefined) {
      const armBody = this.armBodyAt(container, step.index);
      if (armBody === undefined) {
        throw new MovementEngineError(
          'MOVENG_RUNTIME',
          `resume: no body for arm ${step.index} of this combinator (parked '${state.address}')`,
        );
      }
      return {
        statements: armBody,
        frameAddress: childBranch(stmtAddress, step.index),
        atAnchor: false,
      };
    }
    throw new MovementEngineError(
      'MOVENG_RUNTIME',
      `resume: address descends 'branch' into a '${container.kind}' statement (parked '${state.address}')`,
    );
  }

  /**
   * Rehydrate the parked chain's scope at `chainIndex` INTO `env`. Skips bindings
   * `prepareMovement` already bound live (the event param, and file-scope code
   * refs / instances that live in the parent file env). A missing chain entry is
   * a no-op (a shallow leaf has fewer scopes than a deep one).
   */
  private async rehydrateScopeInto(
    state: ParkedScopeState,
    chainIndex: number,
    env: Environment,
  ): Promise<void> {
    const scope = state.scopeChain[chainIndex];
    if (!scope) return;
    const ctx = this.rehydrationContext();
    for (const [name, descriptor] of Object.entries(scope.bindings)) {
      if (descriptor.kind === 'event') continue;
      if (
        env.resolve(name) !== undefined &&
        (descriptor.kind === 'instance' ||
          descriptor.kind === 'movement' ||
          descriptor.kind === 'shape')
      ) {
        continue;
      }
      env.declare(name, await rehydrateBinding(descriptor, ctx));
    }
  }

  private assembleResult(movementName: string): MovementRunResult {
    return {
      movementName,
      writes: this.writes,
      extractionSites: this.summariser.sites,
      trace: this.trace,
      ...(this.parked ? { parked: true } : {}),
      ...(this.parkedAddress !== undefined ? { parkedAddress: this.parkedAddress } : {}),
      ...(this.cancelled ? { cancelled: true } : {}),
      ...(this.deferredRaceFrames.size > 0
        ? { deferredRaceFrames: [...this.deferredRaceFrames] }
        : {}),
    };
  }

  /**
   * The rehydration seam (§4.1) backed by THIS interpreter's already-prepared
   * live context — the same registry / adapter resolution `prepareMovement`
   * wired. Adapters re-resolve via `graphReadFor` / the catalog; FileRefs revive
   * via the owner adapter; code refs come from the re-parsed file env.
   */
  private rehydrationContext(): RehydrationContext {
    return {
      resolveInstance: async (identity) => this.rehydrateInstance(identity),
      resolveSourceRead: async (instanceName) => {
        const binding = this.fileEnv?.resolve(instanceName);
        if (!binding) {
          throw new MovementEngineError(
            'MOVENG_RUNTIME',
            `resume: cannot rebind read seam for instance '${instanceName}' — not in the re-parsed file scope`,
          );
        }
        const read = await this.graphReadFor(instanceName, binding);
        if (!read) {
          throw new MovementEngineError(
            'MOVENG_RUNTIME',
            `resume: '${instanceName}' is not a readable graph`,
          );
        }
        return read.read;
      },
      reviveFileRef: (descriptor) => this.reviveResumedFileRef(descriptor),
      resolveCodeRef: (name) => {
        const binding = this.fileEnv?.resolve(name);
        if (!binding) {
          throw new MovementEngineError(
            'MOVENG_RUNTIME',
            `resume: cannot re-resolve code ref '${name}' from the re-parsed program`,
          );
        }
        return binding;
      },
    };
  }

  /** Re-resolve an instance binding from its serialised identity — the catalog
   *  re-instantiates its schema live (honest drift if the external schema
   *  changed, §4.1). */
  private rehydrateInstance(
    identity: InstanceIdentityDescriptor,
  ): Extract<Binding, { kind: 'instance' }> {
    const args: Record<string, string> = { ...(identity.constructionConfig ?? {}) };
    const spec = this.input.catalog.adapter(identity.adapterSlug);
    const credentialArg = (spec && credentialArgOf(spec)?.name) ?? 'credentials';
    if (identity.credentialName !== undefined) args[credentialArg] = identity.credentialName;
    return {
      kind: 'instance',
      name: identity.name,
      adapterSlug: identity.adapterSlug,
      ...(identity.credentialName !== undefined ? { credentialName: identity.credentialName } : {}),
      ...(identity.constructionConfig !== undefined
        ? { constructionConfig: identity.constructionConfig }
        : {}),
      schema: this.input.catalog.instantiate(identity.adapterSlug, args),
    };
  }

  /**
   * Rebind a parked FileRef's `retrieve()` from its `source` handle — the owner
   * adapter's `resolveFileRef`, re-resolved live via `resolveAdapter` (the same
   * cross-wire revive pattern, §4.1). A FileRef with no `source` (a local
   * producer's self-contained closure that didn't survive the wire) can't be
   * re-bound; it returns sans `retrieve()` and `streamFileRef` fails loud if a
   * consumer reaches for the bytes.
   */
  private reviveResumedFileRef(descriptor: FileRefDescriptor): FileRef {
    const ref: FileRef = {
      __brand: 'FileRef',
      ...(descriptor.name !== undefined ? { name: descriptor.name } : {}),
      ...(descriptor.contentType !== undefined ? { contentType: descriptor.contentType } : {}),
      ...(descriptor.size !== undefined ? { size: descriptor.size } : {}),
      ...(descriptor.source !== undefined ? { source: descriptor.source } : {}),
    };
    const source = descriptor.source;
    if (source) {
      ref.retrieve = async () => {
        const owner = await this.resolveAdapterFn({
          adapterType: source.ownerAdapterType,
          teamId: this.input.teamId,
          role: 'source',
        });
        if (!owner.resolveFileRef) {
          throw new MovementEngineError(
            'MOVENG_RUNTIME',
            `resume: owner adapter '${source.ownerAdapterType}' cannot resolve a parked FileRef`,
          );
        }
        return owner.resolveFileRef({ ref });
      };
    }
    return ref;
  }

  /**
   * The live source setup shared by `run()` and `resume()`: the file scope
   * (imports / instances / movements), movement selection, and the source
   * adapter the entry movement's parameter is typed against. Returns the
   * movement + its movement-body env (the param declared); the source position
   * lands on `this.source`.
   */
  private async prepareMovement(
    program: Program,
  ): Promise<{ movement: MovementDeclaration; movementEnv: Environment }> {
    const fileEnv = new Environment();

    // File scope, pass 1 — declarations only (constructions are inert
    // data; adapters resolve lazily at first read/write). Movements are
    // collected; deferred value expressions evaluate in pass 2 below so
    // program order holds for anything they could observe.
    const movements: MovementDeclaration[] = [];
    const deferredFileStatements: Statement[] = [];
    for (const statement of program.statements) {
      if (statement.kind === 'movement') {
        movements.push(statement);
        fileEnv.declare(statement.name, { kind: 'movement', declaration: statement });
      } else {
        deferredFileStatements.push(statement);
      }
    }

    const movement = this.selectMovement(movements);
    for (const statement of deferredFileStatements) {
      await this.interpretFileStatement(statement, fileEnv);
    }
    this.fileEnv = fileEnv;

    // The DISPATCHED movement takes exactly the triggering event —
    // dispatch supplies one position. Multi-parameter movements are
    // library movements (callees); the checker enforces the arity-1
    // rule on listen/run entries, so reaching this means a direct
    // invocation picked a callee-only movement.
    if (movement.params.length !== 1) {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `'${movement.name}' takes ${movement.params.length} parameters — a dispatched movement takes exactly one (the triggering event); multi-parameter movements run as callees`,
      );
    }
    const param = movement.params[0];
    if (param.type === undefined) {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `'${movement.name}' has an untyped parameter — the checker should have caught this`,
      );
    }
    const paramType = param.type;
    const sourceBinding = fileEnv.resolve(paramType.graph);
    if (sourceBinding?.kind === 'instance') {
      const sourceAdapter = await this.resolveAdapterFn({
        adapterType: sourceBinding.adapterSlug,
        teamId: this.input.teamId,
        credentialsId: this.credentialsIdFor(sourceBinding),
        role: 'source',
      });
      // The program reads the source by NATURAL names; the wrapper
      // translates them to the adapter's internal ids through the
      // instance's own resolver (and stamps landed positions with natural
      // type names). The parameter's declared type names the root position.
      const wrapped = surfaceReadAdapter({
        inner: sourceAdapter,
        schema: sourceBinding.schema,
        ...(paramType.position !== undefined ? { startSurfaceType: paramType.position } : {}),
      });
      // The discriminated root carries the adapter's positionType (a machine
      // typeId, e.g. `granola:note`); resolve it to its NATURAL type name so the
      // seed names the root the way the program + field/edge resolver do. NOT
      // the parameter's declared type — discrimination may have narrowed below
      // it (a broad param + an `IS` arm), and where an inbound event carries no
      // discrimination at all the position stays TYPELESS on purpose: `IS` must
      // refuse rather than guess.
      //
      // A MUTATION event is the one kind with nothing to discriminate: it
      // names the changed record's id, and the trigger names its type. What it
      // SEEDS is still the event (D40) — the listen fires the change, and the
      // changed record is one hop along the event's subject edge — so the type
      // is read off the adapter's own event surface rather than off the
      // parameter. The declared parameter cannot serve here: an event-typed
      // parameter is written as a narrowed ADDRESS, which carries no plain
      // position, so falling back to it seeds a TYPELESS root and every hop off
      // the event (including the hop to its own record) becomes unresolvable.
      const rootSurfaceType =
        (await naturalRootTypeName(sourceAdapter, this.input.event.rootRecordType)) ??
        (this.input.event.triggerType === 'mutation'
          ? (soleEventPosition(sourceBinding.schema) ?? paramType.position)
          : undefined);
      // A typed event seeds the EVENT NODE, typed by its canonical narrowed
      // address (the node the event edge lands on, its pins read off the
      // payload's own address fields + `action`) — an unstable occurrence
      // whose record is reached by its `record` edge. Otherwise the
      // discriminated object type names the root.
      const eventAddress = eventSeedAddress({
        schema: sourceBinding.schema,
        event: this.input.event,
        rootTypeName: rootSurfaceType,
      });
      this.sourceEventAddress = eventAddress;
      this.source = {
        adapter: wrapped,
        position: seedEventPosition(this.input.event, sourceBinding.adapterSlug, {
          ...(rootSurfaceType !== undefined ? { surfaceType: rootSurfaceType } : {}),
          ...(eventAddress !== undefined ? { eventAddress } : {}),
        }),
        instanceName: sourceBinding.name,
      };
      this.sourceInstance = sourceBinding;
      if (this.input.event.triggerType === 'snapshot') {
        // The snapshot envelope carries no adapter identity of its own
        // (run_now.ts builds it before the program is parsed) — the source
        // instance is canonical for the run's mutation context.
        this.mutationContext = {
          ...this.mutationContext,
          source: {
            ...this.mutationContext.source,
            type: 'structured_input',
            adapterType: sourceBinding.adapterSlug,
          },
        };
      }
    } else {
      throw unsupported(
        `a movement parameter typed against '${paramType.graph}'`,
        'type the parameter against a constructed adapter instance',
      );
    }

    const movementEnv = fileEnv.child();
    movementEnv.declare(param.name, { kind: 'event' });
    return { movement, movementEnv };
  }

  private selectMovement(movements: MovementDeclaration[]): MovementDeclaration {
    const movement = this.input.movementName
      ? movements.find((m) => m.name === this.input.movementName)
      : movements.length === 1
        ? movements[0]
        : undefined;
    if (!movement) {
      throw new MovementEngineError(
        'MOVENG_NOT_FOUND',
        this.input.movementName
          ? `no movement named '${this.input.movementName}' in this program`
          : `expected exactly one movement declaration (found ${movements.length}) — pass movementName to pick one`,
      );
    }
    return movement;
  }

  // ── File scope ──

  private async interpretFileStatement(statement: Statement, env: Environment): Promise<void> {
    switch (statement.kind) {
      case 'import':
        if (statement.source.kind === 'file') {
          if (!this.currentImports) {
            throw unsupported(
              `the file import "${statement.source.path}"`,
              'this run has no file resolver — pass resolveFile to runMovement',
            );
          }
          await this.declareFileImports(statement.names, statement.source.path, env);
          return;
        }
        for (const { name, alias } of statement.names) {
          if (alias !== undefined) this.importOriginals.set(alias, name);
          // A bare adapter import is NOT an instance — instantiation is
          // explicit (`go = manual()`). The import name binds opaque; an
          // instance exists only from a construction (the `assign` case
          // below). The checker rejects a bare import used as a position
          // source or `listen to`, so the runtime never needs the old lazy
          // binding (spec plans/2026-06-24-required-instantiation/0_spec.md).
          env.declare(alias ?? name, { kind: 'opaque', what: 'import' });
        }
        return;
      case 'assign':
        switch (statement.value.kind) {
          case 'construct':
            // The construction-shaped spelling of a CALL reaches here too, and
            // means the same thing it means anywhere: run the movement. There
            // is nothing at file scope to run it about.
            if (env.resolve(statement.value.construct.callee)?.kind === 'movement') {
              throw fileLevelCall();
            }
            env.declare(
              statement.name,
              this.instanceBinding(statement.name, statement.value.construct),
            );
            return;
          case 'call':
            throw fileLevelCall();
          case 'expr': {
            const aliased = this.aliasedNodeBinding(statement.value.expr, env);
            if (aliased !== undefined) {
              env.declare(statement.name, aliased);
              return;
            }
            const selected = await this.selectedPositionBinding(statement.value.expr, env);
            if (selected !== undefined) {
              env.declare(statement.name, selected);
              return;
            }
            const { value, provenance } = await this.evaluateSlot(statement.value.expr, { env });
            env.declare(statement.name, { kind: 'value', value, provenance });
            return;
          }
          case 'extract':
            throw unsupported(
              'file-level extract expressions',
              'extraction runs inside a movement body, where the event is in scope',
            );
          case 'block':
            throw unsupported('file-level traversal blocks', 'blocks run inside a movement body');
          case 'write':
            throw unsupported('file-level writes', 'writes run inside a movement body');
          case 'link':
            throw unsupported('file-level link statements', 'links run inside a movement body');
        }
        return;
      case 'shape':
        env.declare(statement.name, { kind: 'shape', declaration: statement });
        return;
      default:
        // Other file-level statements contribute nothing to a movement
        // run (the retired TG-lowering compiler's convention, kept).
        return;
    }
  }

  /**
   * Bind one `import { … } from "<file>"` statement's names from the
   * resolved link (the SAME structure `checkProgramWithLink` validated):
   * a shape binds as its declaration; a movement binds callable, carrying
   * its library's file environment so the call executes against the
   * library's OWN scope (its adapter imports, constructions, file-level
   * values), not the importer's.
   */
  private async declareFileImports(
    names: Array<{ name: string; alias?: string }>,
    path: string,
    env: Environment,
  ): Promise<void> {
    for (const { name, alias } of names) {
      const local = alias ?? name;
      const exported = this.currentImports?.get(local);
      if (!exported) {
        throw new MovementEngineError(
          'MOVENG_RUNTIME',
          `'${local}' did not resolve from "${path}" — the checker should have caught this`,
        );
      }
      if (exported.kind === 'shape') {
        env.declare(local, { kind: 'shape', declaration: exported.declaration });
      } else {
        env.declare(local, {
          kind: 'movement',
          declaration: exported.declaration,
          fileEnv: await this.libraryEnv(exported.file),
        });
      }
    }
  }

  /**
   * A library file's environment, built once per path (diamonds share
   * it): the same two-pass file-scope interpretation `run()` applies to
   * the root program — movements first (hoisted, carrying THIS env as
   * their fileEnv so library-internal calls stay library-scoped), then
   * the deferred statements in source order. `currentImports` and
   * `importOriginals` are saved/restored around the build: both are
   * per-file vocabularies, and the library's constructions resolve their
   * aliases EAGERLY (instanceBinding), so nothing needs them afterwards.
   */
  private async libraryEnv(file: LinkedFile): Promise<Environment> {
    const cached = this.libraryEnvs.get(file.path);
    if (cached) return cached;
    const env = new Environment();
    this.libraryEnvs.set(file.path, env);

    const savedImports = this.currentImports;
    const savedOriginals = new Map(this.importOriginals);
    this.currentImports = file.imports;
    try {
      const deferred: Statement[] = [];
      for (const statement of file.program.statements) {
        if (statement.kind === 'movement') {
          env.declare(statement.name, {
            kind: 'movement',
            declaration: statement,
            fileEnv: env,
          });
        } else {
          deferred.push(statement);
        }
      }
      for (const statement of deferred) {
        await this.interpretFileStatement(statement, env);
      }
    } finally {
      this.currentImports = savedImports;
      this.importOriginals.clear();
      for (const [key, value] of savedOriginals) this.importOriginals.set(key, value);
    }
    return env;
  }

  private instanceBinding(name: string, construct: ConstructionCall): Binding {
    const adapterSlug = this.importOriginal(construct.callee);
    const spec = this.input.catalog.adapter(adapterSlug);
    const credentialArg = (spec && credentialArgOf(spec)?.name) ?? 'credentials';
    const credential = construct.args.find((a) => a.name === credentialArg);
    const args: Record<string, string> = {};
    const constructionConfig: Record<string, string> = {};
    for (const arg of construct.args) {
      const raw = arg.value.raw.trim();
      // Unwrap backtick-quoted credential names before alias resolution so
      // catalog lookups key on the verbatim (unquoted) name in all cases.
      args[arg.name] = arg.name === credentialArg
        ? this.importOriginal(unwrapCredentialArg(raw) ?? raw)
        : raw;
      // Everything that ISN'T the credential is the instance's construction
      // config — the binding store's instance key keys on it (3b).
      if (arg.name !== credentialArg) constructionConfig[arg.name] = raw;
    }
    const rawCredValue = credential?.value.raw.trim();
    const unwrappedCred = rawCredValue !== undefined ? unwrapCredentialArg(rawCredValue) : null;
    return {
      kind: 'instance',
      name,
      adapterSlug,
      ...(unwrappedCred !== null ? { credentialName: this.importOriginal(unwrappedCred) } : {}),
      ...(Object.keys(constructionConfig).length > 0 ? { constructionConfig } : {}),
      schema: this.input.catalog.instantiate(adapterSlug, args),
    };
  }

  /** Resolves a (possibly aliased) imported local name to its catalog / workspace name. */
  private importOriginal(local: string): string {
    return this.importOriginals.get(local) ?? local;
  }

  /**
   * Build a source-role read seam for a constructed instance binding —
   * reads in the program's NATURAL names translate to the adapter's
   * internal ids through the instance's own resolver, the same wrapper
   * the event source rides. Cached per (slug, credential, construction
   * args) since the same instance can be read from multiple heads.
   */
  private async instanceSourceRead(
    binding: Extract<Binding, { kind: 'instance' }>,
  ): Promise<SourceRead> {
    const credentialsId = this.credentialsIdFor(binding);
    const constructionArgs = constructionArgsOf(binding);
    const argsKey = Object.keys(constructionArgs).length
      ? JSON.stringify(Object.entries(constructionArgs).sort(([a], [b]) => a.localeCompare(b)))
      : '';
    const cacheKey = `source::${binding.adapterSlug}::${credentialsId ?? ''}::${argsKey}`;
    let adapter = this.sourceAdapterCache.get(cacheKey);
    if (!adapter) {
      const inner = await this.resolveAdapterFn({
        adapterType: binding.adapterSlug,
        teamId: this.input.teamId,
        credentialsId,
        ...(Object.keys(constructionArgs).length ? { constructionArgs } : {}),
        role: 'source',
      });
      adapter = surfaceReadAdapter({ inner, schema: binding.schema });
      this.sourceAdapterCache.set(cacheKey, adapter);
    }
    return { adapter, instanceName: binding.name };
  }

  /**
   * Resolve a graph-valued binding to its READ seam + start position —
   * the enabler for instance-/handle-rooted traversals (block heads
   * and expression reads): `crm-[c:companies]-> { … }` streams through
   * the crm instance's own adapter from its meta position; a write handle
   * (`co-[c:contacts]-> { … }`) streams through its own graph's adapter
   * from the handle's own stable record — the write result IS a
   * position. Source-role adapters are cached per (slug, credential).
   */
  private async graphReadFor(
    _name: string,
    binding: Binding,
  ): Promise<{ read: SourceRead; start: SourcePosition } | undefined> {
    if (binding.kind === 'instance') {
      return { read: await this.instanceSourceRead(binding), start: makeMetaPosition(binding.adapterSlug) };
    }
    if (binding.kind === 'handle') {
      // No external id means the write bound no concrete record (e.g. a
      // non-record handle) — return undefined so the caller fails loudly
      // rather than reading from a record that isn't there.
      if (binding.handle.externalId === undefined) return undefined;
      const read = await this.instanceSourceRead(binding.graph.instance);
      return {
        read,
        start: makeStablePosition({
          adapterType: binding.handle.adapterType,
          recordType: binding.targetType,
          recordId: binding.handle.externalId,
          data: binding.handle.resultData,
        }),
      };
    }
    return undefined;
  }

  private credentialsIdFor(instance: Extract<Binding, { kind: 'instance' }>): string | undefined {
    if (!instance.credentialName) return undefined;
    return this.input.resolveCredentialId?.(instance.credentialName);
  }

  // ── Statement interpretation (movement body / if arms) ──

  private async interpretBody(
    statements: Statement[],
    env: Environment,
    body: BodyContext,
    /** Resume entry (async user interaction §4.4): the walk begins at this
     *  index instead of 0, skipping the statements whose effects ran before
     *  the park (forward-from-leaf). One-shot — NOT threaded into nested bodies
     *  (an `if` arm / parallel branch always starts at 0). Only the movement-body
     *  root sets it, for a single-ask linear resume (chunk 5). */
    startIndex = 0,
  ): Promise<BodyOutcome> {
    for (let stmtIndex = startIndex; stmtIndex < statements.length; stmtIndex++) {
      const statement = statements[stmtIndex];
      // This statement's lexical address (§4.3) — the address an `ask` here
      // parks at, and the prefix its `if`/`parallel`/fan-out descendants extend.
      const stmtAddress = childStmt(body.address, stmtIndex);
      // The cancel gate (runs-and-cancel spec §cancel): a user-requested cancel
      // stops the run at the next statement boundary — never mid-write.
      // Debounced DB read; latches once true. Caught at the top of
      // run()/resume() (like RunParked), never by the fan-out/parallel park
      // machinery (they re-throw anything but RunParked/ScopeEndedQuietly).
      if (this.input.cancelGate && (await this.input.cancelGate.cancelled())) {
        throw new RunCancelledSignal();
      }
      switch (statement.kind) {
        case 'import':
          await this.interpretFileStatement(statement, env);
          break;
        case 'assign':
          await this.declareAssign(statement.name, statement.value, env, body, stmtAddress);
          break;
        // `return <value>` is a binding into a reserved slot: the same
        // right-hand side, evaluated the same way, into a name the grammar
        // cannot spell — which is what carries it across a park.
        case 'return': {
          await this.declareAssign(RETURN_SLOT, statement.value, env, body, stmtAddress);
          const value = env.resolveOwn(RETURN_SLOT);
          return value !== undefined ? { returned: true, value } : FELL_THROUGH;
        }
        case 'write':
          await this.executeWrite(statement.write, undefined, env, body);
          break;
        case 'error':
          await this.interpretError(statement, env);
          break;
        case 'if': {
          // An arm is transparent: a `return` inside one returns from THIS
          // body, so its outcome rides straight out — and lands in this scope
          // too, so a park anywhere above still carries it.
          const outcome = await this.interpretIf(statement, env, {
            ...body,
            address: stmtAddress,
          });
          if (outcome.returned) {
            env.declare(RETURN_SLOT, outcome.value);
            return outcome;
          }
          break;
        }
        case 'call':
          await this.executeCall(statement, env, { ...body, address: stmtAddress });
          break;
        case 'link':
          await this.executeLink(statement.link, undefined, env);
          break;
        case 'unlink':
          await this.executeUnlinkStatement(statement, env);
          break;
        case 'delete':
          await this.executeDeleteStatement(statement, env);
          break;
        case 'refresh':
          await this.interpretRefresh(statement, env);
          break;
        case 'block':
          await this.interpretBlock(statement.block, undefined, env, stmtAddress);
          break;
        case 'await':
          await this.interpretAwait(statement.await, undefined, env, stmtAddress, body);
          break;
        case 'combinator':
          await this.interpretCombinator(statement.combinator, undefined, env, stmtAddress, body);
          break;
        case 'shape':
        case 'movement':
          throw unsupported(`nested ${statement.kind} declarations inside a movement body`);
      }
    }
    return FELL_THROUGH;
  }

  /**
   * One right-hand side, evaluated and bound. Shared by `name = <value>` and
   * `return <value>` — they take the same grammar, so they take the same
   * evaluation; only the name differs.
   */
  private async declareAssign(
    name: string,
    value: RValue,
    env: Environment,
    body: BodyContext,
    stmtAddress: Address,
  ): Promise<void> {
    switch (value.kind) {
      case 'construct': {
        // `name(args)` is one surface form; what the name RESOLVES to
        // decides what it means — an adapter type constructs, a
        // movement runs and its value is bound. The grammar cannot
        // tell them apart, so it doesn't (parser/ast `constructionAsCall`).
        const construct = value.construct;
        if (env.resolve(construct.callee)?.kind === 'movement') {
          const call = constructionAsCall(construct);
          env.declare(
            name,
            requireCallValue(
              call.callee,
              await this.executeCall(call, env, { ...body, address: stmtAddress }),
            ),
          );
          break;
        }
        env.declare(name, this.instanceBinding(name, construct));
        break;
      }
      case 'call':
        // The other route to a bound call — the one the parser could
        // tell apart. Same execution, same value.
        env.declare(
          name,
          requireCallValue(
            value.call.callee,
            await this.executeCall(value.call, env, { ...body, address: stmtAddress }),
          ),
        );
        break;
      case 'write':
        await this.executeWrite(value.write, name, env, body);
        break;
      case 'expr': {
        const aliased = this.aliasedNodeBinding(value.expr, env);
        if (aliased !== undefined) {
          env.declare(name, aliased);
          break;
        }
        const selected = await this.selectedPositionBinding(value.expr, env);
        if (selected !== undefined) {
          env.declare(name, selected);
          break;
        }
        const evaluated = await this.evaluateSlot(value.expr, { env });
        env.declare(name, {
          kind: 'value',
          value: evaluated.value,
          provenance: evaluated.provenance,
        });
        break;
      }
      case 'extract': {
        const emission = await this.runExtraction(
          name,
          value.extract,
          env,
        );
        env.declare(name, { kind: 'extractRoot', emission });
        break;
      }
      case 'block':
        await this.interpretBlock(value.block, name, env, stmtAddress);
        break;
      case 'link':
        await this.executeLink(value.link, name, env);
        break;
      case 'await':
        await this.interpretAwait(value.await, name, env, stmtAddress, body);
        break;
      case 'combinator':
        await this.interpretCombinator(value.combinator, name, env, stmtAddress, body);
        break;
      case 'collection':
        await this.interpretCollectionOp(value.collection, name, env, body);
        break;
      case 'members':
        this.interpretMembers(value.members, name, env);
        break;
      case 'inlineBlock':
        this.inlineBlockRetired(value.inlineBlock.binding);
        break;
      case 'closure':
        // A closure is (AST, capture) and nothing else runs here: the body runs
        // when it is CALLED. The capture is a flat snapshot of the lexical
        // chain, exactly as a `lazy` walk's is — which is what lets both cross
        // a park unchanged.
        env.declare(name, {
          kind: 'closure',
          closure: value.closure,
          captured: captureScope(env),
        });
        break;
      case 'callback':
        env.declare(
          name,
          await this.mintCallback(value.callback, env, stmtAddress),
        );
        break;
      case 'node':
        env.declare(
          name,
          await this.synthesiseNode(value.node, env),
        );
        break;
      case 'lazy':
        // Nothing runs here — that is the whole point. The walk is
        // stored with the scope it was written in, and every read of
        // this name runs it afresh against the live source.
        env.declare(name, {
          kind: 'lazyWalk',
          walk: this.deferWalk(
            value.lazy.head,
            env,
            value.lazy.mapping,
          ),
        });
        break;
    }
  }

  /**
   * `parallel { … }` — env fork + join. Every sibling statement runs in
   * its OWN child environment, all siblings concurrently (Promise.all):
   * sibling bindings are invisible to each other while the block runs
   * (the checker already rejects cross-sibling reads — `parallelSibling`
   * scope poisoning), and the block's writes interleave in completion
   * order on the firing record. After the join, each sibling's bindings
   * hoist into the enclosing scope in program order — exactly the
   * checker's "sibling bindings come into scope after the block".
   */
  /**
   * `await race([…])` / `await parallel([…])` — the two concurrency combinators
   * (core calculus v2 R5). The arms are FUNCTION values and this is what calls
   * them: each runs concurrently in its own `branch k` frame, and the value is
   * a POSITIONAL receipt — one slot per arm, in the arms' own order.
   *
   * **Bursts and ties.** Every arm is started, and this waits until each has
   * either COMPLETED or PARKED at a suspension. A running arm is never
   * preempted, so a completion that lands before teardown counts: `race` may
   * settle with more than one filled slot, which is what "anything inside one
   * running burst is simultaneous" means.
   *
   * **Cancellation is withdrawal, never a tear.** At settlement `race` stops
   * listening on the arms that parked — their `parked_run` rows and resume
   * correlations go (`cancelSubtrees`), so a later firing on one of them
   * resumes nothing. Nothing in flight is interrupted, because nothing in
   * flight is still running by then.
   *
   * Two paths, exactly as any other join:
   *   - SOMETHING SETTLED IN THIS BURST: bind the receipt and continue inline.
   *     (`race` needs one arm; `parallel` needs them all.)
   *   - EVERYTHING STILL PARKED: record the frame — pending 1 for `race` (the
   *     first completer wins), pending N for `parallel` (every arm must land)
   *     — and suspend. The unwind settles it when the arms resume.
   */
  /**
   * `MAP(xs, f)` / `FILTER(xs, f)` / `REDUCE(xs, init, f)` / `GROUPBY(xs, key)`
   * / `KEYBY(xs, key)` — the function, once per member, in order.
   *
   * Sequential and in-app, which is what the source text says: nothing here is
   * pushed anywhere and nothing runs concurrently (that is `parallel`, written
   * as `parallel`). The checker refuses a function that can park, so an
   * iteration always finishes, and the whole op is one statement.
   */
  private async interpretCollectionOp(
    expr: CollectionOpExpression,
    bindingName: string | undefined,
    env: Environment,
    body: BodyContext,
  ): Promise<void> {
    const spelling = expr.op.toUpperCase();
    const source = await this.evaluateSlot(expr.source, { env });
    const members = source.value;
    if (!Array.isArray(members)) {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `'${spelling}' reads a collection of values and got ${members === null || members === undefined ? 'nothing' : typeof members} — the checker should have caught this`,
      );
    }
    const fn = this.collectionFunction(expr.fn, spelling, env);
    const params = fn.closure.params.map((p) => p.name);

    const call = async (values: unknown[]): Promise<unknown> => {
      const args: Record<string, unknown> = {};
      params.forEach((name, index) => {
        args[name] = values[index] ?? null;
      });
      const outcome = await this.invokeClosure(fn, args, body);
      if (!outcome.returned) {
        throw new MovementEngineError(
          'MOVENG_RUNTIME',
          `the function for '${spelling}' returned nothing — the checker should have caught this`,
        );
      }
      return outcome.value.kind === 'value' ? outcome.value.value : outcome.value;
    };

    let bound: Binding;
    if (expr.op === 'reduce') {
      const start = expr.init !== undefined
        ? (await this.evaluateSlot(expr.init, { env })).value
        : null;
      let carried = start;
      for (const member of members) carried = await call([carried, member]);
      bound = { kind: 'value', value: carried, provenance: transformed(source.provenance) };
    } else if (expr.op === 'map') {
      const out: unknown[] = [];
      for (const member of members) out.push(await call([member]));
      bound = { kind: 'value', value: out, provenance: transformed(source.provenance) };
    } else if (expr.op === 'filter') {
      const out: unknown[] = [];
      // Truthiness is the language's own: the function returns a boolean, and
      // anything else is the checker's business, not a second definition here.
      for (const member of members) if ((await call([member])) === true) out.push(member);
      bound = { kind: 'value', value: out, provenance: source.provenance };
    } else {
      // GROUPBY / KEYBY — the key function's answer names the slot. A key that
      // is not text at run time is a checker escape; say so rather than
      // stringify it, which is the silence the save-time rule exists to avoid.
      const filed: Record<string, unknown> = {};
      for (const member of members) {
        const key = await call([member]);
        if (typeof key !== 'string') {
          throw new MovementEngineError(
            'MOVENG_RUNTIME',
            `'${spelling}' files each member under a text key, and this one answered ${key === null || key === undefined ? 'nothing' : typeof key} — the checker should have caught this`,
          );
        }
        if (expr.op === 'keyby') {
          // Two members under one key is the author's claim turning out false —
          // exactly `ONLY`'s situation, and it gets `ONLY`'s answer: fail the
          // run naming the key, rather than quietly keeping one of them.
          if (Object.hasOwn(filed, key)) {
            throw new MovementEngineError(
              'MOVENG_RUNTIME',
              `KEYBY says each key names one member, and '${key}' names more than one. Use GROUPBY if a key can have several.`,
            );
          }
          filed[key] = member;
          continue;
        }
        const group = filed[key];
        if (Array.isArray(group)) group.push(member);
        else filed[key] = [member];
      }
      bound = { kind: 'value', value: filed, provenance: transformed(source.provenance) };
    }
    if (bindingName !== undefined) env.declare(bindingName, bound);
  }

  /** The function a collection op runs: written in place, or a name bound to
   *  one (a closure, or a movement, which is a closure with a name). */
  private collectionFunction(
    fn: ArmExpression,
    spelling: string,
    env: Environment,
  ): Extract<Binding, { kind: 'closure' }> {
    if (fn.kind === 'closure') {
      return { kind: 'closure', closure: fn.closure, captured: captureScope(env) };
    }
    const binding = env.resolve(fn.name);
    if (binding?.kind === 'closure') return binding;
    if (binding?.kind === 'movement') {
      return {
        kind: 'closure',
        closure: {
          params: binding.declaration.params,
          body: binding.declaration.body,
          span: binding.declaration.span,
        },
        captured: captureScope(binding.fileEnv ?? env),
      };
    }
    throw new MovementEngineError(
      'MOVENG_RUNTIME',
      `'${fn.name}' is ${binding ? describeBinding[binding.kind] : 'not in scope'}, and '${spelling}' runs a function — the checker should have caught this`,
    );
  }

  /**
   * `MEMBERS(<Thesis>)` — the values of a closed type, in the order they were
   * declared. A declared refinement carries them itself; a borrowed field's
   * come from the LIVE schema, re-read per firing exactly as an extract
   * annotation's do, so an option added over there is followed without a
   * re-save.
   */
  private interpretMembers(
    expr: MembersExpression,
    bindingName: string | undefined,
    env: Environment,
  ): void {
    const segments = borrowedTypeSegments(expr.type);
    const resolved = segments !== undefined && segments.length === 3
      ? (() => {
          const schema = this.graphSchemaOf(segments[0], env);
          return schema ? resolveBorrowedField(schema, segments[1], segments[2]) : undefined;
        })()
      : this.declaredTypes.get(expr.type);
    if (resolved === undefined || typeof resolved !== 'object' || resolved.kind !== 'enum') {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `'MEMBERS(<${expr.type}>)' names no closed set of values — the checker should have caught this`,
      );
    }
    if (bindingName !== undefined) {
      env.declare(bindingName, {
        kind: 'value',
        value: [...resolved.options],
        provenance: NO_PROVENANCE,
      });
    }
  }

  private async interpretCombinator(
    expr: CombinatorExpression,
    bindingName: string | undefined,
    env: Environment,
    stmtAddress: Address,
    body: BodyContext,
  ): Promise<void> {
    const arms = await this.resolveArms(expr, env);
    this.trace.push({ kind: 'block', root: expr.kind, positions: arms.length });

    if (arms.length === 0) {
      if (expr.kind === 'race') {
        throw new MovementEngineError(
          'MOVENG_RUNTIME',
          'a race over no arms can never settle — nothing was given to it to run',
        );
      }
      // A parallel over nothing ran nothing, and its receipt has no slots.
      if (bindingName !== undefined) env.declare(bindingName, { kind: 'tuple', slots: [] });
      return;
    }

    const forks = arms.map((arm, index) => ({
      arm,
      index,
      env: env.child(),
      address: childBranch(stmtAddress, index),
    }));
    const settled = new Map<number, Binding>();
    const parked: typeof forks = [];
    // Real concurrency, as `parallel` has always had: each arm runs its own
    // prefix, and one arm's park does not stop the others reaching theirs.
    await Promise.all(
      forks.map(async (fork) => {
        try {
          const outcome = await this.runArm(fork.arm, fork.env, body, fork.address);
          settled.set(fork.index, outcome.returned ? outcome.value : NULL_SLOT);
        } catch (e) {
          if (e instanceof RunParked) {
            parked.push(fork);
            return;
          }
          // A quiet scope end (find-on-missing) still COMPLETED — it ran to its
          // end, it just bound less on the way.
          if (!(e instanceof ScopeEndedQuietly)) throw e;
          settled.set(fork.index, NULL_SLOT);
        }
      }),
    );

    const bindReceipt = (): void => {
      if (bindingName === undefined) return;
      env.declare(bindingName, {
        kind: 'tuple',
        slots: forks.map((fork) => settled.get(fork.index) ?? NULL_SLOT),
      });
    };

    if (expr.kind === 'race') {
      if (settled.size > 0) {
        // Stop listening on every arm still parked at a suspension — one signal
        // per park, and the record behind it stays answerable (F7).
        if (parked.length > 0) {
          await this.input.parkSink?.cancelSubtrees({
            subtreeAddresses: parked.map((fork) => encodeAddress(fork.address)),
          });
        }
        bindReceipt();
        return;
      }
      const frameAddress = encodeAddress(stmtAddress);
      await this.input.parkSink?.recordJoin({ frameAddress, parkedChildren: 1 });
      throw new RunParked(frameAddress);
    }

    if (parked.length > 0) {
      const frameAddress = encodeAddress(stmtAddress);
      await this.input.parkSink?.recordJoin({
        frameAddress,
        parkedChildren: parked.length,
      });
      throw new RunParked(frameAddress);
    }
    bindReceipt();
  }

  /**
   * The arms, as bodies to run. A closure written in place captures the scope
   * it is written in; a NAME is looked up — a closure bound earlier keeps its
   * own capture, a movement runs its declaration against the file scope it was
   * declared in. Arms built at run time are a collection of closures, whatever
   * built it.
   *
   * Every arm ends up the same shape, which is what lets one loop run them and
   * one address scheme resume them.
   */
  private async resolveArms(
    expr: CombinatorExpression,
    env: Environment,
  ): Promise<ArmInvocation[]> {
    if (expr.arms.kind === 'dynamic') {
      const evaluated = await this.evaluateSlot(expr.arms.expr, { env });
      const value = evaluated.value;
      const entries = Array.isArray(value) ? value : [value];
      return entries.map((entry, index) => {
        if (!isClosureBinding(entry)) {
          throw new MovementEngineError(
            'MOVENG_RUNTIME',
            `arm ${index} of '${expr.kind}' is not a function — a combinator runs what it is given, and this is ${typeof entry}`,
          );
        }
        return { body: entry.closure.body, captured: entry.captured };
      });
    }
    return expr.arms.arms.map((arm) => this.armInvocation(arm, expr.kind, env));
  }

  /** One literal arm as a body plus the bindings it brings with it. */
  private armInvocation(
    arm: ArmExpression,
    kind: 'race' | 'parallel',
    env: Environment,
  ): ArmInvocation {
    if (arm.kind === 'closure') {
      // Written in place: it captures the scope around it, which the arm scope
      // is a child of — so there is nothing extra to carry.
      return { body: arm.closure.body };
    }
    const binding = env.resolve(arm.name);
    if (binding?.kind === 'closure') {
      return { body: binding.closure.body, captured: binding.captured };
    }
    if (binding?.kind === 'movement') {
      if (binding.declaration.params.length > 0) {
        throw new MovementEngineError(
          'MOVENG_RUNTIME',
          `'${arm.name}' takes ${binding.declaration.params.length} argument(s), and '${kind}' calls its arms with none — the checker should have caught this`,
        );
      }
      // A movement runs against the file scope it was DECLARED in, not the one
      // that named it here — lexical scoping, exactly as a call does.
      const fileEnv = binding.fileEnv ?? this.fileEnv;
      return {
        body: binding.declaration.body,
        ...(fileEnv !== undefined ? { captured: captureScope(fileEnv) } : {}),
      };
    }
    throw new MovementEngineError(
      'MOVENG_RUNTIME',
      `'${arm.name}' is ${binding ? describeBinding[binding.kind] : 'not in scope'}, and '${kind}' runs its arms — an arm has to be a function. The checker should have caught this.`,
    );
  }

  /** Run one arm in its own branch scope. A park inside it throws `RunParked`
   *  addressed under the arm, which is what makes the arm withdrawable. */
  private async runArm(
    arm: ArmInvocation,
    armEnv: Environment,
    body: BodyContext,
    address: Address,
  ): Promise<BodyOutcome> {
    if (arm.captured !== undefined) {
      for (const [name, binding] of arm.captured) armEnv.declare(name, binding);
    }
    return this.interpretBody(arm.body, armEnv, { ...body, address });
  }

  /**
   * `files_to_dropbox(write Files-[:file]-> { … })` — invoke a same-file
   * movement with a position of its parameter's type — same-file or
   * imported from a library (the resolved link supplies the declaration
   * and its library's file environment). Arguments evaluate in the
   * CALLER's scope:
   *   - an inline `write` adapts the argument: a shape target
   *     materialises an in-memory position (no adapter — shapes are
   *     configuration-free graphs); an instance/kg target performs the
   *     write and passes its handle;
   *   - a bare name passes its position binding through (the event, a
   *     handle, a shape position, an extracted entity, a resource).
   * The callee body then interprets with its parameters bound in a
   * FRESH environment whose parent is FILE scope — lexical scoping:
   * caller locals are invisible by construction (the checker enforces
   * it; the environment shape makes it true). The checker also owns
   * arity/type fit — the runtime re-checks arity only as a cheap guard.
   * The callee's effects are its writes, recorded on the same firing
   * record, and provenance flows through naturally because arguments
   * carry their trails.
   *
   * Every call also has a VALUE: the node the callee's top-level
   * A call's value is what the callee RETURNED — undefined when it returned
   * binds it. Effects are unchanged — the value is additional.
   */
  private async executeCall(
    statement: Extract<Statement, { kind: 'call' }>,
    env: Environment,
    body: BodyContext,
  ): Promise<Binding | undefined> {
    const callee = env.resolve(statement.callee);
    if (callee?.kind !== 'movement') {
      if (callee?.kind === 'opaque') {
        throw unsupported(
          `calling the import '${statement.callee}'`,
          'this run has no file resolver — pass resolveFile to runMovement (or declare the movement in this file)',
        );
      }
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `'${statement.callee}' is ${callee ? describeBinding[callee.kind] : 'not in scope'}, not a callable movement — the checker should have caught this`,
      );
    }
    const declaration = callee.declaration;
    if (this.callStack.includes(declaration)) {
      throw unsupported(
        `recursive movement calls ('${[...this.callStack.map((d) => d.name), declaration.name].join(' → ')}')`,
      );
    }
    if (statement.args.length !== declaration.params.length) {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `'${declaration.name}' takes ${declaration.params.length} argument(s), got ${statement.args.length} — the checker should have caught this`,
      );
    }
    if (!this.fileEnv) {
      throw new MovementEngineError('MOVENG_RUNTIME', 'no file scope for a movement call');
    }
    // An imported callee forks from ITS library's file scope; a same-file
    // callee forks from the running file's — lexical scoping either way.
    const calleeEnv = (callee.fileEnv ?? this.fileEnv).child();
    // Arguments are NAMED (order carries no meaning) but still evaluate
    // in the caller's source order — an inline write argument is an
    // effect, and effects run in the order the text states them.
    const evaluated = new Map<string, Binding>();
    for (const arg of statement.args) {
      evaluated.set(arg.name, await this.evaluateCallArg(arg, env, body));
    }
    for (const param of declaration.params) {
      const binding = evaluated.get(param.name);
      if (!binding) {
        throw new MovementEngineError(
          'MOVENG_RUNTIME',
          `'${declaration.name}' call supplies no argument '${param.name}' — the checker should have caught this`,
        );
      }
      calleeEnv.declare(param.name, binding);
    }
    this.callStack.push(declaration);
    const callerBody = this.movementBody;
    this.movementBody = declaration.body;
    let outcome: BodyOutcome = FELL_THROUGH;
    try {
      // A call re-roots the position (2_model.md "Composition") — the
      // callee runs OFF the trigger's anchor, so anchor-only bridge
      // synthesis stays with the dispatched movement's own body. The address
      // re-roots too (the callee is a fresh `Call` frame, §4.2): for the
      // single-ask milestone an ask inside a callee parks at a callee-rooted
      // address; cross-frame resume addressing lands with 3.2's frame machine.
      outcome = await this.interpretBody(declaration.body, calleeEnv, {
        atAnchor: false,
        address: ROOT_ADDRESS,
      });
    } catch (e) {
      // Find-on-missing inside a callee: the callee's scope is the one
      // that ends — the caller continues after the call. What it bound
      // BEFORE ending is still its value; a scope that stopped early made
      // fewer bindings, which is what the caller reads.
      if (!(e instanceof ScopeEndedQuietly)) throw e;
    } finally {
      this.movementBody = callerBody;
      this.callStack.pop();
    }
    return outcome.returned ? outcome.value : undefined;
  }

  private async evaluateCallArg(
    arg: CallArg,
    env: Environment,
    body: BodyContext,
  ): Promise<Binding> {
    if (arg.kind === 'write') {
      return this.executeWrite(arg.write, undefined, env, body);
    }
    if (arg.kind === 'node') {
      return this.synthesiseNode(arg.node, env);
    }
    if (arg.kind === 'call') {
      // The utility idiom — the nested call runs (its effects are its own) and
      // its value is what this argument passes on.
      return requireCallValue(arg.call.callee, await this.executeCall(arg.call, env, body));
    }
    const raw = arg.expr.raw.trim();
    if (BARE_IDENT.test(raw)) {
      const binding = env.resolve(raw);
      if (!binding) {
        throw new MovementEngineError(
          'MOVENG_RUNTIME',
          `'${raw}' is not in scope — the checker should have caught this`,
        );
      }
      switch (binding.kind) {
        case 'event':
        case 'handle':
        case 'shapePosition':
        case 'extractRoot':
        case 'extractPosition':
        case 'sourcePosition':
        case 'resource':
        case 'nodePosition':
        case 'lazyWalk':
          return binding;
        default:
          throw unsupported(
            `passing ${describeBinding[binding.kind]} ('${raw}') as a movement argument`,
            'arguments are positions — pass the event, a write handle, or adapt with an inline shape-write',
          );
      }
    }
    throw unsupported(
      'computed expressions as movement arguments',
      'arguments are positions — pass a bound position or adapt with an inline shape-write',
    );
  }

  private async interpretIf(
    statement: Extract<Statement, { kind: 'if' }>,
    env: Environment,
    body: BodyContext,
  ): Promise<BodyOutcome> {
    for (let armIndex = 0; armIndex < statement.arms.length; armIndex++) {
      const arm = statement.arms[armIndex];
      const taken = await this.evaluateCondition(arm.condition, env);
      this.trace.push({ kind: 'gate', outcome: taken });
      if (taken) {
        // The taken arm is `branch k` of this `if` (§4.3 — each arm is a branch).
        // An arm is transparent to `return`: its outcome is the enclosing
        // body's, which is what makes the guard clause read as it does in TS.
        return this.interpretBody(arm.body, env.child(), {
          ...body,
          address: childBranch(body.address, armIndex),
        });
      }
    }
    if (statement.elseArm) {
      // The else arm follows the explicit arms (branch index = arm count).
      return this.interpretBody(statement.elseArm.body, env.child(), {
        ...body,
        address: childBranch(body.address, statement.arms.length),
      });
    }
    return FELL_THROUGH;
  }

  // ── Timer parks ──

  /**
   * `await sleep(<duration>)` — durably park this branch for a fixed interval,
   * then resume (the wake driver, §4). Mirrors `interpretAsk`'s scope
   * serialisation — `serializeScopeChain(env.chainFromRoot())` captures the
   * full lexical scope feeding this point — but the durable park is a TIMER
   * park: no `interaction_request`, no answer, just an absolute `wake_at`.
   * Throwing `RunParked` freezes the branch here (exactly like `ask`/cost), so
   * a fan-out counts this leaf into `join_pending` and every branch parks at
   * its own sleep.
   *
   * Under `dryRun` we never park — a simulated run has no wall clock to wait on —
   * so we narrate the fast-forward and continue past the statement immediately.
   */
  private async interpretSleep(
    sleep: { duration: DurationLiteral },
    stmtAddress: Address,
    env: Environment,
    /** When the sleep is `<name> = await sleep(…)` (chunk C): the name to bind a
     *  PRESENCE marker at wake, so the completed branch escapes it onto a race
     *  receipt as an edge (`r-[:expired]->`, S4). Undefined ⇒ a value-less sleep. */
    presenceBindingName?: string,
  ): Promise<void> {
    if (this.input.dryRun) {
      logger.info(`slept ${sleep.duration.raw} (fast-forwarded)`);
      return;
    }
    const parkSink = this.input.parkSink;
    const address = encodeAddress(stmtAddress);
    if (!parkSink) {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `sleep reached at '${address}' with no park sink — the run cannot suspend on a timer without the durable trigger-run substrate`,
      );
    }
    const state: ParkedScopeState = {
      version: 1,
      address,
      // A plain sleep binds nothing — the leaf re-enters AT the un-run
      // continuation, no value injected. An `await sleep` WITH a binding carries
      // the name + `presenceBind` so resume declares a presence marker at wake.
      bindingName: presenceBindingName ?? null,
      ...(presenceBindingName !== undefined ? { presenceBind: true } : {}),
      scopeChain: serializeScopeChain(env.chainFromRoot()),
    };
    const wakeAt = new Date(Date.now() + durationToMs(sleep.duration.raw));
    await parkSink.commitTimerPark({ address, state, wakeAt });
    this.trace.push({ kind: 'gate', outcome: false });
    throw new RunParked(address);
  }

  // ── callback (the deferred, addressable invocation) ──

  /**
   * `cb = callback(<subject>, { once, ttl })` — MINT. The body is not run now;
   * what happens now is a CAPTURE: the enclosing scope chain is serialized with
   * the park machinery's own serializer (a callback body IS a parked
   * continuation with a different entry point — JS closure semantics, which is
   * the park's capture rule verbatim), and stored against this callback
   * expression's canonical lexical address. A fire resumes the run there.
   *
   * The binding it yields is checker-local: `.id` (the payload every platform
   * button carries) and `.url` (the human link), plus a `Called` edge read live
   * from the ledger.
   *
   */
  private async mintCallback(
    callback: CallbackExpression,
    env: Environment,
    stmtAddress: Address,
  ): Promise<Binding> {
    const sink = this.input.callbackSink;
    if (!sink) {
      throw unsupported(
        'callback(…)',
        'this run has no callback sink — a callback needs the durable trigger-run substrate',
      );
    }
    const address = encodeAddress(stmtAddress);
    const params = this.callbackParams(callback.subject, env);
    const config = await this.callbackConfig(callback, env);
    // The CAPTURE. Same shape a park writes, so resume-at-entry is the resume
    // path with a different leaf rule and nothing bespoke to keep in step.
    const state: ParkedScopeState = {
      version: 1,
      address,
      // A callback binds nothing at fire time beyond its parameters, which the
      // fire binds into a child scope of this one.
      bindingName: null,
      scopeChain: serializeScopeChain(env.chainFromRoot()),
    };
    const minted = await sink.mint({
      address,
      params,
      state,
      singleUse: config.singleUse,
      ...(config.expiresAt !== undefined ? { expiresAt: config.expiresAt } : {}),
    });
    return {
      kind: 'callback',
      callbackId: minted.id,
      url: minted.url,
      params,
    };
  }

  /**
   * A callback's FIRE-TIME signature — the values a platform supplies when it
   * fires, in DECLARATION order (which is the order the `Called` landing's
   * fields and the confirm page's controls take).
   *
   * Inline: every declared parameter. Named: the callee's parameters MINUS the
   * ones the author fixed as arguments — an unsupplied parameter is not
   * missing, it is deferred (the checker types it the same way).
   */
  private callbackParams(subject: CallbackSubject, env: Environment): CallbackParamSpec[] {
    const declared =
      subject.kind === 'inline'
        ? subject.closure.params
        : (() => {
            const binding = env.resolve(subject.movement);
            if (binding?.kind !== 'movement') {
              throw new MovementEngineError(
                'MOVENG_RUNTIME',
                `callback(${subject.movement}): '${subject.movement}' is not a movement in scope — the checker should have caught this`,
              );
            }
            const supplied = new Set(subject.args.map((a) => a.name));
            const deferred = binding.declaration.params.filter((p) => !supplied.has(p.name));
            if (deferred.length > 0) {
              // The named form's fire-time binding is not built (a movement
              // parameter is a record position today, so nothing a platform
              // sends can fill one). Refuse AT MINT rather than minting a
              // callback that could only ever fail when tapped.
              throw unsupported(
                `callback(${subject.movement}(…)) leaving '${deferred.map((p) => p.name).join("', '")}' unsupplied`,
                'a named callback binds no values at fire time yet — supply every argument, or use the inline form (`callback((x: <text>) => { … })`)',
              );
            }
            return deferred;
          })();

    return declared.map((param) => {
      // The checker refuses a record position here (no platform can hand us
      // one), so anything unrecognised is a checker escape — say so loudly
      // rather than defaulting the type and mis-coercing at fire time.
      if (
        param.type === undefined
        || !isCallbackParamType(param.type.graph)
        || param.type.hopsRaw !== undefined
      ) {
        throw new MovementEngineError(
          'MOVENG_RUNTIME',
          `a callback's parameter '${param.name}' must be a scalar type, got '<${param.type?.graph ?? '?'}>' — the checker should have caught this`,
        );
      }
      return { name: param.name, type: param.type.graph };
    });
  }

  /** `{ once: <boolean>, ttl: <duration> }` — the config. `once` DEFAULTS TRUE,
   *  and the default lives here (the engine owns it) rather than in the AST. */
  private async callbackConfig(
    callback: CallbackExpression,
    env: Environment,
  ): Promise<{ singleUse: boolean; expiresAt?: Date }> {
    let singleUse = true;
    let expiresAt: Date | undefined;
    for (const entry of callback.config) {
      switch (entry.name) {
        case 'once': {
          const { value } = await this.evaluateSlot(entry.value, { env });
          singleUse = value !== false;
          break;
        }
        case 'ttl':
          // Checker-validated duration literal, so the raw spelling parses.
          expiresAt = new Date(Date.now() + durationToMs(entry.value.raw.trim()));
          break;
        default:
          throw new MovementEngineError(
            'MOVENG_RUNTIME',
            `'${entry.name}' is not a callback setting — the checker should have caught this`,
          );
      }
    }
    return { singleUse, ...(expiresAt !== undefined ? { expiresAt } : {}) };
  }

  /** The `Called` landing — `At` plus one field per fire-time parameter, which
   *  is exactly what the checker derived at the construction site. An in-memory
   *  record: a callback belongs to no graph, so there is no adapter to read
   *  through. */
  private callbackCallBinding(call: CallbackCall): Binding {
    return {
      kind: 'shapePosition',
      shape: CALLBACK_LANDING_SHAPE,
      node: CALLBACK_CALLED_EDGE,
      fields: { [CALLBACK_CALL_AT]: call.at, ...call.values },
      fieldProvenance: {},
    };
  }

  /**
   * `await <traversal>` / `await sleep(<duration>)` — the wake primitive
   * (asks-as-adapter §A, P18). Two sources:
   *
   *   - `sleep(<duration>)` — the clock wake source: an ordinary TIMER park (the
   *     `sleep` statement re-skinned), binding nothing.
   *   - `<head>-[:Edge]->` — the SIGNAL wake source (`untilNonEmpty`): CHECK-NOW,
   *     ELSE PARK. The engine resolves the awaitable adapter and calls its
   *     `resolveAwait` capability against the current graph state:
   *       · `landed`  → bind the landing(s) and CONTINUE INLINE (the resolved
   *                     shortcut, S2 — no park);
   *       · `empty`   → a `resolvesEmpty` settlement (an explicit cancel): bind
   *                     an EMPTY match and continue (downstream runs zero times);
   *       · `pending` → REGISTER the correlation (park ↔ watch-point) on the
   *                     adapter, record the `await` park, and suspend. Resume
   *                     RE-ENTERS here and re-checks live (the await re-evaluates
   *                     itself — no injected answer).
   *
   * dry_run: the faked ask write minted no real record, so `resolveAwait` finds
   * nothing and the await settles immediately EMPTY (F3/F23) — the run walks
   * straight through.
   */
  private async interpretAwait(
    awaitExpr: AwaitExpression,
    bindingName: string | undefined,
    env: Environment,
    stmtAddress: Address,
    body: BodyContext,
  ): Promise<void> {
    const source = awaitExpr.source;
    if (source.kind === 'until') {
      await this.interpretUntil(source, bindingName, env, stmtAddress, {
        ...body,
        address: stmtAddress,
      });
      return;
    }
    if (source.kind === 'sleep') {
      // The clock wake source: a timer park. A BOUND `expired = await sleep(…)`
      // carries its name so the completed branch escapes it onto a race receipt
      // as an edge (S4); on a real park the presence is injected at timer resume,
      // and on the dry-run fast-forward we bind it here (interpretSleep returns).
      await this.interpretSleep({ duration: source.duration }, stmtAddress, env, bindingName);
      if (bindingName !== undefined) {
        env.declare(bindingName, { kind: 'value', value: true, provenance: NO_PROVENANCE });
      }
      return;
    }
    if (source.kind === 'combinator') {
      await this.interpretCombinator(source.combinator, bindingName, env, stmtAddress, body);
      return;
    }

    const address = encodeAddress(stmtAddress);
    const edge = awaitEdgeName(source.head.hopsRaw);
    // The awaited WHERE (`-[:Response WHERE r.answer]->`) — checker-guaranteed
    // PURE (MOV_AWAIT_IMPURE_WHERE). Evaluated at RESOLUTION time against each
    // candidate landing's fields (B.1): a matching landing resolves the await,
    // an unmatched set leaves it armed. Undefined ⇒ no narrowing.
    const hopFilter = /\bWHERE\b/i.test(source.head.hopsRaw)
      ? awaitHopFilter(source.head)
      : undefined;

    // Resolve the awaited head to a record identity. The head is a bound handle
    // whose adapter carries the awaitable capability (the checker guaranteed the
    // edge is awaitable, hence the adapter advertises it).
    const headBinding = env.resolve(source.head.root ?? '');
    if (headBinding?.kind === 'callback') {
      await this.interpretCallbackAwait({
        binding: headBinding,
        edge,
        ...(hopFilter !== undefined ? { hopFilter } : {}),
        bindingName,
        env,
        address,
      });
      return;
    }
    if (headBinding === undefined || headBinding.kind !== 'handle') {
      throw unsupported(
        `await '${source.head.root ?? ''}-[:${edge}]->'`,
        'await needs a written record handle as its head (e.g. an ask written with `write asks-[:Check]->`)',
      );
    }
    const recordId = headBinding.handle.externalId;
    const adapterType = headBinding.handle.adapterType;
    // The FILE-SCOPE instance name the awaited head's adapter came from — the
    // SAME identity a rehydrated `sourcePosition` re-resolves its read seam
    // through after a serialize→DB→deserialize round trip (`resolveSourceRead`
    // looks it up in the re-parsed file scope). Derive it from the head's graph
    // exactly as `graphReadFor` does, NOT from the local binding name (which is
    // absent from file scope and crashes rehydration — chunk C branch-export).
    const instanceName = headBinding.graph.instance.name;
    if (recordId === undefined) {
      // dry_run / rehearsed write — no real record to await; settle empty (F3).
      this.declareAwaitResult(env, bindingName, adapterType, undefined, null, instanceName);
      return;
    }

    // Resolve the awaitable adapter with the AWAITED HEAD's own credential +
    // construction args — the same instance the write went through — so
    // `resolveAwait` can drive the live re-check (Slack's `conversations.replies`
    // needs the bot token). A bare source resolution (no credential) left the
    // Slack client null and the reply never resolved. `credentialsIdFor` is a
    // no-op for credential-free intrinsics (the ask adapter), so this is
    // uniformly correct.
    const headInstance =
      headBinding.graph.kind === 'instance' ? headBinding.graph.instance : undefined;
    const headCredentialsId =
      headInstance !== undefined ? this.credentialsIdFor(headInstance) : undefined;
    const headConstructionArgs =
      headInstance !== undefined ? constructionArgsOf(headInstance) : {};
    const adapter = await this.resolveAdapterFn({
      adapterType,
      teamId: this.input.teamId,
      ...(headCredentialsId !== undefined ? { credentialsId: headCredentialsId } : {}),
      ...(Object.keys(headConstructionArgs).length ? { constructionArgs: headConstructionArgs } : {}),
      role: 'source',
    });
    if (!adapter.awaitable) {
      throw unsupported(
        `await '-[:${edge}]->' on '${adapterType}'`,
        `the '${adapterType}' adapter does not implement the awaitable capability`,
      );
    }

    // Under dry_run the faked write minted no resolvable record; settle empty.
    if (this.input.dryRun) {
      this.declareAwaitResult(env, bindingName, adapterType, adapter, {}, instanceName);
      logger.info(`await ${edge} (dry-run: resolves empty)`);
      return;
    }

    // The head's inline data — everything a normal traversal gets (correlation,
    // not stability). An adapter whose correlation identity isn't the bare
    // `recordId` reads it here (Slack's `Replies`: channel + thread ride the
    // write handle's data, not its `ts`).
    const headData = headBinding.handle.resultData ?? undefined;
    const resolution = await adapter.awaitable.resolveAwait({
      recordId,
      edge,
      ...(headData !== undefined ? { headData } : {}),
    });
    if (resolution.status === 'landed') {
      // Apply the awaited WHERE to each candidate (B.1) THROUGH the adapter's own
      // getFieldValue — the exact read path the resumed body uses — so the
      // predicate reads a candidate identically to `o.User` post-bind, with no
      // name/keying skew between the WHERE and the binding. The first landing to
      // pass wins (v1 edges are cardinality-one).
      let matched: { recordType?: string; fields: Record<string, unknown> } | undefined;
      for (const landing of resolution.landings) {
        if (
          hopFilter === undefined ||
          (await this.awaitLandingMatches(hopFilter, adapter, adapterType, landing))
        ) {
          matched = landing;
          break;
        }
      }
      if (matched !== undefined) {
        // The resolved shortcut (S2): continue inline.
        this.declareAwaitResult(
          env,
          bindingName,
          adapterType,
          adapter,
          matched.fields,
          instanceName,
          matched.recordType,
        );
        return;
      }
      // Landings exist but NONE match the WHERE — leave the await ARMED (park),
      // exactly like pending; a later matching arrival resumes it (F10/B.1).
    }
    if (resolution.status === 'empty') {
      // A resolvesEmpty settlement — bind an empty match; downstream runs zero
      // times (F6). Awaiting an already-settled-empty edge is instant.
      this.declareAwaitResult(env, bindingName, adapterType, adapter, {}, instanceName);
      return;
    }

    // Pending: register the correlation on the adapter (its map from the ask id
    // to this park), record the await park, and suspend. Resume re-enters here.
    const parkSink = this.input.parkSink;
    if (!parkSink) {
      throw unsupported(
        'await (a durable park)',
        'this run has no park sink — an await needs the durable trigger-run substrate',
      );
    }
    const awaitable = adapter.awaitable;
    const state: ParkedScopeState = {
      version: 1,
      address,
      // An await binds nothing at park time: resume RE-ENTERS here and the await
      // re-checks live, binding the landing itself (`reenter` semantics).
      bindingName: null,
      scopeChain: serializeScopeChain(env.chainFromRoot()),
    };
    await parkSink.commitAwaitPark({
      address,
      state,
      correlate: (runId: string) =>
        awaitable.registerAwait({
          recordId,
          edge,
          ...(headData !== undefined ? { headData } : {}),
          runId,
          teamId: this.input.teamId as unknown as string,
          address,
        }),
    });
    this.trace.push({ kind: 'gate', outcome: false });
    throw new RunParked(address);
  }

  /**
   * `await cb-[:Called]->` — CHECK-NOW, ELSE PARK, exactly as an adapter await
   * does, with the CALL LEDGER standing in for `resolveAwait`: a call already
   * recorded resolves inline; nothing recorded registers the correlation and
   * parks. Resume RE-ENTERS here and re-reads the ledger live — which is why
   * the calls are never carried on the captured binding.
   *
   * This is also the author's keep-alive: a run that awaits `Called` stays
   * parked, which is how buttons stay live under ruling (b).
   */
  private async interpretCallbackAwait(input: {
    binding: Extract<Binding, { kind: 'callback' }>;
    edge: string;
    hopFilter?: Expression;
    bindingName: string | undefined;
    env: Environment;
    address: string;
  }): Promise<void> {
    const { binding, bindingName, env, address } = input;
    if (input.edge !== CALLBACK_CALLED_EDGE) {
      throw unsupported(
        `await '-[:${input.edge}]->' on a callback`,
        `a callback has one edge, '${CALLBACK_CALLED_EDGE}'`,
      );
    }
    const sink = this.input.callbackSink;
    if (!sink) {
      throw unsupported(
        `await cb-[:${CALLBACK_CALLED_EDGE}]->`,
        'this run has no callback sink — a callback needs the durable trigger-run substrate',
      );
    }

    const calls = await sink.calls(binding.callbackId);
    const matched = calls.find((call) => this.callbackCallMatches(call, input.hopFilter));
    if (matched !== undefined) {
      // The resolved shortcut (S2): a fire already landed — continue inline.
      if (bindingName !== undefined) env.declare(bindingName, this.callbackCallBinding(matched));
      return;
    }

    const parkSink = this.input.parkSink;
    if (!parkSink) {
      throw unsupported(
        `await cb-[:${CALLBACK_CALLED_EDGE}]-> (a durable park)`,
        'this run has no park sink — an await needs the durable trigger-run substrate',
      );
    }
    const state: ParkedScopeState = {
      version: 1,
      address,
      // Re-enter: the await re-reads the ledger and binds its own landing.
      bindingName: null,
      scopeChain: serializeScopeChain(env.chainFromRoot()),
    };
    await parkSink.commitAwaitPark({
      address,
      state,
      correlate: () => sink.correlateAwait({ callbackId: binding.callbackId, address }),
    });
    this.trace.push({ kind: 'gate', outcome: false });
    throw new RunParked(address);
  }

  /**
   * Run a fired callback's BODY — the side entry. The scope chain up to the
   * callback statement is already rehydrated; the body runs in a CHILD of it
   * (closure semantics) carrying the fire-time values, at its own address frame
   * so a body that parks gets a leaf of its own and repeated fires of a
   * repeatable callback never collide.
   *
   * A body-less `callback()` has nothing to run: the fire IS the recorded call,
   * and whoever awaits `Called` is woken by the caller. Not a variant — an
   * empty body does exactly this by construction.
   */
  private async runCallbackBody(input: {
    statement: Statement | undefined;
    stmtAddress: Address;
    env: Environment;
    atAnchor: boolean;
    position: SourcePosition | undefined;
    values: Record<string, unknown>;
    callIndex: number;
  }): Promise<void> {
    const statement = input.statement;
    if (
      statement === undefined ||
      statement.kind !== 'assign' ||
      statement.value.kind !== 'callback'
    ) {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `fireCallback: no callback statement at '${encodeAddress(input.stmtAddress)}' — the run's pinned version and the stored entry point disagree`,
      );
    }
    const subject = statement.value.callback.subject;
    const frameAddress = childIter(input.stmtAddress, input.callIndex);
    const body: BodyContext = {
      atAnchor: input.atAnchor,
      ...(input.position !== undefined ? { position: input.position } : {}),
      address: frameAddress,
    };

    if (subject.kind === 'named') {
      // The named form defers a whole movement with its fixed arguments — the
      // ordinary call path, re-rooted like any call.
      await this.executeCall(
        { kind: 'call', callee: subject.movement, args: subject.args, span: subject.span },
        input.env,
        body,
      );
      return;
    }

    // The inline subject is an ordinary closure, invoked with what the
    // platform sent. What it returns goes nowhere: firing a callback resumes a
    // run, it does not hand a value to whoever minted it.
    const child = input.env.child();
    for (const param of subject.closure.params) {
      child.declare(param.name, {
        kind: 'value',
        value: input.values[param.name] ?? null,
        provenance: NO_PROVENANCE,
      });
    }
    await this.interpretBody(subject.closure.body, child, body);
  }

  /** The awaited hop's pure WHERE against one recorded call. A call's fields are
   *  plain data (no adapter translates them), so the predicate reads them
   *  directly — the same values the bound landing will read. */
  private callbackCallMatches(call: CallbackCall, filter: Expression | undefined): boolean {
    if (filter === undefined) return true;
    const fields: Record<string, unknown> = { [CALLBACK_CALL_AT]: call.at, ...call.values };
    const reads = new Map<string, unknown>();
    for (const leaf of pureLeafReads(filter)) {
      const key = leafReadKey(leaf);
      const dot = key.indexOf('.');
      reads.set(key, fields[dot >= 0 ? key.slice(dot + 1) : key]);
    }
    return Boolean(evaluatePredicate(filter, { read: (name) => reads.get(name) }));
  }

  /**
   * `await until(<condition>, every: <duration>)` (F12) — the recurring-clock
   * wake source. CHECK-NOW, ELSE RE-PARK: evaluate the condition against the
   * current scope; if it holds, bind its value and CONTINUE INLINE; else park on
   * a TIMER (`wake_at = now + every`)
   * whose resume RE-ENTERS this statement to re-evaluate WITHOUT resuming the
   * program forward. The loopless language can't write the loop, so the engine
   * owns it; the cadence is visible so the re-evaluation cost is visible. Metering
   * is ordinary run time (no premium). Under dry_run there is no wall clock to
   * wait on, so we evaluate once and continue (the general dry-run jank, F3/F23).
   */
  private async interpretUntil(
    source: Extract<AwaitSource, { kind: 'until' }>,
    bindingName: string | undefined,
    env: Environment,
    stmtAddress: Address,
    body: BodyContext,
  ): Promise<void> {
    const evaluated = await this.evaluateUntilCondition(source, env, body);

    if (untilConditionMet(evaluated.value) || this.input.dryRun) {
      // Resolve: the await's value is the condition that now holds. Bind it and
      // continue forward.
      if (bindingName !== undefined) {
        env.declare(
          bindingName,
          evaluated.binding ?? { kind: 'value', value: evaluated.value, provenance: NO_PROVENANCE },
        );
      }
      return;
    }

    const parkSink = this.input.parkSink;
    const address = encodeAddress(stmtAddress);
    if (!parkSink) {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `await until reached at '${address}' with no park sink — a recurring wait needs the durable trigger-run substrate`,
      );
    }
    const everyMs =
      source.every !== undefined ? durationToMs(source.every.raw) : UNTIL_DEFAULT_EVERY_MS;
    const state: ParkedScopeState = {
      version: 1,
      address,
      // An `until` binds nothing at park time: resume RE-ENTERS here and, when the
      // condition is met, binds the compared value itself. The `until` flag tells
      // the timer-resume worker to re-enter-and-re-evaluate, not step past.
      bindingName: null,
      until: true,
      scopeChain: serializeScopeChain(env.chainFromRoot()),
    };
    await parkSink.commitTimerPark({
      address,
      state,
      wakeAt: new Date(Date.now() + everyMs),
    });
    this.trace.push({ kind: 'gate', outcome: false });
    throw new RunParked(address);
  }

  /**
   * Evaluate an `until` condition to a testable value: a CLOSURE is invoked
   * once per tick (its `refresh`es re-fetch live) and what it returns is the
   * answer; a plain expression is that same closure with the ceremony elided,
   * evaluated directly. Returns both the raw value (for the holds test) and the
   * binding itself, so a met `until` can escape what it settled on.
   */
  private async evaluateUntilCondition(
    source: Extract<AwaitSource, { kind: 'until' }>,
    env: Environment,
    body: BodyContext,
  ): Promise<{ value: unknown; binding?: Binding }> {
    // A closure literal, or a name bound to one earlier — the same condition,
    // called once per tick.
    if (source.condition.kind === 'closure') {
      return this.tickClosure(
        { kind: 'closure', closure: source.condition.closure, captured: captureScope(env) },
        body,
      );
    }
    const named = this.namedClosure(source.condition.expr, env);
    if (named !== undefined) return this.tickClosure(named, body);
    const { value, provenance } = await this.evaluateSlot(source.condition.expr, { env });
    return { value, binding: { kind: 'value', value, provenance } };
  }

  /** One tick of a closure condition: call it, and take what it returned. */
  private async tickClosure(
    closure: Extract<Binding, { kind: 'closure' }>,
    body: BodyContext,
  ): Promise<{ value: unknown; binding?: Binding }> {
    const outcome = await this.invokeClosure(closure, {}, body);
    if (!outcome.returned) {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        "an 'until' condition returned nothing — the checker should have caught this",
      );
    }
    const bound = outcome.value;
    return { value: bound.kind === 'value' ? bound.value : bound, binding: bound };
  }

  /** A slot that is exactly a name bound to a CLOSURE — the condition written
   *  once and referred to, rather than spelled inline. */
  private namedClosure(
    slot: ExprSlot,
    env: Environment,
  ): Extract<Binding, { kind: 'closure' }> | undefined {
    const trimmed = slot.raw.trim();
    if (!BARE_IDENT.test(trimmed)) return undefined;
    const binding = env.resolve(trimmed);
    return binding?.kind === 'closure' ? binding : undefined;
  }

  /**
   * Call a closure: its captured scope, its parameters, its body. A closure's
   * body is a body like any other, so `return` leaves it the same way — and
   * the capture is a flat snapshot exactly as a deferred walk's is, which is
   * what makes both survive a park.
   */
  private async invokeClosure(
    binding: Extract<Binding, { kind: 'closure' }>,
    values: Record<string, unknown>,
    body: BodyContext,
  ): Promise<BodyOutcome> {
    const env = new Environment();
    for (const [name, captured] of binding.captured) env.declare(name, captured);
    const child = env.child();
    for (const param of binding.closure.params) {
      child.declare(param.name, {
        kind: 'value',
        value: values[param.name] ?? null,
        provenance: NO_PROVENANCE,
      });
    }
    return this.interpretBody(binding.closure.body, child, body);
  }

  /**
   * Bind an awaited edge's resolution as the landed node — a source-position
   * over the awaitable adapter carrying the landing's fields inline (`r.answer`
   * reads through the adapter's `getFieldValue`). An EMPTY resolution binds a
   * fields-less node: `r.answer` reads null and downstream blocks run zero
   * times. `null` fields (no adapter) is the dry-run / no-record case.
   */
  private declareAwaitResult(
    env: Environment,
    bindingName: string | undefined,
    adapterType: string,
    adapter: Adapter | undefined,
    fields: Record<string, unknown> | null,
    instanceName: string,
    // The landing node's natural type (`Response` for an ask, `Message` for a
    // Slack reply). The bound position types AS this, so field reads dispatch to
    // the adapter's `getFieldValue` for the right type. Absent (empty/dry-run) ⇒
    // the ask `Response` default — a fields-less node reads null regardless.
    recordType: string = 'Response',
  ): void {
    if (bindingName === undefined) return;
    if (fields === null || adapter === undefined) {
      env.declare(bindingName, { kind: 'value', value: null, provenance: NO_PROVENANCE });
      return;
    }
    const position = makeUnstablePosition({
      adapterType,
      recordType,
      data: fields,
    });
    // `instanceName` is the awaited head's FILE-SCOPE instance (not the local
    // binding name) — the identity a rehydrated read seam re-resolves through.
    const read: SourceRead = { adapter, instanceName };
    env.declare(bindingName, { kind: 'sourcePosition', position, read });
  }

  /**
   * Does one candidate landing satisfy the awaited hop's pure WHERE (B.1)? The
   * predicate is checker-guaranteed PURE, so its leaf reads resolve THROUGH the
   * adapter's `getFieldValue` for the landing's own type — the same read path the
   * bound body uses — pre-resolved into a map, then evaluated synchronously.
   * Reading candidates the same way they'll be read post-bind is what keeps an
   * adapter that translates field names (Slack: `User` → `user`) honest under a
   * WHERE without the engine knowing any adapter's internal keys.
   */
  private async awaitLandingMatches(
    filter: Expression,
    adapter: Adapter,
    adapterType: string,
    landing: { recordType?: string; fields: Record<string, unknown> },
  ): Promise<boolean> {
    const position = makeUnstablePosition({
      adapterType,
      recordType: landing.recordType ?? 'Response',
      data: landing.fields,
    });
    const reads = new Map<string, unknown>();
    for (const leaf of pureLeafReads(filter)) {
      const key = leafReadKey(leaf);
      const dot = key.indexOf('.');
      // A leaf reads `<alias>.field` or a bare `field` — the alias IS the
      // landing, so strip it to the field name the adapter keys by.
      const field = dot >= 0 ? key.slice(dot + 1) : key;
      reads.set(key, await adapter.getFieldValue({ position, fieldId: field }));
    }
    return Boolean(evaluatePredicate(filter, { read: (name) => reads.get(name) }));
  }

  // ── refresh (asks-as-adapter F5/F22) ──

  /**
   * `refresh <handle>` — re-fetch the record behind a stable handle by its id and
   * MOVE its field snapshot to now (F5): fields read the snapshot, hops stay live,
   * `refresh` advances the snapshot. Serializable across parks (the swap mutates
   * the in-scope binding, which the scope chain carries). A re-fetch of a
   * since-deleted record is a LOUD run error, never absent-ification (F22). Under
   * a rehearsed / dry-run write (no real record id) there is nothing to move, so
   * refresh is a no-op.
   */
  private async interpretRefresh(statement: RefreshStatement, env: Environment): Promise<void> {
    const at = `refresh ${statement.name}`;
    const binding = env.resolve(statement.name);
    if (binding === undefined) {
      throw new MovementEngineError('MOVENG_RUNTIME', `${at}: '${statement.name}' is not in scope`);
    }

    let adapter: Adapter;
    let recordType: string;
    let externalId: string;
    // The CURRENT field snapshot — the getFieldValue fallback re-reads its keys
    // and preserves any the adapter doesn't override (by seeding the probe
    // position's `data` with it), so a re-fetch never nulls out a base id.
    let snapshot: Record<string, unknown>;
    let applyFresh: (fresh: Record<string, unknown>) => void;

    if (binding.kind === 'handle') {
      if (binding.handle.externalId === undefined) return; // rehearsed / dry-run — no record to move
      externalId = binding.handle.externalId;
      recordType = binding.handle.recordType;
      adapter = await this.resolveAdapterFn({
        adapterType: binding.handle.adapterType,
        teamId: this.input.teamId,
        role: 'source',
      });
      const handle = binding.handle;
      snapshot = { ...(handle.resultData ?? {}), ...handle.writtenValues };
      applyFresh = (fresh) => this.applyRefreshToHandle(handle, fresh);
    } else if (binding.kind === 'sourcePosition') {
      const identity = binding.position.identity;
      const rt = binding.position.recordType;
      if (identity.kind !== 'stable' || rt === null) {
        throw new MovementEngineError(
          'MOVENG_RUNTIME',
          `${at}: '${statement.name}' is not a stable record with an id — nothing to re-fetch`,
        );
      }
      externalId = identity.recordId;
      recordType = rt;
      const read = binding.read ?? this.source;
      if (!read) {
        throw new MovementEngineError(
          'MOVENG_RUNTIME',
          `${at}: '${statement.name}' has no read seam — its graph is unknown`,
        );
      }
      adapter = read.adapter;
      snapshot = (positionData(binding.position) as Record<string, unknown> | undefined) ?? {};
      applyFresh = (fresh) => this.applyRefreshToPosition(binding, fresh);
    } else {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `${at}: '${statement.name}' is ${describeBinding[binding.kind]}, not a re-fetchable record`,
      );
    }

    applyFresh(await this.refetchForRefresh({ adapter, recordType, externalId, snapshot, at }));
  }

  /**
   * Re-fetch a record's fields for `refresh`. Prefer `readRecord` — one call for
   * the whole record, and the only seam that can tell a DELETED record (returns
   * null → LOUD F22 error) from a live one. Adapters that expose no `readRecord`
   * (the ask adapter reads every field live from its own store via the universal,
   * required `getFieldValue`) fall back to re-reading each snapshot field through
   * that seam: the probe position carries the current snapshot as its `data`, so
   * a field the adapter doesn't override live is PRESERVED rather than nulled.
   * The fallback cannot distinguish deletion from a null field, so F22 loudness
   * rides `readRecord` only — acceptable, since the surfaces that need refresh and
   * lack readRecord (asks) don't model record deletion.
   */
  private async refetchForRefresh(input: {
    adapter: Adapter;
    recordType: string;
    externalId: string;
    snapshot: Record<string, unknown>;
    at: string;
  }): Promise<Record<string, unknown>> {
    const { adapter, recordType, externalId, snapshot, at } = input;
    if (typeof adapter.readRecord === 'function') {
      const fresh = await adapter.readRecord({ recordType, externalId });
      if (fresh === null) {
        // F22: the record is gone — refresh is LOUD, never absent-ification.
        throw new MovementEngineError(
          'MOVENG_RUNTIME',
          `${at}: record '${externalId}' no longer exists in '${adapter.adapterType}' — it was deleted, so its snapshot can't be refreshed`,
        );
      }
      return fresh;
    }
    const position: SourcePosition = {
      adapterType: adapter.adapterType,
      recordType,
      identity: { kind: 'stable', recordId: externalId, data: snapshot },
    };
    const fresh: Record<string, unknown> = {};
    for (const fieldId of Object.keys(snapshot)) {
      fresh[fieldId] = await adapter.getFieldValue({ position, fieldId });
    }
    return fresh;
  }

  /** Advance a write handle's readable snapshot to the re-fetched fields.
   *  `readHandleField` reads `writtenValues` before `resultData`, so overwrite
   *  any overlapping written field too — the snapshot truly moves. */
  private applyRefreshToHandle(handle: WriteRecord, fresh: Record<string, unknown>): void {
    handle.resultData = { ...(handle.resultData ?? {}), ...fresh };
    for (const key of Object.keys(fresh)) {
      if (key in handle.writtenValues) handle.writtenValues[key] = fresh[key];
    }
  }

  /** Advance a traversed record's inline data snapshot to the re-fetched fields. */
  private applyRefreshToPosition(
    binding: Extract<Binding, { kind: 'sourcePosition' }>,
    fresh: Record<string, unknown>,
  ): void {
    const identity = binding.position.identity;
    if (identity.kind === 'stable') {
      const existing = (identity.data ?? {}) as Record<string, unknown>;
      identity.data = { ...existing, ...fresh };
    }
  }

  // ── inline block expressions (asks-as-adapter F12) ──

  /**
   * `{ …statements…; b = … }.b` — run the block body ONCE in a child scope, then
   * return the named binding (F12). Total: the checker guarantees the binding
   * exists. Used standalone (`x = { … }.b`) and by `until` conditions (re-run per
   * tick; `refresh` inside advances a snapshot live). A missing binding is a loud
   * engine error (the checker should have caught it).
   */
  /** `{ … }.name` — retired with the rest of naming-is-exporting. The checker
   *  refuses it at save time; a program saved before that gets the same refusal
   *  here rather than a silently different meaning. */
  private inlineBlockRetired(binding: string): never {
    throw unsupported(
      `reading a block's inner binding by name ('{ … }.${binding}')`,
      `a body hands its value back with 'return' — bind the value directly, or write a closure ('() => { … return ${binding} }')`,
    );
  }

  /**
   * `ERROR("message")` — fail the whole run with a reason (§3c). Evaluate the
   * message and throw a run-failing engine error; the firing path records a
   * FAILED trigger_run (the existing failure containment in `runMovementFiring`).
   */
  private async interpretError(
    statement: Extract<Statement, { kind: 'error' }>,
    env: Environment,
  ): Promise<void> {
    const { value } = await this.evaluateSlot(statement.message, { env });
    const message = typeof value === 'string' ? value : String(value ?? '');
    throw new MovementEngineError('MOVENG_ERROR', message);
  }

  private async evaluateCondition(slot: ExprSlot, env: Environment): Promise<boolean> {
    let condition: MovementCondition;
    try {
      condition = parseMovementCondition(slot.raw);
    } catch (e) {
      if (e instanceof BridgeError) {
        throw new MovementEngineError(
          'MOVENG_RUNTIME',
          `invalid condition (the checker should have caught this): ${e.message}`,
        );
      }
      throw e;
    }
    return this.evaluateParsedCondition(condition, env);
  }

  private async evaluateParsedCondition(
    condition: MovementCondition,
    env: Environment,
  ): Promise<boolean> {
    switch (condition.kind) {
      case 'isTest':
        return this.evaluateIsTest(condition, env);
      case 'and': {
        for (const conjunct of condition.conjuncts) {
          if (!(await this.evaluateParsedCondition(conjunct, env))) return false;
        }
        return true;
      }
      case 'expr':
        return Boolean(await evaluateMovementExpression(condition.expr, this.exprContext(env)));
    }
  }

  /**
   * Runtime IS — the checker already narrows IS at compile time, so
   * what reaches runtime is the residual union-discrimination test: is
   * this position's RUNTIME type the named one? The engine answers
   * where it knows the type:
   *   - the event parameter: graph identity is the movement's source
   *     instance (binding objects are declared once — object identity
   *     is alias-safe graph identity); the position is the
   *     discriminated event's record type (engine currency, so the
   *     surface name translates through the run's refs first);
   *   - a write handle / shape position: graph + surface type are
   *     carried on the binding and compare directly;
   *   - a TRAVERSAL ALIAS: the landed record's own `recordType`, as the
   *     surface-read wrapper restamped it — which is what makes an `IS`
   *     narrowing of a polymorphic edge actually discriminate at run
   *     time.
   * Where the RECORD KIND is not knowable — an undiscriminated event
   * seed, a landed record the source returned unstamped, or an event
   * whose address says nothing about the axis a test pins — the run FAILS
   * LOUDLY rather than answering. `false` would have meant two different
   * facts at once ("not that kind" and "can't tell"), and the second one
   * fell through to the `else`: an undiscriminated record arriving in an
   * arm typed as "not that kind" is the silent degradation this language
   * bans, and it is what stopped `else` from narrowing at all. Refusing
   * here is what makes the checker's else-arm elimination sound — and it
   * retires the old falsy-skip, which silently did nothing on exactly the
   * events the author wrote the branch for.
   *
   * A test that IS answerable and comes out false (a different graph, a
   * different record kind) is an ordinary false — only "can't tell"
   * throws.
   */
  /** The run cannot answer an `IS` because the subject arrived with no record
   *  kind on it. Author-facing: names the binding and what went missing, in the
   *  same run-failing register as `ERROR(…)` so it lands in run history. */
  private undiscriminatedIsTest(subjectName: string, reason: string): MovementEngineError {
    return new MovementEngineError(
      'MOVENG_RUNTIME',
      `can't tell what kind of record '${subjectName}' is — ${reason}. `
        + `An 'IS' test needs a record whose kind is known, so this run stopped `
        + `rather than pick a branch that might be wrong`,
    );
  }

  private evaluateIsTest(
    condition: Extract<MovementCondition, { kind: 'isTest' }>,
    env: Environment,
  ): boolean {
    const subjectName = condition.subjectRaw.trim();
    if (!BARE_IDENT.test(subjectName)) return false;
    const subject = env.resolve(subjectName);
    const graph = env.resolve(condition.type.graph);
    if (!subject || !graph) return false;
    // A DECLARED NODE names a STRUCTURE, so the test is structural — the same
    // comparator the checker uses, against the same derived schema. It never
    // reads data: what a position OFFERS is declared, and that is the whole
    // question.
    if (graph.kind === 'shape' && condition.type.hopsRaw === undefined) {
      return this.evaluateDeclaredNodeTest(subjectName, subject, graph, env);
    }
    switch (subject.kind) {
      case 'event': {
        if (graph !== this.sourceInstance) return false;
        if (condition.type.position === undefined && condition.type.hopsRaw === undefined) {
          return true;
        }
        const seedAddress = this.sourceEventAddress;
        // An ADDRESS test (`IS <at-[:`Record Change` WHERE `action` == …]->>`)
        // against a typed event: the test is TRUE when its pins are a SUBSET
        // of the seed's own address, agreeing on every value — the same
        // intersection semantics the checker narrows by, over the same two
        // derivations (`eventAddressOfHops` / `eventSeedAddress`), so check
        // time and fire time cannot disagree.
        if (condition.type.hopsRaw !== undefined) {
          const test = eventAddressOfHops(condition.type.hopsRaw);
          if (test === undefined) return false;
          if (seedAddress !== undefined) {
            if (test.event !== seedAddress.event) return false;
            // An axis the seed never pinned is "can't tell", not "not that
            // one" — the same distinction the record plane draws, on the plane
            // where the kind is an ADDRESS rather than a type name. The seed's
            // pins come off the payload, so a trigger that delivered the event
            // without its `action` (or without a declared narrowing key) leaves
            // every pinned test unanswerable; returning false there would route
            // the run into an `else` the checker has typed as "none of the
            // tested addresses", which is the elimination reading a silence as
            // a fact. A pin the seed HAS, disagreeing, is an ordinary false.
            const unpinned = Object.keys(test.narrowing).filter(
              key => seedAddress.narrowing[key] === undefined,
            );
            if (unpinned.length > 0) {
              throw this.undiscriminatedIsTest(subjectName, unpinnedAxis(unpinned));
            }
            return Object.entries(test.narrowing).every(
              ([key, value]) => seedAddress.narrowing[key] === value,
            );
          }
          const keyed = this.source?.position?.recordType ?? undefined;
          if (keyed == null) throw this.undiscriminatedIsTest(subjectName, UNDISCRIMINATED_EVENT);
          return eventAddressKey(test) === keyed;
        }
        // Position-form (`IS <chat-[:`Message Received`]->>`): an unpinned
        // event-node name is a subset test with no pins.
        if (seedAddress !== undefined && condition.type.position === seedAddress.event) {
          return true;
        }
        const position = this.source?.position;
        // A typed webhook event is an UNSTABLE position — the live record is
        // reached by the record edge, not carried on the seed — so we read
        // `recordType` directly rather than gating on stability. A genuinely
        // undiscriminated event carries `recordType: null`: nothing to compare,
        // so the run refuses rather than guessing a branch.
        const recordType = position?.recordType ?? undefined;
        if (recordType == null) throw this.undiscriminatedIsTest(subjectName, UNDISCRIMINATED_EVENT);
        // Adapter type names are the adapter's own verbatim ids — the named
        // position type compares directly to the runtime record type.
        return condition.type.position === recordType;
      }
      case 'handle': {
        // An ADDRESS test names an event narrowing; a handle is never one.
        if (condition.type.hopsRaw !== undefined) return false;
        if (graph !== subject.graph.instance) return false;
        return (
          condition.type.position === undefined || condition.type.position === subject.targetType
        );
      }
      case 'sourcePosition': {
        // A TRAVERSAL ALIAS — a landed source record. Its type is in hand: the
        // adapter stamped `recordType` and the surface-read wrapper restamped
        // it to the natural name the program speaks, which is the same
        // vocabulary the type marker names. This case used to be absent, so
        // every `IS` on a traversal result fell to `false` and quietly skipped
        // its arm — the narrowing the checker had already typed the body under
        // simply never happened.
        //
        // An ADDRESS test names an event narrowing; a landed record is never
        // one (only the event seed carries an address).
        if (condition.type.hopsRaw !== undefined) return false;
        // The graph the alias was YIELDED from — its own read seam when it came
        // from an instance-/kg-rooted head, else the movement's source. Both
        // sides name it the same way (the binding's own name), so the
        // comparison cannot drift.
        const yieldedFrom = subject.read?.instanceName ?? this.sourceInstance?.name;
        const named = graph.kind === 'instance' ? graph.name : undefined;
        if (named === undefined || yieldedFrom === undefined || named !== yieldedFrom) return false;
        // An unstamped landing is the other "can't tell" case: the source
        // handed back a record without saying what it is, so there is no
        // honest branch to take.
        const recordType = subject.position.recordType ?? undefined;
        if (recordType == null) throw this.undiscriminatedIsTest(subjectName, UNSTAMPED_LANDING);
        return condition.type.position === undefined || condition.type.position === recordType;
      }
      // A declared node is handled structurally above; any OTHER graph is a
      // different graph, which is an ordinary false.
      case 'shapePosition':
        return false;
      default:
        return false;
    }
  }

  /**
   * `rec IS <Doc>` — STRUCTURAL conformance, not a name match.
   *
   * A declared node belongs to no graph, so "is this the same position" is not
   * the question; "does this position carry everything Doc declares" is, and it
   * is decidable from what the position DECLARES — the record type's schema, or
   * a synthesised node's own entries. No data is read, and a field being null
   * is not a misfit: the surface is what the position offers, not what this
   * record happens to hold.
   *
   * Same comparator and same derived schema as the checker (`surfaceMisfit` /
   * `shapeToSchema`), so a predicate cannot mean one thing while authoring and
   * another while running.
   *
   * THREE answers, because there are three facts. A subject with a surface is
   * compared. A subject that is not a position at all is an ordinary false —
   * no structure, so nothing to conform. A subject that IS a position whose
   * structure the run cannot see fails the run, exactly as an undiscriminated
   * event does: "can't tell" and "not that shape" must not share an answer,
   * because the second one routes into an `else` the checker types as
   * "doesn't fit".
   *
   */
  private evaluateDeclaredNodeTest(
    subjectName: string,
    subject: Binding,
    graph: Extract<Binding, { kind: 'shape' }>,
    env: Environment,
  ): boolean {
    const subjectSurface = this.subjectSurface(subject, env);
    if (subjectSurface.kind === 'notARecord') return false;
    if (subjectSurface.kind === 'unknown') {
      throw this.undiscriminatedIsTest(subjectName, subjectSurface.reason);
    }
    const declared = shapeToSchema(graph.declaration, (name) => this.declaredTypes.get(name));
    return (
      surfaceMisfit(subjectSurface.surface, {
        schema: declared,
        position: graph.declaration.name,
      }) === undefined
    );
  }

  /**
   * What a bound subject OFFERS, in the comparator's currency — or which of the
   * two non-answers it is.
   *
   * The ROOT subject is what the branch turns on, so an `unknown` there stops
   * the run. A LANDING reached across an edge is the comparator's ordinary
   * unknown and fits, which is the rule the checker follows for exactly the
   * same landing (`suppliedSurface` returns nothing for a position with no
   * published surface).
   */
  private subjectSurface(subject: Binding, env: Environment): SubjectSurface {
    switch (subject.kind) {
      case 'event': {
        const recordType = this.source?.position?.recordType ?? undefined;
        if (recordType == null) return { kind: 'unknown', reason: UNDISCRIMINATED_EVENT };
        return positionSurface(this.sourceInstance?.schema, recordType);
      }
      case 'sourcePosition': {
        const recordType = subject.position.recordType ?? undefined;
        if (recordType == null) return { kind: 'unknown', reason: UNSTAMPED_LANDING };
        const from = subject.read?.instanceName ?? this.sourceInstance?.name;
        return positionSurface(
          from === undefined ? undefined : this.graphSchemaOf(from, env),
          recordType,
        );
      }
      case 'handle':
        return positionSurface(subject.graph.instance.schema, subject.targetType);
      case 'shapePosition': {
        const declaration = env.resolve(subject.shape);
        return declaration?.kind === 'shape'
          ? positionSurface(
              shapeToSchema(declaration.declaration, (name) => this.declaredTypes.get(name)),
              subject.node,
            )
          : { kind: 'unknown', reason: UNKNOWN_STRUCTURE };
      }
      // The synthesised planes carry their own structure — the literal's
      // entries ARE the surface, which is why a `node { … }` fits a declaration
      // it never names.
      case 'nodePosition':
        return this.synthesisedSurface(subject.fields, subject.edges, env, name => {
          const edge = subject.edges[name];
          return edge.kind === 'landed' ? edge.landings[0] : undefined;
        });
      case 'extractRoot':
      case 'extractPosition':
        return this.synthesisedSurface(
          subject.emission.fields,
          Object.fromEntries([...subject.emission.children.keys()].map(k => [k, null])),
          env,
          name => {
            const child = subject.emission.children.get(name)?.[0];
            return child === undefined
              ? undefined
              : ({ kind: 'extractPosition', emission: child } as const);
          },
        );
      case 'blockMeta':
        return this.synthesisedSurface(
          {},
          Object.fromEntries([...subject.edges.keys()].map(k => [k, null])),
          env,
          name => subject.edges.get(name)?.[0],
        );
      default:
        return { kind: 'notARecord' };
    }
  }

  /** One shape for every in-memory plane pair: entry names on the dot plane
   *  (values are not types, so each is declared-but-untyped), and one lazily
   *  resolved landing per edge name. */
  private synthesisedSurface(
    fields: Record<string, unknown>,
    edgeNames: Record<string, unknown>,
    env: Environment,
    landingOf: (name: string) => Binding | undefined,
  ): SubjectSurface {
    return {
      kind: 'surface',
      surface: {
        properties: Object.fromEntries(Object.keys(fields).map(f => [f, undefined])),
        edges: Object.fromEntries(
          Object.keys(edgeNames).map(name => [
            name,
            () => {
              const landing = landingOf(name);
              if (landing === undefined) return undefined;
              const inner = this.subjectSurface(landing, env);
              return inner.kind === 'surface' ? inner.surface : undefined;
            },
          ]),
        ),
      },
    };
  }

  // ── Extraction (E2) ──

  /**
   * `deals = extract from […] { tree }` — build the static spec (explicit
   * annotations only; BORROWED dotted paths resolve against the live
   * instance schemas in scope, per firing — so enum options reach the LLM
   * exactly as the borrowed field carries them today), then hand the
   * planner the runtime seams: the pluggable LLM client, the transform
   * invoker, and slot evaluation bound to the current scope. Backward
   * adoption from write targets is demoted (the checker SUGGESTS the
   * annotation instead); only annotation-resolved types constrain.
   */
  private async runExtraction(_bindingName: string, extract: ExtractExpression, env: Environment) {
    const spec = buildExtractSpec(extract, {
      resolveBorrowed: ([instanceName, rootName, fieldName]) => {
        const schema = this.graphSchemaOf(instanceName, env);
        if (!schema) return undefined;
        return resolveBorrowedField(schema, rootName, fieldName);
      },
      resolveDeclaredType: (name) => this.declaredTypes.get(name),
    });
    // Where this extract's own trace entries start — the materialiser
    // appends one per LLM region, and the emitted entities are hung off
    // them once the whole tree exists (see `recordExtractedEntities`).
    const traceMark = this.trace.length;
    const emission = await materializeExtract({
      extract,
      spec,
      runtime: {
        llm: this.llmClient(),
        transformInvoker: this.input.transformInvoker ?? registryTransformInvoker,
        evalSlot: (slot) => this.evaluateSlot(slot, { env }),
        resolveFileText: this.input.resolveFileText ?? makeFileTextResolver(),
        trace: this.trace,
      },
    });
    recordExtractedEntities(this.trace, traceMark, emission);
    return emission;
  }

  /** The live schema a borrowed type resolves against: a constructed
   *  instance's. (Shape graphs declare primitive field types inline —
   *  nothing to borrow.) */
  private graphSchemaOf(instanceName: string, env: Environment): InstanceSchema | undefined {
    const binding = env.resolve(instanceName);
    return binding?.kind === 'instance' ? binding.schema : undefined;
  }

  private llmClient(): LlmClient {
    if (this.input.llm) return this.input.llm;
    this.defaultLlm ??= makeAnthropicLlmClient();
    return this.defaultLlm;
  }

  // ── Traversal-headed blocks ──

  /**
   * The block runs once per position its head yields — per emitted
   * entity over extract edges, per resource over `#resources`. Each
   * iteration interprets the body in a fresh child environment (so an
   * iteration's bindings never leak into the next — per-position
   * isolation), and the iteration's NAMED bindings accumulate as the
   * block's meta-node edges. Binding the block (`orgs = …-> { … }`)
   * declares that meta-node; an unbound block discards it.
   */
  private async interpretBlock(
    block: TraversalBlock,
    bindingName: string | undefined,
    env: Environment,
    parentAddress: Address,
  ): Promise<void> {
    const iterations = await this.resolveBlockIterations(block, env);
    this.trace.push({
      kind: 'block',
      root: blockRootLabel(block),
      positions: iterations.length,
    });
    const returned: Binding[] = [];
    let parkedIterations = 0;
    for (let iterIndex = 0; iterIndex < iterations.length; iterIndex++) {
      const iteration = iterations[iterIndex];
      const iterationEnv = env.child();
      for (const [alias, binding] of iteration.bindings) iterationEnv.declare(alias, binding);
      // Block iterations are per-emission positions, never the trigger's
      // anchor — mirrors the TG engine, where a traversal moves the
      // action off the seeded root (W3-Y1 anchor-only bridging). An
      // adapter-edge iteration carries its yielded record as the body's
      // position, so writes bridge to it (the snapshot fan-out shape). Each
      // iteration is `iter j` of this fan-out (§4.3) — positional, stable
      // because A serialises the item list and never re-derives it.
      let outcome: BodyOutcome;
      try {
        outcome = await this.interpretBody(block.body, iterationEnv, {
          atAnchor: false,
          ...(iteration.position !== undefined ? { position: iteration.position } : {}),
          address: childIter(parentAddress, iterIndex),
        });
      } catch (e) {
        // A parked iteration RECORDS its ask (at its `iter j` address) but does
        // NOT halt the fan-out — the next iteration runs its own synchronous
        // prefix and parks at its own ask. So a fan-out over N items fires all N
        // asks (§4.2). Its bindings don't accumulate (it didn't complete).
        if (e instanceof RunParked) {
          parkedIterations += 1;
          continue;
        }
        // Find-on-missing inside a fan-out: THAT iteration skips; the next runs.
        if (!(e instanceof ScopeEndedQuietly)) throw e;
        continue;
      }
      // The ONE way a value leaves an iteration is its `return`; nothing else
      // the body bound escapes.
      if (outcome.returned) returned.push(outcome.value);
    }
    if (bindingName !== undefined) {
      env.declare(bindingName, blockValue(returned));
    }
    // If ANY iteration parked, this fan-out frame is itself pending — record its
    // pending-count (§5.4: the number of parked iterations to wait on), then
    // re-throw so the enclosing sequence stops (§4.2); the join completes once
    // every parked item has resolved (the atomic decrement). The frame address
    // is the fan-out STATEMENT's address (`parentAddress`).
    if (parkedIterations > 0) {
      const frameAddress = encodeAddress(parentAddress);
      await this.input.parkSink?.recordJoin({ frameAddress, parkedChildren: parkedIterations });
      throw new RunParked(frameAddress);
    }
  }

  /**
   * Resolve a block head to its iterations: one alias→binding map per
   * yielded position (plus the yielded SourcePosition itself for
   * adapter-edge heads — the iteration's write-bridge currency). Heads
   * walk extract edges (from an extract root or a deeper extracted
   * entity), adapter edges (collections off the meta root, schema edges
   * off the event or an already-yielded record — the TG engine's
   * iterateRelated/getRelated seam), or a position's `#resources`.
   */
  private async resolveBlockIterations(
    block: TraversalBlock,
    env: Environment,
  ): Promise<BlockIteration[]> {
    return this.resolveHeadIterations(block.head, env);
  }

  /**
   * The head walk itself, independent of any block: `extraSteps` continue past
   * the head's own hops in the SAME walk (what a read through a deferred edge
   * needs — the hops past the edge are hops in the source graph).
   */
  private async resolveHeadIterations(
    head: PathHead,
    env: Environment,
    extraSteps: Extract<Expression, { type: 'traverse' }>['steps'] = [],
  ): Promise<BlockIteration[]> {
    const probed = this.probeHead(head);
    const probe =
      probed?.type === 'traverse' && extraSteps.length > 0
        ? { ...probed, steps: [...probed.steps, ...extraSteps] }
        : probed;
    if (extraSteps.length > 0 && probe?.type !== 'traverse') {
      throw unsupported('continuing a walk past a head that is not a traversal');
    }
    if (head.root === undefined) {
      throw unsupported(
        'rootless block heads (relative traversal)',
        'root the head at a named binding',
      );
    }
    const rootBinding = env.resolve(head.root);
    if (!rootBinding) {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `'${head.root}' is not in scope — the checker should have caught this`,
      );
    }
    return this.headIterationsFrom({ binding: rootBinding, head, root: head.root, probe, env });
  }

  /**
   * The head walk from ONE root binding. Split from `resolveHeadIterations` so
   * a collection of roots — a bound block's returned records — is the same walk
   * run off each of them.
   */
  private async headIterationsFrom(opts: {
    binding: Binding;
    head: PathHead;
    /** The name the head is rooted at — for the messages, and narrowed here. */
    root: string;
    probe: Expression | undefined;
    env: Environment;
  }): Promise<BlockIteration[]> {
    const { binding: rootBinding, head, root, probe, env } = opts;
    if (rootBinding.kind === 'positions') {
      // `orgs-[n:Notes]-> { … }` where `orgs` is what a block returned. The
      // returned records ARE the collection, so the hop is that hop off each
      // one, concatenated — exactly what a traversal's own landings do. Zero
      // landings yield zero iterations: the body runs zero times, which IS the
      // traversal gate, and is why a block that ran zero times is bound here
      // rather than on the value plane.
      const perLanding: BlockIteration[] = [];
      for (const landing of rootBinding.landings) {
        perLanding.push(
          ...(await this.headIterationsFrom({ binding: landing, head, root, probe, env })),
        );
      }
      return perLanding;
    }

    if (rootBinding.kind === 'callback') {
      // `cb-[c:Called]-> { … }` — the SYNCHRONOUS read of the calls so far.
      // Zero of them before anything fires is an empty traversal (the block runs
      // zero times), not a special state; a repeatable callback simply
      // accumulates, and traversals are many-valued already.
      if (probe?.type !== 'traverse' || probe.steps.length !== 1) {
        throw unsupported('this block head over a callback');
      }
      const step = probe.steps[0];
      if (step.type !== 'edge' || step.edgeTypeId !== CALLBACK_CALLED_EDGE) {
        throw unsupported(
          `'${head.hopsRaw}' on a callback`,
          `a callback has one edge, '${CALLBACK_CALLED_EDGE}'`,
        );
      }
      const sink = this.input.callbackSink;
      if (!sink) {
        throw unsupported(
          `cb-[:${CALLBACK_CALLED_EDGE}]->`,
          'this run has no callback sink — a callback needs the durable trigger-run substrate',
        );
      }
      const calls = await sink.calls(rootBinding.callbackId);
      return calls
        .filter((call) => this.callbackCallMatches(call, step.expressionFilter))
        .map((call) => {
          const landing = this.callbackCallBinding(call);
          const bindings = new Map<string, Binding>();
          if (step.alias !== undefined) bindings.set(step.alias, landing);
          return { bindings, landing };
        });
    }

    if (rootBinding.kind === 'nodePosition' || rootBinding.kind === 'lazyWalk') {
      // `d-[c:company]-> { … }` — the synthesised edge, fanned out. One landing
      // for a single nested literal, N for a list, and for a PASS-THROUGH edge
      // whatever its walk yields; an edge the literal never wrote runs the body
      // zero times, like any empty traversal.
      if (probe?.type !== 'traverse') {
        throw unsupported(`this block head over ${describeBinding[rootBinding.kind]}`);
      }
      return this.walkSynthesisedEdges(rootBinding, probe.steps, env);
    }

    if (rootBinding.kind === 'extractRoot' || rootBinding.kind === 'extractPosition') {
      // `extractedNode-[f:_resources]->` — the SOURCE CONTENT that fed this
      // node's extraction (Layer 5 provenance). Resolved IN-FLIGHT against the
      // resources the materialiser stamped onto the emission (the node is not a
      // persisted KG node yet — there is no readback). FILE resources carry the
      // source `FileRef`, so a write off this hop carries the file forward.
      if (probe?.type === 'resource_traverse') {
        const alias = RESOURCES_HEAD_ALIAS.exec(head.hopsRaw)?.[1];
        const resources = await this.filterResources(
          rootBinding.emission.resources,
          probe,
          env,
        );
        return resources.map((resource) => {
          const landing: Binding = { kind: 'resource', resource };
          const bindings = new Map<string, Binding>();
          if (alias !== undefined) bindings.set(alias, landing);
          return { bindings, landing };
        });
      }
      if (probe?.type !== 'traverse') {
        throw unsupported('this block head over an extract result');
      }
      // Iterate emission PATHS so every hop alias binds its own level's
      // entity for the iteration.
      let paths: Array<{ aliases: Map<string, Binding>; emission: typeof rootBinding.emission }> = [
        { aliases: new Map(), emission: rootBinding.emission },
      ];
      for (const step of probe.steps) {
        if (step.type !== 'edge') {
          throw unsupported(`'${step.type}' hops in a block head over an extract result`);
        }
        if (step.expressionFilter) {
          throw unsupported('WHERE filters on extract-result block heads');
        }
        const next: typeof paths = [];
        for (const path of paths) {
          for (const child of path.emission.children.get(step.edgeTypeId) ?? []) {
            const aliases = new Map(path.aliases);
            if (step.alias !== undefined) {
              aliases.set(step.alias, { kind: 'extractPosition', emission: child });
            }
            next.push({ aliases, emission: child });
          }
        }
        paths = next;
      }
      return paths.map((p) => ({
        bindings: p.aliases,
        landing: { kind: 'extractPosition' as const, emission: p.emission },
      }));
    }

    // A graph-rooted head — `crm-[c:companies]-> { … }` (the backfill
    // shape, rooted at a constructed instance in-body) or a write handle
    // (`co-[c:contacts]-> { … }`, the write result IS a position) — streams
    // through THAT graph's adapter from its meta / stable position.
    if (rootBinding.kind === 'instance' || rootBinding.kind === 'handle') {
      if (probe?.type !== 'traverse') {
        throw unsupported(`this block head over ${describeBinding[rootBinding.kind]}`);
      }
      const resolved = await this.graphReadFor(root, rootBinding);
      if (!resolved) {
        throw unsupported(`block heads rooted at '${root}' (a ${rootBinding.kind} binding)`);
      }
      return this.walkSourceHeadPaths({
        start: resolved.start,
        steps: probe.steps,
        env,
        read: resolved.read,
      });
    }

    if (rootBinding.kind === 'event' || rootBinding.kind === 'sourcePosition') {
      if (!this.source) {
        throw new MovementEngineError(
          'MOVENG_RUNTIME',
          'no event in scope for a source-graph block head',
        );
      }
      const start = rootBinding.kind === 'event' ? this.source.position : rootBinding.position;
      const read =
        rootBinding.kind === 'sourcePosition' && rootBinding.read !== undefined
          ? rootBinding.read
          : this.source;

      // `x-[f:_resources]->` — the position's resource bundle, resolved
      // through the same adapter path as the TG engine's resources edge.
      // The bridge parses a `_resources` hop to `resource_traverse`,
      // which carries the filter but NOT the alias or root — those are
      // lexical-only, read off the raw hop text exactly as the
      // checker's head-alias extraction does.
      if (probe?.type === 'resource_traverse') {
        const alias = RESOURCES_HEAD_ALIAS.exec(head.hopsRaw)?.[1];
        const resources = await this.filterResources(
          await resolvePositionResources({
            adapter: this.source.adapter,
            position: start,
            filter: probe.filter,
          }),
          probe,
          env,
        );
        return resources.map((resource) => {
          const landing: Binding = { kind: 'resource', resource };
          const bindings = new Map<string, Binding>();
          if (alias !== undefined) {
            bindings.set(alias, landing);
          }
          return { bindings, landing };
        });
      }

      // Adapter-edge head: `root-[c:companies]->` off the meta position
      // (collection fan-out), `msg-[a:files]->` off a webhook record —
      // both stream through the source adapter's getRelated seam.
      if (probe?.type !== 'traverse') {
        throw unsupported(`this block head over ${describeBinding[rootBinding.kind]}`);
      }
      return this.walkSourceHeadPaths({ start, steps: probe.steps, env, read });
    }

    if (rootBinding.kind === 'blockMeta') {
      // A block head over a race receipt / block meta-node (asks-as-adapter
      // chunk C: `r-[res:result]-> { … }`, `r-[m:asks]-> { m-[x:a]-> … }`). Walk
      // the meta edges (mirrors expression.ts `walkMetaSteps`), binding each
      // hop's alias to that level's binding, one iteration per final path. An
      // edge that isn't there (an un-won branch) yields ZERO iterations — the
      // block runs zero times, which IS the gate (F6/S19). Source landings carry
      // their position for write-bridging; a handle/value binds without one.
      if (probe?.type !== 'traverse') {
        throw unsupported('this block head over a block meta-node');
      }
      let paths: Array<{ aliases: Map<string, Binding>; binding: Binding }> = [
        { aliases: new Map(), binding: rootBinding },
      ];
      for (const step of probe.steps) {
        if (step.type !== 'edge') {
          throw unsupported(`'${step.type}' hops in a block head over a block meta-node`);
        }
        if (step.expressionFilter) {
          throw unsupported('WHERE filters on block meta-node block heads');
        }
        const next: typeof paths = [];
        for (const path of paths) {
          for (const child of metaEdgeBindings(path.binding, step.edgeTypeId)) {
            const aliases = new Map(path.aliases);
            if (step.alias !== undefined) aliases.set(step.alias, child);
            next.push({ aliases, binding: child });
          }
        }
        paths = next;
      }
      return paths.map((p) => {
        const position = p.binding.kind === 'sourcePosition' ? p.binding.position : undefined;
        return {
          bindings: p.aliases,
          landing: p.binding,
          ...(position !== undefined ? { position } : {}),
        };
      });
    }
    throw unsupported(`block heads rooted at '${root}' (a ${rootBinding.kind} binding)`);
  }

  /**
   * Walk the arrow plane of a synthesised node (or straight off a `lazy`
   * binding): each hop crosses one declared edge, fanning out over its
   * landings. A DEFERRED edge hands the REST of the chain to its stored walk —
   * past that edge the hops are hops in the source graph, and the source's own
   * walker owns them, filters and ordering included. Mirrors expression.ts
   * `walkMetaSteps`, which reads the same planes for expressions.
   */
  private async walkSynthesisedEdges(
    root: Extract<Binding, { kind: 'nodePosition' | 'lazyWalk' }>,
    steps: Extract<Expression, { type: 'traverse' }>['steps'],
    env: Environment,
  ): Promise<BlockIteration[]> {
    // A lazy binding IS the walk: the whole chain continues from it.
    if (root.kind === 'lazyWalk') return this.runDeferredWalk(root.walk, steps);
    return this.walkNodePlane([{ aliases: new Map(), binding: root }], steps, env);
  }

  private async walkNodePlane(
    paths: Array<{ aliases: Map<string, Binding>; binding: Binding }>,
    steps: Extract<Expression, { type: 'traverse' }>['steps'],
    env: Environment,
  ): Promise<BlockIteration[]> {
    if (steps.length === 0) {
      // A landing that IS a source record carries its position, so a write in
      // the body bridges to it exactly as it would off any traversal.
      return paths.map((p) => ({
        bindings: p.aliases,
        landing: p.binding,
        ...(p.binding.kind === 'sourcePosition' ? { position: p.binding.position } : {}),
      }));
    }
    const [step, ...rest] = steps;
    if (step.type !== 'edge') {
      throw unsupported(`'${step.type}' hops over a synthesised node`);
    }
    const reached: BlockIteration[] = [];
    for (const path of paths) {
      if (path.binding.kind === 'lazyWalk') {
        reached.push(
          ...(await this.continueDeferred(path.aliases, path.binding.walk, steps)),
        );
        continue;
      }
      if (path.binding.kind === 'sourcePosition') {
        // Past a pass-through edge we are in the SOURCE graph — the source's
        // own walker takes the rest of the chain, WHERE and ordering included.
        const read = path.binding.read ?? this.source;
        if (!read) {
          throw new MovementEngineError(
            'MOVENG_RUNTIME',
            `no read seam for a hop off a landed position ('${step.edgeTypeId}')`,
          );
        }
        const onward = await this.walkSourceHeadPaths({
          start: path.binding.position,
          steps,
          env,
          read,
        });
        reached.push(
          ...onward.map((iteration) => ({
            ...iteration,
            bindings: new Map([...path.aliases, ...iteration.bindings]),
          })),
        );
        continue;
      }
      if (path.binding.kind !== 'nodePosition') {
        // A landing an appended `link` put here (a write handle, say) is a
        // position in ITS OWN graph, and this walker only knows the node plane.
        // Reaching it as the walk's DESTINATION is the early return above;
        // hopping PAST it needs the source walk, which starts from a head.
        throw unsupported(
          `hopping past a '${step.edgeTypeId}' landing that is ${describeBinding[path.binding.kind]}`,
          'traverse the edge into a block and walk on from the landing there',
        );
      }
      const edge = path.binding.edges[step.edgeTypeId];
      if (step.expressionFilter) {
        throw unsupported(
          'WHERE filters on synthesised-node block heads',
          "narrow the entry's own traversal instead — the WHERE belongs on the hop the node's edge is built from",
        );
      }
      if (edge?.kind === 'deferred') {
        if (rest.length > 0 && step.alias !== undefined) {
          // The alias would name a position part-way through the merged walk,
          // and the walk binds its own hops' aliases, not this one. Loud
          // rather than quietly unbound.
          throw unsupported(
            `naming a deferred edge's landing ('${step.alias}') while hopping past it`,
            'drop the alias, or bind the deferred traversal above and traverse from there',
          );
        }
        reached.push(
          ...(await this.continueDeferred(path.aliases, edge.walk, rest, step.alias)),
        );
        continue;
      }
      const next = (edge?.kind === 'landed' ? edge.landings : []).map((landing) => {
        const aliases = new Map(path.aliases);
        if (step.alias !== undefined) aliases.set(step.alias, landing);
        return { aliases, binding: landing };
      });
      reached.push(...(await this.walkNodePlane(next, rest, env)));
    }
    return reached;
  }

  /** Run a deferred walk and fold its iterations into the aliases already
   *  bound on the way in — the outer path's names stay visible inside. */
  private async continueDeferred(
    outer: Map<string, Binding>,
    walk: DeferredWalk,
    steps: Extract<Expression, { type: 'traverse' }>['steps'],
    alias?: string,
  ): Promise<BlockIteration[]> {
    const iterations = await this.runDeferredWalk(walk, steps);
    return iterations.map((iteration) => {
      const bindings = new Map(outer);
      for (const [name, binding] of iteration.bindings) bindings.set(name, binding);
      if (alias !== undefined && iteration.landing !== undefined) {
        bindings.set(alias, iteration.landing);
      }
      return { ...iteration, bindings };
    });
  }

  /**
   * Walk an adapter-edge block head: each hop streams the current
   * positions through the head's read seam (`iterateRelated` when the
   * adapter publishes it — snapshot fan-outs may be large — else
   * `getRelated`), honouring per-hop WHERE filters position-scoped,
   * then the hop's bracket ORDER BY / LIMIT per origin position, and
   * binding each hop alias to its own level's record per path. The
   * fieldId crossing the adapter boundary is position-sensitive: hops
   * off the meta root resolve as collections (typeId currency), record
   * hops as reference fields (see `SourceRead.edgeFieldId`).
   *
   * The fetch itself is `closedHopPushdown` — the same WHERE (closed over
   * the surrounding scope, so a name the author bound reaches the source as a
   * value), ORDER BY and LIMIT an expression hop or an EXISTS hop sends,
   * because the syntax promises the same records wherever the bracket is
   * written (plans/ordering-primitives-2026-09-04/1_decisions.md D1). What the
   * adapter does with it is its business: the engine filters, sorts and
   * slices what comes back regardless, so the answer never depends on it.
   */
  private async walkSourceHeadPaths(input: {
    start: SourcePosition;
    steps: Extract<Expression, { type: 'traverse' }>['steps'];
    env: Environment;
    /** The graph the head reads through — the movement's event source,
     *  or a graph-rooted head's own seam (graphReadFor). */
    read: SourceRead;
  }): Promise<BlockIteration[]> {
    const read = input.read;
    const adapter = read.adapter;
    /** The head's own seam rides each yielded binding only when it is
     *  NOT the event source (event-sourced reads keep resolving through
     *  ctx.source, as before). */
    const bindingRead = read === this.source ? undefined : read;
    let paths: Array<{
      aliases: Map<string, Binding>;
      position: SourcePosition;
      edgeProperties?: Record<string, unknown>;
    }> = [{ aliases: new Map(), position: input.start }];
    for (const step of input.steps) {
      if (step.type !== 'edge') {
        throw unsupported(`'${step.type}' hops in a block head over the source graph`);
      }
      if (step.direction === 'incoming' && !adapter.runtimeCapabilities().traversal.incoming) {
        throw unsupported(
          `incoming block-head hops ('${step.edgeTypeId}')`,
          `source adapter '${adapter.adapterType}' cannot traverse incoming edges`,
        );
      }
      const next: typeof paths = [];
      // Closed over the head's own scope, once for the hop — every origin
      // position in this level reads the same outer bindings.
      const pushdown = await closedHopPushdown({
        step,
        ctx: this.exprContext(input.env),
        edgeProperties: adapter.runtimeCapabilities().traversal.edgeProperties,
      });
      for (const path of paths) {
        const fieldId = read.edgeFieldId?.(step.edgeTypeId, path.position) ?? step.edgeTypeId;
        const landed = adapter.iterateRelated
          ? adapter.iterateRelated({
              position: path.position,
              fieldId,
              direction: step.direction,
              ...pushdown,
            })
          : await adapter.getRelated({
              position: path.position,
              fieldId,
              direction: step.direction,
              ...pushdown,
            });
        const kept: typeof paths = [];
        for await (const r of landed) {
          const edgeProperties =
            r.edgeProperties !== undefined ? { edgeProperties: r.edgeProperties } : {};
          const positionScope = {
            kind: 'position' as const,
            position: r.position,
            ...edgeProperties,
            ...(bindingRead !== undefined ? { read: bindingRead } : {}),
          };
          if (step.expressionFilter) {
            // Position-scoped, per landed record — `property` reads hit
            // the destination, `edge_property` reads the walked edge's
            // inline properties (the bracket-WHERE grammar's currency).
            const keep = await evaluateMovementExpression(step.expressionFilter, {
              ...this.exprContext(input.env),
              scope: positionScope,
            });
            if (!keep) continue;
          }
          const aliases = new Map(path.aliases);
          if (step.alias !== undefined) {
            aliases.set(step.alias, {
              kind: 'sourcePosition',
              position: r.position,
              ...edgeProperties,
              ...(bindingRead !== undefined ? { read: bindingRead } : {}),
            });
          }
          kept.push({ aliases, position: r.position, ...edgeProperties });
        }
        // Bracket ORDER BY / LIMIT — per origin position, post-stream. The key
        // is read against the landed record, through the same reader an
        // expression hop uses, so the same bracket ranks the same way wherever
        // it is written.
        const readOrderKey = hopOrderKeyReader(step, this.exprContext(input.env));
        next.push(
          ...(await applyHopOrderLimit(kept, step.cardinality, {
            value: (item) =>
              readOrderKey({
                kind: 'sourcePosition',
                position: item.position,
                ...(item.edgeProperties !== undefined
                  ? { edgeProperties: item.edgeProperties }
                  : {}),
                ...(bindingRead !== undefined ? { read: bindingRead } : {}),
              }),
          })),
        );
      }
      paths = next;
      if (paths.length === 0) return [];
    }
    return paths.map((p) => ({
      bindings: p.aliases,
      position: p.position,
      landing: {
        kind: 'sourcePosition' as const,
        position: p.position,
        ...(p.edgeProperties !== undefined ? { edgeProperties: p.edgeProperties } : {}),
        ...(bindingRead !== undefined ? { read: bindingRead } : {}),
      },
    }));
  }

  /** Probe-parse a head's hop chain via the bridge (the checker's and
   *  probe convention: append a sentinel property read). */
  /**
   * Apply a `_resources` hop's filters: the legacy structured `filter`
   * (stored-AST compatibility) then the WHERE `expressionFilter`, evaluated
   * per resource with the resource in scope — the same per-landing semantics
   * as an adapter hop's bracket WHERE.
   */
  private async filterResources(
    resources: Resource[],
    probe: Extract<Expression, { type: 'resource_traverse' }>,
    env: Environment,
  ): Promise<Resource[]> {
    const structural = resources.filter((r) => matchesResourceFilter(r, probe.filter));
    if (!probe.expressionFilter) return structural;
    const kept: Resource[] = [];
    for (const resource of structural) {
      const keep = await evaluateMovementExpression(probe.expressionFilter, {
        ...this.exprContext(env),
        currentResource: resource,
      });
      if (keep) kept.push(resource);
    }
    return kept;
  }

  private probeHead(head: TraversalBlock['head']): Expression | undefined {
    try {
      return parseMovementExpression(
        `${spellPathHead(head)}.\`__movement_engine_probe__\``,
      );
    } catch (e) {
      if (e instanceof BridgeError) {
        throw new MovementEngineError(
          'MOVENG_RUNTIME',
          `invalid block head (the checker should have caught this): ${e.message}`,
        );
      }
      throw e;
    }
  }

  // ── Writes ──

  /** Returns the binding the write produced (a handle, or an in-memory
   *  shape position) — declared under `bindingName` when one is given,
   *  and the argument-adaptation currency for inline call args. */
  private async executeWrite(
    write: WriteExpression,
    bindingName: string | undefined,
    env: Environment,
    body: BodyContext,
  ): Promise<Binding> {
    if (write.target.kind === 'linked') {
      const rootBinding =
        write.target.path.root !== undefined ? env.resolve(write.target.path.root) : undefined;
      if (rootBinding?.kind === 'shape') {
        return this.materializeShapeWrite(write, rootBinding, bindingName, env);
      }
    }
    if (write.target.kind === 'position') {
      return this.executePositionWrite(write, write.target, bindingName, env);
    }
    const target = await this.resolveWriteTarget(write, env);
    const adapter = target.adapter;
    const { fields, fieldProvenance, fieldSemantics, fieldEvidence, resources, descriptor } =
      await this.evaluateWriteFields({ write, target, env });

    // Identity: `unique by (…)` ∪ the target's native constraints. The
    // adapter searches by the equality backbone; the engine post-filters by any
    // non-equality conjuncts (`WITHIN`, …); the shared arbitration module decides.
    const identity = this.uniqueByIdentity(write, target);
    const constraints = mergeUniqueness(descriptor?.uniquenessConstraints, identity.constraints);

    // Edge-scoped COMPOUND IDENTITY (not correspondence): when a constraint
    // names the EDGE to one of the write's already-resolved parents, fold that
    // neighbour into the resolve record under the edge's NATURAL name — the
    // adapter then matches by adjacency through the same opaque `record[field]`
    // lookup it uses for property values. ALL tuple parents fold in
    // (consolidate's AND semantics). This powers `unique by (parent AND field)`
    // and is independent of binding/correspondence — it stays.
    const resolveRecord: Record<string, unknown> = { ...fields, ...identity.valueOverlay };
    {
      const constraintFields = new Set(
        constraints.any.flatMap((branch) => branch.all.map((entry) => entry.field)),
      );
      for (const parent of target.parents) {
        if (parent.externalId === undefined) continue;
        if (constraintFields.has(parent.edgeName)) {
          resolveRecord[parent.edgeName] = { id: parent.externalId };
        }
      }
    }

    // Parent → child links, forwarded to the adapter so it wires the
    // relationships at write time (KG: insert/resolve every connecting
    // edge inside the write's transaction; external adapters set the
    // named references on the create payload). Only parents that
    // actually produced a record contribute. A linked write is just the
    // 1-element case of the general N-parent list — the engine always
    // hands the adapter `parentLinks` (0/1/N).
    const parentLinks = target.parents.flatMap((p) =>
      p.externalId !== undefined
        ? [{
            recordType: p.recordType,
            externalId: p.externalId,
            edgeName: p.edgeName,
            ...(p.data !== undefined ? { data: p.data } : {}),
          }]
        : [],
    );

    // A bound write (`write … bind other { … }`) takes the engine-owned
    // BINDING path: correspondence is the identity, `unique by` is ignored,
    // and the engine maintains the link itself through the adapter's normal
    // create / update-by-id (3b). A plain write takes the identity-resolve
    // path (`unique by` ∪ native constraints).
    const handle =
      write.bind !== undefined
        ? await this.executeBindWrite({
            write,
            bind: write.bind,
            target,
            adapter,
            descriptor,
            fields,
            fieldSemantics,
            fieldEvidence,
            resources,
            parentLinks,
            env,
          })
        : await this.executeResolvedWrite({
            target,
            adapter,
            descriptor,
            resolveRecord,
            constraints,
            ...(identity.postFilter ? { identityPostFilter: identity.postFilter } : {}),
            fields,
            fieldSemantics,
            fieldEvidence,
            resources,
            parentLinks,
            body,
          });

    return this.recordWrite({ write: handle, bindingName, env, target, fieldProvenance });
  }

  /**
   * The identity-resolve write path (no `bind`): the adapter searches by the
   * effective `unique by` ∪ native constraints, the shared module arbitrates,
   * and a match updates / a miss creates. Correspondence is NOT established
   * here — the old implicit KG bridge is gone; a write that wants the next
   * event to resolve to the same record declares `bind` (3b: no back-compat
   * for the implicit bridge; the engine's old auto-bridge is removed).
   *
   * `candidates: []` — the cross-adapter `resolveEntity` interface keeps the
   * `candidates` slot for the FROZEN TG engine (P7), but the live engine no
   * longer pre-loads correspondence rows here; identity is `constraints`.
   *
   */
  private async executeResolvedWrite(input: {
    target: ResolvedWriteTarget;
    adapter: Adapter;
    descriptor: Awaited<ReturnType<Adapter['describe']>>;
    resolveRecord: Record<string, unknown>;
    constraints: UniquenessConstraints;
    /** Non-equality `unique by` conjuncts (e.g. `WITHIN`) the adapter's coarse
     *  search can't express — the engine narrows the shortlist by them. */
    identityPostFilter?: Expression;
    fields: Record<string, unknown>;
    fieldSemantics: Record<string, FieldWriteMode>;
    fieldEvidence: Record<string, FieldEvidence>;
    /** Layer-5 node-level resource provenance — forwarded to the create/update
     *  as `WriteInput.resources`. */
    resources: Resource[];
    parentLinks: ParentLink[];
    body: BodyContext;
  }): Promise<WriteRecord> {
    const { target, adapter } = input;
    const resolved = await adapter.resolveEntity({
      record: input.resolveRecord,
      recordType: target.recordType,
      candidates: [],
      constraints: input.constraints,
    });
    const candidates =
      input.identityPostFilter !== undefined
        ? this.narrowCandidatesByPredicate(resolved.candidates, input.identityPostFilter)
        : resolved.candidates;
    const chosen = await arbitrateEntityCandidates({
      asserted: input.fields,
      candidates,
      recordType: target.recordType,
      constraints: input.constraints,
    });
    const matchedExternalId = chosen !== null ? resolved.candidates[chosen].externalId : undefined;

    if (matchedExternalId !== undefined) {
      const updated = await this.applyUpdate({
        adapter,
        recordType: target.recordType,
        externalId: matchedExternalId,
        fields: input.fields,
        fieldSemantics: input.fieldSemantics,
        fieldEvidence: input.fieldEvidence,
        resources: input.resources,
        parentLinks: input.parentLinks,
      });
      // A record resolved by identity moments ago is essentially never gone;
      // if the adapter nonetheless reports not-found, fall through to create.
      if (!('notFound' in updated)) return updated;
    }
    return this.applyCreate({
      adapter,
      recordType: target.recordType,
      fields: input.fields,
      fieldEvidence: input.fieldEvidence,
      resources: input.resources,
      descriptor: input.descriptor,
      parentLinks: input.parentLinks,
      isRoot: target.parents.length === 0,
    });
  }

  /**
   * The engine-owned BIND write path (`write … bind other { … }`): the author
   * declares "this written record IS the counterpart of `other`," and the
   * engine maintains a generic, symmetric binding across any pair of systems —
   * the adapter stays correspondence-agnostic (3b). Flow:
   *
   *   1. Resolve `other`'s position endpoint + the target's instance endpoint.
   *   2. Look up the binding for `other` constrained to the target instance.
   *      • LIVE binding → `updateRecord(by id)` on the TARGET adapter. If the
   *        adapter reports NOT-FOUND (record deleted externally), delete the
   *        stale binding and fall through to (3) — the SELF-HEAL.
   *   3. No / healed binding → `createRecord`, then record the new symmetric
   *      binding `other ↔ new record`.
   *
   * A bound write ALWAYS asserts the link and IGNORES `unique by`. R1 (the
   * correctness gate): re-fire → exactly one target record; a 404'd target
   * self-heals to one fresh record + one fresh binding.
   *
   */
  private async executeBindWrite(input: {
    write: WriteExpression;
    bind: NonNullable<WriteExpression['bind']>;
    target: ResolvedWriteTarget;
    adapter: Adapter;
    descriptor: Awaited<ReturnType<Adapter['describe']>>;
    fields: Record<string, unknown>;
    fieldSemantics: Record<string, FieldWriteMode>;
    fieldEvidence: Record<string, FieldEvidence>;
    /** Layer-5 node-level resource provenance — forwarded to the create/update
     *  as `WriteInput.resources`. */
    resources: Resource[];
    parentLinks: ParentLink[];
    env: Environment;
  }): Promise<WriteRecord> {
    const { target, adapter, descriptor } = input;
    const other = await this.bindEndpointOf(input.bind.name, input.env);
    // The target's instance endpoint, with the recordId still unknown — the
    // binding lookup resolves "what record in this instance corresponds to
    // `other`?". The stable internal type id comes from the descriptor the
    // engine already loaded (`describe` — no new adapter surface).
    const targetInstance = this.bindInstanceContext(target.graph);
    const targetTypeId = descriptor?.typeId ?? target.recordType;

    const create = async (): Promise<WriteRecord> => {
      const created = await this.applyCreate({
        adapter,
        recordType: target.recordType,
        fields: input.fields,
        fieldEvidence: input.fieldEvidence,
        resources: input.resources,
        descriptor,
        parentLinks: input.parentLinks,
        isRoot: target.parents.length === 0,
      });
      if (created.externalId !== undefined && !this.input.dryRun) {
        await recordBinding({
          teamId: this.input.teamId,
          from: other,
          to: {
            adapterType: adapter.adapterType,
            ...targetInstance,
            typeId: targetTypeId,
            recordId: created.externalId,
          },
        });
      }
      return created;
    };

    const bound = await findBoundCounterpart({
      teamId: this.input.teamId,
      endpoint: other,
      counterpart: {
        adapterType: adapter.adapterType,
        ...targetInstance,
        typeId: targetTypeId,
      },
    });
    if (bound === null) return create();

    // LIVE binding — update the bound target by id. The binding IS the
    // identity, so no resolveEntity / unique-by.
    const updated = await this.applyUpdate({
      adapter,
      recordType: target.recordType,
      externalId: bound.recordId,
      fields: input.fields,
      fieldSemantics: input.fieldSemantics,
      fieldEvidence: input.fieldEvidence,
      resources: input.resources,
      parentLinks: input.parentLinks,
    });
    if (!('notFound' in updated)) return updated;

    // SELF-HEAL — the bound target was deleted externally. Drop the stale
    // binding (keyed on the counterpart's exact stored components), then
    // create a fresh record + record a fresh binding.
    if (!this.input.dryRun) {
      await deleteBinding({ teamId: this.input.teamId, from: other, to: bound });
    }
    return create();
  }

  /** The non-record-id components of a target's binding endpoint — the
   *  instance identity (credential + construction config) the binding store
   *  keys on. Undefined graph ⇒ neither is known, which is the same endpoint
   *  a construction-free, credential-free instance keys. */
  private bindInstanceContext(graph: HandleGraph | undefined): {
    credentialId?: string;
    constructionConfig?: Record<string, string>;
  } {
    if (graph === undefined) return {};
    const instance = graph.instance;
    const credentialId = this.credentialsIdFor(instance);
    return {
      ...(credentialId !== undefined ? { credentialId } : {}),
      ...(instance.constructionConfig !== undefined
        ? { constructionConfig: instance.constructionConfig }
        : {}),
    };
  }

  /**
   * Resolve `bind other`'s name to its fully-qualified binding endpoint — the
   * `(adapterType, instanceKey, typeId, recordId)` the binding store keys on.
   * The checker has already constrained `other` to a stable record position
   * (a write handle or a traversed source record), so at runtime it is a
   * `handle` (a prior write result) or a `sourcePosition` (a traversed
   * record). The stable INTERNAL type id is resolved via the position's own
   * adapter `describe` (the natural type name → its stable id), so a type
   * rename never orphans the binding.
   */
  private async bindEndpointOf(name: string, env: Environment): Promise<BindingEndpoint> {
    const binding = env.resolve(name);
    if (binding === undefined) {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `'bind ${name}' — '${name}' is not in scope (the checker should have caught this)`,
      );
    }

    // The position's adapter type, record id, natural type, the graph its
    // instance identity comes from, and the adapter to resolve its stable type
    // id through. Each branch narrows the binding kind, so the adapter is
    // captured WITHOUT a cast.
    let adapterType: string;
    let recordId: string | undefined;
    let naturalType: string | undefined;
    // Undefined where the position came from a read seam of its own — the
    // seam names the adapter, not a construction, so there is no instance
    // identity to key on beyond the adapter itself.
    let graph: HandleGraph | undefined;
    let adapter: Adapter;

    if (binding.kind === 'handle') {
      adapterType = binding.handle.adapterType;
      recordId = binding.handle.externalId;
      naturalType = binding.handle.recordType;
      graph = binding.graph;
      adapter = await this.targetAdapterFor(graph.instance);
    } else if (binding.kind === 'sourcePosition') {
      const position = binding.position;
      adapterType = position.adapterType;
      recordId = positionRecordId(position);
      naturalType = position.recordType ?? undefined;
      // A traversed source record's instance is the read seam it was yielded
      // from, else the movement's source instance.
      const sourceInstance = binding.read === undefined ? this.sourceInstance : undefined;
      graph =
        sourceInstance !== undefined ? { kind: 'instance', instance: sourceInstance } : undefined;
      if (binding.read !== undefined) {
        adapter = binding.read.adapter;
      } else if (sourceInstance !== undefined) {
        adapter = await this.targetAdapterFor(sourceInstance);
      } else {
        throw this.unnamedGraph(`'bind ${name}'`, name);
      }
    } else {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `'bind ${name}' — '${name}' is ${describeBinding[binding.kind]}, not a stable record (the checker should have caught this)`,
      );
    }

    if (recordId === undefined) {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `'bind ${name}' — '${name}' has no stable record id to bind to`,
      );
    }

    // Resolve the stable internal type id from the natural type via the
    // position's own adapter (no new adapter surface — `describe` is uniform).
    let typeId = naturalType ?? '';
    if (naturalType !== undefined) {
      const descriptor = await adapter.describe(naturalType);
      if (descriptor) typeId = descriptor.typeId;
    }

    const instanceContext = this.bindInstanceContext(graph);
    return {
      adapterType,
      ...instanceContext,
      typeId,
      recordId,
    };
  }

  /**
   * Evaluate a write's body fields against an already-resolved target —
   * shared by the create/upsert path (`executeWrite`) and the in-place
   * update path (`executePositionWrite`). Field keys stay the program's
   * NATURAL names (the adapter resolves them to its own ids internally),
   * each value carrying its trail (E4); `?:` fields are collected for the
   * set-if-empty gate.
   *
   * `describe` is called with the NATURAL type name (the adapter translates),
   * and its descriptor is read by NATURAL name — `displayName` for fields —
   * since the internal `fieldId` is adapter-private (Decision #6). Cardinality
   * coercion and field-function advertisement both key on the displayName.
   */
  private async evaluateWriteFields(input: {
    write: WriteExpression;
    target: ResolvedWriteTarget;
    env: Environment;
  }): Promise<{
    fields: Record<string, unknown>;
    fieldProvenance: Record<string, Provenance>;
    fieldSemantics: Record<string, FieldWriteMode>;
    fieldEvidence: Record<string, FieldEvidence>;
    /** Node-level resource provenance (Layer 5) — the SOURCE CONTENT that fed
     *  the extracted node(s) this write draws from. Rides `WriteInput.resources`
     *  so `persistKgResources` records the source file/text against the written
     *  node. Empty when no field reads an extracted node. */
    resources: Resource[];
    descriptor: Awaited<ReturnType<Adapter['describe']>>;
  }> {
    const { write, target, env } = input;
    const adapter = target.adapter;
    const descriptor = await adapter.describe(target.recordType);
    // Keyed by the field's NATURAL name (`displayName`) — the currency the
    // write body, cardinality coercion and field functions all speak.
    const fieldsByName = new Map<string, SchemaFieldDescriptor>(
      (descriptor?.fields ?? []).map((f) => [f.displayName, f]),
    );

    // Field values, in author order, keyed by the field's natural name.
    // `undefined` means "leave alone" — the field is omitted from the write
    // (mirrors the TG engine).
    const fields: Record<string, unknown> = {};
    const fieldProvenance: Record<string, Provenance> = {};
    // Per-field write-precedence, by natural name (absent ⇒ replace). `?:` fill,
    // `+:` append, `+?:` append-if-missing. The engine applies the merge against
    // current values in `applyUpdate`; on a create all modes are a plain set.
    const fieldSemantics: Record<string, FieldWriteMode> = {};
    for (const field of write.fields) {
      const fieldName = field.name;
      const { value: raw, provenance } = await this.evaluateSlot(field.value, {
        env,
        // Functions this destination field advertises, bound to the
        // TARGET adapter — the frozen field-mapping pipeline's binding,
        // mirrored (engine/evaluate.ts bindFieldFunctions). The natural type
        // + field name cross the boundary; the adapter translates.
        fieldFunctions: bindMovementFieldFunctions({
          targetAdapter: adapter,
          recordType: target.recordType,
          fieldId: fieldName,
          descriptor: fieldsByName.get(fieldName),
        }),
      });
      if (raw === undefined) continue;
      fields[fieldName] = coerceValueForFieldCardinality(raw, fieldsByName.get(fieldName));
      fieldProvenance[fieldName] = provenance;
      if (field.semantics !== undefined) fieldSemantics[fieldName] = field.semantics;
    }

    // Per-field evidence for the adapter contract — the TG rule (only a
    // provenance-faithful extracted value earns a citation); adapters
    // without an evidence sink ignore it.
    const fieldEvidence: Record<string, FieldEvidence> = {};
    for (const [name, provenance] of Object.entries(fieldProvenance)) {
      const evidence = fieldEvidenceFromProvenance(provenance);
      if (evidence) fieldEvidence[name] = evidence;
    }

    // Layer 5 — node-level resource provenance. Collect the source content of
    // every extracted node this write draws from: the materialiser stamped the
    // `from [...]` resources (source files + text) onto the extract emissions,
    // and the write's record IS that node's materialisation, so its source
    // resources persist against the written record (`WriteInput.resources`).
    const resources = this.collectWriteResources(write, env);

    return { fields, fieldProvenance, fieldSemantics, fieldEvidence, resources, descriptor };
  }

  /**
   * The source resources an `extract`-fed write carries (Layer 5 provenance).
   * A write's fields read from extract bindings (`d.\`name\``); the extracted
   * node's source content (the `from [...]` files + text the materialiser
   * stamped onto the emission) is what fed it. We resolve the bare identifier
   * tokens in each field's source text against `env` and union the source
   * resources of every `extractRoot`/`extractPosition` binding referenced —
   * deduped by the stable resource `id` so the same source file contributes
   * once. Over-collection is harmless: `persistKgResources` dedups on `id`.
   */
  private collectWriteResources(write: WriteExpression, env: Environment): Resource[] {
    const seen = new Set<string>();
    const out: Resource[] = [];
    const consider = (name: string): void => {
      const binding = env.resolve(name);
      if (binding?.kind !== 'extractRoot' && binding?.kind !== 'extractPosition') return;
      for (const resource of binding.emission.resources) {
        const key = resource.id ?? resource.externalId;
        if (key !== undefined) {
          if (seen.has(key)) continue;
          seen.add(key);
        }
        out.push(resource);
      }
    };
    for (const field of write.fields) {
      for (const name of referencedIdentifiers(field.value.raw)) consider(name);
    }
    return out;
  }

  /**
   * `write a { … }` — update the record bound at alias `a` in place. The
   * unification: a write result IS a position, so a position read earlier
   * in the program (a traversal alias, or a prior write's handle) can be
   * the write's target. The record is ALREADY identified — its stable
   * `recordId` is the value `updateRecord` consumes — so there is no
   * entity resolution, no required-field create-gate, no bridge insert.
   * An unstable position (an inbound payload, an extracted node, a
   * dry-run/no-op write that produced no id) has no record to update; the
   * checker rejects most of these statically, and this re-checks at
   * runtime for the cases the checker can't see (untyped graphs).
   */
  private async executePositionWrite(
    write: WriteExpression,
    target: Extract<WriteExpression['target'], { kind: 'position' }>,
    bindingName: string | undefined,
    env: Environment,
  ): Promise<Binding> {
    const binding = env.resolve(target.alias);
    const resolved = await this.resolvePositionWriteTarget(target.alias, binding, env);

    const { fields, fieldProvenance, fieldSemantics, fieldEvidence, resources } =
      await this.evaluateWriteFields({ write, target: resolved.target, env });

    const handle = await this.applyUpdate({
      adapter: resolved.target.adapter,
      recordType: resolved.target.recordType,
      externalId: resolved.externalId,
      fields,
      fieldSemantics,
      fieldEvidence,
      resources,
      parentLinks: [],
    });
    // A position write updates a record the author already holds; there is no
    // identity to re-resolve and nothing to self-heal. If the adapter reports
    // it gone, that is a genuine runtime error — fail loud.
    if ('notFound' in handle) {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `'write ${target.alias} { … }' — the record (${resolved.target.adapter.adapterType} ${resolved.externalId}) no longer exists`,
      );
    }

    return this.recordWrite({
      write: handle,
      bindingName,
      env,
      target: resolved.target,
      fieldProvenance,
    });
  }

  /**
   * Resolve a bare-alias write target to its update destination: the
   * adapter + engine-currency record type, plus the stable `recordId`
   * `updateRecord` consumes. Both binding kinds that carry a durable
   * record qualify — a `sourcePosition` (a traversal alias; its `read` is
   * the graph it was yielded from) and a write `handle` (a prior write
   * result, already a written position). Throws if the alias isn't a
   * record position or has no stable identity (the checker catches the
   * typed cases; this is the runtime backstop, and the only gate for
   * untyped graphs).
   */
  private async resolvePositionWriteTarget(
    alias: string,
    binding: Binding | undefined,
    env: Environment,
    action: 'update' | 'delete' = 'update',
  ): Promise<{ target: ResolvedWriteTarget; externalId: string }> {
    if (binding === undefined) {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `'${alias}' is not in scope — the checker should have caught this`,
      );
    }

    if (binding.kind === 'sourcePosition') {
      const { identity, recordType } = binding.position;
      if (identity.kind !== 'stable') {
        throw this.unstablePositionWrite(alias);
      }
      if (recordType === null) {
        throw new MovementEngineError(
          'MOVENG_RUNTIME',
          `can't ${action} '${alias}' — its record type is unknown (an un-narrowed position). Narrow it with an IS test first`,
        );
      }
      const read = binding.read ?? this.source;
      if (!read) {
        throw new MovementEngineError(
          'MOVENG_RUNTIME',
          `'${alias}' has no read seam — its graph is unknown, so it can't be ${action}d`,
        );
      }
      // The write goes through the TARGET adapter seam (role: 'target',
      // dry-run-wrapped) — never the read adapter directly — so a position
      // write is captured under dry run exactly like a create. The position's
      // `recordType` is the NATURAL type name (the source-read wrapper stamps
      // it); it crosses the write boundary as-is and the adapter translates.
      const instance = env.resolve(read.instanceName);
      if (instance?.kind !== 'instance') {
        throw new MovementEngineError(
          'MOVENG_RUNTIME',
          `can't ${action} '${alias}' — its graph '${read.instanceName}' is not a constructed instance in scope`,
        );
      }
      return {
        target: {
          adapter: await this.targetAdapterFor(instance),
          recordType,
          graph: { kind: 'instance', instance },
          parents: [],
        },
        externalId: identity.recordId,
      };
    }

    if (binding.kind === 'handle') {
      if (binding.handle.externalId === undefined) {
        throw this.unstablePositionWrite(alias);
      }
      const graph = binding.graph;
      const adapter = await this.targetAdapterFor(graph.instance);
      return {
        target: {
          adapter,
          // The handle's type is the program's natural name; the adapter
          // translates.
          recordType: binding.targetType,
          graph,
          parents: [],
        },
        externalId: binding.handle.externalId,
      };
    }

    throw new MovementEngineError(
      'MOVENG_RUNTIME',
      `'${alias}' is ${describeBinding[binding.kind]} — '${action === 'delete' ? `delete ${alias}` : `write ${alias} { … }`}' needs a record position (a traversal alias or a prior write result)`,
    );
  }

  /**
   * The engine could not name the system a record came from, so a write rooted
   * off it has no target.
   *
   * There is no authoring affordance for an unnamed write target — the grammar
   * has no unnamed-write production — so reaching here is the engine losing a
   * position's provenance, never a program that said nothing. It used to
   * DEFAULT to the knowledge graph: writing to a store on the strength of not
   * knowing where else to write. There is no privileged graph to fall back to
   * any more, and a guarantee that degrades silently is not a weaker guarantee
   * but the absence of one — so it says so instead.
   */
  private unnamedGraph(what: string, name: string): MovementEngineError {
    return new MovementEngineError(
      'MOVENG_RUNTIME',
      `${what} — the system '${name}' came from can't be determined, so there is no target to act on. Root the path at a NAMED system: construct one (\`crm = attio(credentials: …)\`) and start the traversal from that name`,
    );
  }

  private unstablePositionWrite(alias: string): MovementEngineError {
    return new MovementEngineError(
      'MOVENG_RUNTIME',
      `can't update '${alias}' — it has no stable record to update (an inbound payload, an extracted node, or a write that produced no record). Create a new record instead`,
    );
  }

  /**
   * `write Files-[:file]-> { … }` against a shape — shapes are
   * configuration-free graphs (§G): no adapter, no entity resolution,
   * no firing-record write. The fields evaluate in the current scope
   * and the result is an in-memory position of the shape's type with
   * every field's trail intact — argument adaptation is invisible to
   * provenance.
   *
   * RETIRED (layer 8 take 4, wave 4). The checker refuses this construct at
   * author time and points at `node { … }`, which does the same job and more.
   * This path survives ONE wave so that programs saved before the refusal keep
   * running unchanged — retiring a construct must not stop a live automation
   * mid-flight. Delete it, and the `shape`/`shapePosition` bindings that only
   * this mints, once the prod sweep in
   * plans/2026-06-10-data-movement-language/9_node_synthesis_build.md confirms
   * no saved program still writes to a shape.
   */
  private async materializeShapeWrite(
    write: WriteExpression,
    shape: Extract<Binding, { kind: 'shape' }>,
    bindingName: string | undefined,
    env: Environment,
  ): Promise<Binding> {
    if (write.target.kind !== 'linked') {
      throw new MovementEngineError('MOVENG_RUNTIME', 'a shape write names its node directly');
    }
    const node = this.singleWriteEdge(write.target.path);
    if (write.uniqueBy.length > 0) {
      throw unsupported(
        'unique by on a shape write',
        'a shape position is in-memory — there is no store to resolve identity against',
      );
    }
    const fields: Record<string, unknown> = {};
    const fieldProvenance: Record<string, Provenance> = {};
    for (const field of write.fields) {
      const { value, provenance } = await this.evaluateSlot(field.value, { env });
      if (value === undefined) continue;
      fields[field.name] = value;
      fieldProvenance[field.name] = provenance;
    }
    const binding: Binding = {
      kind: 'shapePosition',
      shape: shape.declaration.name,
      node,
      fields,
      fieldProvenance,
    };
    if (bindingName !== undefined) env.declare(bindingName, binding);
    return binding;
  }

  /**
   * `node { … }` — in-memory node synthesis (layer 8 take 4). No adapter, no
   * identity resolution, no firing record: the entries evaluate in the current
   * scope and the result is a position carrying exactly what was written, every
   * field's trail intact.
   *
   * A VALUE entry is computed here. A nested literal is synthesised here. A
   * TRAVERSAL entry is the pass-through edge, and the only entry with a choice
   * about WHEN: eager walks now and keeps the landings; `lazy` keeps the walk
   * itself and runs it at every read (ruling 3). Either way the landings are
   * the source's REAL positions — nothing is copied, so a FileRef reaches the
   * callee as the handle the source produced.
   *
   */
  private async synthesiseNode(literal: NodeLiteral, env: Environment): Promise<Binding> {
    const fields: Record<string, unknown> = {};
    const fieldProvenance: Record<string, Provenance> = {};
    const edges: Record<string, NodeEdge> = {};
    for (const entry of literal.entries) {
      switch (entry.kind) {
        case 'value': {
          const { value, provenance } = await this.evaluateSlot(entry.value, { env });
          // An entry that evaluated to nothing is ABSENT rather than present-
          // and-empty — the same rule a shape write applies, so a callee
          // reading it gets one story about a missing value.
          if (value === undefined) continue;
          fields[entry.name] = value;
          fieldProvenance[entry.name] = provenance;
          break;
        }
        case 'nodes': {
          const landings: Binding[] = [];
          for (const nested of entry.nodes) landings.push(await this.synthesiseNode(nested, env));
          edges[entry.name] = { kind: 'landed', landings };
          break;
        }
        case 'declared':
          // A DECLARED edge starts empty and grows by `link`. Landed with no
          // landings is exactly that: traversing it runs a body zero times,
          // like any other empty edge.
          edges[entry.name] = { kind: 'landed', landings: [] };
          break;
        case 'traversal': {
          // The mapping rides WITH the walk, so `lazy` defers the synthesis
          // along with the hop and eager does both here — one rule, not two.
          edges[entry.name] = entry.lazy
            ? { kind: 'deferred', walk: this.deferWalk(entry.head, env, entry.mapping) }
            : {
                kind: 'landed',
                landings: await this.walkLandings(entry.head, env, entry.mapping),
              };
          break;
        }
      }
    }
    return { kind: 'nodePosition', fields, fieldProvenance, edges };
  }

  /**
   * Store a traversal instead of running it. The scope is SNAPSHOT here — a
   * closure captures what it can see where it is written, and single-assignment
   * bindings make the snapshot exact. It also excludes the binding this walk is
   * about to become, which is what keeps serialising one finite.
   */
  private deferWalk(head: PathHead, env: Environment, mapping?: NodeLiteral): DeferredWalk {
    return { head, captured: captureScope(env), ...(mapping ? { mapping } : {}) };
  }

  /** Walk a head now and return where it landed — the eager half of a
   *  pass-through edge, and the same walk `lazy` defers. A `mapping` renames
   *  each landing here, at the literal, exactly as the deferred form does at
   *  the read. */
  private async walkLandings(
    head: PathHead,
    env: Environment,
    mapping?: NodeLiteral,
  ): Promise<Binding[]> {
    const walked = await this.resolveHeadIterations(head, env);
    const iterations = mapping ? await this.mapIterations(walked, mapping, env) : walked;
    return iterations.flatMap((iteration) =>
      iteration.landing !== undefined ? [iteration.landing] : [],
    );
  }

  /**
   * PER-ITEM synthesis: each landing of a walk, mapped through the tail
   * literal. The literal is evaluated in the walk's own scope EXTENDED with
   * that iteration's hop aliases — the same scope a traversal block's body
   * runs in — so `a.\`File\`` reads the real source position and carries the
   * source's trail. Nothing is fabricated for the wrapper.
   *
   * The iteration's aliases do NOT survive: the alias names the landing inside
   * the tail and nowhere else, which is exactly what the checker says.
   */
  private async mapIterations(
    iterations: BlockIteration[],
    mapping: NodeLiteral,
    env: Environment,
  ): Promise<BlockIteration[]> {
    const mapped: BlockIteration[] = [];
    for (const iteration of iterations) {
      const itemEnv = env.child();
      for (const [name, binding] of iteration.bindings) itemEnv.declare(name, binding);
      mapped.push({ bindings: new Map(), landing: await this.synthesiseNode(mapping, itemEnv) });
    }
    return mapped;
  }

  /**
   * Run a STORED walk (`lazy …`) — the read seam behind every deferred edge and
   * every read of a lazy binding. It re-walks the LIVE source every time: no
   * cache, so a source that changed between two reads shows the change (ruling
   * 3). `extraSteps` continue the chain inside the same walk, so hops past a
   * lazy edge are hops in the source graph, filters and all.
   *
   * A MAPPED walk breaks that continuation in two, because it has to: past the
   * mapping the landings are synthesised nodes, so the remaining hops are hops
   * on the mapping's own arrow plane (a nested tail, a nested pass-through
   * edge), not on the source's.
   */
  private async runDeferredWalk(
    walk: DeferredWalk,
    extraSteps: Extract<Expression, { type: 'traverse' }>['steps'],
  ): Promise<BlockIteration[]> {
    const env = new Environment();
    for (const [name, binding] of walk.captured) env.declare(name, binding);
    if (walk.mapping === undefined) {
      return this.resolveHeadIterations(walk.head, env, extraSteps);
    }
    const mapped = await this.mapIterations(
      await this.resolveHeadIterations(walk.head, env),
      walk.mapping,
      env,
    );
    if (extraSteps.length === 0) return mapped;
    return this.walkNodePlane(
      mapped.flatMap((iteration) =>
        iteration.landing !== undefined
          ? [{ aliases: new Map<string, Binding>(), binding: iteration.landing }]
          : [],
      ),
      extraSteps,
      env,
    );
  }

  // ── Link statements (the edge-only write — §B, absorbed `edge`) ──

  /**
   * `link a -[:e]-> b` — assert an edge between two records that were
   * BOTH already written (the bare-handle form; linked writes cover the
   * parent-child shape, this is the residual case) — or
   * `p = link c-[:portfolio]-> { …criteria… }` — find the edge's target
   * by identity criteria and link it (the criteria form). The runtime
   * owns most of the validation:
   *   - the from name must be a write handle; the bare-handle form's to
   *     name must be one in the SAME graph (binding object identity, the
   *     alias-safe graph identity the IS tests use);
   *   - the edge resolves against the FROM side's type in that graph's
   *     schema where one is known (untyped graphs defer to the adapter's
   *     own resolution, which fails loud on a bad name);
   *   - the receiving adapter must implement the optional `linkRecords`
   *     seam — rejected by name otherwise.
   * The assert lands on the firing record as an edge entry whose
   * provenance carries both endpoints' write origins. Nothing is emitted
   * here: graph mutation events reach listeners only via the knowledge
   * outbox drainer (M-38), external ones only via their webhooks.
   */
  private async executeLink(
    link: LinkExpression,
    bindingName: string | undefined,
    env: Environment,
  ): Promise<void> {
    const fromBinding = env.resolve(link.from);
    if (fromBinding?.kind === 'nodePosition') {
      this.appendLocalLanding(link, fromBinding, env);
      return;
    }
    if (link.target.kind === 'criteria') {
      await this.executeCriteriaLink(link, link.target, bindingName, env);
      return;
    }
    const at = `link ${link.from} -[:${link.edge}]-> ${link.target.name}`;
    const resolved = await this.resolveLinkStatement(
      { from: link.from, edge: link.edge, to: link.target.name },
      env,
      at,
    );
    if (typeof resolved.adapter.linkRecords !== 'function') {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `${at}: the '${resolved.adapter.adapterType}' adapter cannot link two existing records (no linkRecords capability) — express the relationship as a linked write (write ${link.from}-[:${link.edge}]-> { … }) instead`,
      );
    }
    const linked = await resolved.adapter.linkRecords({
      from: resolved.from,
      edgeName: resolved.edgeName,
      to: resolved.to,
      mutationContext: this.mutationContext,
    });
    this.recordLinkStatement({ kind: 'link', resolved, changed: linked.created });
  }

  /**
   * `link sent -[:messages]-> one` where `sent` is a node this run built: the
   * landing is pushed onto that edge's own array. Nothing reaches a system, so
   * nothing lands on the firing record — what grew is the run's own graph.
   *
   * The landing keeps its own KIND, so traversing to it and writing off it
   * afterwards take the paths they already take, and a park carries it by the
   * same serialisation every other landing rides.
   *
   */
  private appendLocalLanding(
    link: LinkExpression,
    from: Extract<Binding, { kind: 'nodePosition' }>,
    env: Environment,
  ): void {
    const at = `link ${link.from} -[:${link.edge}]->`;
    if (link.target.kind !== 'handle') {
      throw unsupported(
        `${at} { … } on a record this run built`,
        'criteria find a record in a system; link a position you already have',
      );
    }
    const edge = from.edges[link.edge];
    if (edge === undefined || edge.kind !== 'landed') {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `${at}: '${link.from}' has no appendable edge '${link.edge}' — the checker should have caught this`,
      );
    }
    const to = env.resolve(link.target.name);
    if (!to) {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `'${link.target.name}' is not in scope — the checker should have caught this`,
      );
    }
    if (!APPENDABLE_LANDING_KINDS.has(to.kind)) {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `${at} ${link.target.name}: an edge lands on a position — '${link.target.name}' is ${describeBinding[to.kind]}`,
      );
    }
    edge.landings.push(to);
  }

  /**
   * The criteria form: `link c -[:portfolio]-> { name: "Fund III" }` —
   * the target is FOUND, never created and never written. The body's
   * fields are identity criteria ONLY: they resolve through the same
   * gate a write's identity does (adapter candidate search merged with
   * the target's native uniqueness, then `arbitrateEntityCandidates`),
   * the found type inferred from the edge like a linked write. On
   * missing, the ENCLOSING SCOPE ends quietly — the documented
   * find-on-missing semantics (a fan-out iteration skips; nothing
   * throws, because transactionality across systems can't be
   * guaranteed). Binding the statement yields the FOUND target's handle,
   * with full result data via `readRecord` where the adapter offers it.
   */
  private async executeCriteriaLink(
    link: LinkExpression,
    target: Extract<LinkExpression['target'], { kind: 'criteria' }>,
    bindingName: string | undefined,
    env: Environment,
  ): Promise<void> {
    const at = `link ${link.from} -[:${link.edge}]-> { … }`;
    const from = this.resolveEdgeEndpoint(link.from, env, at);
    const graph = from.graph;
    const surfaceType = this.inferLinkedSurfaceType({
      graph,
      parentSurfaceType: from.targetType,
      edgeName: link.edge,
      explicitType: target.explicitType,
      rootName: link.from,
      verb: 'link',
    });
    const fromId = from.handle.externalId;
    if (fromId === undefined) {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `${at}: '${link.from}' carries no written record id to link`,
      );
    }
    const adapter = await this.targetAdapterFor(graph.instance);
    // The found type and the edge cross the boundary in the program's NATURAL
    // currency; the adapter resolves them (the edge against the FROM side's
    // type) to its own ids internally.
    const recordType = surfaceType;
    const edgeName = link.edge;

    // Criteria evaluation — match values only, keyed by natural field name
    // exactly like write fields (the adapter translates).
    const criteria: Record<string, unknown> = {};
    for (const field of target.fields) {
      const { value } = await this.evaluateSlot(field.value, { env });
      if (value === undefined) continue;
      criteria[field.name] = value;
    }

    // Identity: the criteria AND-group ∪ the target's native rules —
    // the same merge a write's resolution applies (unique-by-style).
    const descriptor = await adapter.describe(recordType);
    const constraints = mergeUniqueness(descriptor?.uniquenessConstraints, {
      any:
        Object.keys(criteria).length > 0
          ? [{ all: Object.keys(criteria).map((field) => ({ field })) }]
          : [],
    });
    // Find-existing resolves purely by identity criteria — correspondence is
    // bind-only now (the implicit bridge is gone, 3b). `candidates: []` keeps
    // the cross-adapter interface slot the frozen TG engine still uses (P7).
    const resolved = await adapter.resolveEntity({
      record: criteria,
      recordType,
      candidates: [],
      constraints,
    });
    const chosen = await arbitrateEntityCandidates({
      asserted: criteria,
      candidates: resolved.candidates,
      recordType,
      constraints,
    });
    if (chosen === null) {
      // Find-on-missing: the enclosing scope ends quietly.
      throw new ScopeEndedQuietly(`${at}: no existing ${surfaceType} matched the criteria`);
    }
    const matched = resolved.candidates[chosen];

    if (typeof adapter.linkRecords !== 'function') {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `${at}: the '${adapter.adapterType}' adapter cannot link two existing records (no linkRecords capability)`,
      );
    }
    const fromRecordType = from.targetType;
    const linked = await adapter.linkRecords({
      from: { recordType: fromRecordType, externalId: fromId },
      edgeName,
      to: { recordType, externalId: matched.externalId },
      mutationContext: this.mutationContext,
    });

    // The FOUND handle — full result data via readRecord where the
    // adapter offers it, falling back to the candidate's snapshot.
    let resultData: Record<string, unknown> = {
      ...(matched.url !== undefined ? { url: matched.url } : {}),
      ...matched.data,
    };
    if (typeof adapter.readRecord === 'function') {
      const current = await adapter.readRecord({
        recordType,
        externalId: matched.externalId,
      });
      if (current) resultData = { ...resultData, ...current };
    }
    // The firing entry is the LINK itself — FROM-keyed, the edge in
    // `link`, recorded onto the firing log. The bound handle is a
    // SEPARATE record: it stands on the FOUND to-side node (its identity,
    // its read-back fields), which was found-not-written, so it is not a
    // firing-log entry of its own — its `origin` chains to the link's
    // index so later reads still trace back through the firing graph.
    const writeIndex = this.writes.length;
    this.writes.push({
      kind: 'link',
      adapterType: adapter.adapterType,
      recordType: fromRecordType,
      created: linked.created,
      committed: this.committedThrough(adapter),
      externalId: fromId,
      writtenValues: {},
      link: {
        edgeName,
        toRecordType: recordType,
        toExternalId: matched.externalId,
        foundTarget: true,
      },
      provenance: {
        from: this.summariser.summariseTrail(handleTrail(from.handle)),
        // The to side was FOUND, not written — no write origin to chain.
        to: [],
      },
      ...(bindingName !== undefined ? { bindingName } : {}),
    });
    const foundHandle: WriteRecord = {
      adapterType: adapter.adapterType,
      recordType,
      created: false,
      // The to-side was FOUND, not written — no effect to commit or capture.
      committed: this.committedThrough(adapter),
      externalId: matched.externalId,
      writtenValues: {},
      resultData,
      provenance: {},
      origin: { kind: 'write', writeIndex, externalId: matched.externalId },
    };
    if (bindingName !== undefined) {
      env.declare(bindingName, {
        kind: 'handle',
        handle: foundHandle,
        targetType: surfaceType,
        graph,
      });
    }
  }

  /**
   * `unlink a -[:e]-> b` — sever the edge `edge` asserted (the exact
   * inverse). Same endpoint rules and the same currency at the adapter
   * boundary; the capability is `Adapter.unlinkRecords`, rejected by
   * name where the adapter doesn't carry it. Idempotent at the adapter
   * (`removed: false` when no link existed); the firing record carries
   * the entry either way (kind 'unlink', `created` = whether a link was
   * actually severed) with both endpoints' write origins as provenance.
   */
  private async executeUnlinkStatement(
    statement: Extract<Statement, { kind: 'unlink' }>,
    env: Environment,
  ): Promise<void> {
    const at = `unlink ${statement.from} -[:${statement.edge}]-> ${statement.to}`;
    const resolved = await this.resolveLinkStatement(statement, env, at);
    if (typeof resolved.adapter.unlinkRecords !== 'function') {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `${at}: the '${resolved.adapter.adapterType}' adapter cannot sever a link between two existing records (no unlinkRecords capability)`,
      );
    }
    const unlinked = await resolved.adapter.unlinkRecords({
      from: resolved.from,
      edgeName: resolved.edgeName,
      to: resolved.to,
      mutationContext: this.mutationContext,
    });
    this.recordLinkStatement({ kind: 'unlink', resolved, changed: unlinked.removed });
  }

  /**
   * `delete <name>` — remove the record a position stands on, through the
   * receiving adapter's `deleteRecord` (rejected by name where the adapter
   * doesn't genuinely implement it — the capability check is `typeof`, so
   * test fakes and capability-less adapters fail loud before any call).
   * The deletable positions are exactly the updatable ones — a write
   * handle OR a traversed source record — resolved through the same seam
   * as `write <alias> { … }` (`resolvePositionWriteTarget`), so "I found
   * it, now remove it" works wherever "I found it, now change it" does.
   * The firing record carries a kind 'delete' entry; for a handle its
   * provenance chains to the handle's own write, for a traversed record
   * the entry's ids are the provenance.
   */
  private async executeDeleteStatement(
    statement: Extract<Statement, { kind: 'delete' }>,
    env: Environment,
  ): Promise<void> {
    const at = `delete ${statement.name}`;
    const binding = env.resolve(statement.name);
    const resolved = await this.resolvePositionWriteTarget(
      statement.name,
      binding,
      env,
      'delete',
    );
    const adapter = resolved.target.adapter;
    if (typeof adapter.deleteRecord !== 'function') {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `${at}: the '${adapter.adapterType}' adapter cannot delete records (no deleteRecord capability)`,
      );
    }
    // The position's type crosses the boundary in its NATURAL name — the
    // adapter resolves it to its own id internally.
    const recordType = resolved.target.recordType;
    const externalId = resolved.externalId;
    await adapter.deleteRecord({
      recordType,
      externalId,
      mutationContext: this.mutationContext,
    });

    this.writes.push({
      kind: 'delete',
      adapterType: adapter.adapterType,
      recordType,
      created: false,
      committed: this.committedThrough(adapter),
      externalId,
      writtenValues: {},
      provenance:
        binding?.kind === 'handle'
          ? { record: this.summariser.summariseTrail(handleTrail(binding.handle)) }
          : {},
    });
  }

  /**
   * Shared resolution for the two bare-handle link statements (`link` and
   * `unlink`): both names must be write handles in the SAME graph, the
   * edge resolves against the FROM side's type where the graph schema
   * declares it, and everything the adapter consumes — endpoint types,
   * the edge name — translates to engine currency at this boundary.
   */
  private async resolveLinkStatement(
    statement: { from: string; edge: string; to: string },
    env: Environment,
    at: string,
  ): Promise<ResolvedLinkStatement> {
    const from = this.resolveEdgeEndpoint(statement.from, env, at);
    const to = this.resolveEdgeEndpoint(statement.to, env, at);
    const graph = from.graph;
    if (to.graph.instance !== graph.instance) {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `${at}: both handles must live in the same graph — '${statement.from}' is in ${describeHandleGraph(from.graph)} and '${statement.to}' is in ${describeHandleGraph(to.graph)}`,
      );
    }

    // The edge belongs to the from-side's type (SURFACE currency, like
    // linked-write inference): validate against the graph schema when
    // the from type is declared there.
    const schema = graph.instance.schema;
    const fromPosition = schema?.positions[from.targetType];
    const declaredEdge = fromPosition?.edges[statement.edge];
    if (fromPosition !== undefined && declaredEdge === undefined) {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `${at}: '${statement.edge}' is not a declared edge of ${from.targetType} — the edge resolves against the from-side's type`,
      );
    }
    if (
      declaredEdge !== undefined &&
      !declaredEdge.polymorphic &&
      declaredEdge.target !== to.targetType
    ) {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `${at}: '${statement.edge}' connects ${from.targetType} to ${declaredEdge.target}, but '${statement.to}' is a ${to.targetType} handle`,
      );
    }

    const fromId = from.handle.externalId;
    const toId = to.handle.externalId;
    if (fromId === undefined || toId === undefined) {
      const missing = fromId === undefined ? statement.from : statement.to;
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `${at}: '${missing}' carries no written record id to link`,
      );
    }

    const adapter = await this.targetAdapterFor(graph.instance);

    // NATURAL currency at the adapter boundary, like every write — the adapter
    // resolves the endpoint types and the edge (against the FROM side's type)
    // to its own ids internally.
    return {
      adapter,
      edgeName: statement.edge,
      from: { recordType: from.targetType, externalId: fromId },
      to: { recordType: to.targetType, externalId: toId },
      fromHandle: from.handle,
      toHandle: to.handle,
    };
  }

  /** The firing-record entry for a standalone link statement — same shape
   *  for assert and sever; `kind` discriminates, `created` carries whether
   *  the statement actually changed the target, and provenance is the two
   *  endpoints' write origins. */
  private recordLinkStatement(input: {
    kind: 'link' | 'unlink';
    resolved: ResolvedLinkStatement;
    changed: boolean;
  }): void {
    const { resolved } = input;
    this.writes.push({
      kind: input.kind,
      adapterType: resolved.adapter.adapterType,
      recordType: resolved.from.recordType,
      created: input.changed,
      committed: this.committedThrough(resolved.adapter),
      externalId: resolved.from.externalId,
      writtenValues: {},
      link: {
        edgeName: resolved.edgeName,
        toRecordType: resolved.to.recordType,
        toExternalId: resolved.to.externalId,
      },
      provenance: {
        from: this.summariser.summariseTrail(handleTrail(resolved.fromHandle)),
        to: this.summariser.summariseTrail(handleTrail(resolved.toHandle)),
      },
    });
  }

  private resolveEdgeEndpoint(
    name: string,
    env: Environment,
    at: string,
  ): Extract<Binding, { kind: 'handle' }> {
    const binding = env.resolve(name);
    if (!binding) {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `'${name}' is not in scope — the checker should have caught this`,
      );
    }
    if (binding.kind !== 'handle') {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `${at}: link statements connect written handles — '${name}' is ${describeBinding[binding.kind]}`,
      );
    }
    return binding;
  }

  /**
   * Finalise a produced `WriteRecord` and land it on the firing log — the
   * recording step of the produce-and-record act. The record from
   * `applyCreate` / `applyUpdate` already carries its identity and
   * write-event facts; here it gains the firing-log layer in place
   * (summarised per-field provenance, interned write origin) and is
   * pushed onto `this.writes`. The handle binding wraps that SAME object,
   * so the binding value and the firing entry are one — there is no
   * slim-handle → fuller-entry transform.
   */
  private recordWrite(input: {
    write: WriteRecord;
    bindingName: string | undefined;
    env: Environment;
    target: ResolvedWriteTarget;
    /** Trails of the evaluated field values — summarised onto the
     *  firing record for the fields that were actually written. */
    fieldProvenance: Record<string, Provenance>;
  }): Binding {
    const writeIndex = this.writes.length;
    const record = input.write;
    for (const fieldId of Object.keys(record.writtenValues)) {
      record.provenance[fieldId] = this.summariser.summariseTrail(
        input.fieldProvenance[fieldId] ?? NO_PROVENANCE,
      );
    }
    if (input.bindingName !== undefined) record.bindingName = input.bindingName;
    // The interned write origin — later reads of this handle chain to
    // this write by index (E4 provenance across systems).
    record.origin = {
      kind: 'write',
      writeIndex,
      ...(record.externalId !== undefined ? { externalId: record.externalId } : {}),
    };
    this.writes.push(record);
    const binding: Binding = {
      kind: 'handle',
      handle: record,
      // NATURAL currency — linked writes infer their type from the
      // (natural-named) graph schema via this handle; `target.recordType` is
      // that natural name.
      targetType: input.target.recordType,
      graph: input.target.graph,
    };
    if (input.bindingName !== undefined) {
      input.env.declare(input.bindingName, binding);
    }
    return binding;
  }

  /**
   * Resolve a write's destination: the receiving adapter, the written
   * record type, the graph the handle will live in, and — for linked
   * writes — the parent context.
   *
   * `write <instance>.<type>` routes to the named instance's adapter; a
   * `kg` binding routes to the intrinsic KG adapter through the SAME
   * `resolveAdapter` seam (no special engine path — 6_engine.md).
   *
   * `write h-[:edge]-> { … }` (linked) lands in the parent handle's
   * graph: exactly one declared edge from the parent, written type
   * inferred from that graph's schema (explicit only for polymorphic
   * edges — the checker enforces this when the schema is known; the
   * runtime re-enforces it for untyped graphs).
   */
  private async resolveWriteTarget(
    write: WriteExpression,
    env: Environment,
  ): Promise<ResolvedWriteTarget> {
    if (write.target.kind === 'tuple') {
      return this.resolveTupleWriteTarget(write.target, env);
    }

    if (write.target.kind === 'position') {
      // Position writes never reach here — `executeWrite` dispatches them to
      // `executePositionWrite` before resolving a create target.
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `'write ${write.target.alias} { … }' is a position write — it should have been dispatched to the update path`,
      );
    }

    // Linked write: `write h-[:edge]-> { … }`.
    const target = write.target;
    const rootBinding =
      target.path.root !== undefined ? env.resolve(target.path.root) : undefined;
    // A META-rooted linked write (`write crm-[:companies]-> { … }`) — the root
    // is a bare constructed instance, so this is a top-level create with no
    // parent; the written type is the collection the edge names.
    if (rootBinding?.kind === 'instance') {
      return this.resolveMetaWriteTarget(target, rootBinding);
    }
    const graph = this.linkedPathGraph(target.path, env);
    const parent = this.resolveLinkedParent({
      path: target.path,
      explicitType: target.explicitType,
      env,
      verb: 'write',
    });
    return {
      adapter: await this.targetAdapterFor(graph.instance),
      recordType: parent.surfaceType,
      graph,
      parents: [parent.parent],
    };
  }

  /**
   * A meta-rooted linked write — the root names a whole graph (a constructed
   * instance), so the write creates a top-level record with no parent edge.
   * The edge names the collection; its target type is the record's natural
   * type, which the adapter translates to its own id.
   */
  private async resolveMetaWriteTarget(
    target: Extract<WriteExpression['target'], { kind: 'linked' }>,
    binding: Extract<Binding, { kind: 'instance' }>,
  ): Promise<ResolvedWriteTarget> {
    const edgeName = this.singleWriteEdge(target.path);
    const schema = binding.schema;
    // The collection resolves to the record's natural type (`companies` →
    // `company`); where the schema doesn't map it (a graph's collection IS the
    // natural type, and unpublished types never appear), the edge name IS the
    // natural name — passed through so the adapter stays the authority and
    // fails loud on drift.
    const recordType = target.explicitType ?? schema?.collections[edgeName]?.target ?? edgeName;
    return {
      adapter: await this.targetAdapterFor(binding),
      recordType,
      graph: { kind: 'instance', instance: binding },
      parents: [],
    };
  }

  /** The single declared edge a linked write walks — shared by meta writes and
   *  in-memory shape writes (both name their target with exactly one hop). */
  private singleWriteEdge(path: PathHead): string {
    const probe = this.probeHead(path);
    const steps = probe?.type === 'traverse' ? probe.steps : undefined;
    if (!steps || steps.length !== 1 || steps[0].type !== 'edge') {
      throw unsupported(
        'multi-hop linked writes',
        'a linked write walks exactly one declared edge from its root',
      );
    }
    return steps[0].edgeTypeId;
  }

  /** The handle graph a linked/tuple path's root lives in — peeked before
   *  resolving the parent so the graph's resolver can be fetched once. */
  private linkedPathGraph(path: PathHead, env: Environment): HandleGraph {
    const rootName = path.root;
    const binding = rootName !== undefined ? env.resolve(rootName) : undefined;
    if (binding?.kind === 'handle') return binding.graph;
    // A traversal-bound SOURCE position parents a write too (the
    // positions-and-edges selection form: `sheets-[s:Spreadsheet WHERE …]->
    // { write s-[:cells]-> … }`) — the write lands in the graph the
    // position was read from.
    if (binding?.kind === 'sourcePosition') {
      // Mirror the bind/position-write resolution: a graph-rooted read names
      // its constructed instance; the env binding for that name IS the
      // HandleGraph instance. Event-sourced positions fall back to the
      // movement's source instance.
      if (binding.read !== undefined) {
        const inst = env.resolve(binding.read.instanceName);
        if (inst?.kind === 'instance') return { kind: 'instance', instance: inst };
      } else if (this.sourceInstance !== undefined) {
        return { kind: 'instance', instance: this.sourceInstance };
      }
      throw this.unnamedGraph("a linked write's parent", rootName ?? '');
    }
    // The EVENT parameter parents a write in its source instance's graph
    // (`write msg-[:replies]->` — the messaging write-back shape).
    if (binding?.kind === 'event') {
      if (this.sourceInstance !== undefined) {
        return { kind: 'instance', instance: this.sourceInstance };
      }
      throw this.unnamedGraph("a linked write's parent", rootName ?? '');
    }
    throw new MovementEngineError(
      'MOVENG_RUNTIME',
      `a linked write's path must start at a bound write handle or a traversed record — '${rootName ?? ''}' is ${binding ? describeBinding[binding.kind] : 'not in scope'}`,
    );
  }

  /**
   * Tuple-path multi-parent write: `write (a-[:e]->, b-[:f]->) { … }` —
   * ONE create at the convergence of N edges. Every path resolves like a
   * linked write's; all paths must land in the SAME graph and infer the
   * SAME written type (the checker enforces it where the schema is
   * typed; the runtime re-enforces it for untyped graphs, naming both
   * inferences).
   */
  private async resolveTupleWriteTarget(
    target: Extract<WriteExpression['target'], { kind: 'tuple' }>,
    env: Environment,
  ): Promise<ResolvedWriteTarget> {
    const resolved = target.paths.map((path) =>
      this.resolveLinkedParent({
        path,
        explicitType: target.explicitType,
        env,
        verb: 'write',
      }),
    );
    const [first, ...rest] = resolved;
    for (const other of rest) {
      if (other.graph.instance !== first.graph.instance) {
        throw new MovementEngineError(
          'MOVENG_RUNTIME',
          `a tuple write's paths must land in the same graph — '${first.rootName}' is in ${describeHandleGraph(first.graph)} and '${other.rootName}' is in ${describeHandleGraph(other.graph)}`,
        );
      }
      if (other.surfaceType !== first.surfaceType) {
        throw new MovementEngineError(
          'MOVENG_RUNTIME',
          `the tuple's paths must converge on ONE written type — '${first.rootName}-[:${first.surfaceEdgeName}]->' infers '${first.surfaceType}' but '${other.rootName}-[:${other.surfaceEdgeName}]->' infers '${other.surfaceType}'`,
        );
      }
    }
    const graph = first.graph;
    return {
      adapter: await this.targetAdapterFor(graph.instance),
      recordType: first.surfaceType,
      graph,
      parents: resolved.map((r) => r.parent),
    };
  }

  /**
   * One parent path of a linked or tuple write: the root must be a bound
   * write handle, the path walks exactly one edge, and the written type
   * is inferred from the parent's graph schema in SURFACE currency
   * (explicit only for polymorphic edges); everything the adapter
   * consumes — parent type, edge name — translates to engine currency
   * here.
   */
  private resolveLinkedParent(input: {
    path: PathHead;
    explicitType: string | undefined;
    env: Environment;
    verb: 'write';
  }): {
    graph: HandleGraph;
    surfaceType: string;
    surfaceEdgeName: string;
    rootName: string;
    parent: ResolvedWriteTarget['parents'][number];
  } {
    const rootName = input.path.root;
    const binding = rootName !== undefined ? input.env.resolve(rootName) : undefined;
    if (binding?.kind === 'shapePosition') {
      throw unsupported(
        'linked writes off a shape position (multi-node shapes)',
        'single-node shape arguments run today',
      );
    }
    if (
      rootName === undefined ||
      (binding?.kind !== 'handle' && binding?.kind !== 'sourcePosition' && binding?.kind !== 'event')
    ) {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `a linked write's path must start at a bound write handle, a traversed record, or the event — '${rootName ?? ''}' is ${binding ? describeBinding[binding.kind] : 'not in scope'}`,
      );
    }
    // A source position (traversed, or the EVENT parameter itself) can parent
    // a write only when it carries a STABLE native id — that id IS the
    // parentLink externalId. Unstable positions (webhook payload fan-outs,
    // events whose dispatcher recorded no record ref) have nothing durable to
    // link to.
    const parentPosition =
      binding.kind === 'sourcePosition'
        ? binding.position
        : binding.kind === 'event'
          ? this.source?.position
          : undefined;
    if (binding.kind === 'sourcePosition' || binding.kind === 'event') {
      const identity = parentPosition?.identity;
      if (parentPosition === undefined || identity?.kind !== 'stable' || parentPosition.recordType === null) {
        throw new MovementEngineError(
          'MOVENG_RUNTIME',
          binding.kind === 'event'
            ? `'${rootName}' (the event) carries no durable record id — this source's events can't parent a linked write`
            : `'${rootName}' is a traversed position without a stable record id — only positions with durable native identity (e.g. a WHERE-selected Spreadsheet or Channel) can parent a linked write`,
        );
      }
    }
    const probe = this.probeHead(input.path);
    const steps = probe?.type === 'traverse' ? probe.steps : undefined;
    if (!steps || steps.length !== 1 || steps[0].type !== 'edge') {
      throw unsupported(
        'multi-hop linked writes',
        'a linked write walks exactly one declared edge from its parent handle',
      );
    }
    const edgeName = steps[0].edgeTypeId;
    const graph = this.linkedPathGraph(input.path, input.env);
    const parentSurfaceType =
      binding.kind === 'handle'
        ? binding.targetType
        : (parentPosition!.recordType as string);
    const parentExternalId =
      binding.kind === 'handle'
        ? binding.handle.externalId
        : (parentPosition!.identity as { kind: 'stable'; recordId: string }).recordId;
    // Type inference happens in SURFACE currency (the instance/kg schema
    // is surface-named; the parent's surface type is the handle's target
    // type or the traversed position's recordType).
    const surfaceType = this.inferLinkedSurfaceType({
      graph,
      parentSurfaceType,
      edgeName,
      explicitType: input.explicitType,
      rootName,
      verb: input.verb,
    });
    const parentData =
      binding.kind === 'handle'
        ? binding.handle.resultData
        : (positionData(parentPosition!) as Record<string, unknown> | undefined) ?? undefined;
    return {
      graph,
      surfaceType,
      surfaceEdgeName: edgeName,
      rootName,
      parent: {
        handleName: rootName,
        // The edge + parent type cross the boundary in the program's NATURAL
        // currency; the adapter resolves the parentLink edge (against the
        // parent's type) and the parent type to its own ids internally.
        edgeName,
        recordType: parentSurfaceType,
        externalId: parentExternalId,
        ...(parentData !== undefined && parentData !== null && typeof parentData === 'object'
          ? { data: parentData as Record<string, unknown> }
          : {}),
      },
    };
  }

  /** The target type one declared edge points at, in surface currency —
   *  shared by linked writes, tuple paths, and criteria links. */
  private inferLinkedSurfaceType(input: {
    graph: HandleGraph;
    parentSurfaceType: string;
    edgeName: string;
    explicitType: string | undefined;
    rootName: string;
    verb: 'write' | 'link';
  }): string {
    const { graph, edgeName } = input;
    const keyword = input.verb === 'write' ? 'write' : 'link';
    const schema = graph.instance.schema;
    // A WRITABLE-ONLY type mints no position (an ask family: you can raise a
    // request, you can never enumerate open ones), so its relationship table
    // lives on the WRITE SHAPE. Same fallback the checker's linked-path
    // resolution makes — without it, `write a-[:Response]->` off a fresh
    // request can't name its own landing type at run time.
    const edge =
      schema?.positions[input.parentSurfaceType]?.edges[edgeName] ??
      (schema?.writableRoots[input.parentSurfaceType] ?? schema?.createShapes?.[input.parentSurfaceType])
        ?.edges?.[edgeName];
    if (edge?.polymorphic && input.explicitType === undefined) {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `'${edgeName}' is polymorphic — say which type this ${input.verb === 'write' ? 'write creates' : 'link finds'}: ${keyword} …-[:${edgeName}]-><type> { … }`,
      );
    }
    if (input.explicitType !== undefined) return input.explicitType;
    if (edge !== undefined) return edge.target;
    throw new MovementEngineError(
      'MOVENG_RUNTIME',
      `cannot infer the ${input.verb === 'write' ? 'written' : 'found'} type for edge '${edgeName}' from '${input.rootName}' (a ${input.parentSurfaceType} handle) — name it explicitly: ${keyword} …-[:${edgeName}]-><type> { … }`,
    );
  }

  /**
   * `unique by (…)` → OR-of-AND constraints, in the program's NATURAL
   * currency (the adapter resolves each `field` to its own property/edge id
   * inside `resolveEntity`, property-then-edge). A backticked component is a
   * target field OR edge name, passed through verbatim; a bare component must
   * name one of the write's own parent handles and lowers to `{ field:
   * <parent's natural edge name> }` — `executeWrite` folds the resolved parent
   * into the resolve record under that edge name so the adapter matches by
   * adjacency (edge-scoped compound identity).
   */
  /**
   * Lower the write's `unique by (…)` predicate(s) to the identity the adapter
   * searches by, plus an engine-side precise post-filter for the parts the
   * coarse search can't express (adapter-capability-contract chunk 8).
   *
   * The predicate is now a full expression. Its EQUALITY backbone — bare
   * `\`field\`` (identify by the value being written), `\`field\` == <literal>`,
   * and bound parent handles (edge-scoped identity) — lowers to OR-of-AND
   * `UniquenessConstraints` (the adapter's currency); literal RHS values ride a
   * `valueOverlay` folded into the resolve record so the adapter's
   * `record[field]` search finds them. NON-equality conjuncts (`WITHIN`,
   * ranges) can't be a coarse field match, so they become a `postFilter`
   * expression the engine evaluates over the returned candidates via the shared
   * filter unit — precise, over a bounded shortlist (principle 4).
   */
  private uniqueByIdentity(
    write: WriteExpression,
    target: ResolvedWriteTarget,
  ): {
    constraints: UniquenessConstraints;
    valueOverlay: Record<string, unknown>;
    postFilter?: Expression;
  } {
    const any: UniquenessConstraints['any'] = [];
    const valueOverlay: Record<string, unknown> = {};
    const postClauses: Expression[] = [];
    for (const clause of write.uniqueBy) {
      const all: { field: string; fuzzy?: boolean }[] = [];
      const nonEquality: Expression[] = [];
      // FUZZY rides on a textual conjunct, so split first (lifting the modifier)
      // then flatten each parsed part — equivalent to a single-parse flatten for
      // plain predicates, but it carries the per-component fuzzy flag through.
      for (const part of splitUniquenessConjuncts(clause.predicate.raw)) {
        const fuzzyMark = part.fuzzy ? { fuzzy: true as const } : {};
        for (const conjunct of flattenAndConjuncts(parseMovementExpression(part.raw))) {
          if (
            conjunct.type === 'property' ||
            conjunct.type === 'edge_property' ||
            conjunct.type === 'alias_ref'
          ) {
            // A bare name: a field of the written record (identify by its written
            // value), OR a bound parent handle (→ the parent's edge name,
            // edge-scoped identity). The bridge renders a bare name as either
            // `property` or `alias_ref`, so resolve the parent handle for both.
            const name = conjunct.type === 'alias_ref' ? conjunct.name : conjunct.propertyTypeId;
            const parent = target.parents.find((p) => p.handleName === name);
            all.push({ field: parent ? parent.edgeName : name, ...fuzzyMark });
          } else if (
            conjunct.type === 'compare' &&
            conjunct.op === 'eq' &&
            (conjunct.left.type === 'property' || conjunct.left.type === 'edge_property')
          ) {
            const field = conjunct.left.propertyTypeId;
            all.push({ field, ...fuzzyMark });
            if (conjunct.right.type === 'static') valueOverlay[field] = conjunct.right.value;
          } else {
            nonEquality.push(conjunct);
          }
        }
      }
      if (all.length > 0) any.push({ all });
      if (nonEquality.length > 0) {
        postClauses.push(
          nonEquality.length === 1
            ? nonEquality[0]
            : { type: 'logical', op: 'and', operands: nonEquality },
        );
      }
    }
    // A single clause's non-equality conjuncts post-filter precisely. Multiple
    // OR-ed clauses with non-equality parts would muddy the OR semantics, so we
    // only post-filter the unambiguous single-clause case (the common one).
    const postFilter =
      postClauses.length === 1 && write.uniqueBy.length === 1 ? postClauses[0] : undefined;
    return { constraints: { any }, valueOverlay, ...(postFilter ? { postFilter } : {}) };
  }

  /**
   * Narrow resolved candidates to those that also satisfy the `unique by`
   * predicate's non-equality conjuncts (chunk 8), via the shared filter unit
   * over each candidate's own fields. Lenient: a candidate whose data doesn't
   * carry a referenced field is KEPT (never drop a real match on sparse data —
   * a false drop would mint a duplicate). Only pure predicates are evaluated;
   * anything else leaves the shortlist untouched.
   */
  private narrowCandidatesByPredicate<T extends { data?: Record<string, unknown> }>(
    candidates: T[],
    predicate: Expression,
  ): T[] {
    if (!isPurePredicate(predicate)) return candidates;
    const fields = pureLeafReads(predicate).map(leafReadKey);
    return candidates.filter((candidate) => {
      const data = candidate.data ?? {};
      if (fields.some((f) => !(f in data))) return true; // sparse ⇒ keep (lenient)
      return Boolean(evaluatePredicate(predicate, { read: (name) => data[name] }));
    });
  }

  /** The firing-log linkage projection of a write's parent set. */
  private parentSummaries(
    parentLinks: ParentLink[],
  ): { parents?: Array<{ recordType: string; externalId: string; edgeName: string }> } {
    if (parentLinks.length === 0) return {};
    return {
      parents: parentLinks.map((p) => ({
        recordType: p.recordType,
        externalId: p.externalId,
        edgeName: p.edgeName,
      })),
    };
  }

  private async applyUpdate(input: {
    adapter: Adapter;
    recordType: string;
    externalId: string;
    fields: Record<string, unknown>;
    /** Per-field write-precedence (absent ⇒ replace). The engine applies the
     *  merge against current values here; the adapter writes a final value. */
    fieldSemantics: Record<string, FieldWriteMode>;
    /** Per-field evidence for provenance-faithful values — filtered to
     *  the fields that survive no-op suppression, like the TG engine. */
    fieldEvidence: Record<string, FieldEvidence>;
    /** Node-level resource provenance (Layer 5) — the source content that fed
     *  the extracted node(s) this write draws from, persisted against the
     *  updated record (`WriteInput.resources`). Empty for non-extract writes. */
    resources?: Resource[];
    parentLinks: ParentLink[];
  }): Promise<WriteRecord | { notFound: true }> {
    // Current values against the live record, when the adapter can read one.
    // `replace` uses them for no-op suppression; `?:`/`+:`/`+?:` for the
    // set-if-empty / append merge. When the adapter can't read current values
    // (no readRecord) every field is treated as written-from-empty — the safe
    // direction (fill/append both reduce to "set the new value").
    const currentValues = input.adapter.readRecord
      ? await input.adapter.readRecord({
          recordType: input.recordType,
          externalId: input.externalId,
          fieldIds: Object.keys(input.fields),
        })
      : null;
    const fieldsToWrite: Record<string, unknown> = {};
    for (const [fieldId, value] of Object.entries(input.fields)) {
      const mode = input.fieldSemantics[fieldId];
      const current = currentValues?.[fieldId];

      if (mode === 'fill') {
        // Write only when the current value is EMPTY — null/undefined, or an
        // empty list (an empty STRING still counts as a value, unchanged from
        // the TG engine's set-if-null). Single or multi.
        if (!isEmptyFieldValue(current)) continue;
        fieldsToWrite[fieldId] = value;
        continue;
      }

      if (mode === 'append' || mode === 'append-missing') {
        // Multi-value merge against the current list. `append` concatenates
        // (duplicates allowed); `append-missing` adds only elements not already
        // present (set union). The adapter still receives a single final list.
        const currentArr = toFieldArray(current);
        const incoming = toFieldArray(value);
        const merged =
          mode === 'append'
            ? [...currentArr, ...incoming]
            : [...currentArr, ...incoming.filter((v) => !currentArr.some((c) => deepEqual(c, v)))];
        if (currentValues && deepEqual(merged, currentArr)) continue; // no-op
        fieldsToWrite[fieldId] = merged;
        continue;
      }

      // replace (default) — overwrite with no-op suppression.
      if (currentValues && deepEqual(value, current)) continue;
      fieldsToWrite[fieldId] = value;
    }
    // Pure no-op only when there is ALSO no resource provenance to persist:
    // an extract-fed write whose fields all match the live record still needs
    // its source resources recorded against the node (Layer 5). When resources
    // are present the update runs with empty fields so `WriteInput.resources`
    // reaches the adapter.
    const hasResources = (input.resources?.length ?? 0) > 0;
    if (Object.keys(fieldsToWrite).length === 0 && !hasResources) {
      return {
        adapterType: input.adapter.adapterType,
        recordType: input.recordType,
        created: false,
        committed: this.committedThrough(input.adapter),
        externalId: input.externalId,
        writtenValues: {},
        provenance: {},
        ...this.parentSummaries(input.parentLinks),
      };
    }
    // Any `FileRef` in the fields carries its own `retrieve()` byte channel —
    // the consuming adapter pulls the bytes itself (streamFileRef). The engine
    // just hands the fields through. Node-level resources ride alongside
    // (`WriteInput.resources`) — the adapter's resource sink persists them.
    const updated = await input.adapter.updateRecord({
      recordType: input.recordType,
      externalId: input.externalId,
      fields: fieldsToWrite,
      evidence: evidenceForWrite(input.fieldEvidence, fieldsToWrite),
      ...(hasResources ? { resources: input.resources } : {}),
      mutationContext: this.mutationContext,
      // Forwarded so edge-anchored field writes on a matched node can
      // resolve the existing parent → child edge(s) (W4-KG3); external
      // adapters ignore it. Mirrors the TG engine's update branch. A
      // linked write is the 1-element case of the general N-parent list.
      parentLinks: input.parentLinks,
    });
    // NOT-FOUND contract (3b): the target record is gone. Surface it so the
    // bind flow can self-heal (drop the stale binding + re-mint). A non-bind
    // update never reaches here with a stale id (it resolved by identity
    // moments ago), but the typed signal is propagated uniformly.
    if (!updateRecordSucceeded(updated)) return { notFound: true };
    return {
      adapterType: input.adapter.adapterType,
      recordType: input.recordType,
      created: false,
      committed: this.committedThrough(input.adapter),
      externalId: input.externalId,
      writtenValues: fieldsToWrite,
      resultData: writeResultData(updated),
      provenance: {},
      ...this.parentSummaries(input.parentLinks),
    };
  }

  private async applyCreate(input: {
    adapter: Adapter;
    recordType: string;
    fields: Record<string, unknown>;
    /** Per-field evidence for provenance-faithful values — the record
     *  and its evidence persist as one transactional unit (3b §3.3). */
    fieldEvidence: Record<string, FieldEvidence>;
    /** Node-level resource provenance (Layer 5) — the source content that fed
     *  the extracted node this write materialises, persisted against the new
     *  record (`WriteInput.resources`). Empty for non-extract writes. */
    resources?: Resource[];
    descriptor: Awaited<ReturnType<Adapter['describe']>>;
    parentLinks: ParentLink[];
    /** False for linked/tuple writes — required-field applicability
     *  follows the TG engine's root/child context (`hideOn` filtering). */
    isRoot: boolean;
    bridgeToExternal?: WriteInput['bridgeToExternal'];
  }): Promise<WriteRecord> {
    // Required-field hard gate — same contract as the TG engine's create
    // branch: creating a record that leaves a target-required field empty
    // fails loud, naming the fields. Everything here speaks the program's
    // NATURAL names (the write `fields` are keyed by them; the descriptor's
    // `displayName` is the field's natural name). A required REFERENCE field
    // satisfied by a parent link (the linked/tuple form sets it structurally)
    // must not double-fire — the parent's `edgeName` IS the reference's
    // natural name.
    const satisfiedByParentLink = new Set(input.parentLinks.map((p) => p.edgeName));
    const missingRequired = applicableRequiredFields({
      descriptorFields: input.descriptor?.fields ?? [],
      isRoot: input.isRoot,
    })
      .map((f) => f.displayName)
      .filter(
        (fieldName) =>
          isEmptyWriteValue(input.fields[fieldName]) && !satisfiedByParentLink.has(fieldName),
      );
    if (missingRequired.length > 0) {
      const typeLabel = input.descriptor?.displayName ?? input.recordType;
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `cannot create a ${typeLabel} record: required field(s) ${missingRequired
          .map((f) => `"${f}"`)
          .join(', ')} have no value`,
      );
    }
    // Any `FileRef` in the fields (an email attachment, a `#resources` file)
    // carries its own `retrieve()` byte channel — the consuming adapter pulls the
    // bytes itself (streamFileRef / exposeFile). The engine hands fields through.
    const created = await input.adapter.createRecord({
      recordType: input.recordType,
      fields: input.fields,
      evidence: evidenceForWrite(input.fieldEvidence, input.fields),
      // Node-level resources (Layer 5) — the source content that fed the
      // extracted node, persisted against the new record by the adapter's
      // resource sink (KG: resource row + node_resource link + facts).
      ...((input.resources?.length ?? 0) > 0 ? { resources: input.resources } : {}),
      mutationContext: this.mutationContext,
      // Parent → child wiring (KG: insert every connecting edge inside
      // the same transaction; N for a tuple-path write, 1 for a linked
      // write, 0 for a root) and the anchor write's external bridge —
      // both mirrored from the TG engine's create branch.
      parentLinks: input.parentLinks,
      bridgeToExternal: input.bridgeToExternal,
    });
    return {
      adapterType: input.adapter.adapterType,
      recordType: input.recordType,
      created: true,
      committed: this.committedThrough(input.adapter),
      externalId: created.externalId,
      writtenValues: input.fields,
      resultData: writeResultData(created),
      provenance: {},
      ...this.parentSummaries(input.parentLinks),
    };
  }

  /**
   * Per-instance target adapters, resolved through the shared seam with
   * `role: 'target'` and dry-run-wrapped — cached per (slug, credential)
   * exactly like the TG engine's `resolveTargetAdapter`.
   */
  private async targetAdapterFor(
    instance: Extract<Binding, { kind: 'instance' }>,
  ): Promise<Adapter> {
    // Dry-run is decided per-instance from the instance's OWN construction —
    // read here, at the moment we resolve the adapter we're about to write
    // through, so no upstream static analysis can misjudge it. A whole-run
    // rehearsal (Test run) forces every instance dry; a `dry_run: true`
    // construction rehearses just that target inside an otherwise-live run.
    const dryRun = this.input.dryRun === true || instanceIsDryRun(instance);
    return this.resolveTargetAdapter(
      instance.adapterSlug,
      this.credentialsIdFor(instance),
      dryRun,
      constructionArgsOf(instance),
    );
  }

  private async resolveTargetAdapter(
    adapterType: string,
    credentialsId: string | undefined,
    dryRun: boolean,
    constructionArgs?: Record<string, string>,
  ): Promise<Adapter> {
    const argsKey =
      constructionArgs && Object.keys(constructionArgs).length
        ? JSON.stringify(Object.entries(constructionArgs).sort(([a], [b]) => a.localeCompare(b)))
        : '';
    const cacheKey = `${dryRun ? 'dry ' : ''}${adapterType} ${credentialsId ?? ''} ${argsKey}`;
    const cached = this.targetAdapterCache.get(cacheKey);
    if (cached) return cached;
    const real = await this.resolveAdapterFn({
      adapterType,
      teamId: this.input.teamId,
      credentialsId,
      ...(constructionArgs && Object.keys(constructionArgs).length ? { constructionArgs } : {}),
      role: 'target',
    });
    const wrapped = dryRun ? wrapAdapterForDryRun(real, this.input.writeSink) : real;
    if (dryRun) this.dryAdapters.add(wrapped);
    this.targetAdapterCache.set(cacheKey, wrapped);
    return wrapped;
  }

  /** The dry-run-wrapped target adapters — membership is the per-write
   *  `committed` signal: a write through one of these was captured, not
   *  committed (`resolveTargetAdapter` wraps + registers iff the target is
   *  rehearsed). */
  private readonly dryAdapters = new WeakSet<Adapter>();

  /** Whether a write through this resolved adapter actually committed —
   *  false when the adapter is a dry-run wrapper. */
  private committedThrough(adapter: Adapter): boolean {
    return !this.dryAdapters.has(adapter);
  }

  // ── Expressions ──

  private exprContext(env: Environment): MovementExprContext {
    return {
      env,
      source: this.source,
      graphRead: (name, binding) => this.graphReadFor(name, binding),
      walkDeferred: async (walk, extraSteps) =>
        (await this.runDeferredWalk(walk, extraSteps)).flatMap((iteration) =>
          iteration.landing !== undefined ? [iteration.landing] : [],
        ),
      llm: this.llmClient(),
      trace: this.trace,
      // `@<key>` resolution — the dispatch context the frozen engine's
      // resolveMetaKey reads, with the run-wide actor caches. The bag
      // mirrors the frozen field-mapping pipeline's per-dispatch bag.
      meta: {
        event: this.input.event,
        teamId: this.input.teamId,
        now: this.pinnedNow,
        bag: { trigger: this.input.event, mutationContext: this.mutationContext },
        actingUserCache: this.actingUserCache,
        actorCache: this.actorCache,
      },
    };
  }

  /**
   * `channel = FIRST(chat-[ch:Channels WHERE …]->)` — the assignment that binds
   * a RECORD, not a value. The checker types it as a maybe-empty position, and
   * the engine has to agree: a `value` binding holding a position object would
   * parent no write (`resolveLinkedParent` reads the binding KIND) and carry no
   * read seam, so the write would land in the wrong graph if it landed at all.
   *
   * Walked through the ordinary block-head machinery — the selection IS a
   * traversal, and taking one of its landings is what FIRST/LAST mean. No
   * landing binds a plain null: absence, in the language's own currency, which
   * `x == null` then answers.
   *
   * Undefined for every other expression, which assigns as before.
   */
  /**
   * `btn = a` — a bare name already bound on the NODE plane re-binds the SAME
   * binding under a second name (the checker's alias rule). Evaluating it as
   * an expression would collapse the position to a scalar value and every
   * later walk off the new name would find nothing.
   */
  private aliasedNodeBinding(slot: ExprSlot, env: Environment): Binding | undefined {
    const trimmed = slot.raw.trim();
    let name: string | undefined;
    if (BARE_IDENT.test(trimmed)) {
      name = trimmed;
    } else {
      // Backtick-coined names only exist parsed.
      try {
        name = bareName(parseMovementExpression(trimmed));
      } catch {
        return undefined; // a parse failure is the evaluator's to report
      }
    }
    if (name === undefined) return undefined;
    const binding = env.resolve(name);
    if (binding === undefined) return undefined;
    switch (binding.kind) {
      case 'event':
      case 'handle':
      case 'extractRoot':
      case 'extractPosition':
      case 'sourcePosition':
      case 'resource':
      case 'blockMeta':
      case 'shapePosition':
      case 'nodePosition':
      case 'lazyWalk':
      case 'callback':
      case 'positions':
      case 'closure':
      case 'tuple':
        return binding;
      case 'value':
      case 'instance':
      case 'shape':
      case 'movement':
      case 'opaque':
        return undefined;
    }
  }

  private async selectedPositionBinding(
    slot: ExprSlot,
    env: Environment,
  ): Promise<Binding | undefined> {
    let path: ReturnType<typeof aggregatedBarePath>;
    try {
      path = aggregatedBarePath(parseMovementExpression(slot.raw));
    } catch {
      return undefined; // a parse failure is the evaluator's to report
    }
    if (path === undefined || path.aliasRoot === undefined) return undefined;
    const rootBinding = env.resolve(path.aliasRoot);
    if (rootBinding === undefined) return undefined;
    const resolved =
      rootBinding.kind === 'event' || rootBinding.kind === 'sourcePosition'
        ? this.source !== undefined
          ? {
              start: rootBinding.kind === 'event' ? this.source.position : rootBinding.position,
              read:
                rootBinding.kind === 'sourcePosition' && rootBinding.read !== undefined
                  ? rootBinding.read
                  : this.source,
            }
          : undefined
        : await this.graphReadFor(path.aliasRoot, rootBinding);
    if (resolved === undefined) return undefined;
    const landings = await this.walkSourceHeadPaths({
      start: resolved.start,
      steps: path.steps,
      env,
      read: resolved.read,
    });
    // ONLY is a cardinality claim: more than one landing means it was wrong,
    // and nothing at author time could have seen that (same rule the value
    // plane's fold follows).
    if (path.fn === 'only' && landings.length > 1) {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `ONLY(${slot.raw.trim()}) says there is exactly one, and there are ${landings.length}. Narrow it until there is.`,
      );
    }
    const landed = path.fn === 'last' ? landings[landings.length - 1] : landings[0];
    if (landed?.position === undefined) {
      return { kind: 'value', value: null, provenance: NO_PROVENANCE };
    }
    // The head's own seam rides the binding only when it is NOT the event
    // source, exactly as a block head's aliases carry it.
    const bindingRead = resolved.read === this.source ? undefined : resolved.read;
    return {
      kind: 'sourcePosition',
      position: landed.position,
      ...(bindingRead !== undefined ? { read: bindingRead } : {}),
    };
  }

  private async evaluateSlot(
    slot: ExprSlot,
    options: {
      env: Environment;
      /** Write-field evaluation only — the destination field's adapter
       *  functions (see `MovementExprContext.fieldFunctions`). */
      fieldFunctions?: MovementExprContext['fieldFunctions'];
    },
  ): Promise<MovementEvalResult> {
    let expr: Expression;
    try {
      expr = parseMovementExpression(slot.raw);
    } catch (e) {
      if (e instanceof BridgeError) {
        throw new MovementEngineError(
          'MOVENG_RUNTIME',
          `invalid expression (the checker should have caught this): ${e.message}`,
        );
      }
      throw e;
    }
    // The slot's span locates any literals the expression carries —
    // the program is part of the trail.
    return evalMovementExpr(expr, {
      ...this.exprContext(options.env),
      literalSpan: slot.span,
      ...(options.fieldFunctions !== undefined ? { fieldFunctions: options.fieldFunctions } : {}),
    });
  }
}

/** A single bare identifier — a name-only call argument / IS subject. */
const BARE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * What an `IS <Doc>` subject offers — three answers, because there are three
 * facts. `notARecord` is not a position at all (a scalar, an instance, a
 * deferred plural): no structure, so an ordinary false. `unknown` IS a position
 * whose structure the run cannot see: not the same fact, and not allowed to
 * share an answer with it.
 */
type SubjectSurface =
  | { kind: 'surface'; surface: SuppliedSurface }
  | { kind: 'unknown'; reason: string }
  | { kind: 'notARecord' };

/** A schema-published position, as a surface — `unknown` when the kind is in
 *  hand but nothing describes it. */
function positionSurface(
  schema: InstanceSchema | undefined,
  position: string,
): SubjectSurface {
  const surface = schema && schemaSurface(schema, position);
  return surface === undefined
    ? { kind: 'unknown', reason: undescribedKind(position) }
    : { kind: 'surface', surface };
}

/** The record's kind is known; its STRUCTURE is not, so there is nothing to
 *  compare a declared node against. */
const undescribedKind = (position: string): string =>
  `nothing describes the structure of a '${position}'`;
const UNKNOWN_STRUCTURE = 'nothing describes its structure';

/** Why an `IS` test had nothing to compare against. Author-facing halves of
 *  `undiscriminatedIsTest`, kept here so the two throw sites cannot drift. */
const UNDISCRIMINATED_EVENT =
  'the event arrived without a discriminated kind, so the trigger never said which one it was';
const UNSTAMPED_LANDING =
  'the connected system returned it without a record type';
/** The address case: the event HAS an address, but not on the axis the test
 *  pins. Names the axis, since that is the field the trigger has to deliver
 *  for the branch to be answerable. */
const unpinnedAxis = (axes: string[]): string =>
  `the event carries no ${axes.map(a => `'${a}'`).join(' or ')}, and this test asks about `
  + `${axes.length === 1 ? 'it' : 'them'}`;

/** The lexical alias of a `-[f:_resources …]->` head's hop (the parsed
 *  `resource_traverse` drops it). `#resources` is accepted as a deprecated
 *  alias for legacy heads. */
const RESOURCES_HEAD_ALIAS = /^\s*-\[\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(?:_resources|#resources)\b/;

/** Identifier tokens in an expression's source text, EXCLUDING the names that
 *  follow a `.` (field reads — `d.\`name\`` references the binding `d`, not a
 *  binding `name`) and backtick-quoted field names. Used to find which in-scope
 *  bindings a write field draws from, for Layer-5 resource collection — a loose
 *  superset is fine (over-collected resources dedupe on their stable id). */
function referencedIdentifiers(raw: string): string[] {
  // Strip backtick-quoted segments (field names) so `\`name\`` never registers.
  const withoutFields = raw.replace(/`[^`]*`/g, ' ');
  const names = new Set<string>();
  const re = /(\.)?\b([A-Za-z_][A-Za-z0-9_]*)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(withoutFields)) !== null) {
    if (m[1] === '.') continue; // a field/method name after a dot — not a binding
    names.add(m[2]);
  }
  return [...names];
}

// ── Event seeding (mirrors the TG engine's trigger root) ────────────────────

/**
 * The event's source position — what the movement parameter binds to.
 * Mirrors `seedRootSourcePosition` in `engine/evaluate.ts`:
 *   - webhook: a discriminated inbound event seeds the typed stable
 *     record; otherwise the raw payload rides an unstable position.
 *     Property reads then go through the source adapter exactly as
 *     they do under the TG engine;
 *   - snapshot: the source instance's meta position (the manual_run.ts
 *     backfill shape) — collection blocks fan out from it. The envelope
 *     carries no adapter identity of its own (run_now.ts builds it
 *     before the program is parsed), so the seed speaks the source
 *     INSTANCE's adapter slug.
 */
/**
 * Resolve a discriminated inbound root's `positionType` (a machine typeId like
 * `granola:note`) to its NATURAL type name (`Meeting Note`) via the adapter's
 * own entry points — the same `typeId → displayName` mapping the resolver is
 * built from. The seed then names the root the way the program and the
 * field/edge resolver do. Falls back to the id itself when it names no entry
 * (e.g. Airtable's static `airtable:webhook_record` positionType), where the
 * resolver's bilingual tolerance + the adapter's name-keyed reads carry it.
 */
async function naturalRootTypeName(
  adapter: Adapter,
  rootRecordType: string | undefined,
): Promise<string | undefined> {
  if (rootRecordType === undefined) return undefined;
  try {
    const entries = await adapter.listEntryPoints();
    return entries.find((e) => e.typeId === rootRecordType)?.displayName ?? rootRecordType;
  } catch {
    return rootRecordType;
  }
}

/**
 * The canonical address of the EVENT NODE a typed inbound event seeds, or
 * undefined when the source's schema declares no event edges (such a source
 * keeps its stable record seed).
 *
 * THE EVENT IS JUST A NODE, so the seed's type is that node narrowed by what
 * the event itself says: each declared address hop (`eventNarrowingKeys`)
 * read off the payload's same-named field (`base`, `table` — the adapter
 * publishes them ON the event node precisely so the same values narrow both),
 * plus the payload's `action` when the node declares that axis. The node is
 * picked by the event's own discrimination (`rootTypeName`, the natural name
 * of `rootRecordType`) — the multi-edge case (whatsapp's message / reaction /
 * location) — falling back to the sole declared edge.
 *
 * The same derivation types the seed (`eventAddressKey`) and answers runtime
 * IS tests (pin subset), so check time and fire time cannot disagree.
 *
 */
/**
 * The one event node an adapter publishes, when it publishes exactly one.
 *
 * Derived, not named: an adapter with a single event surface has no ambiguity
 * about which node an event of its is, and one with several must discriminate
 * (which is what `rootRecordType` is for). Nothing here knows which adapter it
 * is looking at.
 */
function soleEventPosition(schema: InstanceSchema | undefined): string | undefined {
  const nodes = schema?.eventPositions;
  return nodes !== undefined && nodes.length === 1 ? nodes[0].position : undefined;
}

function eventSeedAddress(input: {
  schema: InstanceSchema | undefined;
  event: TriggerEvent;
  rootTypeName: string | undefined;
}): EventAddress | undefined {
  const schema = input.schema;
  const nodes = schema?.eventPositions;
  if (schema === undefined || nodes === undefined || nodes.length === 0) return undefined;
  if (input.event.triggerType !== 'webhook' && input.event.triggerType !== 'poll') {
    return undefined;
  }
  const node =
    nodes.find((n) => n.position === input.rootTypeName)?.position
    ?? (nodes.length === 1 ? nodes[0].position : undefined);
  if (node === undefined) return undefined;
  const payload =
    typeof input.event.payload === 'object' && input.event.payload !== null
      ? (input.event.payload as Record<string, unknown>)
      : undefined;
  const narrowing: Record<string, string> = {};
  for (const key of schema.eventNarrowingKeys ?? []) {
    const value = payload?.[key];
    if (typeof value === 'string' && value.length > 0) narrowing[key] = value;
  }
  const actionType = schema.positions[node]?.properties[EVENT_ACTION_FIELD];
  if (typeof actionType === 'object' && 'kind' in actionType && actionType.kind === 'enum') {
    const value = payload?.[EVENT_ACTION_FIELD];
    if (typeof value === 'string' && value.length > 0) narrowing[EVENT_ACTION_FIELD] = value;
  }
  return { event: node, narrowing };
}

function seedEventPosition(
  event: TriggerEvent,
  sourceAdapterSlug: string,
  options: {
    /** The NATURAL type name to stamp on the root seed's recordType: the
     *  mutation's KG node type (the param's declared surface type) or a
     *  discriminated inbound type resolved to its displayName (see
     *  `naturalRootTypeName`). The surface-read wrapper + the adapter's resolver
     *  translate field/edge names against it. Without it the seed would carry
     *  the discriminated `positionType` — a machine typeId the field resolver
     *  keys nothing on (it keys by displayName) — the
     *  `'<field>' is not a known field of '<typeId>'` drift. */
    surfaceType?: string;
    /** The delivered NODE's canonical narrowed address (`eventSeedAddress`).
     *  When set, the seed is that node, typed by `eventAddressKey(address)` —
     *  the same identity the checker grafts — with the payload riding in
     *  `data`. STABLE when the fires edge lands straight on the discriminated
     *  record (`surfaceType === address.event` and the dispatcher recorded its
     *  id); an event node distinct from its record seeds UNSTABLE (an
     *  occurrence — its record is reached by the record edge on demand).
     *  Supersedes `surfaceType` for the webhook/poll branch. */
    eventAddress?: EventAddress;
  } = {},
): SourcePosition {
  // Webhook (unsolicited) and poll (solicited PollSource pull) seed the same
  // way: a discriminated event seeds the typed stable record (the adapter's
  // `listEventTypes` matched it to a concrete type); otherwise the raw payload
  // rides an unstable position. Property/edge reads then go through the source
  // adapter identically.
  if (event.triggerType === 'webhook' || event.triggerType === 'poll') {
    if (options.eventAddress !== undefined) {
      // A typed event: the seed IS the delivered node, typed by its canonical
      // narrowed address (an unpinned address keys as the bare node name —
      // `Message`), so `ev IS <chat-[:Message]->>` and the
      // pinned forms resolve.
      //
      // Stability follows from WHAT the edge delivers. Where the fires edge
      // lands straight on the record (rule 1's collapse — the adapter's own
      // discrimination named the delivered node, and the dispatcher recorded
      // its durable id), the seed IS that record: stable, so a linked write
      // can anchor off the parameter (`write e-[:replies]->`) exactly as it
      // anchored off the retired record-edge hop. An event node DISTINCT from
      // its record (airtable/attio — the discrimination names the RECORD's
      // type, not the event node) stays an unstable occurrence whose record
      // is reached by its own edge on demand.
      const externalId = event.externalRecordRef?.externalId;
      if (externalId !== undefined && options.surfaceType === options.eventAddress.event) {
        return makeStablePosition({
          adapterType: event.adapterType,
          recordType: eventAddressKey(options.eventAddress),
          recordId: externalId,
          data: event.payload,
        });
      }
      return makeUnstablePosition({
        adapterType: event.adapterType,
        recordType: eventAddressKey(options.eventAddress),
        data: event.payload,
      });
    }
    const externalId = event.externalRecordRef?.externalId;
    if (event.rootRecordType && externalId) {
      return makeStablePosition({
        adapterType: event.adapterType,
        // The program's declared natural type names the root (mirroring the
        // mutation branch's `surfaceType`). Fall back to the discriminated
        // `rootRecordType` (a typeId) only when the param is untyped — that path
        // leans on the resolver's bilingual tolerance.
        recordType: options.surfaceType ?? event.rootRecordType,
        recordId: externalId,
        data: event.payload,
      });
    }
    // A TYPELESS POSITION IS AN ERROR (ruling 2026-07-19).
    //
    // The two branches above name the type from the program's declared
    // parameter (`surfaceType`) or the event's discriminated root; this
    // fallback used to mint `recordType: null` when neither applied, and an
    // untyped position is not a weaker guarantee, it is none. Every downstream
    // read then GUESSES: field ids resolve against nothing, and edge names used
    // to be resolved by scanning every described type for a matching name — a
    // whole-graph read with no collision policy, arrived at because the type
    // was thrown away here.
    //
    // NAME THE TYPE WHERE IT IS KNOWN. `surfaceType` still applies when the
    // event carries no external record, so take it before falling back — that
    // is strictly more type than the `null` this used to mint unconditionally.
    //
    // It does NOT throw when neither is known, and that is a measured
    // retraction rather than a concession. "A typeless position is an error"
    // (ruling 2026-07-19) is right about the goal, but enforcing it HERE breaks
    // 145 engine tests: the engine seeds positions in many flows before a type
    // is established, so typeless-at-seed is a normal intermediate state in the
    // current design, not an exceptional one. Making it an error is a real
    // design change to the seed path, not a guard — and the guard that belongs
    // at the RESOLUTION boundary (`BaseAdapter.resolveEdgeReadId`) is already
    // there, which is where a typeless position actually causes a wrong answer.
    const inferredType = options.surfaceType ?? event.rootRecordType ?? null;
    return makeUnstablePosition({
      adapterType: event.adapterType,
      recordType: inferredType,
      data: event.payload,
    });
  }
  if (event.triggerType === 'snapshot') {
    return makeMetaPosition(sourceAdapterSlug);
  }
  if (event.triggerType === 'mutation') {
    // The changed record, anchored by the trigger's recordId — seeded against
    // the SOURCE INSTANCE's adapter, exactly as the webhook doors seed theirs.
    if (!event.recordId) {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        'a mutation event carries no recordId — nothing to seed the changed record from',
      );
    }
    return makeStablePosition({
      adapterType: sourceAdapterSlug,
      recordType: options.surfaceType ?? null,
      recordId: event.recordId,
    });
  }
  throw unsupported(
    `'${event.triggerType}' trigger events`,
    'the movement engine seeds webhook, poll, snapshot, and mutation events',
  );
}

// ── Write-shape helpers (mirrored from engine/evaluate.ts) ──────────────────

/**
 * Bind a write field's advertised functions (`SchemaFieldDescriptor.
 * functions`) to thunks invoking the target adapter's
 * `invokeFieldFunction` — mirrored from the frozen engine's
 * `bindFieldFunctions` (engine/evaluate.ts; private there): keyed by the
 * lowercased call name (the parser lowercases `fn`), `args[0]` coerced
 * to the `instructions` brief, `args[1..]` passed through verbatim.
 * Undefined when the field advertises none, so non-built-in names stay
 * unsupported on ordinary fields.
 */
function bindMovementFieldFunctions(input: {
  targetAdapter: Adapter;
  recordType: string;
  fieldId: string;
  descriptor: SchemaFieldDescriptor | undefined;
}): MovementExprContext['fieldFunctions'] {
  const functions = input.descriptor?.functions;
  if (!functions || functions.length === 0) return undefined;
  const { targetAdapter, recordType, fieldId } = input;
  const map: Record<string, (args: unknown[]) => Promise<unknown>> = {};
  for (const fn of functions) {
    map[fn.name.toLowerCase()] = async (args: unknown[]) => {
      if (!targetAdapter.invokeFieldFunction) {
        throw new MovementEngineError(
          'MOVENG_RUNTIME',
          `the '${targetAdapter.adapterType}' adapter advertises ${fn.name}() on '${recordType}.${fieldId}' but does not implement invokeFieldFunction`,
        );
      }
      return targetAdapter.invokeFieldFunction({
        recordType,
        fieldId,
        functionName: fn.name,
        args: { instructions: String(args[0] ?? ''), data: args.slice(1) },
      });
    };
  }
  return map;
}

/** The evidence map a write carries: the faithful fields' evidence,
 *  restricted to the fields actually being written — `undefined` when
 *  none qualify (mirrors the TG engine's `writeEvidence`). */
function evidenceForWrite(
  fieldEvidence: Record<string, FieldEvidence>,
  fieldsToWrite: Record<string, unknown>,
): Record<string, FieldEvidence> | undefined {
  const evidence: Record<string, FieldEvidence> = {};
  for (const fieldId of Object.keys(fieldsToWrite)) {
    const fieldEv = fieldEvidence[fieldId];
    if (fieldEv) evidence[fieldId] = fieldEv;
  }
  return Object.keys(evidence).length > 0 ? evidence : undefined;
}

/** Where a handle's record lives, for the cross-graph edge error. */
function describeHandleGraph(graph: HandleGraph): string {
  return `'${graph.instance.name}'`;
}

/** A handle's interned write origin as a trail — the edge-assert entry's
 *  per-endpoint provenance (refs into the run's own `writes`). */
function handleTrail(handle: WriteRecord): Provenance {
  return handle.origin !== undefined ? { origins: [handle.origin] } : NO_PROVENANCE;
}

/** The handle's result-data bag: the adapter's flat `WriteResult.data`
 *  plus the top-level `url` when one is surfaced (explicit keys win). */
function writeResultData(written: WriteResult): Record<string, unknown> {
  return {
    ...(written.url !== undefined ? { url: written.url } : {}),
    ...written.data,
  };
}

/** A value that doesn't satisfy a required field: absent, null, empty
 *  string, or an empty array. */
function isEmptyWriteValue(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  );
}

/**
 * Emptiness for the `?:` (set-if-empty) gate: null/undefined or an empty list.
 * Distinct from `isEmptyWriteValue` — an empty STRING counts as a value here
 * (a `?:` write must not overwrite a deliberately-blanked text field), matching
 * the TG engine's set-if-null semantics.
 */
function isEmptyFieldValue(value: unknown): boolean {
  return value === undefined || value === null || (Array.isArray(value) && value.length === 0);
}

/** Normalise a field value to an array for the append merges — a scalar wraps
 *  as a one-element list; null/undefined is the empty list. */
function toFieldArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Cardinality coercion before the value hits the adapter — many target +
 * scalar wraps as `[value]`; one (or undeclared) target + array joins as
 * CSV. Mirrored from the TG engine so both engines emit byte-identical
 * field values.
 *
 * A `json` field is exempt from the CSV join: it holds a JSON DOCUMENT, and an
 * array IS one, so joining would stringify every element (`"[object Object],
 * [object Object]"`) — the tap-loss defect. The field's KIND is what decides,
 * not a guess about the value's shape.
 */
function coerceValueForFieldCardinality(
  value: unknown,
  field: Pick<SchemaFieldDescriptor, 'kind' | 'cardinality'> | undefined,
): unknown {
  if (value === null || value === undefined) return value;
  const targetIsMany = field?.cardinality === 'many';
  if (targetIsMany && !Array.isArray(value)) return [value];
  if (!targetIsMany && Array.isArray(value)) {
    if (field?.kind === 'json') return value;
    return value
      .filter((v) => v !== null && v !== undefined)
      .map((v) => String(v))
      .join(', ');
  }
  return value;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== (b as unknown[]).length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], (b as unknown[])[i])) return false;
    }
    return true;
  }
  const aKeys = Object.keys(a as object);
  const bKeys = Object.keys(b as object);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) {
      return false;
    }
  }
  return true;
}

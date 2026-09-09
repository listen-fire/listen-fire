// The scope serialize / rehydrate seam (async user interaction §4.1, §4.6).
//
// A parked movement run survives a process boundary for days. Its scope — the
// `Binding`s feeding the parked `ask` — is ALMOST entirely plain data; the live
// refs are a small closed set. `serializeBinding` turns a live `Binding` into a
// plain-JSON descriptor (a tagged variant per binding kind); `rehydrateBinding`
// rebuilds the live `Binding` from a descriptor + a rehydration context that
// re-resolves the live refs. The two are inverse modulo live refs (an adapter is
// re-resolved, a FileRef's `retrieve()` rebound, an instance schema re-fetched,
// code refs taken from the re-parsed AST).
//
// The three buckets (§4.1):
//   1. Pure data — serialise as-is: `event`, `value`, `handle`,
//      `extractRoot`/`extractPosition` (the materialised emission — the extraction
//      RAN, its output is data, never re-run), the data half of `sourcePosition`
//      (`SourcePosition` + `edgeProperties`), `shapePosition`.
//   2. A live ref behind a serialisable identity — rebind on rehydrate: the
//      adapter inside `instance` and `sourcePosition.read` (re-resolved by
//      slug+creds via the registry; `edgeFieldId` re-derived; the instance schema
//      RE-FETCHED live, never serialised), and the `retrieve()` closure inside a
//      `resource`'s FileRef (rebound via the FileRef-revive pattern — `source`).
//   3. Code refs — NOT serialised, re-resolved from the re-parsed (version-pinned)
//      program: `shape` declarations, `movement` callables, `opaque` imports. By
//      name against the rehydration context's code resolver. `blockMeta` and
//      `positions` are recursive (their contained bindings serialise per these
//      rules). A `closure` carries its BODY as AST — it has no name to
//      re-resolve by — plus its capture, recursively.
//
// Guard: a `value` binding's payload is `unknown`. The seam asserts it is
// JSON-serialisable at the boundary, so a non-serialisable value fails LOUD at
// park (never corrupts the parked scope).
//
// This module is pure: all DB / registry / FileRef access stays behind the
// injected `RehydrationContext`, exactly as the interpreter keeps `resolveAdapter`
// / `parkSink` behind seams.

import type { ClosureExpression, NodeLiteral, PathHead } from 'movement-lang';
import type { FileRef, Resource } from '../translation_graph/adapter';
import type { SourcePosition } from '../translation_graph/types';
import type { ExtractEmission } from './extraction';
import type {
  Binding,
  DeferredWalk,
  Environment,
  HandleGraph,
  NodeEdge,
  SourceRead,
  WriteRecord,
} from './expression';
import type { Provenance } from './provenance';
import { MovementEngineError } from './errors';

// ── The descriptor (plain JSON) ──────────────────────────────────────────────

/**
 * A serialised instance identity — the construction-free facts the registry
 * re-resolves a live adapter from. The `schema` is deliberately ABSENT: an
 * instance represents a live system, so its schema is RE-FETCHED on rehydrate
 * (honest drift if the external schema changed — §4.1 decision).
 */
export interface InstanceIdentityDescriptor {
  name: string;
  adapterSlug: string;
  credentialName?: string;
  constructionConfig?: Record<string, string>;
}

/** The serialised `SourceRead` — just the instance identity behind it. The live
 *  `adapter` + the `edgeFieldId` closure are rebound from `instanceName` on
 *  rehydrate. */
export interface SourceReadDescriptor {
  instanceName: string;
}

/** A wire FileRef: metadata + the owner-resolvable `source` handle, no closure.
 *  Rehydrate rebinds `retrieve()` from `source` (the FileRef-revive pattern). */
export interface FileRefDescriptor {
  name?: string;
  contentType?: string;
  size?: number;
  source?: { ownerAdapterType: string; handle: string };
}

/** A serialised `ExtractEmission` — its `children` Map flattened to a record of
 *  arrays (JSON has no Map). The emission is pure data (the extraction ran). */
export interface ExtractEmissionDescriptor {
  nodeName: string;
  fields: Record<string, unknown>;
  provenance: ExtractEmission['provenance'];
  origin?: ExtractEmission['origin'];
  /** Layer-5 source resources — `fileRef` closures stripped to descriptors
   *  (Bucket 2), revived through the seam on rehydrate. */
  resources: ResourceDescriptor[];
  children: Record<string, ExtractEmissionDescriptor[]>;
}

export type BindingDescriptor =
  | { kind: 'event' }
  | { kind: 'instance'; instance: InstanceIdentityDescriptor }
  | { kind: 'handle'; handle: WriteRecord; targetType: string; graph: HandleGraphDescriptor }
  | { kind: 'extractRoot'; emission: ExtractEmissionDescriptor }
  | { kind: 'extractPosition'; emission: ExtractEmissionDescriptor }
  | {
      kind: 'sourcePosition';
      position: SourcePosition;
      edgeProperties?: Record<string, unknown>;
      read?: SourceReadDescriptor;
    }
  | { kind: 'resource'; resource: ResourceDescriptor }
  | { kind: 'blockMeta'; edges: Record<string, BindingDescriptor[]>; plural?: true }
  /** Bucket 3 (recursive) — a block's returned landings. */
  | { kind: 'positions'; landings: BindingDescriptor[] }
  | { kind: 'tuple'; slots: BindingDescriptor[] }
  /**
   * Bucket 3 (recursive) — a closure. Its BODY rides across as AST, exactly as
   * a deferred walk's head does: the version pin makes it byte-identical on the
   * other side, and re-deriving it from a name would need the closure to have
   * one. Its capture serialises by the ordinary rules.
   */
  | { kind: 'closure'; closure: ClosureExpression; captured: Record<string, BindingDescriptor> }
  | { kind: 'value'; value: unknown; provenance?: Provenance }
  /** Bucket 1 — a minted callback is pure data: its id, its link, its fire-time
   *  signature. The CALLS are deliberately NOT here (they arrive after the park
   *  and are read live from the store), and neither is the body (it is code, at
   *  the address the store row names). */
  | {
      kind: 'callback';
      callbackId: string;
      url: string;
      params: Extract<Binding, { kind: 'callback' }>['params'];
    }
  // Bucket 3 — code refs carry ONLY the re-resolution tag (the name). The live
  // declaration / fileEnv comes from the re-parsed program.
  | { kind: 'shape'; name: string }
  | { kind: 'movement'; name: string }
  | { kind: 'shapePosition'; shape: string; node: string; fields: Record<string, unknown>; fieldProvenance: Extract<Binding, { kind: 'shapePosition' }>['fieldProvenance'] }
  /** Bucket 3 (recursive) — a synthesised node. Its entry VALUES are already
   *  data; each edge is either landings (bindings, serialised like a
   *  meta-node's) or a deferred WALK. */
  | {
      kind: 'nodePosition';
      fields: Record<string, unknown>;
      fieldProvenance: Extract<Binding, { kind: 'nodePosition' }>['fieldProvenance'];
      edges: Record<string, NodeEdgeDescriptor>;
    }
  /** Bucket 3 (recursive) — a stored, unrun traversal. */
  | { kind: 'lazyWalk'; walk: DeferredWalkDescriptor }
  | { kind: 'opaque'; what: string; name: string };

export type NodeEdgeDescriptor =
  | { kind: 'landed'; landings: BindingDescriptor[] }
  | { kind: 'deferred'; walk: DeferredWalkDescriptor };

/**
 * A stored walk, serialised: the traversal's own text plus the scope it
 * captured, each captured binding serialised by the ordinary rules — and its
 * per-item `mapping`, which is AST and rides across as itself.
 *
 * The LANDINGS are deliberately not here, mapped or not. A lazy walk has none
 * until something reads it, and re-walking after a resume is the CORRECT
 * answer, not a concession: a run that parked for a day and woke should see the
 * source as it is now (layer 8 ruling 3 — every read re-walks; there is no
 * cache to preserve across a park either). What parks is the RECIPE — the walk
 * and the renaming — never anything either produced.
 */
export interface DeferredWalkDescriptor {
  head: PathHead;
  captured: Record<string, BindingDescriptor>;
  mapping?: NodeLiteral;
}

/** The `HandleGraph` serialised — its `instance` is an instance identity
 *  (Bucket 2), re-resolved on rehydrate. */
export type HandleGraphDescriptor = {
  kind: 'instance';
  instance: InstanceIdentityDescriptor;
};

/** A serialised `Resource` — every field is plain data except `fileRef`, whose
 *  closure is stripped to a `FileRefDescriptor` (Bucket 2). */
export type ResourceDescriptor = Omit<Resource, 'fileRef'> & { fileRef?: FileRefDescriptor };

// ── The rehydration context (chunk 5 passes this in) ──────────────────────────

/**
 * The seams `rehydrateBinding` rebinds live refs through. Mirrors the
 * interpreter's own injected seams (`resolveAdapter`, `parkSink`): the pure
 * function never touches the DB / registry / AST directly.
 */
export interface RehydrationContext {
  /**
   * Re-resolve a live instance: the registry yields the adapter (by slug +
   * credential), and the instance schema is RE-FETCHED live (never serialised).
   * Returns the live `instance` binding chunk 5 binds back into scope.
   */
  resolveInstance(identity: InstanceIdentityDescriptor): Promise<Extract<Binding, { kind: 'instance' }>>;
  /**
   * The live read seam for a named instance — the same `SourceRead`
   * the interpreter threads onto positions: the re-resolved adapter +
   * re-derived `edgeFieldId`. Used to rebind `sourcePosition.read`.
   */
  resolveSourceRead(instanceName: string): Promise<SourceRead>;
  /**
   * Rebind a wire FileRef's `retrieve()` from its `source` handle — the owner
   * adapter's `resolveFileRef`, or the document store for `FILE()` artifacts
   * (the same pattern `reviveFileRefs` uses across the wire).
   */
  reviveFileRef(descriptor: FileRefDescriptor): FileRef;
  /**
   * Re-resolve a code ref (`shape` / `movement` / `opaque` import) by name
   * against the re-parsed program's environment — the version pin (P11) makes
   * the AST byte-identical, so the name resolves to an equivalent declaration.
   */
  resolveCodeRef(name: string): Binding;
}

// ── JSON-serialisability guard (the `value` boundary, §4.1) ───────────────────

/**
 * Assert a `value` binding's payload survives a JSON round-trip. A
 * non-serialisable value (a closure, a `Date` that wouldn't revive, a `Map`)
 * would silently corrupt the parked scope — so we fail LOUD at park instead.
 * Returns the round-tripped value (so the descriptor holds exactly what will
 * come back, not a richer in-memory form that drifts on rehydrate).
 */
export function assertJsonSerializable(value: unknown, where: string): unknown {
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch (e) {
    throw new MovementEngineError(
      'MOVENG_PARK_NONSERIALIZABLE',
      `${where}: value is not JSON-serialisable (${(e as Error).message}) — a parked scope must be durable.`,
    );
  }
  if (json === undefined) {
    // JSON.stringify(undefined) / a bare function returns undefined.
    if (value === undefined) return undefined;
    throw new MovementEngineError(
      'MOVENG_PARK_NONSERIALIZABLE',
      `${where}: value is not JSON-serialisable (it stringifies to undefined) — a parked scope must be durable.`,
    );
  }
  return JSON.parse(json);
}

// ── Serialize ─────────────────────────────────────────────────────────────────

function serializeInstanceIdentity(
  instance: Extract<Binding, { kind: 'instance' }>,
): InstanceIdentityDescriptor {
  return {
    name: instance.name,
    adapterSlug: instance.adapterSlug,
    ...(instance.credentialName !== undefined ? { credentialName: instance.credentialName } : {}),
    ...(instance.constructionConfig !== undefined
      ? { constructionConfig: instance.constructionConfig }
      : {}),
  };
}

function serializeHandleGraph(graph: HandleGraph): HandleGraphDescriptor {
  return { kind: 'instance', instance: serializeInstanceIdentity(graph.instance) };
}

function serializeEmission(emission: ExtractEmission): ExtractEmissionDescriptor {
  const children: Record<string, ExtractEmissionDescriptor[]> = {};
  for (const [edge, kids] of emission.children) {
    children[edge] = kids.map(serializeEmission);
  }
  return {
    nodeName: emission.nodeName,
    fields: emission.fields,
    provenance: emission.provenance,
    ...(emission.origin !== undefined ? { origin: emission.origin } : {}),
    resources: emission.resources.map(serializeResource),
    children,
  };
}

function serializeFileRef(ref: FileRef): FileRefDescriptor {
  return {
    ...(ref.name !== undefined ? { name: ref.name } : {}),
    ...(ref.contentType !== undefined ? { contentType: ref.contentType } : {}),
    ...(ref.size !== undefined ? { size: ref.size } : {}),
    ...(ref.source !== undefined ? { source: ref.source } : {}),
  };
}

function serializeResource(resource: Resource): ResourceDescriptor {
  const { fileRef, ...rest } = resource;
  return {
    ...rest,
    ...(fileRef !== undefined ? { fileRef: serializeFileRef(fileRef) } : {}),
  };
}

/**
 * Serialise one `Binding` to a plain-JSON descriptor. Bucket 1 copies data,
 * Bucket 2 strips the live ref to its serialisable identity, Bucket 3 keeps
 * only the code ref's name. Exhaustive over every binding kind (a new one is a
 * compile error at the `default`).
 */
export function serializeBinding(binding: Binding): BindingDescriptor {
  switch (binding.kind) {
    // ── Bucket 1 — pure data ──
    case 'event':
      return { kind: 'event' };
    case 'handle':
      return {
        kind: 'handle',
        handle: binding.handle,
        targetType: binding.targetType,
        graph: serializeHandleGraph(binding.graph),
      };
    case 'extractRoot':
      return { kind: 'extractRoot', emission: serializeEmission(binding.emission) };
    case 'extractPosition':
      return { kind: 'extractPosition', emission: serializeEmission(binding.emission) };
    case 'sourcePosition':
      return {
        kind: 'sourcePosition',
        position: binding.position,
        ...(binding.edgeProperties !== undefined ? { edgeProperties: binding.edgeProperties } : {}),
        // Bucket 2: keep only the read's instance identity; the live adapter +
        // edgeFieldId are rebound on rehydrate.
        ...(binding.read !== undefined ? { read: { instanceName: binding.read.instanceName } } : {}),
      };
    case 'shapePosition':
      return {
        kind: 'shapePosition',
        shape: binding.shape,
        node: binding.node,
        fields: binding.fields,
        fieldProvenance: binding.fieldProvenance,
      };
    case 'nodePosition': {
      const edges: Record<string, NodeEdgeDescriptor> = {};
      for (const [name, edge] of Object.entries(binding.edges)) {
        edges[name] =
          edge.kind === 'landed'
            ? { kind: 'landed', landings: edge.landings.map(serializeBinding) }
            : { kind: 'deferred', walk: serializeDeferredWalk(edge.walk) };
      }
      return {
        kind: 'nodePosition',
        fields: binding.fields,
        fieldProvenance: binding.fieldProvenance,
        edges,
      };
    }
    case 'lazyWalk':
      return { kind: 'lazyWalk', walk: serializeDeferredWalk(binding.walk) };
    case 'callback':
      return {
        kind: 'callback',
        callbackId: binding.callbackId,
        url: binding.url,
        params: binding.params,
      };
    // ── Bucket 2 — live ref behind a serialisable identity ──
    case 'instance':
      return { kind: 'instance', instance: serializeInstanceIdentity(binding) };
    case 'resource':
      return { kind: 'resource', resource: serializeResource(binding.resource) };
    // ── Bucket 1 (value) — with the JSON guard ──
    case 'value':
      return {
        kind: 'value',
        value: assertJsonSerializable(binding.value, 'value binding'),
        ...(binding.provenance !== undefined ? { provenance: binding.provenance } : {}),
      };
    // ── Bucket 3 — code refs (name only; re-resolved from the re-parsed AST) ──
    case 'shape':
      return { kind: 'shape', name: binding.declaration.name };
    case 'movement':
      return { kind: 'movement', name: binding.declaration.name };
    case 'opaque':
      // An import. `what` is the descriptive label; the binding has no stored
      // name, so re-resolution is by the descriptor's tag — opaque imports are
      // re-derived from the AST like other code refs (keyed by the slot name,
      // supplied by the scope serialiser). We keep `what` for fidelity and a
      // placeholder name; the scope walk overrides `name` with the slot key.
      return { kind: 'opaque', what: binding.what, name: '' };
    case 'positions':
      return { kind: 'positions', landings: binding.landings.map(serializeBinding) };
    case 'tuple':
      return { kind: 'tuple', slots: binding.slots.map(serializeBinding) };
    case 'closure': {
      const captured: Record<string, BindingDescriptor> = {};
      for (const [name, entry] of binding.captured) {
        const descriptor = serializeBinding(entry);
        captured[name] = descriptor.kind === 'opaque' ? { ...descriptor, name } : descriptor;
      }
      return { kind: 'closure', closure: binding.closure, captured };
    }
    // ── Bucket 3 (recursive) — block meta-node ──
    case 'blockMeta': {
      const edges: Record<string, BindingDescriptor[]> = {};
      for (const [name, bindings] of binding.edges) {
        edges[name] = bindings.map(serializeBinding);
      }
      return { kind: 'blockMeta', edges, ...(binding.plural === true ? { plural: true } : {}) };
    }
    default:
      return assertNever(binding);
  }
}

// ── Rehydrate ─────────────────────────────────────────────────────────────────

function rehydrateEmission(
  descriptor: ExtractEmissionDescriptor,
  ctx: RehydrationContext,
): ExtractEmission {
  const children = new Map<string, ExtractEmission[]>();
  for (const [edge, kids] of Object.entries(descriptor.children)) {
    children.set(edge, kids.map((k) => rehydrateEmission(k, ctx)));
  }
  return {
    nodeName: descriptor.nodeName,
    fields: descriptor.fields,
    provenance: descriptor.provenance,
    ...(descriptor.origin !== undefined ? { origin: descriptor.origin } : {}),
    resources: (descriptor.resources ?? []).map((r) => rehydrateResource(r, ctx)),
    children,
  };
}

async function rehydrateHandleGraph(
  graph: HandleGraphDescriptor,
  ctx: RehydrationContext,
): Promise<HandleGraph> {
  return { kind: 'instance', instance: await ctx.resolveInstance(graph.instance) };
}

function rehydrateResource(descriptor: ResourceDescriptor, ctx: RehydrationContext): Resource {
  const { fileRef, ...rest } = descriptor;
  return {
    ...rest,
    ...(fileRef !== undefined ? { fileRef: ctx.reviveFileRef(fileRef) } : {}),
  };
}

function serializeDeferredWalk(walk: DeferredWalk): DeferredWalkDescriptor {
  const captured: Record<string, BindingDescriptor> = {};
  for (const [name, binding] of walk.captured) {
    const descriptor = serializeBinding(binding);
    captured[name] = descriptor.kind === 'opaque' ? { ...descriptor, name } : descriptor;
  }
  return { head: walk.head, captured, ...(walk.mapping ? { mapping: walk.mapping } : {}) };
}

async function rehydrateDeferredWalk(
  descriptor: DeferredWalkDescriptor,
  ctx: RehydrationContext,
): Promise<DeferredWalk> {
  const captured = new Map<string, Binding>();
  for (const [name, entry] of Object.entries(descriptor.captured)) {
    captured.set(name, await rehydrateBinding(entry, ctx));
  }
  return {
    head: descriptor.head,
    captured,
    ...(descriptor.mapping ? { mapping: descriptor.mapping } : {}),
  };
}

/**
 * Rebuild a live `Binding` from a descriptor. Bucket 1 returns the data as-is,
 * Bucket 2 rebinds the live ref through the context (registry / FileRef-revive),
 * Bucket 3 takes the code ref from the re-parsed program. Async because Bucket-2
 * adapter re-resolution + live schema re-fetch hit the registry.
 */
export async function rehydrateBinding(
  descriptor: BindingDescriptor,
  ctx: RehydrationContext,
): Promise<Binding> {
  switch (descriptor.kind) {
    // ── Bucket 1 — pure data ──
    case 'event':
      return { kind: 'event' };
    case 'handle':
      return {
        kind: 'handle',
        handle: descriptor.handle,
        targetType: descriptor.targetType,
        graph: await rehydrateHandleGraph(descriptor.graph, ctx),
      };
    case 'extractRoot':
      return { kind: 'extractRoot', emission: rehydrateEmission(descriptor.emission, ctx) };
    case 'extractPosition':
      return { kind: 'extractPosition', emission: rehydrateEmission(descriptor.emission, ctx) };
    case 'sourcePosition':
      return {
        kind: 'sourcePosition',
        position: descriptor.position,
        ...(descriptor.edgeProperties !== undefined ? { edgeProperties: descriptor.edgeProperties } : {}),
        ...(descriptor.read !== undefined
          ? { read: await ctx.resolveSourceRead(descriptor.read.instanceName) }
          : {}),
      };
    case 'shapePosition':
      return {
        kind: 'shapePosition',
        shape: descriptor.shape,
        node: descriptor.node,
        fields: descriptor.fields,
        fieldProvenance: descriptor.fieldProvenance,
      };
    case 'nodePosition': {
      const edges: Record<string, NodeEdge> = {};
      for (const [name, edge] of Object.entries(descriptor.edges)) {
        edges[name] =
          edge.kind === 'landed'
            ? {
                kind: 'landed',
                landings: await Promise.all(edge.landings.map((l) => rehydrateBinding(l, ctx))),
              }
            : { kind: 'deferred', walk: await rehydrateDeferredWalk(edge.walk, ctx) };
      }
      return {
        kind: 'nodePosition',
        fields: descriptor.fields,
        fieldProvenance: descriptor.fieldProvenance,
        edges,
      };
    }
    case 'lazyWalk':
      return { kind: 'lazyWalk', walk: await rehydrateDeferredWalk(descriptor.walk, ctx) };
    case 'value':
      return {
        kind: 'value',
        value: descriptor.value,
        ...(descriptor.provenance !== undefined ? { provenance: descriptor.provenance } : {}),
      };
    case 'callback':
      return {
        kind: 'callback',
        callbackId: descriptor.callbackId,
        url: descriptor.url,
        params: descriptor.params,
      };
    // ── Bucket 2 — live ref ──
    case 'instance':
      return ctx.resolveInstance(descriptor.instance);
    case 'resource':
      return { kind: 'resource', resource: rehydrateResource(descriptor.resource, ctx) };
    // ── Bucket 3 — code refs from the re-parsed program ──
    case 'shape':
    case 'movement':
    case 'opaque':
      return ctx.resolveCodeRef(descriptor.name);
    case 'positions':
      return {
        kind: 'positions',
        landings: await Promise.all(
          descriptor.landings.map((l) => rehydrateBinding(l, ctx)),
        ),
      };
    case 'tuple':
      return {
        kind: 'tuple',
        slots: await Promise.all(descriptor.slots.map((slot) => rehydrateBinding(slot, ctx))),
      };
    case 'closure': {
      const captured = new Map<string, Binding>();
      for (const [name, entry] of Object.entries(descriptor.captured)) {
        captured.set(name, await rehydrateBinding(entry, ctx));
      }
      return { kind: 'closure', closure: descriptor.closure, captured };
    }
    // ── Bucket 3 (recursive) ──
    case 'blockMeta': {
      const edges = new Map<string, Binding[]>();
      for (const [name, descriptors] of Object.entries(descriptor.edges)) {
        edges.set(name, await Promise.all(descriptors.map((d) => rehydrateBinding(d, ctx))));
      }
      return {
        kind: 'blockMeta',
        edges,
        ...(descriptor.plural === true ? { plural: true } : {}),
      };
    }
    default:
      return assertNever(descriptor);
  }
}

// ── Scope serialisation (§4.6) ────────────────────────────────────────────────

/**
 * A serialised scope-node: the bindings declared in ONE lexical scope, keyed by
 * name. For the single-ask linear body (the only case that parks today) the
 * parked state is one chain of these from the movement body's root scope to the
 * ask's scope — §4.6's "the bindings feeding the parked ask". The multi-leaf
 * shared-ancestor frontier (fan-out, chunk 3.2) keys these by address-prefix; a
 * single chain is the degenerate one-branch case, so the shape generalises.
 */
export interface SerializedScope {
  bindings: Record<string, BindingDescriptor>;
}

/**
 * The full parked-run state (§4.6) — what `parked_run.state` holds. Versioned so
 * chunk 5's resume + chunk 3.2's multi-leaf can evolve the shape compatibly. The
 * `scopeChain` is root-first: index 0 is the movement body's own scope, the last
 * entry is the ask's immediate scope. Resume rebuilds the `Environment` chain by
 * rehydrating each scope in order, chaining child envs (4.1 / §4.6).
 */
export interface ParkedScopeState {
  /** Schema version of this state blob. */
  version: 1;
  /** The parked ask's canonical lexical address (§4.3) — the resume entry point. */
  address: string;
  /** The ask's binding name (`a = ask …`), so resume binds the answer back. Null
   *  for a value-less ask. */
  bindingName: string | null;
  /**
   * A PRESENCE-marker bind (asks-as-adapter chunk C): `expired = await sleep(2d)`
   * binds nothing of value, but the completed branch must escape `expired` onto
   * the race receipt as an edge (`r-[:expired]->`, S4). When set, the timer
   * resume declares `bindingName` as a presence value (`true`) at wake, so the
   * binding survives the park with no injected answer. Absent for an ordinary
   * value-less sleep (which binds nothing at all). */
  presenceBind?: boolean;
  /**
   * An `await until(…)` recurring-clock park (asks-as-adapter chunk D, F12). A
   * timer park (`park_reason='timer'`) whose resume RE-ENTERS the `until`
   * statement (`reenter=true`) to RE-EVALUATE the condition rather than stepping
   * past it: unmet ⇒ it re-parks at the same address with a fresh `wake_at`
   * (re-armed); met ⇒ it binds and continues. The timer-resume worker reads this
   * flag to choose re-enter over step-past, and to leave a re-armed leaf alone. */
  until?: boolean;
  /** Root-first chain of lexical scopes feeding the ask (§4.6). */
  scopeChain: SerializedScope[];
}

/**
 * Serialise one `Environment`'s OWN bindings (no parent walk) to a scope-node.
 * The interpreter declares the imported / constructed / read bindings into the
 * env as it descends; this captures exactly what THIS scope added.
 */
export function serializeScope(env: Environment): SerializedScope {
  const bindings: Record<string, BindingDescriptor> = {};
  for (const [name, binding] of env.ownBindings()) {
    const descriptor = serializeBinding(binding);
    // An opaque import's re-resolution tag is its slot NAME (it has no stored
    // declaration name); patch it in here where the name is known.
    bindings[name] = descriptor.kind === 'opaque' ? { ...descriptor, name } : descriptor;
  }
  return { bindings };
}

/**
 * Serialise the scope CHAIN from the movement body's root env down to (and
 * including) the ask's immediate env. `chain` is root-first; the interpreter
 * hands it the live env stack at the park point. Shared ancestor scopes are
 * serialised once because they appear once in the chain (§4.6) — the multi-leaf
 * frontier keys them by prefix instead, a superset of this single-branch shape.
 */
export function serializeScopeChain(chain: Environment[]): SerializedScope[] {
  return chain.map(serializeScope);
}

// ── Exhaustiveness ────────────────────────────────────────────────────────────

function assertNever(value: never): never {
  throw new MovementEngineError(
    'MOVENG_PARK_NONSERIALIZABLE',
    `unhandled binding kind in scope serialisation: ${JSON.stringify(value)}`,
  );
}

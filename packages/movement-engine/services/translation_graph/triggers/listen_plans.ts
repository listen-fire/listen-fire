// A program's standing listens, as its check answers them (one plan per
// `listen to <traversal> fire f`), whether an arrival fires one, whether what
// landed fits the node a listen states it is, and the pipeline each is named
// by. The judge, the landing check and a plan's identity are the engine's
// own (crates/movement-engine/src/listen_judge.rs, listen_landing.rs,
// crates/movement-parser/src/listen_plan.rs), reached through the wasm, so
// this host and listen-fire decide every arrival alike
// (engine-contracts/conformance/listen-arrivals.json, listen-landings.json)
// and name every listen alike (conformance/listen-pipelines.json).

import { createHash } from 'node:crypto';

import { lastEdgeOf, listenPlanSchema, verdictSchema } from 'engine-contracts';
import { RUN_HOST_UNITS, callJudgeArrival, callLandingMisfits, callLandingNode, callListenIdentity, entryPositionKeyOf, instanceSchemaKey, unwrapCredentialArg } from 'movement-lang';
import { z } from 'zod';

import type { ArrivedRecord, Arrival, AwaitLanding, ListenPlan, PlanArrival, TriggerEvent, Verdict } from 'engine-contracts';
import type { AdapterSnapshot, CheckAnswer, ImportStatement, InstanceSchema, Program } from 'movement-lang';

import { listenHearsCredential } from './listen_config';

/** The connection a listen's instance is: its module, the credential its
 *  construction names (by its imported name) and its other arguments. */
export interface ListenConstruction {
  adapter: string;
  credentialName?: string;
  constructionArgs?: Record<string, string>;
}

/**
 * Each connection `program` makes, by the instance's name, as a listen on it
 * is routed: the adapter (import alias resolved), the credential and the
 * other arguments, raw. A run host unit (`manual`) the file does not bind
 * itself is the host's own, credential-free and argument-free. Undefined for
 * a name that is neither: the checker refuses a listen on one.
 */
export function listenConstructionsOf(program: Program): (instance: string) => ListenConstruction | undefined {
  const importOriginals = new Map<string, string>();
  const imported = new Set<string>();
  const constructions = new Map<string, ListenConstruction>();

  const recordImports = (statement: ImportStatement): void => {
    for (const { name, alias } of statement.names) {
      if (alias !== undefined) importOriginals.set(alias, name);
      imported.add(alias ?? name);
    }
  };
  const original = (local: string): string => importOriginals.get(local) ?? local;

  // Every import first, wherever it is written, as listen-fire reads them
  // (crates/lf/src/routing.rs `import_originals`): the credential a
  // construction names is part of its listens' pipeline names.
  for (const statement of program.statements) {
    if (statement.kind === 'import') recordImports(statement);
  }
  for (const statement of program.statements) {
    if (statement.kind === 'assign' && statement.value.kind === 'construct') {
      const construct = statement.value.construct;
      const credentialRaw = construct.args.find((a) => a.name === 'credentials')?.value.raw.trim();
      const credentialName = credentialRaw !== undefined ? unwrapCredentialArg(credentialRaw) : null;
      // The non-credential args, raw — the entry position a listen's address
      // is relative to.
      const constructionArgs: Record<string, string> = {};
      for (const arg of construct.args) {
        if (arg.name === 'credentials') continue;
        constructionArgs[arg.name] = arg.value.raw;
      }
      constructions.set(statement.name, {
        adapter: original(construct.callee),
        ...(credentialName !== null ? { credentialName: original(credentialName) } : {}),
        ...(Object.keys(constructionArgs).length > 0 ? { constructionArgs } : {}),
      });
    }
  }
  return (instance) => constructions.get(instance) ?? (RUN_HOST_UNITS.includes(instance) && !imported.has(instance) ? { adapter: instance } : undefined);
}

/** The plans a check answer carries (`listens`); none when it carries none. */
export function listenPlansOf(answer: unknown): ListenPlan[] {
  if (answer === null || typeof answer !== 'object' || !('listens' in answer) || answer.listens === undefined) return [];
  return listenPlanSchema.array().parse(answer.listens);
}

/** Whether `arrival` fires the listen `plan` describes, `nowMs` (epoch ms)
 *  the instant WITHIN measures from. An undecided verdict runs nothing; the
 *  host logs its reason. */
export function judgeArrival(plan: ListenPlan, arrival: PlanArrival, nowMs: number): Verdict {
  const reply = callJudgeArrival(JSON.stringify({ plan, arrival, nowMs }));
  if (!reply.ok) throw new Error(`the listen judge refused its input: ${JSON.stringify(reply.json)}`);
  return verdictSchema.parse(reply.json);
}

const landingMisfitsSchema = z.object({ node: z.string(), misfits: z.array(z.string()) }).strict();

/** The node a listen states its landing is, as the engine read it from a
 *  program (`landingNode`): its shape is the engine's, handed back as it came. */
export interface DeclaredNode {
  readonly declared: unknown;
}

/** `node`, the node a listen states its landing is (`-[:Requests]-><Payment>`),
 *  as the single file `source` declares it, read once: `landingMisfits`
 *  checks each arrival against it without reading the program again. Throws
 *  for a source that does not parse or declares no such node. */
export function landingNode(input: { source: string; node: string }): DeclaredNode {
  const reply = callLandingNode(JSON.stringify(input));
  if (!reply.ok) throw new Error(`the landing check refused its input: ${JSON.stringify(reply.json)}`);
  return z.object({ declared: z.unknown() }).strict().parse(reply.json);
}

/** What of `landing` (an arrival's record's fields) does not fit `node`,
 *  the node a listen states its landing is (`-[:Requests]-><Payment>`), as
 *  the single file `source` declares it, or as `landingNode` read it: the
 *  node's name as the lines name it, and one line per misfit, none when it
 *  fits. An arrival that misfits runs nothing, as listen-fire has it. */
export function landingMisfits(input: ({ source: string; node: string } | DeclaredNode) & { landing: unknown }): z.infer<typeof landingMisfitsSchema> {
  const reply = callLandingMisfits(JSON.stringify(input));
  if (!reply.ok) throw new Error(`the landing check refused its input: ${JSON.stringify(reply.json)}`);
  return landingMisfitsSchema.parse(reply.json);
}

/** What makes two listens one (`ListenPlan::identity`): the plan, its hops'
 *  aliases read as their places, without the lane's name. */
export function listenIdentity(plan: ListenPlan): string {
  const reply = callListenIdentity(JSON.stringify(plan));
  const identity: unknown = reply.ok && typeof reply.json === 'object' && reply.json !== null ? Reflect.get(reply.json, 'identity') : undefined;
  if (typeof identity !== 'string') throw new Error(`a plan's identity was refused: ${JSON.stringify(reply.json)}`);
  return identity;
}

/**
 * The pipeline a listen on a traversal is named by, its receipts and an
 * arrival's `notFor` with it: `listen:<file>:<movement>:<digest>`, the digest
 * the first 8 hex digits of the sha256 of its identity and of its
 * connection's construction (the credential and the other arguments), so one
 * whose connection is made otherwise is another listen. listen-fire names
 * the same listen the same (crates/lf/src/routing.rs `Listen::pipeline`).
 */
export function listenPipeline(input: { file: string; plan: ListenPlan; credentialName?: string; constructionArgs?: Readonly<Record<string, string>> }): string {
  // Sorted as Rust sorts its strings: by their UTF-8 bytes.
  const args = Object.entries(input.constructionArgs ?? {}).sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const construction = JSON.stringify({ args, credential: input.credentialName ?? null });
  const digest = createHash('sha256').update(`${listenIdentity(input.plan)}\n${construction}`).digest('hex').slice(0, 8);
  return `listen:${input.file}:${input.plan.movement}:${digest}`;
}

/** A saved listen on a traversal as a host routes it: its plan, its
 *  pipeline, and the credential its connection is made with (by the name
 *  the program imports it by). */
export interface PlannedListen {
  plan: ListenPlan;
  pipeline: string;
  credentialName?: string;
  /** Its construction's other arguments, raw: the entry position it pins. */
  constructionArgs?: Record<string, string>;
}

/** Each of `plans` (the check's of `program`, the file `file`) with its
 *  connection's construction read from the program. */
export function plannedListensOf(input: { file: string; program: Program; plans: readonly ListenPlan[] }): PlannedListen[] {
  const constructionOf = listenConstructionsOf(input.program);
  return input.plans.map((plan) => {
    const construction = constructionOf(plan.connection);
    // The checker plans no listen on a name that is no connection.
    if (construction === undefined) throw new Error(`${input.file}: the listen that fires ${plan.movement} is on \`${plan.connection}\`, which is no connection the file makes`);
    const { credentialName, constructionArgs } = construction;
    return {
      plan,
      pipeline: listenPipeline({ file: input.file, plan, ...(credentialName !== undefined ? { credentialName } : {}), ...(constructionArgs !== undefined ? { constructionArgs } : {}) }),
      ...(credentialName !== undefined ? { credentialName } : {}),
      ...(constructionArgs !== undefined ? { constructionArgs } : {}),
    };
  });
}

/**
 * Whether `arrival`, delivered by a module of `delivery.adapterType` for the
 * connection `delivery.credentialName` (absent: the module's install, which
 * serves every connection), fires `listen` at `nowMs`, as the judge finds its
 * filters. Null when the arrival is not this listen's to judge: it says the
 * record went; it is on another module or another edge than the listen's
 * last; it came for another connection (`listenHearsCredential`); or it is
 * marked for this listen's own sake (`notFor` its pipeline). An Undecided
 * verdict runs nothing, and the host says why.
 */
export function listenFires(listen: PlannedListen, arrival: Arrival, delivery: { adapterType: string; credentialName?: string }, nowMs: number): Verdict | null {
  const { plan } = listen;
  if ('gone' in arrival || plan.adapter !== delivery.adapterType || lastEdgeOf(plan) !== arrival.edge) return null;
  if (!listenHearsCredential(listen.credentialName, delivery.credentialName) || arrival.notFor === listen.pipeline) return null;
  return judgeArrival(
    plan,
    {
      edge: arrival.edge,
      ...(arrival.key !== undefined ? { key: arrival.key } : {}),
      landing: arrivedRecord(arrival.landing),
      ...(arrival.parents !== undefined ? { parents: arrival.parents.map((parent) => (parent === null ? null : arrivedRecord(parent))) } : {}),
      ...(arrival.takenApplied === true ? { takenApplied: true } : {}),
    },
    nowMs,
  );
}

/**
 * A record's `fields` as a program reads them, by name: each field the
 * catalog names otherwise than its module keys it (`fieldIds`, the
 * position's: name → id) takes the value its id holds, as a run reading it
 * through the module does; the rest of the record is kept as it came. A host
 * hands the judge each record so named (listen-fire's Rust `named_fields`,
 * held by both to engine-contracts/conformance/listen-field-names.json).
 */
export function namedFields(fields: Readonly<Record<string, unknown>>, fieldIds: Readonly<Record<string, string>>): Record<string, unknown> {
  const named: Record<string, unknown> = { ...fields };
  for (const [name, id] of Object.entries(fieldIds)) {
    if (Object.hasOwn(fields, id)) named[name] = fields[id];
  }
  return named;
}

/** Each record type's `fieldIds` in one connection's schema, by the record
 *  type's name: what `namedArrival` reads an arrival's records by. */
export type FieldIdsByType = Readonly<Record<string, Readonly<Record<string, string>>>>;

/** The `fieldIds` of each record type `schema` (a connection's, from the
 *  catalog) positions. */
/** The schema of `listen`'s connection among its module's, as the checker
 *  instantiates it from its construction (listen-fire's `field_ids_of`): its
 *  credential's schema at the entry position the construction pins, else its
 *  credential's unpositioned one; never another credential's. */
export function listenSchemaOf(adapter: Pick<AdapterSnapshot, 'constructionArgs' | 'schemas'> | undefined, listen: Pick<PlannedListen, 'credentialName' | 'constructionArgs'>): InstanceSchema | undefined {
  if (adapter === undefined) return undefined;
  const credential = listen.credentialName !== undefined ? { credentialName: listen.credentialName } : {};
  const positionKey = entryPositionKeyOf(adapter, listen.constructionArgs);
  return adapter.schemas[instanceSchemaKey({ ...credential, positionKey })] ?? adapter.schemas[instanceSchemaKey(credential)];
}

export function fieldIdsOf(schema: { positions: Readonly<Record<string, { fieldIds?: Record<string, string> }>> } | undefined): FieldIdsByType {
  return Object.fromEntries(Object.entries(schema?.positions ?? {}).flatMap(([name, position]) => (position.fieldIds !== undefined ? [[name, position.fieldIds]] : [])));
}

/** `arrival`'s records, its landing and its parents, read by the names a
 *  program writes (`namedFields`), each by the record type it states. */
export function namedArrival(arrival: Exclude<Arrival, { gone: true }>, fieldIds: FieldIdsByType): Exclude<Arrival, { gone: true }> {
  const named = (record: AwaitLanding): AwaitLanding => {
    const ids = record.recordType !== undefined ? fieldIds[record.recordType] : undefined;
    return ids === undefined ? record : { ...record, fields: namedFields(record.fields, ids) };
  };
  return {
    ...arrival,
    landing: named(arrival.landing),
    ...(arrival.parents !== undefined ? { parents: arrival.parents.map((parent) => (parent === null ? null : named(parent))) } : {}),
  };
}

/** What the judge reads of a record an arrival carries: its record type,
 *  which tells it from another record type's edge of the same name, its
 *  fields, and those its module could not read. */
function arrivedRecord(landing: AwaitLanding): ArrivedRecord {
  return {
    ...(landing.recordType !== undefined ? { recordType: landing.recordType } : {}),
    fields: landing.fields,
    ...(landing.unknown !== undefined && landing.unknown.length > 0 ? { unknown: landing.unknown } : {}),
  };
}

/** The edges a fired function waits on off the records its run is handed at
 *  delivery: off the trigger itself (`own`), and off each record the
 *  arrival carries, by the record type it states (`carried`): an arrival
 *  that fires carries each record of the type its hop lands on, whichever
 *  member of a union it is under. */
export interface TriggerAwaits {
  own: string[];
  carried: Readonly<Record<string, readonly string[]>>;
}

/** The edges the check stamps on the parameter of the function `plan` fires,
 *  which `program` declares: where a run of it enters its trigger, and so
 *  the waits a delivery opens for the run as it is kept
 *  (crates/lf/src/routing.rs `trigger_awaits_of`). Those awaited off the
 *  trigger (`opensWaits`), and off each record type the arrival carries
 *  (`carriedAwaits`), by that type. `stamps` is the check's of `program`. */
export function triggerAwaitsOf(input: { program: Program; stamps: CheckAnswer['stamps']; plan: ListenPlan }): TriggerAwaits {
  const { plan } = input;
  const index = input.program.statements.findIndex((statement) => statement.kind === 'movement' && statement.name === plan.movement);
  if (index === -1) return { own: [], carried: {} };
  const path = `/statements/${index}/params/0`;
  const onParam = input.stamps.filter((stamp) => stamp.file === undefined && stamp.path === path);
  // The parameter's one stamp of each, as listen-fire reads them (`trigger_awaits_of`).
  const own = onParam.flatMap((stamp) => ('opensWaits' in stamp ? [[...stamp.opensWaits]] : []))[0] ?? [];
  const carried = onParam.flatMap((stamp) => ('carriedAwaits' in stamp ? [stamp.carriedAwaits] : []))[0] ?? {};
  return { own, carried };
}

/** The receipt a listen takes of `arrival` as it runs it, so a redelivery
 *  of the same arrival runs it once: its edge, the record it landed on, its
 *  identity and its version (crates/lf/src/arrivals.rs `arrival_receipt_key`). */
export function arrivalReceiptKey(arrival: Exclude<Arrival, { gone: true }>): string {
  return `${arrival.edge}:${arrival.key ?? ''}:${arrival.identity}:${arrival.version ?? ''}`;
}

/** The event a run fired by an arrival is handed: what landed on the
 *  listen's last edge, which its function's parameter binds, what it carries,
 *  what it is about and who acted; stamped with when it happened at its
 *  provider, else `now`, so the run's writes say when the change they follow
 *  happened (crates/lf/src/routing.rs `arrival_trigger_of`; both read
 *  engine-contracts/conformance/arrival-triggers.json). */
export function arrivalTriggerOf(input: { pipelineInputId: string; adapterType: string; arrival: Exclude<Arrival, { gone: true }>; now: Date }): TriggerEvent {
  const { adapterType, arrival } = input;
  const occurred = arrival.occurredAt === undefined ? undefined : new Date(arrival.occurredAt);
  const occurredAt = occurred !== undefined && !Number.isNaN(occurred.getTime()) ? occurred : input.now;
  return {
    pipelineInputId: input.pipelineInputId,
    adapterType,
    triggerType: 'arrival',
    arrival: {
      adapterType,
      edge: arrival.edge,
      landing: arrival.landing,
      ...(arrival.parents !== undefined && arrival.parents.length > 0 ? { parents: arrival.parents } : {}),
      ...(arrival.about !== undefined ? { about: arrival.about } : {}),
      ...(arrival.actor !== undefined ? { actor: arrival.actor } : {}),
    },
    occurredAt: occurredAt.toISOString(),
  };
}

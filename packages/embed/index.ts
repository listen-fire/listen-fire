// The embedder's host in one piece. A tenant connects modules (each loaded in
// process over the tenant's own credential) and saves programs, checked
// against a catalog built from its connections and cached until they or its
// schema change. What a module says arrived runs every listen of the tenant's
// programs that it fires (`dispatch`) and wakes the runs awaiting it
// (`arrive`), and `tick` steps on the runs that parked on a timer once it is
// due. Every rule is the engine's own: the checker, the plan it answers for
// each listen, the judge of an arrival (`listenFires`), the park sink, the
// waits and the drains. The embedder supplies its modules, a
// store, and what arrives; the engine's public parts this is built from serve a
// host that needs another shape (docs/embedding.md). Its own package, outside
// the core, because it loads modules through the module kit.

import { randomUUID } from 'node:crypto';

import { tenantIdOf, type Arrival, type ListenPlan, type RunInput, type SegmentLimits } from 'engine-contracts';
import {
  adapterInProcess,
  inProcessValidationDefault,
  memoryKv,
  noCredential,
  refusingFiles,
  secretsCredential,
  type AdapterModuleDefinition,
  type InProcessAdapterModule,
  type ModuleHost,
  type ModuleLog,
} from 'module-kit';
import { buildCatalogSnapshot, type CatalogAdapterInput } from 'movement-engine/public/catalog';
import { MovementEngineError, inProcessHost, introspectAdapter, type InProcessHostOptions } from 'movement-engine/public/embed';
import type { EngineHost } from 'movement-engine/public/host';
import { arrivalTriggerOf, listenFires, listenPlansOf, plannedListensOf, type PlannedListen } from 'movement-engine/public/inbound';
import {
  ENGINE_VERSION,
  checkAnswerInRust,
  parsePinned,
  resumeMovement,
  runMovement,
  settleRaceFrame,
  type MovementRunResult,
  type MovementWriteRecord,
} from 'movement-engine/public/movement-engine';
import {
  RESUME_TIMER_WORK_KIND,
  RUN_HOST_WORK_KINDS,
  RUN_LEASE_TTL_MS,
  SETTLE_RACE_WORK_KIND,
  WAKE_AWAIT_WORK_KIND,
  armTimerWake,
  drainDueTimers,
  heldMarks,
  drainOwedRaces,
  logArrivals,
  memoryRunHostStore,
  nextTimerWake,
  parkSources,
  runHostWorkKindOf,
  runParkHost,
  sweepArrivals,
  waitWakeOf,
  wakeWait,
  withRunLease,
  type ClaimedWork,
  type HeldRunLease,
  type RunHost,
  type RunHostStore,
  type RunHostWorkKind,
  type RunRowStore,
  type RunSettle,
  type StepLeaf,
  type WaitWake,
} from 'movement-engine/public/run-host';
import { createMemoryVault, createSecretsFamily, type SecretFields, type SecretsBackend } from 'movement-engine/public/secrets';

import { MANUAL, MANUAL_MANIFEST, invocationOf, manualAdapter } from './manual';

type CatalogSnapshot = RunInput['catalog'];

/** What a module reports arrived on a listenable edge (adapter protocol 2.6). */
export type { Arrival } from 'engine-contracts';

/** A program a tenant saved: its source, the release it was checked under,
 *  and the check's plan of each of its listens, read once on save. */
export interface SavedProgram {
  name: string;
  source: string;
  languageVersion: NonNullable<RunInput['languageVersion']>;
  listens: ListenPlan[];
}

/** A tenant's connection as stored: the name a movement imports it by, the
 *  module's adapter type, and the credential's id in the secrets (absent for
 *  a module that declares none). */
export interface StoredConnection {
  name: string;
  adapterType: string;
  credentialRef?: string;
}

/** A run kept between its segments: what it is re-entered with. Where it
 *  stands is its run row in the run host's store (`RunRowStore.runStatus`),
 *  written in the same write as the park or the step's end that moves it. */
export interface EmbeddedRun {
  runId: string;
  tenant: string;
  program: string;
  movement: string;
  input: Omit<RunInput, 'runId'>;
  spentMicrodollars: number;
}

/** Where a run stands, as its run row says. */
export type EmbeddedRunStatus = 'running' | 'parked' | 'completed' | 'failed';
const RUN_STATUSES: readonly EmbeddedRunStatus[] = ['running', 'parked', 'completed', 'failed'];

/** Where an embedded host keeps what outlives one call. Over a database, each
 *  family is a table; `runHost` must pass the store contract suite
 *  (public/testing). */
export interface EmbeddedHostStore {
  connections: {
    put(tenant: string, connection: StoredConnection): Promise<void>;
    remove(tenant: string, name: string): Promise<void>;
    list(tenant: string): Promise<StoredConnection[]>;
  };
  programs: {
    put(tenant: string, program: SavedProgram): Promise<void>;
    list(tenant: string): Promise<SavedProgram[]>;
  };
  runs: {
    put(run: EmbeddedRun): Promise<void>;
    get(runId: string): Promise<EmbeddedRun | null>;
  };
  /** Parked leaves, joins, timers, waits and the arrivals they read, run
   *  leases, queued work, pinned texts, and each run's row: a park marks its
   *  run parked, and the step that ends a run settles it, in the same write. */
  runHost: RunHostStore & RunRowStore;
}

/** A secrets backend a connect can store a new credential in. */
export interface ConnectableSecrets extends SecretsBackend {
  put(ref: string, fields: SecretFields): unknown;
}

/** What a run may consume: the segment limits, the cost cap, and how long one
 *  segment may take (docs/contracts/run-limits.md). An absent one is the
 *  engine's default; the cost cap's default is none. */
export interface EmbeddedRunLimits extends SegmentLimits {
  costCapMicrodollars?: number;
  maxSegmentSeconds?: number;
}

export interface EmbeddedHostOptions {
  /** Every module a tenant may connect. A stored connection names its module
   *  by adapter type, so the same list loads it again after a restart. */
  modules: readonly AdapterModuleDefinition[];
  /** Default: in memory, gone when the process exits. */
  store?: EmbeddedHostStore;
  /** Where each connection's credential is kept. Default: in memory. */
  secrets?: ConnectableSecrets;
  /** The engine's other slots: models, files, write locks, a trace. */
  engine?: Omit<InProcessHostOptions, 'adapters' | 'credentials' | 'park' | 'clock'>;
  limits?: EmbeddedRunLimits;
  /** The clock runs read and timers are due by. Default: the wall clock. */
  now?: () => Date;
  /** What a loaded module's context holds beyond its tenant and credential.
   *  Default: a log that keeps only warnings and errors, no files, state in
   *  memory per connection, answers validated outside production. */
  moduleHost?: (input: { tenant: string; connection: string }) => Partial<Omit<ModuleHost, 'tenant' | 'credential'>>;
  /** Where the host says what it did not run: an arrival a listen's judge
   *  could not decide. Default: the console's warnings. */
  log?: Pick<ModuleLog, 'warn'>;
}

/** What a save answers: saved, or the checker's reasons why not. */
export type SaveAnswer = { saved: true; listens: number } | { saved: false; problems: string[] };

/** What one segment of a run came to. `parked`: it waits, and a later `tick`
 *  (or nothing, for a limit pause) steps it on. */
export interface EmbeddedRunOutcome {
  runId: string;
  tenant: string;
  program: string;
  movement: string;
  outcome: { ok: true; writes: MovementWriteRecord[]; spentMicrodollars: number; parked: boolean } | { ok: false; error: string };
}

/** What a module of `adapterType` says arrived for a tenant on its
 *  listenable edges. `connection` names the connection it came for; absent,
 *  it is the module's own install's and reaches every connection's listens. */
export interface Delivery {
  adapterType: string;
  connection?: string;
  arrivals: readonly Arrival[];
}

export interface EmbeddedHost {
  /** Connect `module` for `tenant` under `name` (the name its movements
   *  import), over `credential`; replaces a connection of that name. */
  connect(tenant: string, connection: { name: string; module: AdapterModuleDefinition; credential?: SecretFields }): Promise<void>;
  disconnect(tenant: string, name: string): Promise<void>;
  /** The tenant's schema changed (a field added, an option renamed): its
   *  catalog is rebuilt on next use. A connect or disconnect does this itself. */
  schemaChanged(tenant: string): void;
  /** What the tenant's programs are checked and run against. */
  catalog(tenant: string): Promise<CatalogSnapshot>;
  /** Check a program against the tenant's catalog; save it if clean. A
   *  listen this host would not fire as written is refused by name: one in
   *  the retired settings form, one whose earlier hop only listen-fire
   *  lists, one that states the node its landing is. */
  save(tenant: string, program: { name: string; source: string }): Promise<SaveAnswer>;
  /** Run every listen of the tenant's programs on whose last edge an
   *  arrival of `delivery` landed, on the connection it came for, that the
   *  listen's judge fires, one outcome each. One the judge cannot decide
   *  runs nothing, said once per delivery (`log`). Runs awaiting what
   *  arrived are woken by `arrive`, not here. */
  dispatch(tenant: string, delivery: Delivery): Promise<EmbeddedRunOutcome[]>;
  /** Run one program now: an Invocation lands on the manual unit's
   *  `Invocations`, `text` its `Text` (listen-fire's `listen-fire run <movement> --text`),
   *  and every listen of the program on it that fires runs. None, when the
   *  program is not saved or declares no such listen. */
  run(tenant: string, request: { program: string; text?: string }): Promise<EmbeddedRunOutcome[]>;
  /** What a module of `adapterType` says arrived on its listenable edges for
   *  `tenant` (a module reads them off the deliveries it accepts): each of
   *  the tenant's runs awaiting one steps on, one outcome per segment. An arrival no run awaits
   *  yet is kept for an hour, for a run that starts waiting on it. The
   *  listens it fires run by `dispatch`. */
  arrive(tenant: string, input: { adapterType: string; arrivals: readonly Arrival[] }): Promise<EmbeddedRunOutcome[]>;
  /** Step on every run whose timer is due by `now`, every run woken by an
   *  arrival, and every run that owes a race an earlier step left unsettled:
   *  one outcome per segment. First it forgets the arrivals logged more than
   *  an hour before `now` that no run awaits. */
  tick(now?: Date): Promise<EmbeddedRunOutcome[]>;
}

const WARNINGS_ONLY: ModuleLog = {
  debug: () => {},
  info: () => {},
  warn: (message, meta) => console.warn(message, meta ?? {}),
  error: (message, meta) => console.error(message, meta ?? {}),
};

/** The host over `options` (see the file's head). */
export function createEmbeddedHost(options: EmbeddedHostOptions): EmbeddedHost {
  const now = options.now ?? (() => new Date());
  const log = options.log ?? WARNINGS_ONLY;
  const store = options.store ?? memoryEmbeddedHostStore({ now: () => now().getTime() });
  const vault = options.secrets ?? createMemoryVault();
  const secrets = createSecretsFamily({ backend: vault });
  const modules = new Map(options.modules.map((module) => [module.manifest.adapterType, module]));
  const limits = options.limits ?? {};
  // The run host's `manual` unit, unless a module of that type replaces it.
  const manualUnit = modules.has(MANUAL) ? undefined : manualAdapter();
  const loaded = new Map<string, { module: AdapterModuleDefinition; instance: InProcessAdapterModule }>();
  const catalogs = new Map<string, Promise<CatalogSnapshot>>();
  // A run's first segment takes no lease: each step holds its arrival mark
  // here instead, so a tick's sweep keeps what it may yet read.
  const marks = heldMarks();
  /** Where the run stands, or null for a run the host never started. */
  const statusOf = async (runId: string): Promise<EmbeddedRunStatus | null> => {
    const status = await store.runHost.runStatus({ runId });
    if (status === null) return null;
    return RUN_STATUSES.find((known) => known === status) ?? fail(`run ${runId} has status ${JSON.stringify(status)}, which this host never writes`);
  };

  /** Settle a run outside a step's end: its first segment's end, or a
   *  failure the drain's rules record. A run already settled stays so. */
  const settleRun = async (run: EmbeddedRun, settle: RunSettle): Promise<void> => {
    const status = await statusOf(run.runId);
    if (status !== 'running' && status !== 'parked') return;
    await store.runHost.parks.commitSegment({ runId: run.runId, teamId: run.tenant, resumed: null, joins: [], parks: [], settle });
  };

  const settled = (status: 'completed' | 'failed', outcome: EmbeddedRunOutcome['outcome']): RunSettle => ({ status, outcome, at: now().toISOString() });

  const runHost: RunHost = {
    store: store.runHost,
    runs: {
      cancelRequest: async () => null,
      markFailed: async ({ runId, message }) => {
        const run = await store.runs.get(runId);
        if (run !== null) await settleRun(run, settled('failed', { ok: false, error: message }));
      },
    },
  };

  const moduleOf = (adapterType: string): AdapterModuleDefinition => {
    const module = modules.get(adapterType);
    if (module === undefined) throw new Error(`no module for adapter type "${adapterType}": add it to the host's modules`);
    return module;
  };

  /** The connection's module, loaded once per connection for its tenant. */
  const load = (tenant: string, connection: StoredConnection) => {
    const key = connectionKey(tenant, connection.name);
    const known = loaded.get(key);
    if (known !== undefined) return known;
    const module = moduleOf(connection.adapterType);
    const declared = module.credentials[0];
    const credential =
      connection.credentialRef === undefined || declared === undefined
        ? noCredential(`${module.name} has no credential for ${tenant}'s connection "${connection.name}"`)
        : secretsCredential({
            name: declared.name,
            ref: connection.credentialRef,
            secrets,
            ...(declared.kind === 'oauth2' ? { oauth2: { declaration: declared } } : {}),
          });
    const instance = adapterInProcess(module, {
      log: WARNINGS_ONLY,
      files: refusingFiles(`this host keeps no files for ${module.name}`),
      kv: memoryKv(),
      validateResults: inProcessValidationDefault(process.env),
      ...options.moduleHost?.({ tenant, connection: connection.name }),
      tenant,
      credential,
    });
    const entry = { module, instance };
    loaded.set(key, entry);
    return entry;
  };

  const buildCatalog = async (tenant: string): Promise<CatalogSnapshot> => {
    const connections = await store.connections.list(tenant);
    const adapters = new Map<string, CatalogAdapterInput & { schemas: NonNullable<CatalogAdapterInput['schemas']> }>();
    for (const connection of connections) {
      const { module, instance } = load(tenant, connection);
      const { schema } = await introspectAdapter(instance.adapter, module.manifest);
      const entry = adapters.get(connection.adapterType) ?? { manifest: module.manifest, schemas: {} };
      entry.schemas[connection.name] = schema;
      adapters.set(connection.adapterType, entry);
    }
    const units: CatalogAdapterInput[] =
      manualUnit !== undefined ? [{ manifest: MANUAL_MANIFEST, schemas: { '': (await introspectAdapter(manualUnit, MANUAL_MANIFEST)).schema } }] : [];
    return buildCatalogSnapshot({
      adapters: [...units, ...adapters.values()],
      credentials: Object.fromEntries(
        connections.map(({ name, adapterType }) => {
          const declared = moduleOf(adapterType).credentials[0];
          return [name, { adapters: [adapterType], ...(declared !== undefined ? { credential: declared.name } : {}) }];
        }),
      ),
      plugins: {},
    });
  };

  const catalog = (tenant: string): Promise<CatalogSnapshot> => {
    const cached = catalogs.get(tenant);
    if (cached !== undefined) return cached;
    const built = buildCatalog(tenant);
    catalogs.set(tenant, built);
    // A failed build is not kept: the next use tries again.
    built.catch(() => catalogs.delete(tenant));
    return built;
  };

  const forget = (tenant: string, name: string): void => {
    loaded.delete(connectionKey(tenant, name));
    catalogs.delete(tenant);
  };

  /** The instance a run resolves: the tenant's connection holding that
   *  credential, or, for a module that declares none, its one connection. */
  const resolve = async (tenant: string, adapterType: string, credentialsId: string | undefined) => {
    if (adapterType === MANUAL && manualUnit !== undefined) return manualUnit;
    const ofType = (await store.connections.list(tenant)).filter((c) => c.adapterType === adapterType);
    const connection =
      credentialsId !== undefined ? ofType.find((c) => c.credentialRef === credentialsId) : ofType.length === 1 && ofType[0].credentialRef === undefined ? ofType[0] : undefined;
    if (connection === undefined) throw new Error(`tenant ${tenant} has no "${adapterType}" connection${credentialsId !== undefined ? ` holding ${credentialsId}` : ' without a credential'}`);
    return load(tenant, connection).instance.adapter;
  };

  /** The host one run's segments run against: its tenant's connections, and
   *  the run's own parks and waits (fenced by the lease a resume holds; a
   *  resumed leaf's notes kept with the segment's progress past it). */
  const hostFor = (run: EmbeddedRun, resume?: { fence: string; leaf?: string }): EngineHost => {
    const parks = runParkHost(runHost, {
      runId: run.runId,
      teamId: run.tenant,
      ...(resume !== undefined ? { fence: resume.fence } : {}),
      ...(resume?.leaf !== undefined ? { resumed: resume.leaf } : {}),
      // The park's own write marks the run parked (`parks.commit`).
      records: { ensureRun: async () => {}, markParked: async () => {} },
    });
    return inProcessHost({
      ...options.engine,
      adapters: { resolve: ({ adapterType, credentialsId }) => resolve(run.tenant, adapterType, credentialsId) },
      // A run reaches only its own tenant's connections.
      credentials: {
        belongsTo: async ({ credentialsId }) => (await store.connections.list(run.tenant)).some((c) => c.credentialRef === credentialsId),
      },
      clock: { now: async () => ({ nowIso: now().toISOString() }) },
      park: {
        sink: parks.sink,
        waits: parks.waits,
        wake: parks.wake,
        sources: parkSources(store.runHost.sources, run.tenant),
      },
    });
  };

  const outcomeOf = (run: EmbeddedRun, result: MovementRunResult): EmbeddedRunOutcome => {
    run.spentMicrodollars = result.runSpentMicrodollars ?? run.spentMicrodollars + (result.spentMicrodollars ?? 0);
    return { ...namesOf(run), outcome: { ok: true, writes: result.writes, spentMicrodollars: run.spentMicrodollars, parked: result.parked === true } };
  };

  const failureOf = (run: EmbeddedRun, error: string): EmbeddedRunOutcome => ({ ...namesOf(run), outcome: { ok: false, error } });

  const fire = async (tenant: string, program: SavedProgram, listen: PlannedListen, arrival: Exclude<Arrival, { gone: true }>): Promise<EmbeddedRunOutcome> => {
    const connections = await store.connections.list(tenant);
    const firedAt = now();
    const triggerEvent = arrivalTriggerOf({ pipelineInputId: listen.pipeline, adapterType: listen.plan.adapter, arrival, now: firedAt });
    const { costCapMicrodollars, maxSegmentSeconds, ...segmentLimits } = limits;
    const run: EmbeddedRun = {
      runId: randomUUID(),
      tenant,
      program: program.name,
      movement: listen.plan.movement,
      input: {
        source: program.source,
        languageVersion: program.languageVersion,
        movementName: listen.plan.movement,
        event: triggerEvent,
        firedAt: firedAt.toISOString(),
        teamId: tenantIdOf(tenant),
        catalog: await catalog(tenant),
        credentialIds: Object.fromEntries(connections.flatMap(({ name, credentialRef }) => (credentialRef !== undefined ? [[name, credentialRef]] : []))),
        limits: segmentLimits,
        ...(costCapMicrodollars !== undefined ? { costCapMicrodollars } : {}),
        ...(maxSegmentSeconds !== undefined ? { maxSegmentSeconds } : {}),
      },
      spentMicrodollars: 0,
    };
    await store.runs.put(run);
    await store.runHost.startRun({ runId: run.runId });
    let outcome: EmbeddedRunOutcome;
    let parked = false;
    try {
      const result = await marks.holding(store.runHost, () => runMovement({ ...run.input, runId: run.runId, host: hostFor(run) }));
      parked = result.parked === true;
      outcome = outcomeOf(run, result);
    } catch (error) {
      outcome = failureOf(run, messageOf(error));
    }
    await store.runs.put(run);
    // A run that parked was marked so by its park's write.
    if (!parked) await settleRun(run, settled(outcome.outcome.ok ? 'completed' : 'failed', outcome.outcome));
    return outcome;
  };

  /** Each arrival of `delivery` judged against every listen of `programs`
   *  on its edge (`listenFires`), and each listen it fires run, in the order
   *  the arrivals came. An Undecided verdict runs nothing, its reason said
   *  once per delivery. */
  const fireArrivals = async (tenant: string, programs: readonly SavedProgram[], delivery: Delivery): Promise<EmbeddedRunOutcome[]> => {
    const listening = programs.map((program) => ({
      program,
      listens: plannedListensOf({ file: program.name, program: parsePinned({ source: program.source, languageVersion: program.languageVersion }), plans: program.listens }),
    }));
    const delivered = { adapterType: delivery.adapterType, ...(delivery.connection !== undefined ? { credentialName: delivery.connection } : {}) };
    const nowMs = now().getTime();
    const said = new Set<string>();
    const outcomes: EmbeddedRunOutcome[] = [];
    for (const arrival of delivery.arrivals) {
      if ('gone' in arrival) continue;
      for (const { program, listens } of listening) {
        for (const listen of listens) {
          const verdict = listenFires(listen, arrival, delivered, nowMs);
          if (verdict === null || 'skips' in verdict) continue;
          if ('undecided' in verdict) {
            const line = `${program.name}:${listen.plan.movement}: an arrival on ${arrival.edge} cannot be judged (${verdict.undecided}): it runs nothing`;
            if (!said.has(line)) log.warn(line);
            said.add(line);
            continue;
          }
          outcomes.push(await fire(tenant, program, listen, arrival));
        }
      }
    }
    return outcomes;
  };

  /** One parked run's step: a segment re-entered from its leaf (or a race
   *  settled), its cost counted on from what the run spent before. A step
   *  that ends its run answers the run's settle, which the drain writes in
   *  the step's end, under the lease: a lease lost there writes neither,
   *  leaving the leaf parked for the run's next holder. A step that fails
   *  records the failure itself, and the drain tears the run down. */
  const stepperFor = (run: EmbeddedRun, fence: string, stepped: EmbeddedRunOutcome[]): StepLeaf => {
    return async (request, settle) => {
      const host = hostFor(run, { fence, ...(request.kind === 'leaf' ? { leaf: request.address } : {}) });
      const input = { ...run.input, runId: run.runId, priorSpentMicrodollars: run.spentMicrodollars, state: request.state, host };
      try {
        const result = await marks.holding(store.runHost, () =>
          request.kind === 'leaf'
            ? resumeMovement({ ...input, ...(request.reenter ? { reenter: true } : {}), deferRaceSettlement: request.deferRaceSettlement })
            : settleRaceFrame({ ...input, frameAddress: request.frameAddress }),
        );
        const outcome = outcomeOf(run, result);
        stepped.push(outcome);
        await store.runs.put(run);
        const deferredRaceFrames = result.deferredRaceFrames ?? [];
        if (result.parked === true) return { kind: 'parked', parkedAddress: result.parkedAddress, deferredRaceFrames };
        // A race the segment left its run to settle is owed: the run goes on.
        const endsRun = deferredRaceFrames.length === 0 && (await settle.runComplete());
        return { kind: 'completed', deferredRaceFrames, ...(endsRun ? { settle: settled('completed', outcome.outcome) } : {}) };
      } catch (error) {
        const message = messageOf(error);
        const failure = failureOf(run, message);
        stepped.push(failure);
        await store.runs.put(run);
        await settleRun(run, settled('failed', failure.outcome));
        return { kind: 'failed', error: message };
      }
    };
  };

  /** The run's step under `lease`, the run read again under it, only while
   *  it is parked, as listen-fire's parked stepper. One that ended (completed
   *  or failed since its row was queued, or no longer kept) steps nothing.
   *  One still `running` is busy, its row retried; no row should name one,
   *  since a park marks its run parked in its own write. */
  const parkedStepper = async (runId: string, lease: HeldRunLease, stepped: EmbeddedRunOutcome[]): Promise<StepLeaf | 'busy' | 'ended'> => {
    const run = await store.runs.get(runId);
    const status = await statusOf(runId);
    if (run === null || status === null) return 'ended';
    switch (status) {
      case 'parked':
        return stepperFor(run, lease.token, stepped);
      case 'running':
        return 'busy';
      case 'completed':
      case 'failed':
        return 'ended';
      default: {
        const unreachable: never = status;
        throw new Error(`unhandled run status ${JSON.stringify(unreachable)}`);
      }
    }
  };

  /** The run a claimed row steps, by its kind: a wake names its wait, a
   *  timer's or a race's row names only its run. Null for a run the host no
   *  longer keeps. */
  const rowRun = async (claimed: ClaimedWork): Promise<DueRow | null> => {
    const kind = runHostWorkKindOf(claimed.kind) ?? fail(`claimed a work row of kind ${claimed.kind}, which this host never queues`);
    if (kind === WAKE_AWAIT_WORK_KIND) {
      const wake = waitWakeOf(claimed.payload) ?? fail(`a ${kind} row whose payload names no wait: ${JSON.stringify(claimed.payload)}`);
      const run = await store.runs.get(wake.runId);
      return run === null ? null : { kind, run, wake };
    }
    const runId: unknown = Reflect.get(Object(claimed.payload), 'runId');
    if (typeof runId !== 'string') fail(`a ${kind} row whose payload names no run: ${JSON.stringify(claimed.payload)}`);
    const run = await store.runs.get(runId);
    return run === null ? null : { kind, run };
  };

  /** One claimed row's run, stepped under its lease if it is still parked:
   *  a timer's due leaves, the await a wake names, or the races the run owes.
   *  Busy when another process holds the run, or took it over while its
   *  drain ran (the lease lost: the leaf claimed goes back to parked, and
   *  only this row's retry steps it on), or the run is not yet marked
   *  parked. */
  const stepRow = async (row: DueRow, dueBy: string, stepped: EmbeddedRunOutcome[]): Promise<'done' | 'busy'> => {
    const { runId, tenant: teamId } = row.run;
    const leases = store.runHost.leases;
    switch (row.kind) {
      case WAKE_AWAIT_WORK_KIND: {
        let runBusy = false;
        const { busy } = await wakeWait(runHost, {
          wake: row.wake,
          teamId,
          stepper: async ({ lease }) => {
            const step = await parkedStepper(runId, lease, stepped);
            runBusy = step === 'busy';
            return typeof step === 'string' ? null : step;
          },
        });
        return busy || runBusy ? 'busy' : 'done';
      }
      case RESUME_TIMER_WORK_KIND: {
        const held = await withRunLease(leases, runId, async (lease) => {
          const step = await parkedStepper(runId, lease, stepped);
          return typeof step === 'string' ? step : drainDueTimers(runHost, { runId, teamId, dueBy, lease, step });
        });
        if (held.kind === 'busy') return 'busy';
        switch (held.value) {
          case 'busy':
          case 'leaseLost':
            return 'busy';
          // A run that ended has nothing to wake: a timer leaf it left behind
          // is never armed again.
          case 'ended':
            return 'done';
          case 'done': {
            // The run's one timer row, re-armed while it is claimed, outlives
            // the completion that follows, due at the run's next timer.
            const next = await nextTimerWake(runHost, { runId });
            if (next !== null) await armTimerWake(store.runHost, { runId, teamId, wakeAt: next });
            return 'done';
          }
          default: {
            const unreachable: never = held.value;
            throw new Error(`unhandled timer drain ${JSON.stringify(unreachable)}`);
          }
        }
      }
      case SETTLE_RACE_WORK_KIND: {
        // A race an arm won and left its run to settle, its drain died
        // before it did: the run's races are settled, and nothing else.
        const held = await withRunLease(leases, runId, async (lease) => {
          const step = await parkedStepper(runId, lease, stepped);
          return typeof step === 'string' ? step : drainOwedRaces(runHost, { runId, teamId, lease, step });
        });
        if (held.kind === 'busy') return 'busy';
        return held.value === 'busy' || held.value === 'leaseLost' ? 'busy' : 'done';
      }
      default: {
        const unreachable: never = row;
        throw new Error(`unhandled work row ${JSON.stringify(unreachable)}`);
      }
    }
  };

  /** Every due row of the run host's `kinds` (absent: all of them) stepped
   *  once; given `tenant`, only that tenant's runs' rows (claimed by its team
   *  where the store keeps rows' teams; any other tenant's row claimed is
   *  left due for a later step). A row that throws stays leased, retried once
   *  its lease lapses; the rows claimed after it go back due at once. */
  const stepWork = async (input: { dueBy: string; kinds?: readonly RunHostWorkKind[]; tenant?: string }): Promise<EmbeddedRunOutcome[]> => {
    const work = store.runHost.work;
    const stepped: EmbeddedRunOutcome[] = [];
    const claims = await work.claimDue({
      limit: 100,
      leaseMs: RUN_LEASE_TTL_MS,
      dueBy: input.dueBy,
      kinds: input.kinds ?? RUN_HOST_WORK_KINDS,
      ...(input.tenant !== undefined ? { teamId: input.tenant } : {}),
    });
    for (const [index, claimed] of claims.entries()) {
      try {
        const row = await rowRun(claimed);
        // A run the host no longer keeps has nothing to step.
        if (row === null) await work.complete(claimed);
        else if (input.tenant !== undefined && row.run.tenant !== input.tenant) await work.release({ ...claimed, why: 'busy' });
        // Another process holds the run: its row goes back for later.
        else if ((await stepRow(row, input.dueBy, stepped)) === 'busy') await work.release({ ...claimed, why: 'busy' });
        else await work.complete(claimed);
      } catch (error) {
        // Never stepped, so no attempt of theirs (`busy`). Best effort: a
        // release that fails leaves its row leased until its lease lapses,
        // and the error thrown is still the one that stopped the step.
        for (const unstepped of claims.slice(index + 1)) await work.release({ ...unstepped, why: 'busy' }).catch(() => {});
        throw error;
      }
    }
    return stepped;
  };

  return {
    async connect(tenant, { name, module, credential }) {
      if (modules.get(module.manifest.adapterType) !== module) {
        throw new Error(`module ${module.name} is not among the host's modules: add it to createEmbeddedHost({ modules })`);
      }
      const stored: StoredConnection = { name, adapterType: module.manifest.adapterType };
      if (credential !== undefined) {
        stored.credentialRef = connectionKey(tenant, name);
        await vault.put(stored.credentialRef, credential);
      }
      await store.connections.put(tenant, stored);
      forget(tenant, name);
    },

    async disconnect(tenant, name) {
      await store.connections.remove(tenant, name);
      forget(tenant, name);
    },

    schemaChanged(tenant) {
      catalogs.delete(tenant);
    },

    catalog,

    async save(tenant, { name, source }) {
      const snapshot = await catalog(tenant);
      let answer: ReturnType<typeof checkAnswerInRust>;
      try {
        answer = checkAnswerInRust({ source, catalog: snapshot, languageVersion: ENGINE_VERSION });
      } catch (error) {
        if (error instanceof MovementEngineError) return { saved: false, problems: [error.message] };
        throw error;
      }
      const listens = listenPlansOf(answer);
      const problems = [
        ...answer.diagnostics.filter((d) => d.code === SETTINGS_RETIRED).map((d) => `line ${d.span.start.line}: ${d.message}: this host fires only a listen on a traversal`),
        ...listens.flatMap(unfiredHere),
      ];
      if (problems.length > 0) return { saved: false, problems };
      await store.programs.put(tenant, { name, source, languageVersion: ENGINE_VERSION, listens });
      return { saved: true, listens: listens.length };
    },

    async dispatch(tenant, delivery) {
      return fireArrivals(tenant, await store.programs.list(tenant), delivery);
    },

    async run(tenant, { program: name, text }) {
      const program = (await store.programs.list(tenant)).find((p) => p.name === name);
      if (program === undefined) return [];
      return fireArrivals(tenant, [program], { adapterType: MANUAL, arrivals: [invocationOf({ firedAt: now(), ...(text !== undefined ? { text } : {}) })] });
    },

    async arrive(tenant, { adapterType, arrivals }) {
      const declared = modules.get(adapterType)?.manifest.resendWindowSeconds;
      await logArrivals(store.runHost, { teamId: tenant, adapterType, arrivals, at: now().toISOString(), ...(declared !== undefined ? { resendWindowMs: declared * 1000 } : {}) });
      return stepWork({ dueBy: now().toISOString(), kinds: [WAKE_AWAIT_WORK_KIND], tenant });
    },

    async tick(at = now()) {
      await sweepArrivals(store.runHost, marks);
      return stepWork({ dueBy: at.toISOString() });
    },
  };
}

/** The diagnostic a listen in the 0.12 settings form draws under 0.13: a
 *  warning until the form is gone, but this host never fires one. */
const SETTINGS_RETIRED = 'MOV_LISTEN_SETTINGS_RETIRED';

/** Why this host would not fire `plan` as it is written, if it would not.
 *  listen-fire alone lists the members of an earlier hop whose WHERE an
 *  arrival cannot be judged by (a `resolved` hop): judged here with that hop
 *  unjudged, it would fire under every member. And listen-fire alone checks
 *  an arrival against the node a listen states its landing is. */
function unfiredHere(plan: ListenPlan): string[] {
  const named = `the listen that fires ${plan.movement}`;
  const resolved = plan.hops.filter((hop) => hop.judged === 'resolved').map((hop) => hop.edge);
  return [
    ...(resolved.length > 0
      ? [
          `${named} filters ${resolved.map((edge) => `\`${edge}\``).join(', ')} by a WHERE its module's arrivals do not carry the record for: only listen-fire lists those members to judge it, and this host would fire under every one. Filter that hop on the landing's fields instead, or run the listen on listen-fire`,
        ]
      : []),
    ...(plan.landing !== undefined
      ? [`${named} states its landing is a ${plan.landing}: this host does not check an arrival against the node a listen states, so it would run one that does not fit`]
      : []),
  ];
}

/** A due run host row, and the run it steps. */
type DueRow =
  | { kind: typeof WAKE_AWAIT_WORK_KIND; run: EmbeddedRun; wake: WaitWake }
  | { kind: typeof RESUME_TIMER_WORK_KIND | typeof SETTLE_RACE_WORK_KIND; run: EmbeddedRun };

function fail(message: string): never {
  throw new Error(message);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function namesOf(run: EmbeddedRun): Pick<EmbeddedRunOutcome, 'runId' | 'tenant' | 'program' | 'movement'> {
  return { runId: run.runId, tenant: run.tenant, program: run.program, movement: run.movement };
}

/** One tenant's connection, as a key no other tenant's can share. */
function connectionKey(tenant: string, name: string): string {
  return `${encodeURIComponent(tenant)}/${encodeURIComponent(name)}`;
}

/** Every family of an embedded host's store, in memory: one process. */
export function memoryEmbeddedHostStore(options: { now?: () => number } = {}): EmbeddedHostStore {
  const connections = new Map<string, Map<string, StoredConnection>>();
  const programs = new Map<string, Map<string, SavedProgram>>();
  const runs = new Map<string, EmbeddedRun>();
  const tenantMap = <T>(maps: Map<string, Map<string, T>>, tenant: string): Map<string, T> => {
    const known = maps.get(tenant);
    if (known !== undefined) return known;
    const created = new Map<string, T>();
    maps.set(tenant, created);
    return created;
  };
  return {
    connections: {
      put: async (tenant, connection) => void tenantMap(connections, tenant).set(connection.name, { ...connection }),
      remove: async (tenant, name) => void tenantMap(connections, tenant).delete(name),
      list: async (tenant) => [...tenantMap(connections, tenant).values()],
    },
    programs: {
      put: async (tenant, program) => void tenantMap(programs, tenant).set(program.name, program),
      list: async (tenant) => [...tenantMap(programs, tenant).values()],
    },
    runs: {
      put: async (run) => void runs.set(run.runId, { ...run }),
      get: async (runId) => {
        const run = runs.get(runId);
        return run === undefined ? null : { ...run };
      },
    },
    runHost: memoryRunHostStore(options.now !== undefined ? { now: options.now } : {}),
  };
}

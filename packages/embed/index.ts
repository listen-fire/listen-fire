// The embedder's host in one piece. A tenant connects modules (each loaded in
// process over the tenant's own credential) and saves programs, checked
// against a catalog built from its connections and cached until they or its
// schema change. An event from the embedder's product runs every listen of the
// tenant's programs that hears it, and `tick` steps on the runs that parked on
// a timer once it is due. Every rule is the engine's own: the checker, the
// listen table read off the source, the routing rule (`listenerHearsDelivery`),
// the park sink and the timer drain. The embedder supplies its modules, a
// store, and its events; the engine's public parts this is built from serve a
// host that needs another shape (docs/embedding.md). Its own package, outside
// the core, because it loads modules through the module kit.

import { randomUUID } from 'node:crypto';

import { tenantIdOf, type RunInput, type SegmentLimits } from 'engine-contracts';
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
import type { DiscriminableEvent } from 'movement-engine/public/adapter';
import { buildCatalogSnapshot, type CatalogAdapterInput } from 'movement-engine/public/catalog';
import { MovementEngineError, inProcessHost, introspectAdapter, type InProcessHostOptions } from 'movement-engine/public/embed';
import type { EngineHost } from 'movement-engine/public/host';
import { collectFileListeners, listenerHearsDelivery, triggerEventOf, type FileListener } from 'movement-engine/public/inbound';
import {
  ENGINE_VERSION,
  checkPinnedInRust,
  parsePinned,
  resumeMovement,
  runMovement,
  settleRaceFrame,
  type MovementRunResult,
  type MovementWriteRecord,
} from 'movement-engine/public/movement-engine';
import {
  RUN_LEASE_TTL_MS,
  armTimerWake,
  drainDueTimers,
  memoryRunHostStore,
  nextTimerWake,
  parkSources,
  runParkSink,
  withRunLease,
  type RunHost,
  type RunHostStore,
  type StepLeaf,
} from 'movement-engine/public/run-host';
import { createMemoryVault, createSecretsFamily, type SecretFields, type SecretsBackend } from 'movement-engine/public/secrets';

import { MANUAL, MANUAL_MANIFEST, manualAdapter, manualEvent } from './manual';

type CatalogSnapshot = RunInput['catalog'];

/** A program a tenant saved: its source, the release it was checked under,
 *  and its listens, read once on save. */
export interface SavedProgram {
  name: string;
  source: string;
  languageVersion: NonNullable<RunInput['languageVersion']>;
  listeners: FileListener[];
}

/** A tenant's connection as stored: the name a movement imports it by, the
 *  module's adapter type, and the credential's id in the secrets (absent for
 *  a module that declares none). */
export interface StoredConnection {
  name: string;
  adapterType: string;
  credentialRef?: string;
}

/** A run kept between its segments: what it is re-entered with. */
export interface EmbeddedRun {
  runId: string;
  tenant: string;
  program: string;
  movement: string;
  input: Omit<RunInput, 'runId'>;
  spentMicrodollars: number;
  status: 'running' | 'parked' | 'completed' | 'failed';
}

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
  /** Parked leaves, joins, timers, run leases, queued work, pinned texts. */
  runHost: RunHostStore;
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

/** An event the embedder's product raised for a tenant. `connection` names the
 *  connection it came for; absent, it is the module's own and reaches every
 *  connection's listens. */
export interface Delivery {
  adapterType: string;
  connection?: string;
  event: DiscriminableEvent;
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
  /** Check a program against the tenant's catalog; save it if clean. */
  save(tenant: string, program: { name: string; source: string }): Promise<SaveAnswer>;
  /** Run every listen of the tenant's programs that hears `delivery`. */
  dispatch(tenant: string, delivery: Delivery): Promise<EmbeddedRunOutcome[]>;
  /** Run one program now: every `listen to manual` it declares fires, with
   *  `text` as the Invocation's `Text` (lf's `lf run <movement> --text`).
   *  None, when the program is not saved or declares no such listen. */
  run(tenant: string, request: { program: string; text?: string }): Promise<EmbeddedRunOutcome[]>;
  /** Step on every run whose timer is due by `now`: one outcome per segment. */
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
  const store = options.store ?? memoryEmbeddedHostStore({ now: () => now().getTime() });
  const vault = options.secrets ?? createMemoryVault();
  const secrets = createSecretsFamily({ backend: vault });
  const modules = new Map(options.modules.map((module) => [module.manifest.adapterType, module]));
  const limits = options.limits ?? {};
  // The run host's `manual` unit, unless a module of that type replaces it.
  const manualUnit = modules.has(MANUAL) ? undefined : manualAdapter();
  const loaded = new Map<string, { module: AdapterModuleDefinition; instance: InProcessAdapterModule }>();
  const catalogs = new Map<string, Promise<CatalogSnapshot>>();
  const runHost: RunHost = {
    store: store.runHost,
    keepers: [],
    runs: {
      cancelRequest: async () => null,
      markFailed: async ({ runId }) => {
        const run = await store.runs.get(runId);
        if (run !== null && run.status !== 'failed') await store.runs.put({ ...run, status: 'failed' });
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
   *  the run's own park sink (fenced by the lease a resume holds). */
  const hostFor = (run: EmbeddedRun, fence?: string): EngineHost =>
    inProcessHost({
      ...options.engine,
      adapters: { resolve: ({ adapterType, credentialsId }) => resolve(run.tenant, adapterType, credentialsId) },
      // A run reaches only its own tenant's connections.
      credentials: {
        belongsTo: async ({ credentialsId }) => (await store.connections.list(run.tenant)).some((c) => c.credentialRef === credentialsId),
      },
      clock: { now: async () => ({ nowIso: now().toISOString() }) },
      park: {
        sink: runParkSink(runHost, {
          runId: run.runId,
          teamId: run.tenant,
          ...(fence !== undefined ? { fence } : {}),
          records: {
            ensureRun: async () => {},
            markParked: async () => {
              run.status = 'parked';
              await store.runs.put(run);
            },
          },
        }),
        sources: parkSources(store.runHost.sources, run.tenant),
      },
    });

  const outcomeOf = (run: EmbeddedRun, result: MovementRunResult): EmbeddedRunOutcome => {
    run.spentMicrodollars = result.runSpentMicrodollars ?? run.spentMicrodollars + (result.spentMicrodollars ?? 0);
    return { ...namesOf(run), outcome: { ok: true, writes: result.writes, spentMicrodollars: run.spentMicrodollars, parked: result.parked === true } };
  };

  const failureOf = (run: EmbeddedRun, error: string): EmbeddedRunOutcome => {
    run.status = 'failed';
    return { ...namesOf(run), outcome: { ok: false, error } };
  };

  const fire = async (tenant: string, program: SavedProgram, listener: FileListener, delivery: Delivery): Promise<EmbeddedRunOutcome> => {
    const connections = await store.connections.list(tenant);
    const firedAt = now();
    const named = listener.credentialName ?? delivery.connection;
    const source = connections.find((c) => c.adapterType === delivery.adapterType && (named === undefined || c.name === named));
    const eventTypes = source !== undefined ? ((await load(tenant, source).instance.adapter.listEventTypes?.()) ?? []) : [];
    const { triggerEvent } = triggerEventOf({
      pipelineInputId: `listen:${program.name}:${listener.movementName}`,
      adapterType: delivery.adapterType,
      triggerType: 'webhook',
      event: delivery.event,
      eventTypes,
      now: firedAt,
    });
    const { costCapMicrodollars, maxSegmentSeconds, ...segmentLimits } = limits;
    const run: EmbeddedRun = {
      runId: randomUUID(),
      tenant,
      program: program.name,
      movement: listener.movementName,
      input: {
        source: program.source,
        languageVersion: program.languageVersion,
        movementName: listener.movementName,
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
      status: 'running',
    };
    await store.runs.put(run);
    let outcome: EmbeddedRunOutcome;
    try {
      const result = await runMovement({ ...run.input, runId: run.runId, host: hostFor(run) });
      run.status = result.parked === true ? 'parked' : 'completed';
      outcome = outcomeOf(run, result);
    } catch (error) {
      outcome = failureOf(run, messageOf(error));
    }
    await store.runs.put(run);
    return outcome;
  };

  /** One parked run's step: a segment re-entered from its leaf (or a race
   *  settled), its cost counted on from what the run spent before. */
  const stepFor = (run: EmbeddedRun, fence: string, stepped: EmbeddedRunOutcome[]): StepLeaf => {
    return async (request, settle) => {
      const input = { ...run.input, runId: run.runId, priorSpentMicrodollars: run.spentMicrodollars, state: request.state, host: hostFor(run, fence) };
      try {
        const result =
          request.kind === 'leaf'
            ? await resumeMovement({ ...input, ...(request.reenter ? { reenter: true } : {}), deferRaceSettlement: request.deferRaceSettlement })
            : await settleRaceFrame({ ...input, frameAddress: request.frameAddress });
        stepped.push(outcomeOf(run, result));
        const deferredRaceFrames = result.deferredRaceFrames ?? [];
        if (result.parked !== true && (await settle.runComplete())) run.status = 'completed';
        await store.runs.put(run);
        return result.parked === true ? { kind: 'parked', parkedAddress: result.parkedAddress, deferredRaceFrames } : { kind: 'completed', deferredRaceFrames };
      } catch (error) {
        const message = messageOf(error);
        stepped.push(failureOf(run, message));
        await store.runs.put(run);
        return { kind: 'failed', error: message };
      }
    };
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
      try {
        checkPinnedInRust({ source, catalog: snapshot, languageVersion: ENGINE_VERSION });
      } catch (error) {
        if (error instanceof MovementEngineError) return { saved: false, problems: [error.message] };
        throw error;
      }
      const listeners = collectFileListeners(parsePinned({ source, languageVersion: ENGINE_VERSION }));
      await store.programs.put(tenant, { name, source, languageVersion: ENGINE_VERSION, listeners });
      return { saved: true, listens: listeners.length };
    },

    async dispatch(tenant, delivery) {
      const outcomes: EmbeddedRunOutcome[] = [];
      for (const program of await store.programs.list(tenant)) {
        for (const listener of program.listeners) {
          const heard = listenerHearsDelivery(listener, {
            adapterType: delivery.adapterType,
            ...(delivery.connection !== undefined ? { credentialName: delivery.connection } : {}),
            event: delivery.event,
          });
          if (heard) outcomes.push(await fire(tenant, program, listener, delivery));
        }
      }
      return outcomes;
    },

    async run(tenant, { program: name, text }) {
      const program = (await store.programs.list(tenant)).find((p) => p.name === name);
      if (program === undefined) return [];
      const delivery: Delivery = { adapterType: MANUAL, event: manualEvent({ firedAt: now(), ...(text !== undefined ? { text } : {}) }) };
      const outcomes: EmbeddedRunOutcome[] = [];
      for (const listener of program.listeners) {
        if (listener.adapter === MANUAL) outcomes.push(await fire(tenant, program, listener, delivery));
      }
      return outcomes;
    },

    async tick(at = now()) {
      const dueBy = at.toISOString();
      const work = store.runHost.work;
      const stepped: EmbeddedRunOutcome[] = [];
      for (const claimed of await work.claimDue({ limit: 100, leaseMs: RUN_LEASE_TTL_MS, dueBy })) {
        const runId: unknown = Reflect.get(Object(claimed.payload), 'runId');
        const run = claimed.kind === 'resume_timer' && typeof runId === 'string' ? await store.runs.get(runId) : null;
        if (run === null) {
          await work.complete(claimed);
          continue;
        }
        const held = await withRunLease(store.runHost.leases, run.runId, (lease) =>
          drainDueTimers(runHost, { runId: run.runId, dueBy, lease, step: stepFor(run, lease.token, stepped) }),
        );
        // Another process holds the run: its timer row goes back for later.
        if (held.kind === 'busy') {
          await work.release(claimed);
          continue;
        }
        // Completed before re-arming: the row is one per run, so a re-park
        // during the drain shares it.
        await work.complete(claimed);
        const next = await nextTimerWake(runHost, { runId: run.runId });
        if (next !== null) await armTimerWake(store.runHost, { runId: run.runId, teamId: run.tenant, wakeAt: next });
      }
      return stepped;
    },
  };
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

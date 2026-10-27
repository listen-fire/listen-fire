// The engine inside the SaaS's own process: each customer is a tenant with its
// own saved movements, its own CRM records and fields, its own API key and,
// when it connects one, its own Slack workspace (a ready-made module loaded
// the same way as the SaaS's own); a customer's movement is checked when saved
// and run when one of its events happens. A run
// that waits (`await sleep(1h)`) parks in an in-memory run-host store and is
// stepped on by `tick()` once its time comes. Everything here comes from the
// engine's public entries and the module kit.

import { randomUUID } from 'node:crypto';

import { tenantIdOf, type RunInput } from '@listen-fire/engine-contracts';
import { ENGINE_VERSION, runMovement, resumeMovement, settleRaceFrame, checkPinnedInRust, parsePinned, type MovementRunResult } from '@listen-fire/engine/public/movement-engine';
import { inProcessHost, introspectAdapter, collectFileListeners, memoryRunHostStore, pricedModels, type FileListener, type ModelClient } from '@listen-fire/engine/public/embed';
import {
  armTimerWake,
  drainDueTimers,
  nextTimerWake,
  parkSources,
  runParkSink,
  withRunLease,
  type RunHost,
  type StepLeaf,
  type StepOutcome,
} from '@listen-fire/engine/public/run-host';
import { buildCatalogSnapshot } from '@listen-fire/engine/public/catalog';
import { eventMatchesTriggerScope, triggerEventOf } from '@listen-fire/engine/public/inbound';
import { createMemoryVault, createSecretsFamily, type MemoryVault } from '@listen-fire/engine/public/secrets';
import type { Adapter, DiscriminableEvent } from '@listen-fire/engine/public/adapter';
import type { EngineHost } from '@listen-fire/engine/public/host';
import { adapterInProcess, memoryKv, refusingFiles, secretsCredential, type AdapterModuleDefinition, type ModuleLog } from '@listen-fire/module-kit';
import { slackModule } from '@listen-fire/slack';

import { CompanyStore, crmModule, type FieldDefinition } from './crm';

/** The language version every customer's movement is pinned to: the
 *  engine's release. */
export const LANGUAGE_VERSION = ENGINE_VERSION;

/** The connection a customer's movement imports for its CRM workspace, and,
 *  once the customer connects Slack, for its Slack workspace. */
export const CREDENTIAL = 'workspace';
export const SLACK_CREDENTIAL = 'slack_workspace';

/** A customer's Slack: the bot token, and the API it is reached at (the
 *  workspace's own, unless a test points it elsewhere). */
export interface SlackConnection {
  accessToken: string;
  baseUrl?: string;
}

/** A connection a movement imports by `name`: an adapter module, the
 *  credential it declares, and where the customer's secret is kept. */
interface Connection {
  name: string;
  module: AdapterModuleDefinition;
  credential: string;
  ref: string;
}

/** What a run may consume. A customer's movement is code the SaaS did not
 *  write: every limit is set, and every run has a cost cap. */
export interface Limits {
  maxSteps: number;
  maxTextBytes: number;
  maxCollectionItems: number;
  maxResultBytes: number;
  /** The most one run may spend on models, in microdollars. */
  costCapMicrodollars: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxSteps: 100_000,
  maxTextBytes: 1024 * 1024,
  maxCollectionItems: 10_000,
  maxResultBytes: 4 * 1024 * 1024,
  costCapMicrodollars: 50_000,
};

interface Customer {
  movements: Map<string, SavedMovement>;
  slack: boolean;
}

interface SavedMovement {
  name: string;
  source: string;
  listeners: FileListener[];
}

/** What a save answers: saved, or why not (the checker's words). */
export type SaveAnswer = { saved: true; listens: number } | { saved: false; problems: string[] };

export interface FiredRun {
  movement: string;
  /** `parked`: the run waits (a sleep), and `tick()` steps it on later. */
  outcome: { ok: true; writes: number; spentMicrodollars: number; parked?: true } | { ok: false; error: string };
}

/** A run the SaaS keeps between its segments: what to re-enter it with. */
interface RunRecord {
  tenant: string;
  movement: string;
  input: Omit<RunInput, 'runId'>;
  spentMicrodollars: number;
  status: 'running' | 'parked' | 'completed' | 'failed';
}

type CatalogSnapshot = RunInput['catalog'];

const quietLog: ModuleLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

export class Embedding {
  readonly companies = new CompanyStore();
  private readonly crm = crmModule(this.companies);
  private readonly vault: MemoryVault = createMemoryVault();
  private readonly secrets = createSecretsFamily({ backend: this.vault });
  private readonly customers = new Map<string, Customer>();
  private readonly runs = new Map<string, RunRecord>();
  private readonly now: () => Date;
  /** Where parked runs wait: their leaves, joins, timers and pinned texts. */
  private readonly runHost: RunHost;

  constructor(private readonly options: { models?: ModelClient; limits?: Limits; now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
    this.runHost = {
      store: memoryRunHostStore({ now: () => this.now().getTime() }),
      keepers: [],
      runs: {
        cancelRequest: async () => null,
        markFailed: async ({ runId }) => this.settle(runId, 'failed'),
      },
    };
  }

  /** The host one run's segments run against: the SaaS's parts, and the run's
   *  own park sink (a park names no run, so the sink is the run's). */
  private hostFor(runId: string, tenant: string): EngineHost {
    return inProcessHost({
      adapters: { resolve: ({ adapterType, teamId, credentialsId }) => this.adapterFor({ adapterType, tenant: teamId, credentialsId }) },
      // A run reaches only its own tenant's connections: the host asks this
      // before it builds an instance for the credential a run names.
      credentials: { belongsTo: ({ teamId, credentialsId }) => this.connectionsOf(teamId).some(({ ref }) => ref === credentialsId) },
      ...(this.options.models !== undefined ? { llm: pricedModels({ client: this.options.models }) } : {}),
      clock: { now: async () => ({ nowIso: this.now().toISOString() }) },
      park: {
        sink: runParkSink(this.runHost, {
          runId,
          teamId: tenant,
          records: { ensureRun: async () => {}, markParked: async () => this.settle(runId, 'parked') },
        }),
        sources: parkSources(this.runHost.store.sources, tenant),
      },
    });
  }

  private settle(runId: string, status: RunRecord['status']): void {
    const run = this.runs.get(runId);
    if (run !== undefined) run.status = status;
  }

  /** A new customer: its own tenant, the fields it defines on `Company`, and
   *  the API key its CRM workspace is reached with, kept in the SaaS's vault. */
  addCustomer(tenant: string, apiKey: string, fields: FieldDefinition[] = []): void {
    this.vault.put(crmRef(tenant), { api_key: apiKey });
    this.companies.defineFields(tenant, fields);
    this.customers.set(tenant, { movements: new Map(), slack: false });
  }

  /** The customer's own Slack workspace: its movements may now import it. */
  connectSlack(tenant: string, slack: SlackConnection): void {
    this.vault.put(slackRef(tenant), { ...slack });
    this.customerOf(tenant).slack = true;
  }

  /** Check a customer's movement against its own catalog; save it if clean. */
  async save(tenant: string, name: string, source: string): Promise<SaveAnswer> {
    const saved = this.customerOf(tenant).movements;
    const catalog = await this.catalogFor(tenant);
    try {
      checkPinnedInRust({ source, catalog, languageVersion: LANGUAGE_VERSION });
    } catch (error) {
      return { saved: false, problems: [error instanceof Error ? error.message : String(error)] };
    }
    const listeners = collectFileListeners(parsePinned({ source, languageVersion: LANGUAGE_VERSION }));
    saved.set(name, { name, source, listeners });
    return { saved: true, listens: listeners.length };
  }

  /** Something happened in a customer's CRM: run each of its movements that
   *  listens for it. */
  async fire(tenant: string, event: DiscriminableEvent): Promise<FiredRun[]> {
    const catalog = await this.catalogFor(tenant);
    const runs: FiredRun[] = [];
    for (const movement of this.customerOf(tenant).movements.values()) {
      for (const listener of movement.listeners) {
        if (listener.adapter !== 'crm' || !eventMatchesTriggerScope(event, listener.config)) continue;
        runs.push({ movement: movement.name, outcome: await this.run(tenant, movement, listener, event, catalog) });
      }
    }
    return runs;
  }

  private async run(tenant: string, movement: SavedMovement, listener: FileListener, event: DiscriminableEvent, catalog: CatalogSnapshot): Promise<FiredRun['outcome']> {
    const limits = this.options.limits ?? DEFAULT_LIMITS;
    const { triggerEvent } = triggerEventOf({
      pipelineInputId: `${movement.name}:${listener.movementName}`,
      adapterType: 'crm',
      triggerType: 'webhook',
      event,
      eventTypes: (await this.adapterFor({ adapterType: 'crm', tenant, credentialsId: crmRef(tenant) }).listEventTypes?.()) ?? [],
      now: this.now(),
    });
    const runId = randomUUID();
    const run: RunRecord = {
      tenant,
      movement: movement.name,
      input: {
        source: movement.source,
        languageVersion: LANGUAGE_VERSION,
        movementName: listener.movementName,
        event: triggerEvent,
        teamId: tenantIdOf(tenant),
        catalog,
        credentialIds: Object.fromEntries(this.connectionsOf(tenant).map(({ name, ref }) => [name, ref])),
        costCapMicrodollars: limits.costCapMicrodollars,
        limits: {
          maxSteps: limits.maxSteps,
          maxTextBytes: limits.maxTextBytes,
          maxCollectionItems: limits.maxCollectionItems,
          maxResultBytes: limits.maxResultBytes,
        },
      },
      spentMicrodollars: 0,
      status: 'running',
    };
    this.runs.set(runId, run);
    try {
      const result = await runMovement({ ...run.input, runId, host: this.hostFor(runId, tenant) });
      run.status = result.parked === true ? 'parked' : 'completed';
      return this.ran(run, result);
    } catch (error) {
      run.status = 'failed';
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** What one segment came to, kept on the run. */
  private ran(run: RunRecord, result: MovementRunResult): FiredRun['outcome'] {
    run.spentMicrodollars = result.runSpentMicrodollars ?? run.spentMicrodollars + (result.spentMicrodollars ?? 0);
    return {
      ok: true,
      writes: result.writes.length,
      spentMicrodollars: run.spentMicrodollars,
      ...(result.parked === true ? { parked: true as const } : {}),
    };
  }

  /** Step on every parked run whose timer is due: each under its run lease,
   *  its due leaves resumed, its next timer re-armed. The SaaS calls this from
   *  a scheduler (or the `POST /tick` route). */
  async tick(): Promise<FiredRun[]> {
    const { store } = this.runHost;
    const stepped: FiredRun[] = [];
    for (const work of await store.work.claimDue({ limit: 100, leaseMs: 60_000, dueBy: this.now().toISOString() })) {
      const runId = String(Reflect.get(Object(work.payload), 'runId'));
      const run = this.runs.get(runId);
      if (work.kind !== 'resume_timer' || run === undefined) {
        await store.work.complete(work);
        continue;
      }
      const outcomes: Array<FiredRun['outcome']> = [];
      await withRunLease(store.leases, runId, (lease) =>
        drainDueTimers(this.runHost, { runId, dueBy: this.now().toISOString(), lease, step: this.stepFor(runId, run, outcomes) }),
      );
      await store.work.complete(work);
      const next = await nextTimerWake(this.runHost, { runId });
      if (next !== null) await armTimerWake(store, { runId, teamId: run.tenant, wakeAt: next });
      for (const outcome of outcomes) stepped.push({ movement: run.movement, outcome });
    }
    return stepped;
  }

  /** One parked run's step: a segment re-entered from its leaf (or a race
   *  settled), on the run's own host, its cost counted from what it spent. */
  private stepFor(runId: string, run: RunRecord, outcomes: Array<FiredRun['outcome']>): StepLeaf {
    return async (request, settle): Promise<StepOutcome> => {
      const input = {
        ...run.input,
        runId,
        priorSpentMicrodollars: run.spentMicrodollars,
        state: request.state,
        host: this.hostFor(runId, run.tenant),
      };
      try {
        const result =
          request.kind === 'leaf'
            ? await resumeMovement({ ...input, ...(request.reenter ? { reenter: true } : {}), deferRaceSettlement: request.deferRaceSettlement })
            : await settleRaceFrame({ ...input, frameAddress: request.frameAddress });
        outcomes.push(this.ran(run, result));
        const deferredRaceFrames = result.deferredRaceFrames ?? [];
        if (result.parked === true) return { kind: 'parked', parkedAddress: result.parkedAddress, deferredRaceFrames };
        if (await settle.runComplete()) run.status = 'completed';
        return { kind: 'completed', deferredRaceFrames };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        run.status = 'failed';
        outcomes.push({ ok: false, error: message });
        return { kind: 'failed', error: message };
      }
    };
  }

  /** What a customer's movements are checked against: each adapter it
   *  holds a connection to, introspected for that customer. */
  private async catalogFor(tenant: string): Promise<CatalogSnapshot> {
    const connections = this.connectionsOf(tenant);
    const adapters = await Promise.all(
      connections.map(async ({ name, module, ref }) => {
        const adapter = this.adapterFor({ adapterType: module.manifest.adapterType, tenant, credentialsId: ref });
        const { schema } = await introspectAdapter(adapter, module.manifest);
        return { manifest: module.manifest, schemas: { [name]: schema } };
      }),
    );
    return buildCatalogSnapshot({
      adapters,
      credentials: Object.fromEntries(connections.map(({ name, module, credential }) => [name, { adapters: [module.manifest.adapterType], credential }])),
      plugins: {},
    });
  }

  private connectionsOf(tenant: string): Connection[] {
    return [
      { name: CREDENTIAL, module: this.crm, credential: 'crm', ref: crmRef(tenant) },
      ...(this.customers.get(tenant)?.slack === true ? [{ name: SLACK_CREDENTIAL, module: slackModule, credential: 'slack', ref: slackRef(tenant) }] : []),
    ];
  }

  /** An adapter module loaded in process for one tenant, over the connection named. */
  private adapterFor(input: { adapterType: string; tenant: string; credentialsId: string | undefined }): Adapter {
    const { adapterType, tenant, credentialsId } = input;
    const connection = this.connectionsOf(tenant).find(({ module }) => module.manifest.adapterType === adapterType);
    if (connection === undefined) throw new Error(`no adapter "${adapterType}" for customer ${tenant}`);
    if (credentialsId === undefined) throw new Error(`the ${adapterType} adapter needs a connection`);
    return adapterInProcess(connection.module, {
      tenant,
      credential: secretsCredential({ name: connection.credential, ref: credentialsId, secrets: this.secrets }),
      log: quietLog,
      files: refusingFiles('the example keeps no files'),
      kv: memoryKv(),
      validateResults: true,
    }).adapter;
  }

  private customerOf(tenant: string): Customer {
    const customer = this.customers.get(tenant);
    if (customer === undefined) throw new Error(`no customer ${tenant}`);
    return customer;
  }
}

function crmRef(tenant: string): string {
  return `crm:${tenant}`;
}

function slackRef(tenant: string): string {
  return `slack:${tenant}`;
}

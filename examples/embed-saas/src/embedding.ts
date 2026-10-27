// The engine inside the SaaS's own process: each customer is a tenant with its
// own CRM records and fields, its own API key and, when it connects one, its
// own Slack workspace (a ready-made module loaded the same way as the SaaS's
// own). The engine's embedded host does the rest: it checks a customer's
// movement when it is saved, runs each one that listens when the CRM raises
// an event, and parks a run that waits (`await sleep(1h)`) until the `tick()`
// past its wake (`@listen-fire/embed`, over the engine's public entries).

import type { IncomingMessage } from 'node:http';

import { createAuthoringHandler, type AuthoringHandler } from '@listen-fire/authoring-mcp';
import { createEmbeddedHost, type EmbeddedHost, type EmbeddedRunLimits, type EmbeddedRunOutcome, type SaveAnswer } from '@listen-fire/embed';
import { pricedModels, type ModelClient } from '@listen-fire/engine/public/embed';
import type { DiscriminableEvent } from '@listen-fire/engine/public/adapter';
import { slackModule } from '@listen-fire/slack';

import { authoringStore, authoringTenant } from './authoring';
import { CompanyStore, crmModule, type FieldDefinition } from './crm';

export type { SaveAnswer };

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

/** What a run may consume. A customer's movement is code the SaaS did not
 *  write: every limit is set, and every run has a cost cap (in microdollars). */
export const DEFAULT_LIMITS = {
  maxSteps: 100_000,
  maxTextBytes: 1024 * 1024,
  maxCollectionItems: 10_000,
  maxResultBytes: 4 * 1024 * 1024,
  costCapMicrodollars: 50_000,
} satisfies EmbeddedRunLimits;

export interface FiredRun {
  movement: string;
  /** `parked`: the run waits (a sleep), and `tick()` steps it on later. */
  outcome: { ok: true; writes: number; spentMicrodollars: number; parked?: true } | { ok: false; error: string };
}

export class Embedding {
  readonly companies = new CompanyStore();
  private readonly crm = crmModule(this.companies);
  private readonly host: EmbeddedHost;
  private readonly kept: ReturnType<typeof authoringStore>;
  /** Each customer's API key: its CRM's credential, and the demo auth of its MCP endpoint. */
  private readonly apiKeys = new Map<string, string>();

  constructor(options: { models?: ModelClient; limits?: EmbeddedRunLimits; now?: () => Date } = {}) {
    this.kept = authoringStore(options.now ?? (() => new Date()));
    this.host = createEmbeddedHost({
      modules: [this.crm, slackModule],
      store: this.kept.store,
      limits: options.limits ?? DEFAULT_LIMITS,
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.models !== undefined ? { engine: { llm: pricedModels({ client: options.models }) } } : {}),
    });
  }

  /** A new customer: its own tenant, the fields it defines on `Company`, and
   *  the API key its CRM workspace is reached with. */
  async addCustomer(tenant: string, apiKey: string, fields: FieldDefinition[] = []): Promise<void> {
    this.companies.defineFields(tenant, fields);
    this.apiKeys.set(tenant, apiKey);
    await this.host.connect(tenant, { name: CREDENTIAL, module: this.crm, credential: { api_key: apiKey } });
  }

  /** The customer's own Slack workspace: its movements may now import it. */
  async connectSlack(tenant: string, slack: SlackConnection): Promise<void> {
    await this.host.connect(tenant, { name: SLACK_CREDENTIAL, module: slackModule, credential: { ...slack } });
  }

  /** Check a customer's movement against its own catalog; save it if clean. */
  save(tenant: string, name: string, source: string): Promise<SaveAnswer> {
    return this.host.save(tenant, { name, source });
  }

  /** Something happened in a customer's CRM: run each of its movements that
   *  listens for it. */
  async fire(tenant: string, event: DiscriminableEvent): Promise<FiredRun[]> {
    return this.kept.runs.record(await this.host.dispatch(tenant, { adapterType: 'crm', event })).map(firedRun);
  }

  /** Step on every parked run whose timer is due. The SaaS calls this from a
   *  scheduler (or the `POST /tick` route). */
  async tick(): Promise<FiredRun[]> {
    return this.kept.runs.record(await this.host.tick()).map(firedRun);
  }

  /**
   * The authoring tools over MCP, mounted at `/customers/:tenant/mcp`: the
   * tenant is the path's, and the request must carry that customer's API key
   * as a bearer token (the example's demo auth; a product uses its own).
   */
  authoringHandler(): AuthoringHandler {
    const { store, programs, runs } = this.kept;
    return createAuthoringHandler({
      tenant: async (request: IncomingMessage) => {
        const tenant = tenantOfPath(request.url ?? '/');
        const key = this.apiKeys.get(tenant ?? '');
        if (tenant === undefined || key === undefined || request.headers.authorization !== `Bearer ${key}`) {
          return { ok: false, status: 401, message: "send the customer's API key as a bearer token" };
        }
        return { ok: true, tenant: authoringTenant({ tenant, host: this.host, store, programs, runs }) };
      },
      instructions: "This is the SaaS's own CRM: a customer's movements read and write its companies, with the fields it defined.",
    });
  }
}

function firedRun({ program, outcome }: EmbeddedRunOutcome): FiredRun {
  if (!outcome.ok) return { movement: program, outcome };
  const { writes, spentMicrodollars, parked } = outcome;
  return { movement: program, outcome: { ok: true, writes: writes.length, spentMicrodollars, ...(parked ? { parked: true as const } : {}) } };
}

/** `acme` from `/customers/acme/mcp`. */
export function tenantOfPath(url: string): string | undefined {
  const [customers, tenant, mcp, ...rest] = url.split('?')[0].split('/').filter(Boolean).map(decodeURIComponent);
  return customers === 'customers' && mcp === 'mcp' && rest.length === 0 ? tenant : undefined;
}

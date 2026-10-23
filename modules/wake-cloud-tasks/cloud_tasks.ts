// The wake on Google Cloud Tasks, as a library: the module's process
// (wake_cloud_tasks.ts) serves it, and a host may import it in-process
// (`@listen-fire/wake-cloud-tasks/cloud_tasks`). It reaches neither the wire
// nor the engine, so that import stays light.
//
// A wake is a task named for its coalescing window (`<job id>-<window
// index>`), whose target starts the drain job with the invoker's OAuth token.
// Cloud Tasks refuses a second task of a name, which is what coalesces a
// burst; it keeps an executed name about an hour, so a window whose task has
// already run is followed by the next window's.

import { GoogleAuth, JWT } from 'google-auth-library';

const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const DEFAULT_BASE_URL = 'https://cloudtasks.googleapis.com';
const DEFAULT_WINDOW_MS = 60_000;
/** Cloud Tasks refuses a scheduleTime further ahead than this. */
const MAX_SCHEDULE_AHEAD_MS = 30 * 24 * 60 * 60 * 1_000;
const CALL_TIMEOUT_MS = 10_000;

const QUEUE = /^projects\/[^/]+\/locations\/[^/]+\/queues\/[^/]+$/;
const JOB = /^projects\/[^/]+\/locations\/[^/]+\/jobs\/[a-z0-9-]+$/;

/** One install's settings, read. */
export interface CloudTasksInstall {
  queue: string;
  job: string;
  /** The job's last segment: the task names' prefix. */
  jobId: string;
  invokerServiceAccount: string;
  windowMs: number;
  baseUrl: string;
  clientEmail?: string;
  privateKey?: string;
}

/** A setting missing or unreadable. Names the setting, never its value. */
export class WakeSettingError extends Error {
  constructor(
    readonly code: 'missing_setting' | 'bad_setting',
    readonly setting: string,
    message: string,
  ) {
    super(message);
  }
}

/** A Cloud Tasks call answered other than as expected: its HTTP status and
 *  Google's `error.status`, never a header. */
export class CloudTasksError extends Error {
  constructor(
    readonly status: number,
    readonly errorStatus: string | undefined,
    call: string,
  ) {
    super(`Cloud Tasks answered ${status}${errorStatus !== undefined ? ` ${errorStatus}` : ''} to ${call}`);
  }
}

function text(settings: Record<string, unknown>, name: string): string | undefined {
  const value = settings[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function required(settings: Record<string, unknown>, name: string, what: string): string {
  const value = text(settings, name);
  if (value === undefined) throw new WakeSettingError('missing_setting', name, `wake_cloud_tasks has no \`${name}\` setting (${what})`);
  return value;
}

export function readInstall(settings: Record<string, unknown>): CloudTasksInstall {
  const queue = required(settings, 'queue', 'the Cloud Tasks queue');
  if (!QUEUE.test(queue)) throw new WakeSettingError('bad_setting', 'queue', "wake_cloud_tasks's `queue` setting is not a queue's name: projects/<project>/locations/<location>/queues/<name>");
  const job = required(settings, 'job', 'the Cloud Run job a task starts');
  if (!JOB.test(job)) throw new WakeSettingError('bad_setting', 'job', "wake_cloud_tasks's `job` setting is not a Cloud Run job's name: projects/<project>/locations/<location>/jobs/<name>");
  const invokerServiceAccount = required(settings, 'invoker_service_account', 'the service account whose token runs the job');
  if (!invokerServiceAccount.includes('@')) throw new WakeSettingError('bad_setting', 'invoker_service_account', "wake_cloud_tasks's `invoker_service_account` setting is not a service account's email");
  const window = text(settings, 'coalesce_window_ms');
  const windowMs = window === undefined ? DEFAULT_WINDOW_MS : Number(window);
  if (!Number.isInteger(windowMs) || windowMs < 1_000 || windowMs > 3_600_000) {
    throw new WakeSettingError('bad_setting', 'coalesce_window_ms', "wake_cloud_tasks's `coalesce_window_ms` setting is not a whole number of milliseconds from 1000 to 3600000");
  }
  const clientEmail = text(settings, 'client_email');
  const privateKey = text(settings, 'private_key');
  if (clientEmail !== undefined && privateKey === undefined) throw new WakeSettingError('missing_setting', 'private_key', 'wake_cloud_tasks has `client_email` but no `private_key`: give both, or neither to use the environment’s own Google credentials');
  if (privateKey !== undefined && clientEmail === undefined) throw new WakeSettingError('missing_setting', 'client_email', 'wake_cloud_tasks has `private_key` but no `client_email`: give both, or neither to use the environment’s own Google credentials');
  return {
    queue,
    job,
    jobId: job.slice(job.lastIndexOf('/') + 1),
    invokerServiceAccount,
    windowMs,
    baseUrl: (text(settings, 'base_url') ?? DEFAULT_BASE_URL).replace(/\/+$/, ''),
    ...(clientEmail !== undefined && privateKey !== undefined ? { clientEmail, privateKey: privateKey.replace(/\\n/g, '\n') } : {}),
  };
}

export interface CloudTasksWakeOptions {
  /** The clock (epoch milliseconds); default `Date.now`. */
  now?: () => number;
  /** The Authorization header value for a call to `url`; default the key pair's locally signed JWT, else the environment's credentials. */
  accessToken?: (url: string) => Promise<string>;
}

/** A key pair's client that signs its own token rather than exchanging it at Google's token endpoint. */
function selfSigned(email: string, key: string): JWT {
  const jwt = new JWT({ email, key, scopes: [SCOPE] });
  // A property, not a constructor option, in google-auth-library 10.
  jwt.useJWTAccessWithScope = true;
  return jwt;
}

/** The Authorization header from the key pair, else the environment's credentials, built once. */
function defaultAccessToken(install: CloudTasksInstall): (url: string) => Promise<string> {
  const client = install.clientEmail !== undefined && install.privateKey !== undefined ? selfSigned(install.clientEmail, install.privateKey) : new GoogleAuth({ scopes: [SCOPE] });
  return async (url) => {
    const authorization = (await client.getRequestHeaders(url)).get('authorization');
    if (authorization === null) throw new Error('the Google credentials gave no Authorization header');
    return authorization;
  };
}

type Created = 'created' | 'exists';

export class CloudTasksWake {
  private readonly clock: () => number;
  private readonly accessToken: (url: string) => Promise<string>;
  private getRefusalLogged = false;

  constructor(
    readonly install: CloudTasksInstall,
    opts: CloudTasksWakeOptions = {},
  ) {
    this.clock = opts.now ?? Date.now;
    this.accessToken = opts.accessToken ?? defaultAccessToken(install);
  }

  taskId(index: number): string {
    return `${this.install.jobId}-${index}`;
  }

  /** Work is due now: this window's task, scheduled now. A present task of
   *  that name is the coalescing; a spent one (already run) makes the next
   *  window's, at its start. */
  async now(_kind: string): Promise<void> {
    const at = this.clock();
    const index = Math.floor(at / this.install.windowMs);
    if ((await this.create(index, at)) === 'created') return;
    if (await this.present(index)) return;
    await this.create(index + 1, (index + 1) * this.install.windowMs);
  }

  /** Work is due at `at`: the task of the window `at` closes, scheduled at
   *  that window's end, so never before `at` and at most a window late. */
  async at(kind: string, at: Date): Promise<void> {
    const now = this.clock();
    const due = at.getTime();
    if (due <= now) return this.now(kind);
    if (due - now > MAX_SCHEDULE_AHEAD_MS) {
      console.warn(`[wake_cloud_tasks] ${kind} work due ${at.toISOString()} is more than 30 days ahead, past Cloud Tasks' limit: no task made; a scheduled drain will find it`);
      return;
    }
    const index = Math.ceil(due / this.install.windowMs);
    await this.create(index, index * this.install.windowMs);
  }

  private taskName(index: number): string {
    return `${this.install.queue}/tasks/${this.taskId(index)}`;
  }

  private async create(index: number, scheduleMs: number): Promise<Created> {
    const url = `${this.install.baseUrl}/v2/${this.install.queue}/tasks`;
    const task = {
      name: this.taskName(index),
      scheduleTime: new Date(scheduleMs).toISOString(),
      httpRequest: {
        url: `https://run.googleapis.com/v2/${this.install.job}:run`,
        httpMethod: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: Buffer.from('{}').toString('base64'),
        oauthToken: { serviceAccountEmail: this.install.invokerServiceAccount, scope: SCOPE },
      },
    };
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: await this.accessToken(url), 'content-type': 'application/json' },
      body: JSON.stringify({ task }),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    if (response.ok) {
      await response.body?.cancel();
      return 'created';
    }
    if (response.status === 409) {
      await response.body?.cancel();
      return 'exists';
    }
    throw new CloudTasksError(response.status, await errorStatusOf(response), 'a task create');
  }

  /** Whether the task of `index` is still waiting to run. */
  private async present(index: number): Promise<boolean> {
    const url = `${this.install.baseUrl}/v2/${this.taskName(index)}`;
    const response = await fetch(url, { headers: { authorization: await this.accessToken(url) }, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
    if (response.ok) {
      await response.body?.cancel();
      return true;
    }
    if (response.status === 404) {
      await response.body?.cancel();
      return false;
    }
    // Without cloudtasks.tasks.get the task cannot be told from a spent one;
    // the next window's task is at worst one more drain.
    if (response.status === 403) {
      await response.body?.cancel();
      if (!this.getRefusalLogged) {
        this.getRefusalLogged = true;
        console.warn("[wake_cloud_tasks] a task get was refused 403: the caller lacks cloudtasks.tasks.get (roles/cloudtasks.viewer), so each coalesced wake also makes the next window's task");
      }
      return false;
    }
    throw new CloudTasksError(response.status, await errorStatusOf(response), 'a task get');
  }
}

async function errorStatusOf(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = await response.json();
    const error: unknown = typeof body === 'object' && body !== null ? Reflect.get(body, 'error') : undefined;
    const status: unknown = typeof error === 'object' && error !== null ? Reflect.get(error, 'status') : undefined;
    return typeof status === 'string' ? status : undefined;
  } catch {
    return undefined;
  }
}

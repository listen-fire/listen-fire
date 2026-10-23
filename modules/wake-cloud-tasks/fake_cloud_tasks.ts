// A fake Google Cloud Tasks, shipped so every host's tests and dev loop can
// run the wake without Google: the two REST calls the module makes (create
// and get a task, in Google's error shapes), the metadata server's token
// endpoint (for a module using the environment's credentials), and a
// dispatcher that "runs" each task at its scheduleTime as Cloud Tasks would,
// presenting the invoker's OAuth token to the job. Names are kept after
// dispatch, as Cloud Tasks keeps an executed name about an hour, so a create
// of a spent name is 409 while its get is 404.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

export interface FakeTask {
  name: string;
  scheduleTime: string;
  httpRequest: {
    url: string;
    httpMethod?: string;
    headers?: Record<string, string>;
    body?: string;
    oauthToken?: { serviceAccountEmail?: string; scope?: string };
    oidcToken?: unknown;
  };
}

export interface FakeCreated {
  name: string;
  scheduleTime: string;
  task: FakeTask;
  /** The create call's own Authorization header. */
  authorization: string;
}

export interface FakeGet {
  name: string;
  authorization: string;
  status: number;
}

export interface FakeRun {
  name: string;
  scheduleTime: string;
  /** When the fake dispatched it (epoch milliseconds, the fake's clock). */
  at: number;
  /** What the job is presented: the invoker's OAuth token. */
  authorization: string;
}

export type FakeCall = 'create' | 'get';

/** A refusal the fake answers instead of the call's own answer. */
export interface FakeFault {
  status: number;
  errorStatus: string;
}

export interface FakeCloudTasksOptions {
  /** `timer`: each task runs at its scheduleTime (plus `dispatchDelayMs`); `manual`: only `dispatchDue()` runs them. Default `timer`. */
  dispatch?: 'timer' | 'manual';
  dispatchDelayMs?: number;
  /** Called as each task runs: the job starting. */
  onRun?: (run: FakeRun) => void | Promise<void>;
  /** The fake's clock (epoch milliseconds); default `Date.now`. A timer dispatch always waits on real time. */
  now?: () => number;
}

export interface FakeCloudTasks {
  /** Cloud Tasks' base URL (the module's `base_url`). */
  url: string;
  /** `host:port` of the metadata token endpoint (`GCE_METADATA_HOST`). */
  metadataHost: string;
  created: FakeCreated[];
  gets: FakeGet[];
  runs: FakeRun[];
  /** Set to refuse calls: answered for each create or get before its own answer. */
  fault: ((call: FakeCall) => FakeFault | undefined) | undefined;
  /** The tasks not yet run. */
  tasks(): FakeTask[];
  /** Run every task whose scheduleTime has come, by the fake's clock. */
  dispatchDue(): Promise<void>;
  close(): Promise<void>;
}

const MAX_SCHEDULE_AHEAD_MS = 30 * 24 * 60 * 60 * 1_000;
const QUEUE = /^projects\/[^/]+\/locations\/[^/]+\/queues\/[^/]+$/;
const TASK_ID = /^[A-Za-z0-9_-]{1,500}$/;
const RUN_JOB = /^https:\/\/run\.googleapis\.com\/v2\/projects\/[^/]+\/locations\/[^/]+\/jobs\/[^/:]+:run$/;

function googleError(response: ServerResponse, code: number, status: string, message: string): void {
  response.writeHead(code, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error: { code, message, status } }));
}

function json(response: ServerResponse, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(200, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(body));
}

async function bodyOf(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  const text = Buffer.concat(chunks).toString('utf8');
  return text === '' ? undefined : JSON.parse(text);
}

const field = (value: unknown, name: string): unknown => (typeof value === 'object' && value !== null ? Reflect.get(value, name) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/** The create body's task, or why Cloud Tasks would refuse it (400 INVALID_ARGUMENT). */
function taskOf(body: unknown, queue: string, now: number): FakeTask | string {
  const task = field(body, 'task');
  const name = text(field(task, 'name'));
  if (name === undefined || !name.startsWith(`${queue}/tasks/`) || !TASK_ID.test(name.slice(queue.length + '/tasks/'.length))) return 'the task name is not a task of this queue';
  const scheduleTime = text(field(task, 'scheduleTime')) ?? new Date(now).toISOString();
  const scheduled = Date.parse(scheduleTime);
  if (Number.isNaN(scheduled)) return 'scheduleTime is not a timestamp';
  if (scheduled - now > MAX_SCHEDULE_AHEAD_MS) return 'scheduleTime is more than 30 days ahead';
  const http = field(task, 'httpRequest');
  const url = text(field(http, 'url'));
  if (url === undefined || !RUN_JOB.test(url)) return 'the target is not a Cloud Run job run (https://run.googleapis.com/v2/projects/*/locations/*/jobs/*:run)';
  if (field(http, 'oidcToken') !== undefined) return 'an oidcToken is for a service URL, not a Google API';
  const oauth = field(http, 'oauthToken');
  const serviceAccountEmail = text(field(oauth, 'serviceAccountEmail'));
  if (serviceAccountEmail === undefined || serviceAccountEmail === '') return 'oauthToken.serviceAccountEmail is missing';
  const headers = field(http, 'headers');
  return {
    name,
    scheduleTime,
    httpRequest: {
      url,
      ...(text(field(http, 'httpMethod')) !== undefined ? { httpMethod: text(field(http, 'httpMethod')) } : {}),
      ...(typeof headers === 'object' && headers !== null ? { headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, String(v)])) } : {}),
      ...(text(field(http, 'body')) !== undefined ? { body: text(field(http, 'body')) } : {}),
      oauthToken: { serviceAccountEmail, ...(text(field(oauth, 'scope')) !== undefined ? { scope: text(field(oauth, 'scope')) } : {}) },
    },
  };
}

export async function fakeCloudTasks(options: FakeCloudTasksOptions = {}): Promise<FakeCloudTasks> {
  const now = options.now ?? Date.now;
  const timerMode = (options.dispatch ?? 'timer') === 'timer';
  const delay = options.dispatchDelayMs ?? 0;
  const pending = new Map<string, FakeTask>();
  const everCreated = new Set<string>();
  const timers = new Set<NodeJS.Timeout>();
  const created: FakeCreated[] = [];
  const gets: FakeGet[] = [];
  const runs: FakeRun[] = [];

  async function run(name: string): Promise<void> {
    const task = pending.get(name);
    if (task === undefined) return;
    pending.delete(name);
    const record: FakeRun = { name, scheduleTime: task.scheduleTime, at: now(), authorization: `Bearer fake-oauth:${task.httpRequest.oauthToken?.serviceAccountEmail ?? ''}` };
    runs.push(record);
    await options.onRun?.(record);
  }

  function arm(task: FakeTask): void {
    const due = Date.parse(task.scheduleTime) + delay;
    const timer = setTimeout(() => {
      timers.delete(timer);
      // A timer may fire a millisecond early; a task never runs before its time.
      if (Date.now() < due) return arm(task);
      void run(task.name);
    }, Math.max(0, due - Date.now()));
    timers.add(timer);
  }

  const fake: FakeCloudTasks = {
    url: '',
    metadataHost: '',
    created,
    gets,
    runs,
    fault: undefined,
    tasks: () => [...pending.values()],
    async dispatchDue() {
      const due = [...pending.values()].filter((task) => Date.parse(task.scheduleTime) <= now()).sort((a, b) => Date.parse(a.scheduleTime) - Date.parse(b.scheduleTime));
      for (const task of due) await run(task.name);
    },
    close: async () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    if (path.startsWith('/computeMetadata/')) {
      if (request.headers['metadata-flavor'] !== 'Google') return googleError(response, 403, 'PERMISSION_DENIED', 'Metadata-Flavor: Google is required');
      if (path === '/computeMetadata/v1/instance/service-accounts/default/token') {
        return json(response, { access_token: 'fake-ambient-token', expires_in: 3600, token_type: 'Bearer' }, { 'Metadata-Flavor': 'Google' });
      }
      response.writeHead(404, { 'Metadata-Flavor': 'Google' });
      return void response.end();
    }
    if (request.method === 'GET' && path === '/_fake/tasks') return json(response, { pending: fake.tasks(), created, runs });

    const create = request.method === 'POST' ? /^\/v2\/(.+)\/tasks$/.exec(path) : null;
    const get = request.method === 'GET' ? /^\/v2\/(.+\/tasks\/[^/]+)$/.exec(path) : null;
    const queue = create?.[1];
    if ((queue === undefined || !QUEUE.test(queue)) && get === null) return googleError(response, 404, 'NOT_FOUND', `no route ${request.method} ${path}`);
    const authorization = request.headers.authorization;
    if (authorization === undefined || !authorization.startsWith('Bearer ')) return googleError(response, 401, 'UNAUTHENTICATED', 'Request is missing required authentication credential.');

    if (queue !== undefined) {
      const body = await bodyOf(request);
      const fault = fake.fault?.('create');
      if (fault !== undefined) return googleError(response, fault.status, fault.errorStatus, 'refused by the fake');
      const task = taskOf(body, queue, now());
      if (typeof task === 'string') return googleError(response, 400, 'INVALID_ARGUMENT', task);
      if (everCreated.has(task.name)) return googleError(response, 409, 'ALREADY_EXISTS', 'Requested entity already exists');
      everCreated.add(task.name);
      pending.set(task.name, task);
      created.push({ name: task.name, scheduleTime: task.scheduleTime, task, authorization });
      if (timerMode) arm(task);
      return json(response, task);
    }

    const name = get?.[1] ?? '';
    const fault = fake.fault?.('get');
    if (fault !== undefined) {
      gets.push({ name, authorization, status: fault.status });
      return googleError(response, fault.status, fault.errorStatus, 'refused by the fake');
    }
    const task = pending.get(name);
    gets.push({ name, authorization, status: task === undefined ? 404 : 200 });
    if (task === undefined) return googleError(response, 404, 'NOT_FOUND', 'Requested entity was not found.');
    return json(response, task);
  }

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => googleError(response, 400, 'INVALID_ARGUMENT', error instanceof Error ? error.message : String(error)));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const bound = server.address();
  if (bound === null || typeof bound === 'string') throw new Error('the fake Cloud Tasks is not on a port');
  fake.url = `http://127.0.0.1:${bound.port}`;
  fake.metadataHost = `127.0.0.1:${bound.port}`;
  return fake;
}

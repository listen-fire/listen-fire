// The Cloud Tasks wake in-process (cloud_tasks.ts, as the platform imports
// it), against the shipped fake in manual mode on one injected clock: how a
// wake becomes a task (its name, its schedule, its target and the token it
// carries), how a burst coalesces, and what each setting refuses.

import { CloudTasksError, CloudTasksWake, WakeSettingError, readInstall, type CloudTasksInstall } from '../cloud_tasks';
import { fakeCloudTasks, type FakeCloudTasks } from '../fake_cloud_tasks';

const MINUTE = 60_000;
/** A unix minute; the clock starts 12.345 s into it. */
const M = 29_871_234;

let clock: number;
let api: FakeCloudTasks;
const tokenAsked: string[] = [];

beforeEach(async () => {
  clock = M * MINUTE + 12_345;
  tokenAsked.length = 0;
  api = await fakeCloudTasks({ dispatch: 'manual', now: () => clock });
});

afterEach(async () => {
  await api.close();
  jest.restoreAllMocks();
});

const settings = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  queue: 'projects/acme/locations/europe-west1/queues/lf-wake',
  job: 'projects/acme/locations/europe-west1/jobs/lf-drain',
  invoker_service_account: 'lf-drain-invoker@acme.iam.gserviceaccount.com',
  base_url: api.url,
  ...extra,
});

function wakeOf(install: CloudTasksInstall = readInstall(settings())): CloudTasksWake {
  return new CloudTasksWake(install, {
    now: () => clock,
    accessToken: async (url) => {
      tokenAsked.push(url);
      return 'Bearer caller-token';
    },
  });
}

const taskName = (index: number) => `projects/acme/locations/europe-west1/queues/lf-wake/tasks/lf-drain-${index}`;
const iso = (ms: number) => new Date(ms).toISOString();

describe('a wake becomes a task', () => {
  it("task names are the job's id and the unix minute at the default window", async () => {
    const wake = wakeOf();
    expect(wake.taskId(M)).toBe('lf-drain-29871234');
    await wake.now('fire_event');
    expect(api.created.map((c) => c.name)).toEqual([taskName(M)]);
  });

  it("ten nows in one window make one task, and a now after it ran makes the next window's", async () => {
    const wake = wakeOf();
    for (let i = 0; i < 10; i++) {
      await wake.now('fire_event');
      clock += 1_000;
    }
    expect(api.created.map((c) => [c.name, c.scheduleTime])).toEqual([[taskName(M), iso(M * MINUTE + 12_345)]]);
    expect(api.tasks()).toHaveLength(1);

    await api.dispatchDue();
    expect(api.runs.map((r) => r.name)).toEqual([taskName(M)]);
    expect(api.tasks()).toHaveLength(0);

    await wake.now('fire_event');
    expect(api.created.map((c) => [c.name, c.scheduleTime])).toEqual([
      [taskName(M), iso(M * MINUTE + 12_345)],
      [taskName(M + 1), iso((M + 1) * MINUTE)],
    ]);
    await wake.now('poll_listen');
    expect(api.created).toHaveLength(2);
  });

  it('an at already past is a task due now, named for this window', async () => {
    await wakeOf().at('resume_timer', new Date(clock - 5 * MINUTE));
    expect(api.created.map((c) => [c.name, c.scheduleTime])).toEqual([[taskName(M), iso(clock)]]);
  });

  it("an at ahead is scheduled at its window's end, never before it", async () => {
    const wake = wakeOf();
    const at = clock + 90_500;
    await wake.at('resume_timer', new Date(at));
    expect(api.created.map((c) => [c.name, c.scheduleTime])).toEqual([[taskName(M + 2), iso((M + 2) * MINUTE)]]);
    expect((M + 2) * MINUTE).toBeGreaterThanOrEqual(at);

    // Another at in that window is the same task; one on a boundary is scheduled for itself.
    await wake.at('fire_cron', new Date(at + 1_000));
    await wake.at('fire_cron', new Date((M + 3) * MINUTE));
    expect(api.created.map((c) => [c.name, c.scheduleTime])).toEqual([
      [taskName(M + 2), iso((M + 2) * MINUTE)],
      [taskName(M + 3), iso((M + 3) * MINUTE)],
    ]);

    clock = (M + 2) * MINUTE - 1;
    await api.dispatchDue();
    expect(api.runs).toHaveLength(0);
    clock = (M + 2) * MINUTE;
    await api.dispatchDue();
    expect(api.runs.map((r) => r.name)).toEqual([taskName(M + 2)]);
  });

  it('an at past 30 days makes no task and answers', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(wakeOf().at('resume_timer', new Date(clock + 31 * 24 * 60 * MINUTE))).resolves.toBeUndefined();
    expect(api.created).toHaveLength(0);
    expect(api.gets).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/30 days/);
  });

  it('a GET refused 403 makes the next window\'s task', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const wake = wakeOf();
    await wake.now('fire_event');
    api.fault = (call) => (call === 'get' ? { status: 403, errorStatus: 'PERMISSION_DENIED' } : undefined);
    await wake.now('fire_event');
    expect(api.gets.map((g) => g.status)).toEqual([403]);
    expect(api.created.map((c) => [c.name, c.scheduleTime])).toEqual([
      [taskName(M), iso(clock)],
      [taskName(M + 1), iso((M + 1) * MINUTE)],
    ]);
    await wake.now('fire_event');
    expect(api.created).toHaveLength(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/cloudtasks\.tasks\.get/);
  });

  it('a 503 from Cloud Tasks is a module_error naming the status and no header', async () => {
    api.fault = () => ({ status: 503, errorStatus: 'UNAVAILABLE' });
    const failed: unknown = await wakeOf().now('fire_event').catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(CloudTasksError);
    const message = String(Reflect.get(Object(failed), 'message'));
    expect(message).toMatch(/503/);
    expect(message).toMatch(/UNAVAILABLE/);
    expect(message).not.toMatch(/caller-token|Bearer|authorization/i);
  });

  it('the task carries the invoker\'s OAuth token for run.googleapis.com, never an OIDC token, and the create call carries the caller\'s own credential', async () => {
    await wakeOf().now('fire_event');
    const [created] = api.created;
    expect(created?.authorization).toBe('Bearer caller-token');
    expect(tokenAsked).toEqual([`${api.url}/v2/projects/acme/locations/europe-west1/queues/lf-wake/tasks`]);
    expect(created?.task.httpRequest).toEqual({
      url: 'https://run.googleapis.com/v2/projects/acme/locations/europe-west1/jobs/lf-drain:run',
      httpMethod: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: Buffer.from('{}').toString('base64'),
      oauthToken: { serviceAccountEmail: 'lf-drain-invoker@acme.iam.gserviceaccount.com', scope: 'https://www.googleapis.com/auth/cloud-platform' },
    });
    expect(JSON.stringify(created?.task)).not.toMatch(/oidcToken/);
    await api.dispatchDue();
    expect(api.runs.map((r) => r.authorization)).toEqual(['Bearer fake-oauth:lf-drain-invoker@acme.iam.gserviceaccount.com']);
  });

  it('the window is the coalescing unit: at 1000 ms the index is the unix second', async () => {
    const wake = wakeOf(readInstall(settings({ coalesce_window_ms: '1000' })));
    await wake.now('fire_event');
    expect(api.created.map((c) => c.name)).toEqual([taskName(Math.floor(clock / 1_000))]);
  });
});

describe('readInstall', () => {
  function refused(extra: Record<string, unknown>, without: string[] = []): WakeSettingError {
    const given = settings(extra);
    for (const name of without) delete given[name];
    try {
      readInstall(given);
    } catch (error) {
      if (error instanceof WakeSettingError) return error;
      throw error;
    }
    throw new Error('readInstall accepted the settings');
  }

  it('reads an install, the key pair unescaped and the defaults filled', () => {
    const install = readInstall(settings({ base_url: undefined, client_email: 'caller@acme.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----' }));
    expect(install).toEqual({
      queue: 'projects/acme/locations/europe-west1/queues/lf-wake',
      job: 'projects/acme/locations/europe-west1/jobs/lf-drain',
      jobId: 'lf-drain',
      invokerServiceAccount: 'lf-drain-invoker@acme.iam.gserviceaccount.com',
      windowMs: 60_000,
      baseUrl: 'https://cloudtasks.googleapis.com',
      clientEmail: 'caller@acme.iam.gserviceaccount.com',
      privateKey: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
    });
  });

  it.each([
    ['queue', 'missing_setting', {}, ['queue']],
    ['queue', 'bad_setting', { queue: 'lf-wake' }, []],
    ['job', 'missing_setting', {}, ['job']],
    ['job', 'bad_setting', { job: 'projects/acme/locations/europe-west1/services/lf-drain' }, []],
    ['invoker_service_account', 'missing_setting', {}, ['invoker_service_account']],
    ['invoker_service_account', 'bad_setting', { invoker_service_account: 'lf-drain-invoker' }, []],
    ['coalesce_window_ms', 'bad_setting', { coalesce_window_ms: '999' }, []],
    ['coalesce_window_ms', 'bad_setting', { coalesce_window_ms: '3600001' }, []],
    ['coalesce_window_ms', 'bad_setting', { coalesce_window_ms: '1500.5' }, []],
    ['private_key', 'missing_setting', { client_email: 'caller@acme.iam.gserviceaccount.com' }, []],
    ['client_email', 'missing_setting', { private_key: 'SECRET-KEY-MATERIAL' }, []],
  ])('refuses %s as %s', (setting, code, extra, without) => {
    const error = refused(extra, without);
    expect(error.code).toBe(code);
    expect(error.setting).toBe(setting);
    expect(error.message).toContain(setting);
    expect(error.message).not.toMatch(/SECRET-KEY-MATERIAL|lf-wake'|services\/lf-drain|3600001/);
  });
});

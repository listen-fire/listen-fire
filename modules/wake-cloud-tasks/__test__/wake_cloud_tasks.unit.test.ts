// The Cloud Tasks module started as the process lf starts (serve.ts), over
// the wire against the shipped fake in timer mode: the wake slot's
// conformance kit (a worker started is a task the fake dispatched), and the
// credential the module calls Cloud Tasks with. A generated service account
// key signs its own tokens, so nothing reaches Google. (A process, not this
// test's own: Google's HTTP client loads its fetch by a dynamic import jest's
// sandbox refuses.)

import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { WAKE_METHODS } from 'engine-contracts/slots';
import { SlotClient, SlotRefused, commonSlotCases, startModule, wakeSlotCases, type StartedModule } from 'module-runtime/module-wire';

import { fakeCloudTasks, type FakeCloudTasks } from '../fake_cloud_tasks';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const CLIENT_EMAIL = 'lf-wake@acme.iam.gserviceaccount.com';
const INVOKER = 'lf-drain-invoker@acme.iam.gserviceaccount.com';
const SERVE = ['--require', require.resolve('tsx/cjs'), resolve(__dirname, '../serve.ts')];

/** A loopback port nothing listens on. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const bound = server.address();
  await new Promise<void>((done) => server.close(() => done()));
  if (bound === null || typeof bound === 'string') throw new Error('no port');
  return bound.port;
}

let served: StartedModule;
let api: FakeCloudTasks;

beforeAll(async () => {
  // Any reach for the environment's credentials fails: the key pair must sign locally.
  served = await startModule(process.execPath, SERVE, { env: { GCE_METADATA_HOST: `127.0.0.1:${await closedPort()}`, GOOGLE_APPLICATION_CREDENTIALS: '' } });
}, 60_000);

afterAll(async () => {
  await served.close();
});

beforeEach(async () => {
  api = await fakeCloudTasks({ dispatch: 'timer' });
});

afterEach(async () => {
  await api.close();
});

const settings = (extra: Record<string, string> = {}): Record<string, string> => ({
  queue: 'projects/acme/locations/europe-west1/queues/lf-wake',
  job: 'projects/acme/locations/europe-west1/jobs/lf-drain',
  invoker_service_account: INVOKER,
  coalesce_window_ms: '1000',
  base_url: api.url,
  client_email: CLIENT_EMAIL,
  private_key: privateKey,
  ...extra,
});

function payloadOf(authorization: string | undefined): Record<string, unknown> {
  const token = authorization?.replace(/^Bearer /, '') ?? '';
  const parsed: unknown = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'));
  return Object(parsed);
}

describe('the wake slot conformance kit', () => {
  for (const conformance of commonSlotCases('wake', WAKE_METHODS)) {
    it(conformance.name, async () => {
      await conformance.run(new SlotClient(served.address, settings()));
    });
  }
  for (const conformance of wakeSlotCases) {
    it(conformance.name, async () => {
      await conformance.run({ client: new SlotClient(served.address, settings()), started: async () => api.runs.map((r) => r.at), slackMs: 2_500 });
    }, 15_000);
  }
});

describe('wake_cloud_tasks', () => {
  it("the module's own call is a locally signed JWT of client_email; nothing leaves loopback", async () => {
    expect(await new SlotClient(served.address, settings()).call('wake.now', { kind: 'fire_event' })).toBeNull();
    const [created] = api.created;
    expect(created?.authorization).toMatch(/^Bearer ey/);
    expect(payloadOf(created?.authorization)).toMatchObject({ iss: CLIENT_EMAIL, scope: 'https://www.googleapis.com/auth/cloud-platform' });
    expect(created?.task.httpRequest.oauthToken).toEqual({ serviceAccountEmail: INVOKER, scope: 'https://www.googleapis.com/auth/cloud-platform' });
  });

  it("with no key pair the module uses the environment's credentials", async () => {
    const ambient = await startModule(process.execPath, SERVE, {
      env: { HOME: mkdtempSync(join(tmpdir(), 'lf-wake-home-')), GOOGLE_APPLICATION_CREDENTIALS: '', GCE_METADATA_HOST: api.metadataHost, METADATA_SERVER_DETECTION: 'assume-present' },
    });
    try {
      const { client_email: _email, private_key: _key, ...rest } = settings();
      expect(await new SlotClient(ambient.address, rest).call('wake.now', { kind: 'fire_event' })).toBeNull();
      expect(api.created.map((c) => c.authorization)).toEqual(['Bearer fake-ambient-token']);
    } finally {
      await ambient.close();
    }
  }, 30_000);

  it('a 503 from Cloud Tasks is refused as module_error, naming the status and no credential', async () => {
    api.fault = () => ({ status: 503, errorStatus: 'UNAVAILABLE' });
    const refused: unknown = await new SlotClient(served.address, settings()).call('wake.now', { kind: 'fire_event' }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(SlotRefused);
    expect(Reflect.get(Object(refused), 'code')).toBe('module_error');
    const message = String(Reflect.get(Object(refused), 'message'));
    expect(message).toMatch(/503 UNAVAILABLE/);
    expect(message).not.toMatch(/Bearer|BEGIN PRIVATE KEY/);
  });

  it('a missing setting is refused naming it and lf connect', async () => {
    const { queue: _queue, ...rest } = settings();
    const refused: unknown = await new SlotClient(served.address, rest).call('wake.now', { kind: 'fire_event' }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(SlotRefused);
    expect(Reflect.get(Object(refused), 'code')).toBe('missing_setting');
    expect(String(Reflect.get(Object(refused), 'message'))).toMatch(/`queue`.*lf connect wake_cloud_tasks/);
  });
});

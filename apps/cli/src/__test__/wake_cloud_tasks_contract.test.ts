// The wake slot's conformance cases (module-runtime `module_wire/
// conformance.ts`) against the Cloud Tasks module (modules/wake-cloud-tasks)
// and its shipped fake Cloud Tasks, whose dispatched tasks are the workers
// started: spoken to directly, and through listen-fire's own client of it (`listen-fire
// --contract-wake-slot`, the project's wake slot filled by the module's own
// lf-external.yaml), so the module listen-fire installs means what the slot says. A
// generated service account key signs the module's calls; nothing reaches
// Google.

import { test } from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WAKE_METHODS } from 'engine-contracts/slots';
import { SlotClient, commonSlotCases, startModule, wakeSlotCases, type StartedModule } from 'movement-engine/public/module-wire';
import { fakeCloudTasks, type FakeCloudTasks } from '../../../../modules/wake-cloud-tasks/fake_cloud_tasks';
import { lfBinary } from './lf_bin';

const MODULE = resolve(__dirname, '../../../../modules/wake-cloud-tasks');

/** How node starts the module's serve.ts. */
const WAKE_MODULE_COMMAND = [process.execPath, '--require', require.resolve('tsx/cjs'), join(MODULE, 'serve.ts')];

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });

const SETTINGS = {
  queue: 'projects/acme/locations/europe-west1/queues/lf-wake',
  job: 'projects/acme/locations/europe-west1/jobs/lf-drain',
  invoker_service_account: 'lf-drain-invoker@acme.iam.gserviceaccount.com',
  coalesce_window_ms: '1000',
  client_email: 'lf-wake@acme.iam.gserviceaccount.com',
  private_key: privateKey,
};

/** A project whose wake slot the module fills, installed by its own lf-external.yaml. */
function wakeCloudTasksProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lf-wake-cloud-tasks-'));
  mkdirSync(join(dir, 'externals/wake_cloud_tasks'), { recursive: true });
  const manifest = readFileSync(join(MODULE, 'lf-external.yaml'), 'utf8').replace(/^command: .*$/m, `command: [${WAKE_MODULE_COMMAND.map((part) => JSON.stringify(part)).join(', ')}]`);
  writeFileSync(join(dir, 'externals/wake_cloud_tasks/lf-external.yaml'), manifest);
  writeFileSync(join(dir, 'lf.yaml'), 'engine: 0.12.0\ncore:\n  wake: wake_cloud_tasks\n');
  return dir;
}

const bridges: Array<{ over: string; start(api: FakeCloudTasks): Promise<{ module: StartedModule; settings: Record<string, string> }> }> = [
  {
    over: 'the Cloud Tasks module',
    start: async (api) => {
      const [command = process.execPath, ...args] = WAKE_MODULE_COMMAND;
      return { module: await startModule(command, args), settings: { ...SETTINGS, base_url: api.url } };
    },
  },
  {
    over: "listen-fire's client of the Cloud Tasks module",
    start: async (api) => ({
      module: await startModule(lfBinary(), ['--contract-wake-slot', '--dir', wakeCloudTasksProject()], {
        env: {
          LF_SECRET__WAKE_CLOUD_TASKS__EXTERNAL: 'wake_cloud_tasks',
          LF_SECRET__WAKE_CLOUD_TASKS__QUEUE: SETTINGS.queue,
          LF_SECRET__WAKE_CLOUD_TASKS__JOB: SETTINGS.job,
          LF_SECRET__WAKE_CLOUD_TASKS__INVOKER_SERVICE_ACCOUNT: SETTINGS.invoker_service_account,
          LF_SECRET__WAKE_CLOUD_TASKS__COALESCE_WINDOW_MS: SETTINGS.coalesce_window_ms,
          LF_SECRET__WAKE_CLOUD_TASKS__BASE_URL: api.url,
          LF_SECRET__WAKE_CLOUD_TASKS__CLIENT_EMAIL: SETTINGS.client_email,
          LF_SECRET__WAKE_CLOUD_TASKS__PRIVATE_KEY: privateKey.replace(/\n/g, '\\n'),
        },
      }),
      settings: {},
    }),
  },
];

for (const bridge of bridges) {
  for (const conformance of commonSlotCases('wake', WAKE_METHODS)) {
    test(`${bridge.over}: ${conformance.name}`, async () => {
      const api = await fakeCloudTasks({ dispatch: 'timer' });
      const { module, settings } = await bridge.start(api);
      try {
        await conformance.run(new SlotClient(module.address, settings));
      } finally {
        await module.close();
        await api.close();
      }
    });
  }
  for (const conformance of wakeSlotCases) {
    test(`${bridge.over}: ${conformance.name}`, async () => {
      const api = await fakeCloudTasks({ dispatch: 'timer' });
      const { module, settings } = await bridge.start(api);
      try {
        await conformance.run({ client: new SlotClient(module.address, settings), started: async () => api.runs.map((run) => run.at), slackMs: 2_500 });
      } finally {
        await module.close();
        await api.close();
      }
    });
  }
}

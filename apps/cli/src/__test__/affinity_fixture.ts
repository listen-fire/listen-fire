// The fake Affinity (modules/affinity/__test__/real_engine), serving a Master
// Deals List and a Portfolio list, as a child process on a free port.

import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const AFFINITY = join(resolve(__dirname, '../../../..'), 'modules/affinity');

export interface Fake {
  url: string;
  requests(): string[];
  stop(): Promise<void>;
}

export async function fakeAffinity(dir: string, options: { twinPersons?: boolean } = {}): Promise<Fake> {
  const plan = join(dir, 'plan.json');
  const log = join(dir, 'requests.log');
  writeFileSync(
    plan,
    JSON.stringify({
      owners: ['daria@project-a.vc'],
      portfolio: true,
      ...options,
      deals: [
        {
          name: 'Veltha',
          host: 'veltha.example',
          founders: [{ first: 'Ada', last: 'Veltha', linkedin: 'https://www.linkedin.com/in/ada-veltha' }],
          seed: 'synced',
          portfolio: { dealCreated: '2026-05-01T00:00:00.000Z', ownership: '12%' },
        },
      ],
    }),
  );
  writeFileSync(log, '');
  const child: ChildProcess = spawn(process.execPath, ['--require', require.resolve('tsx/cjs'), join(AFFINITY, '__test__/real_engine/fake_affinity_server.ts'), plan, log], {
    cwd: AFFINITY,
    env: { ...process.env, PORT: '0' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const exited = new Promise<void>((done) => child.once('exit', () => done()));
  const port = await new Promise<string>((found, failed) => {
    createInterface({ input: child.stdout! }).on('line', (line) => {
      const listening = /listening on (\d+)/.exec(line)?.[1];
      if (listening !== undefined) found(listening);
    });
    void exited.then(() => failed(new Error('the fake Affinity exited before listening')));
  });
  return {
    url: `http://127.0.0.1:${port}`,
    requests: () => readFileSync(log, 'utf8').split('\n').filter((l) => l !== ''),
    stop: async () => (child.kill('SIGTERM'), exited),
  };
}

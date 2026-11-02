// The fake Affinity (modules/affinity/__test__/real_engine), serving a Master
// Deals List and a Portfolio list (and, asked, an opportunity list, Deals), as
// a child process on a free port; a project connecting to it; and a delivery
// signed as Affinity signs it.

import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { RELEASE } from './release';

const AFFINITY = join(resolve(__dirname, '../../../..'), 'modules/affinity');

export interface Fake {
  url: string;
  requests(): string[];
  stop(): Promise<void>;
}

export async function fakeAffinity(dir: string, options: { twinPersons?: boolean; opportunityList?: boolean } = {}): Promise<Fake> {
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

export const AFFINITY_SIGNING_KEY = 'affinity-signing-key';

/** A project with one movement file connecting to the fake as `Affinity`. */
export function affinityProject(fake: Fake, movement: string, lfYaml = ''): string {
  const dir = mkdtempSync(join(tmpdir(), 'lf-affinity-'));
  writeFileSync(join(dir, 'lf.yaml'), `engine: ${RELEASE}\nmovements: movements\nexternals: externals\n${lfYaml}`);
  mkdirSync(join(dir, 'externals/affinity'), { recursive: true });
  writeFileSync(join(dir, 'externals/affinity/lf-external.yaml'), `name: affinity\nkind: adapter\nprotocol: 2\nmodule: ${AFFINITY}\n`);
  mkdirSync(join(dir, '.lf'));
  writeFileSync(join(dir, '.lf/secrets.yaml'), `Affinity:\n  module: affinity\n  credential: affinity\n  apiKey: test-key\n  baseUrl: ${fake.url}\n  webhook_secret: ${AFFINITY_SIGNING_KEY}\n`);
  chmodSync(join(dir, '.lf/secrets.yaml'), 0o600);
  mkdirSync(join(dir, 'movements'));
  writeFileSync(join(dir, 'movements/deal_date.mvt'), movement);
  return dir;
}

/** One Affinity delivery, signed with the account's key as Affinity signs it. */
export async function deliverAffinity(url: string, type: string, body: Record<string, unknown>): Promise<{ status: number; text: string }> {
  const raw = JSON.stringify({ type, body, sent_at: Math.floor(Date.now() / 1000) });
  const answer = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-affinity-webhook-signature': createHmac('sha256', AFFINITY_SIGNING_KEY).update(raw).digest('hex') },
    body: raw,
  });
  return { status: answer.status, text: await answer.text() };
}

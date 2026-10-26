// A record's `List Entries` under lf: an organisation on two Affinity lists
// (the fake Affinity in modules/affinity/__test__/real_engine, serving a
// Master Deals List and a Portfolio list), read through a hop whose WHERE
// pins one list. `lf check` types the hop by that list's own columns, and
// `lf run` returns the Deals entry's `Deal Created` without reading a column
// off the Portfolio entry.

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';

import { lf } from './example';

const REPO = resolve(__dirname, '../../../..');
const AFFINITY = join(REPO, 'modules/affinity');

interface Fake {
  url: string;
  requests(): string[];
  stop(): Promise<void>;
}

async function fakeAffinity(dir: string): Promise<Fake> {
  const plan = join(dir, 'plan.json');
  const log = join(dir, 'requests.log');
  writeFileSync(
    plan,
    JSON.stringify({
      owners: ['daria@project-a.vc'],
      portfolio: true,
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

const MOVEMENT = (hopWhere: string) => `import { affinity } from adapters
import { Affinity } from credentials

crm = connect affinity using Affinity

function \`Deal Date\` (run: <manual-[:Invocation]->>) {
  dates = crm-[o:\`Organization\` WHERE o.\`Name\` == run.Text]->-[le:\`List Entries\` WHERE ${hopWhere}]-> {
    return le.\`Deal Created\`
  }
  return dates
}
listen to manual fire \`Deal Date\`
`;

function project(fake: Fake, hopWhere: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'lf-affinity-lists-'));
  writeFileSync(join(dir, 'lf.yaml'), 'engine: 0.12.0\nmovements: movements\nexternals: externals\n');
  mkdirSync(join(dir, 'externals/affinity'), { recursive: true });
  writeFileSync(join(dir, 'externals/affinity/lf-external.yaml'), `name: affinity\nkind: adapter\nprotocol: 2\nmodule: ${AFFINITY}\n`);
  mkdirSync(join(dir, '.lf'));
  writeFileSync(join(dir, '.lf/secrets.yaml'), `Affinity:\n  external: affinity\n  apiKey: test-key\n  baseUrl: ${fake.url}\n`);
  chmodSync(join(dir, '.lf/secrets.yaml'), 0o600);
  mkdirSync(join(dir, 'movements'));
  writeFileSync(join(dir, 'movements/deal_date.mvt'), MOVEMENT(hopWhere));
  return dir;
}

test("a List Entries hop pinned to one list checks against that list's columns and returns its entry's value", async () => {
  const fake = await fakeAffinity(mkdtempSync(join(tmpdir(), 'lf-affinity-fake-')));
  try {
    for (const hopWhere of ['le.`listName` == "Master Deals List"', 'le.`Status` != "Lost" AND le.`listName` == "Master Deals List"']) {
      const dir = project(fake, hopWhere);
      const checked = lf(dir, 'check');
      assert.equal(checked.code, 0, checked.out);
      const ran = lf(dir, 'run', 'Deal Date', '--text', 'Veltha');
      assert.equal(ran.code, 0, ran.out);
      assert.match(ran.out, /deal_date:Deal Date completed/, ran.out);
      assert.match(ran.out, /returned \["2026-05-01[^"]*"\]/, ran.out);
      // One entry's columns read, ever: the Deals entry's, never the Portfolio entry's.
      const entriesRead = new Set(fake.requests().flatMap((r) => /list_entry_id=(\d+)/.exec(r)?.[1] ?? []));
      assert.equal(entriesRead.size, 1, fake.requests().join('\n'));
    }
  } finally {
    await fake.stop();
  }
});

test('a List Entries hop with no list pinned still reads only what every list has', async () => {
  const fake = await fakeAffinity(mkdtempSync(join(tmpdir(), 'lf-affinity-fake-')));
  try {
    const checked = lf(project(fake, 'le.`listName` != "Portfolio"'), 'check');
    assert.equal(checked.code, 1, checked.out);
    assert.match(checked.out, /MOV_UNKNOWN_PROPERTY crm\.Organization List Entry has no field 'Deal Created'/);
  } finally {
    await fake.stop();
  }
});

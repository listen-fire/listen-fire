// A polled Dealroom round's run walks to the round's company: the edges off a
// fired record read what the module put on the arrival's landing. Against the
// fake Dealroom in packages/fake-channels, every step as a person types it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { lf } from './example';
import { lf as lfAsked, ok } from './interactive';

async function fakeChannels(): Promise<{ url: string; stop(): Promise<void> }> {
  const cwd = mkdtempSync(join(tmpdir(), 'lf-dealroom-fake-'));
  const child: ChildProcess = spawn(process.execPath, [require.resolve('@listen-fire/fake-channels/bin/fake-channels.cjs')], {
    cwd,
    env: { ...process.env, FAKE_CHANNELS_PORT: '0' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const exited = new Promise<void>((done) => child.once('exit', () => done()));
  const url = await new Promise<string>((found, failed) => {
    createInterface({ input: child.stdout! }).on('line', (line) => {
      const port = /running on http:\/\/localhost:(\d+)/.exec(line)?.[1];
      if (port !== undefined) found(`http://127.0.0.1:${port}`);
    });
    void exited.then(() => failed(new Error('fake-channels exited before listening')));
  });
  return { url, stop: async () => (child.kill('SIGTERM'), exited) };
}

/** Dealroom's own instant text: `YYYY-MM-DD HH:MM:SS`, UTC. */
const dealroomInstant = (at: Date) => at.toISOString().slice(0, 19).replace('T', ' ');

test("a polled Dealroom round's run reads the round's Company", async () => {
  const fake = await fakeChannels();
  try {
    const dir = join(mkdtempSync(join(tmpdir(), 'lf-dealroom-')), 'dealroom-project');
    assert.equal(lf(join(dir, '..'), 'init', 'dealroom-project').code, 0);
    await ok(lfAsked(dir, ['connect', '@lf/dealroom', '--yes']));
    await ok(lfAsked(dir, ['credential', 'add', '--module', 'dealroom', 'deals_key'], { answers: ['dev-loop-dealroom-key', `${fake.url}/dealroom`] }));
    writeFileSync(
      join(dir, 'movements/rounds.mvt'),
      `import { \`@lf/dealroom\` as dealroom } from adapters
import { deals_key } from credentials

deals = connect dealroom using deals_key

function triage(r: <deals-[:\`Funding Rounds\`]->>) {
  company = r-[:Company]->
  fail("\${r.Round} for \${company.Name}")
}

listen to deals-[r:\`Funding Rounds\`]-> fire triage
`,
    );
    const checked = lf(dir, 'check');
    assert.equal(checked.code, 0, checked.out);

    const armed = lf(dir, 'run', '--poll', 'triage');
    assert.match(armed.out, /armed; it fires on changes from now/, armed.out);

    const later = dealroomInstant(new Date(Date.now() + 60_000));
    const seeded = await fetch(`${fake.url}/admin/dealroom/seed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        entities: [
          {
            entity_type: 'round',
            id: '99',
            data: {
              id: '99', companyId: '1', date: later.slice(0, 10), year: Number(later.slice(0, 4)), month: Number(later.slice(5, 7)),
              amount: 20, amount_source: 20_000_000, currency: 'USD', round: 'series b', standardised_round_label: 'Series B', valuation: 90,
              is_verified: true, is_undisclosed: false, news_source: null, unknown_investors: [], amount_eur_million: 18.4, amount_usd_million: 20,
              last_updated: `${later.replace(' ', 'T')}+00:00`, last_updated_utc: later, created_utc: later,
            },
          },
        ],
      }),
    });
    assert.equal(seeded.status, 200, await seeded.text());

    const fired = lf(dir, 'run', '--poll', 'triage');
    assert.match(fired.out, /MOVENG_ERROR: series b for Nimbusly/, fired.out);
  } finally {
    await fake.stop();
  }
});

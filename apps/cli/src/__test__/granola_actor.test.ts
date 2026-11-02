// Who a polled Granola meeting came from, read by the run it fires: the
// meeting's owner is its `@actor_email`. Against the fake Granola in
// packages/fake-channels, every step as a person types it.

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
  const cwd = mkdtempSync(join(tmpdir(), 'lf-granola-fake-'));
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

test("a polled Granola meeting's run reads its owner as @actor_email", async () => {
  const fake = await fakeChannels();
  try {
    const dir = join(mkdtempSync(join(tmpdir(), 'lf-granola-')), 'granola-project');
    assert.equal(lf(join(dir, '..'), 'init', 'granola-project').code, 0);
    await ok(lfAsked(dir, ['connect', '@lf/granola', '--yes']));
    await ok(lfAsked(dir, ['credential', 'add', '--module', 'granola', 'notes_key'], { answers: ['test-key', `${fake.url}/granola`] }));
    writeFileSync(
      join(dir, 'movements/meetings.mvt'),
      `import { \`@lf/granola\` as granola } from adapters
import { notes_key } from credentials

notes = connect granola using notes_key

function summarise(n: <notes-[:Meetings]->>) {
  who = @actor_email
  fail("\${n.Title} was held by \${who}")
}

listen to notes-[n:Meetings]-> fire summarise
`,
    );
    const checked = lf(dir, 'check');
    assert.equal(checked.code, 0, checked.out);

    const armed = lf(dir, 'run', '--poll', 'summarise');
    assert.match(armed.out, /armed; it fires on changes from now/, armed.out);

    const later = new Date(Date.now() + 60_000).toISOString();
    const seeded = await fetch(`${fake.url}/admin/granola/seed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        entities: [
          {
            entity_type: 'note',
            id: 'note-1',
            data: {
              id: 'note-1',
              object: 'note',
              title: 'Series A sync',
              owner: { name: 'Priya Owner', email: 'priya@fund.example' },
              created_at: later,
              updated_at: later,
              calendar_event: null,
              attendees: [],
              folder_membership: [],
              summary_text: 'We agreed the terms.',
              summary_markdown: null,
              transcript: null,
            },
          },
        ],
      }),
    });
    assert.equal(seeded.status, 200, await seeded.text());

    const fired = lf(dir, 'run', '--poll', 'summarise');
    assert.match(fired.out, /MOVENG_ERROR: Series A sync was held by priya@fund\.example/, fired.out);
  } finally {
    await fake.stop();
  }
});

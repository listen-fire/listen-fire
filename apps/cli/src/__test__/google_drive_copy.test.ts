// Copying a Drive file with lf: `write (folder-[:Files]->, template-[:Copies]->)`
// against the fake Drive in packages/fake-channels (its files.copy), every step
// as a person types it: lf connect @lf/google-drive (pointed at the fake) →
// lf credential add --headless → the picker's grants (the module's kv) →
// lf check → lf run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { lf as lfSync } from './example';
import { lf, ok } from './interactive';

async function fakeChannels(): Promise<{ url: string; seed(entities: unknown[]): Promise<void>; stop(): Promise<void> }> {
  const cwd = mkdtempSync(join(tmpdir(), 'lf-drive-fake-'));
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
  return {
    url,
    seed: async (entities) => {
      const answer = await fetch(`${url}/admin/gdrive/seed`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entities }) });
      assert.equal(answer.status, 200);
    },
    stop: async () => (child.kill('SIGTERM'), exited),
  };
}

const FOLDER = 'application/vnd.google-apps.folder';
const DOC = 'application/vnd.google-apps.document';

/** A project with the Drive module installed against the fake, signed in as
 *  henry_drive, with the picker's grants kept (the module's kv): a Briefs
 *  folder and a Brief template the app was granted. The fake also holds a
 *  stranger's file the app was not granted. */
async function driveProject(fake: Awaited<ReturnType<typeof fakeChannels>>): Promise<string> {
  const F = fake.url;
  await fake.seed([
    { entity_type: 'file', id: 'fold-briefs', data: { id: 'fold-briefs', name: 'Briefs', mimeType: FOLDER, parents: ['root'], webViewLink: 'https://drive.google.com/drive/folders/fold-briefs', content: null, size: null } },
    { entity_type: 'file', id: 'doc-template', data: { id: 'doc-template', name: 'Brief template', mimeType: DOC, parents: ['root'], webViewLink: 'https://docs.google.com/document/d/doc-template', content: 'Dear {{name}}', size: null } },
    { entity_type: 'file', id: 'doc-stranger', data: { id: 'doc-stranger', name: 'Not yours', mimeType: DOC, parents: ['root'], webViewLink: 'https://docs.google.com/document/d/doc-stranger', content: 'secret', size: null, granted: false } },
  ]);
  const dir = join(mkdtempSync(join(tmpdir(), 'lf-drive-')), 'drive-copy');
  assert.equal(lfSync(join(dir, '..'), 'init', 'drive-copy').code, 0);
  const connected = await ok(
    lf(dir, ['connect', '@lf/google-drive', '--yes', '--base-url', F, '--oauth-authorize-url', `${F}/oauth/authorize`, '--oauth-token-url', `${F}/oauth/token`], {
      answers: ['lf-drive-app', 'lf-drive-secret', '8977'],
    }),
  );
  assert.match(connected, /installed @lf\/google-drive as externals\/google_drive/);
  const adding = lf(dir, ['credential', 'add', '--module', '@lf/google-drive', 'henry_drive', '--credential', 'google', '--headless'], { answers: ['', ''] });
  const authorize = (await adding.line(/^\s+http:\/\/127\.0\.0\.1:\d+\/oauth\/authorize\?/)).trim();
  const location = (await fetch(authorize, { redirect: 'manual' })).headers.get('location');
  assert.ok(location !== null, 'the fake provider redirects back with a code');
  await adding.line(/paste the URL your browser was sent back to/);
  adding.answer(location);
  assert.match(await ok(adding), /added henry_drive/);

  // The module keeps its kv in the install's state folder ({lf}); the picker's
  // grants are what the user chose there.
  appendFileSync(join(dir, 'externals/google_drive/lf-external.yaml'), 'env:\n  MODULE_STATE_DIR: "{lf}"\n');
  grant(dir, ['fold-briefs', FOLDER, 'Briefs'], ['doc-template', DOC, 'Brief template']);
  return dir;
}

const program = (source: string) => `import { google_drive } from adapters
import { henry_drive } from credentials

drive = connect google_drive using henry_drive

function copy(run: <manual-[:Invocation]->>) {
  folder = only(drive-[f:Folders WHERE f.Name == "Briefs"]->)
  if (folder == null) { fail("no Briefs folder") }
${source}
}

listen to manual fire copy
`;

const COPY_AND_RELINK = `  template = only(drive-[t:Files WHERE t.Name == "Brief template"]->)
  if (template == null) { fail("no Brief template") }
  made = write (folder-[:Files]->, template-[:Copies]->) { Name: "Acme brief" }
  again = write (folder-[:Files]->, made-[:Copies]->) { Name: "Acme brief v2" }
  return "\${made.Id}|\${made.Name}|\${made.\`Mime Type\`}|\${made.Url} / \${again.Name}"`;

test('a granted file is copied into a granted folder, and a later write copies the copy', async () => {
  const fake = await fakeChannels();
  try {
    const dir = await driveProject(fake);
    writeFileSync(join(dir, 'movements/hello.mvt'), program(COPY_AND_RELINK));

    const checked = lfSync(dir, 'check');
    assert.equal(checked.code, 0, checked.out);

    const run = lfSync(dir, 'run', 'copy');
    assert.equal(run.code, 0, run.out);
    assert.match(run.out, /2 write\(s\)/);
    const returned = /returned "(.*)"/.exec(run.out)?.[1] ?? '';
    const [first, second] = returned.split(' / ');
    const [id, name, mimeType, url] = first.split('|');
    assert.equal(`${name} ${mimeType}`, `Acme brief ${DOC}`, run.out);
    assert.equal(second, 'Acme brief v2', run.out);
    assert.match(id, /\S+/);
    assert.match(url, /^https:\/\/drive\.google\.com\/file\/d\//, run.out);

    // The fake holds both copies, in the Briefs folder, the second made from the first.
    const copies = (await (await fetch(`${fake.url}/drive/v3/files?q=${encodeURIComponent("'fold-briefs' in parents and trashed = false")}`)).json()) as { files: Array<{ id: string; name: string; mimeType: string }> };
    assert.deepEqual(copies.files.map((f) => f.name).sort(), ['Acme brief', 'Acme brief v2']);
    assert.ok(copies.files.every((f) => f.mimeType === DOC));
    assert.equal(id, copies.files.find((f) => f.name === 'Acme brief')?.id, 'the handle carries the new file\'s id');
    // The second copy was made from the first, by the id the first write returned.
    assert.match(run.out, new RegExp(`Copied doc-template → (\\S+)[\\s\\S]*Copied \\1 → `));
  } finally {
    await fake.stop();
  }
});

test('copying a file the app was not granted fails the run with the reason', async () => {
  const fake = await fakeChannels();
  try {
    const dir = await driveProject(fake);
    // A stale grant: listed here, but Drive no longer lets the app see the file.
    grant(dir, ['fold-briefs', FOLDER, 'Briefs'], ['doc-stranger', DOC, 'Not yours']);
    writeFileSync(
      join(dir, 'movements/hello.mvt'),
      program(`  stranger = only(drive-[s:Files WHERE s.Name == "Not yours"]->)
  if (stranger == null) { fail("no stranger") }
  write (folder-[:Files]->, stranger-[:Copies]->) { Name: "Stolen" }`),
    );
    const run = lfSync(dir, 'run', 'copy');
    assert.notEqual(run.code, 0, run.out);
    assert.match(run.out, /cannot copy doc-stranger.*not granted/i);
  } finally {
    await fake.stop();
  }
});

function grant(dir: string, ...items: Array<[id: string, mimeType: string, name: string]>): void {
  const state = join(dir, '.lf/externals/google_drive');
  mkdirSync(state, { recursive: true });
  const entries = items.map(([id, mimeType, name]) => ({ key: `granted/${id}`, value: { mimeType, name } }));
  writeFileSync(join(state, 'local.json'), JSON.stringify({ entries }));
}

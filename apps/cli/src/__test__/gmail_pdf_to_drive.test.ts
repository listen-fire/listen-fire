// A PDF attached to a Gmail message, filed in Drive with lf, against the fake
// Gmail and fake Drive in packages/fake-channels: the bytes arrive exactly,
// and Drive takes the file's type from the upload's media part (the module
// names no type in the metadata), so it stays application/pdf.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { lf as lfSync } from './example';
import { lf, ok } from './interactive';

const FOLDER = 'application/vnd.google-apps.folder';

async function fakeChannels(): Promise<{ url: string; post(path: string, body: unknown): Promise<unknown>; stop(): Promise<void> }> {
  const cwd = mkdtempSync(join(tmpdir(), 'lf-pdf-fake-'));
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
  const post = async (path: string, body: unknown) => {
    const answer = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(answer.status, 200, await answer.clone().text());
    return answer.json() as Promise<unknown>;
  };
  return { url, post, stop: async () => (child.kill('SIGTERM'), exited) };
}

/** Sign `name` in to the module installed against the fake, as a person types it. */
async function signIn(dir: string, module: string, name: string, credential: string, answers: string[]): Promise<void> {
  const adding = lf(dir, ['credential', 'add', '--module', module, name, '--credential', credential, '--headless'], { answers });
  const authorize = (await adding.line(/^\s+http:\/\/127\.0\.0\.1:\d+\/oauth\/authorize\?/)).trim();
  const location = (await fetch(authorize, { redirect: 'manual' })).headers.get('location');
  assert.ok(location !== null, 'the fake provider redirects back with a code');
  await adding.line(/paste the URL your browser was sent back to/);
  adding.answer(location);
  assert.match(await ok(adding), new RegExp(`added ${name}`));
}

const PROGRAM = `import { gmail, google_drive } from adapters
import { henry_mail, henry_drive } from credentials

mail = connect gmail using henry_mail
drive = connect google_drive using henry_drive

function file_invoice(run: <manual-[:Invocation]->>) {
  msg = only(mail-[m:Messages WHERE m.Subject == "Invoice PW-20417"]->)
  if (msg == null) { fail("no invoice") }
  pdf = first(msg-[a:Attachments WHERE a.\`Content Type\` == "application/pdf"]->)
  if (pdf == null) { fail("no PDF attached") }
  folder = only(drive-[f:Folders WHERE f.Name == "Invoices"]->)
  if (folder == null) { fail("no Invoices folder") }
  write folder-[:Files]-> { Name: pdf.Name, File: pdf.File }
}

listen to manual fire file_invoice
`;

test('a PDF attached to a Gmail message is filed in Drive as application/pdf, byte for byte', async () => {
  const fake = await fakeChannels();
  try {
    const F = fake.url;
    // Bytes that are not utf-8 text, as a PDF's are.
    const bytes = Buffer.concat([Buffer.from('%PDF-1.7\r\n'), Buffer.from([0x00, 0xff, 0xfe, 0x80, 0xc3]), Buffer.from('\r\n%%EOF\n')]);
    await fake.post('/fake-gmail/messages', {
      id: 'm-inv',
      subject: 'Invoice PW-20417',
      bodyText: 'Attached.',
      attachments: [{ filename: 'PW-20417.pdf', contentType: 'application/pdf', contentBase64: bytes.toString('base64') }],
    });
    await fake.post('/admin/gdrive/seed', {
      entities: [{ entity_type: 'file', id: 'fold-inv', data: { id: 'fold-inv', name: 'Invoices', mimeType: FOLDER, parents: ['root'], webViewLink: 'https://drive.google.com/drive/folders/fold-inv', content: null, size: null } }],
    });

    const dir = join(mkdtempSync(join(tmpdir(), 'lf-pdf-')), 'invoices');
    assert.equal(lfSync(join(dir, '..'), 'init', 'invoices').code, 0);
    const oauth = ['--yes', '--base-url', F, '--oauth-authorize-url', `${F}/oauth/authorize`, '--oauth-token-url', `${F}/oauth/token`];
    await ok(lf(dir, ['connect', '@lf/gmail', ...oauth], { answers: ['lf-gmail-app', 'lf-gmail-secret', '8979'] }));
    await ok(lf(dir, ['connect', '@lf/google-drive', ...oauth], { answers: ['lf-drive-app', 'lf-drive-secret', '8977'] }));
    await signIn(dir, 'gmail', 'henry_mail', 'gmail', ['dev-loop@listen-fire.local', '', '', '', '']);
    await signIn(dir, '@lf/google-drive', 'henry_drive', 'google', ['', '']);
    // The Drive picker's grant of the Invoices folder (the module's kv).
    appendFileSync(join(dir, 'externals/google_drive/lf-external.yaml'), 'env:\n  MODULE_STATE_DIR: "{lf}"\n');
    const state = join(dir, '.lf/externals/google_drive');
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, 'local.json'), JSON.stringify({ entries: [{ key: 'granted/fold-inv', value: { mimeType: FOLDER, name: 'Invoices' } }] }));

    writeFileSync(join(dir, 'movements/invoices.mvt'), PROGRAM);
    const checked = lfSync(dir, 'check');
    assert.equal(checked.code, 0, checked.out);
    const run = lfSync(dir, 'run', 'file_invoice');
    assert.equal(run.code, 0, run.out);

    const listed = (await (await fetch(`${F}/drive/v3/files?q=${encodeURIComponent("'fold-inv' in parents and trashed = false")}`)).json()) as {
      files: Array<{ id: string; name: string; mimeType: string; size: number; sha256Checksum: string }>;
    };
    assert.equal(listed.files.length, 1, JSON.stringify(listed));
    const [filed] = listed.files;
    assert.equal(filed.name, 'PW-20417.pdf');
    assert.equal(filed.mimeType, 'application/pdf');
    assert.equal(filed.size, bytes.length);
    assert.equal(filed.sha256Checksum, createHash('sha256').update(bytes).digest('hex'));
    const media = await fetch(`${F}/drive/v3/files/${filed.id}?alt=media`);
    assert.match(media.headers.get('content-type') ?? '', /^application\/pdf/);
    assert.ok(Buffer.from(await media.arrayBuffer()).equals(bytes));
  } finally {
    await fake.stop();
  }
});

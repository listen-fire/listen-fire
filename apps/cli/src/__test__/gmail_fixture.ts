// Gmail with listen-fire against the fake Gmail in packages/fake-channels, set up as a
// person types it: listen-fire connect @lf/gmail (pointed at the fake), then
// listen-fire credential add --headless (the plain sign-in, or the `gmail_drafts` one
// that also asks for the compose scope).

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { lf as lfSync } from './example';
import { lf, ok } from './interactive';

export const MAILBOX = 'dev-loop@listen-fire.local';
export const COMPOSE_SCOPE = 'https://www.googleapis.com/auth/gmail.compose';

export interface Fake {
  url: string;
  message(input: Record<string, unknown>): Promise<string>;
  label(id: string, labels: string[]): Promise<void>;
  makeLabel(name: string): Promise<string>;
  state(): Promise<{ drafts: Array<Record<string, unknown>>; outbox: unknown[] }>;
  stop(): Promise<void>;
}

export async function fakeChannels(): Promise<Fake> {
  const cwd = mkdtempSync(join(tmpdir(), 'lf-gmail-fake-'));
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
  const post = async (path: string, body: unknown): Promise<Record<string, unknown>> => {
    const answer = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(answer.status, 200, await answer.clone().text());
    return (await answer.json()) as Record<string, unknown>;
  };
  return {
    url,
    message: async (input) => String((await post('/fake-gmail/messages', input)).id),
    // Gmail's own endpoint, as a person's mail client (or a filter) labels a message.
    label: async (id, labels) => void (await post(`/gmail/v1/users/me/messages/${id}/modify`, { addLabelIds: labels })),
    makeLabel: async (name) => String((await post('/gmail/v1/users/me/labels', { name })).id),
    state: async () => (await (await fetch(`${url}/fake-gmail/state`)).json()) as { drafts: Array<Record<string, unknown>>; outbox: unknown[] },
    stop: async () => (child.kill('SIGTERM'), exited),
  };
}

/** A project with Gmail installed against the fake and the mailbox signed in
 *  as henry_mail, under the credential named (`gmail`, or `gmail_drafts` for
 *  a sign-in that also asks for the compose scope). Returns the scope the
 *  sign-in asked for. */
export async function gmailProject(fake: Fake, credential: 'gmail' | 'gmail_drafts'): Promise<{ dir: string; asked: string }> {
  const F = fake.url;
  const dir = join(mkdtempSync(join(tmpdir(), 'lf-gmail-')), 'gmail-project');
  assert.equal(lfSync(join(dir, '..'), 'init', 'gmail-project').code, 0);
  const connected = await ok(
    lf(dir, ['connect', '@lf/gmail', '--yes', '--base-url', F, '--oauth-authorize-url', `${F}/oauth/authorize`, '--oauth-token-url', `${F}/oauth/token`], {
      answers: ['lf-gmail-app', 'lf-gmail-secret', '8979'],
    }),
  );
  assert.match(connected, /connected gmail/);
  // The mailbox, then the optional fields a host fills for a delegated mailbox.
  const optional = credential === 'gmail' ? 4 : 6;
  const adding = lf(dir, ['credential', 'add', '--module', 'gmail', 'henry_mail', '--credential', credential, '--headless'], {
    answers: [MAILBOX, ...Array<string>(optional).fill('')],
  });
  const authorize = (await adding.line(/^\s+http:\/\/127\.0\.0\.1:\d+\/oauth\/authorize\?/)).trim();
  const location = (await fetch(authorize, { redirect: 'manual' })).headers.get('location');
  assert.ok(location !== null, 'the fake provider redirects back with a code');
  await adding.line(/paste the URL your browser was sent back to/);
  adding.answer(location);
  assert.match(await ok(adding), /added henry_mail/);
  return { dir, asked: new URL(authorize).searchParams.get('scope') ?? '' };
}

// The stand-ins the demo runs against, no accounts needed: the fake GitHub
// API from the GitHub module's tests, seeded with a morning's notifications,
// and the repo's fake Slack (packages/fake-channels). serve-fakes.cjs starts
// them for a person; the example's test starts the same ones, so the README's
// output and the test's expectations come from one seed.

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

import { startFakeGithub, type FakeGithub, type FakeNotification } from '../../../modules/github/__test__/fake_github';

/** The token the fake GitHub accepts; any other is answered 401. */
export const GITHUB_TOKEN = 'ghp_demo_token';

export interface Fakes {
  /** The API base a GitHub credential names. */
  githubUrl: string;
  /** The API base a Slack credential names. */
  slackUrl: string;
  /** Every message posted to the fake Slack by the bot, `#channel text`. */
  posted(): Promise<string[]>;
  github: FakeGithub;
  stop(): Promise<void>;
}

const FAKE_CHANNELS = resolve(__dirname, '../../../packages/fake-channels/bin/fake-channels.cjs');

/** The fake Slack's channels by id, as packages/fake-channels seeds them. */
const CHANNEL_NAMES: Record<string, string> = { C001: 'general', C002: 'dealflow', C003: 'portfolio' };

/** What the bot posted to the fake Slack at `channelsUrl`, `#channel text`. */
export async function posted(channelsUrl: string): Promise<string[]> {
  const rows = (await (await fetch(`${channelsUrl}/admin/slack/message/state`)).json()) as Array<{ channel: string; text: string; user: string }>;
  return rows.filter((m) => m.user === 'bot').map((m) => `#${CHANNEL_NAMES[m.channel] ?? m.channel} ${m.text}`);
}

/** Starts both fakes and seeds GitHub. `slackPort` 0 picks a free one. */
export async function startFakes(options: { slackPort?: number } = {}): Promise<Fakes> {
  const github = await startFakeGithub({ token: GITHUB_TOKEN });
  seed(github);
  const channels = spawn(process.execPath, [FAKE_CHANNELS], {
    cwd: mkdtempSync(join(tmpdir(), 'github-triage-slack-')),
    env: { ...process.env, FAKE_CHANNELS_PORT: String(options.slackPort ?? 0) },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const exited = new Promise<void>((done) => channels.once('exit', () => done()));
  const channelsUrl = await new Promise<string>((found, failed) => {
    createInterface({ input: channels.stdout }).on('line', (line) => {
      const port = /running on http:\/\/localhost:(\d+)/.exec(line)?.[1];
      if (port !== undefined) found(`http://127.0.0.1:${port}`);
    });
    void exited.then(() => failed(new Error('the fake Slack exited before listening')));
  });
  return {
    githubUrl: github.url,
    slackUrl: `${channelsUrl}/slack/`,
    github,
    posted: () => posted(channelsUrl),
    stop: async () => {
      channels.kill('SIGTERM');
      await Promise.all([exited, github.close()]);
    },
  };
}

/** A morning's inbox: two review requests and a mention need you; a release
 *  you watch and a CI run do not. */
export const INBOX: readonly FakeNotification[] = [
  { id: 'n1', reason: 'review_requested', repo: 'acme/api', type: 'PullRequest', number: 42, title: 'Retry webhook deliveries with backoff', updated_at: '2026-10-29T07:12:00Z' },
  { id: 'n2', reason: 'mention', repo: 'acme/api', type: 'Issue', number: 57, title: 'Webhook retries double-charge on timeout', updated_at: '2026-10-29T06:40:00Z' },
  { id: 'n3', reason: 'review_requested', repo: 'acme/web', type: 'PullRequest', number: 318, title: 'Move settings to the new layout', updated_at: '2026-10-28T17:05:00Z' },
  { id: 'n4', reason: 'subscribed', repo: 'acme/web', type: 'Release', title: 'v2.4.0', updated_at: '2026-10-28T16:00:00Z' },
  { id: 'n5', reason: 'ci_activity', repo: 'acme/api', type: 'CheckSuite', title: 'CI workflow run failed for main', updated_at: '2026-10-28T15:30:00Z' },
];

function seed(github: FakeGithub): void {
  github.repo({ owner: 'acme', name: 'api' });
  github.repo({ owner: 'acme', name: 'web' });
  github.pull('acme/api', { number: 42, title: 'Retry webhook deliveries with backoff', author: 'ada', reviewers: ['you'] });
  github.pull('acme/web', { number: 318, title: 'Move settings to the new layout', author: 'priya', reviewers: ['you'] });
  github.issue('acme/api', { number: 57, title: 'Webhook retries double-charge on timeout', author: 'sam' });
  for (const thread of INBOX) github.notify(thread);
}

/**
 * Points a project's GitHub and Slack credentials at the fakes, as a person
 * does: `listen-fire connect`, then `listen-fire credential add`, its
 * questions answered on stdin. A credential already there is replaced, so
 * the fakes can be started again on new ports. Asynchronous, never
 * `spawnSync`: the fake GitHub answers from this process.
 */
export async function pointAtFakes(dir: string, fakes: Fakes, options: { lf: string; log?: (line: string) => void }): Promise<void> {
  const log = options.log ?? (() => {});
  const lf = async (args: string[], answers: string[] = []): Promise<string> => {
    if (args[1] !== 'list') log(`ran: listen-fire ${args.join(' ')}`);
    const child = spawn(options.lf, args, { cwd: dir, env: { ...process.env, NODE_NO_WARNINGS: '1' } });
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (out += chunk));
    child.stdin.end(answers.map((a) => `${a}\n`).join(''));
    const code = await new Promise<number | null>((done) => child.once('close', done));
    if (code !== 0) throw new Error(`listen-fire ${args.join(' ')} failed:\n${out}`);
    return out;
  };
  const existing = await lf(['credential', 'list']);
  for (const name of ['my_github', 'my_slack']) {
    if (new RegExp(`^${name}\\b`, 'm').test(existing)) await lf(['credential', 'delete', name]);
  }
  await lf(['connect', '@lf/github', '--yes']);
  await lf(['credential', 'add', '--module', '@lf/github', 'my_github'], [GITHUB_TOKEN, fakes.githubUrl]);
  await lf(['connect', '@lf/slack', '--yes'], ['']);
  await lf(['credential', 'add', '--module', '@lf/slack', 'my_slack'], ['xoxb-demo', '', '', fakes.slackUrl]);
}

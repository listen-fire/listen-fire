// A project with `@lf/slack` connected to the fake in packages/fake-channels,
// and the Slack side of a delivery: a door, a signature, an Events API body,
// a press. Shared by the tests that drive Slack end to end.

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { lf as lfSync, type Served } from './example';
import { fakeChannels, type Fake } from './gmail_fixture';
import { lf, ok } from './interactive';

// A workspace-built listen-fire finds its bundled modules beside its own
// (canonical) path; a worktree's listen-fire may be the main checkout's, so the
// modules and serve-module this tree holds are named.
const REPO = resolve(__dirname, '../../../..');
process.env.LF_MODULES_DIR ??= join(REPO, 'modules');
process.env.LF_SERVE_MODULE ??= join(REPO, 'apps/cli/node_modules/.bin/serve-module');

export const SIGNING_SECRET = 'slack-signing-secret';

// No listen names the Slack connection: `listen-fire serve` prints its door
// because a run awaits a record of it.
export const HEADER = `import { \`@lf/slack\` as slack } from adapters
import { team_slack } from credentials

chat = connect slack using team_slack
`;

export interface World {
  dir: string;
  channels: Fake;
  close(): Promise<void>;
}

/** A project with Slack connected to the fake, its deliveries signed with
 *  SIGNING_SECRET, and `program` as its one movement. */
export async function slackWorld(program: string): Promise<World> {
  const channels = await fakeChannels();
  try {
    const dir = join(mkdtempSync(join(tmpdir(), 'lf-slack-')), 'presses');
    assert.equal(lfSync(join(dir, '..'), 'init', 'presses').code, 0);
    await ok(lf(dir, ['connect', '@lf/slack', '--yes', '--webhook-secret', SIGNING_SECRET]));
    await ok(lf(dir, ['credential', 'add', '--module', '@lf/slack', 'team_slack'], { answers: ['xoxb-test', '', '', `${channels.url}/slack/`] }));
    writeFileSync(join(dir, 'movements/slack.mvt'), program);
    return { dir, channels, close: () => channels.stop() };
  } catch (error) {
    await channels.stop();
    throw error;
  }
}

export interface FakeMessage {
  channel: string;
  text: string;
  ts: string;
  user: string;
  blocks: unknown[] | null;
}

export async function botMessages(channels: Fake): Promise<FakeMessage[]> {
  const rows = (await (await fetch(`${channels.url}/admin/slack/message/state`)).json()) as FakeMessage[];
  return rows.filter((m) => m.user === 'bot');
}

/** The door `listen-fire serve` prints for the Slack connection. */
export async function slackDoor(serving: Served): Promise<string> {
  const line = await serving.waitFor(/^slack team_slack: http:\/\/\S+$/);
  return line.slice('slack team_slack: '.length);
}

export interface Signing {
  secret?: string;
  /** Seconds since the epoch the request says it was sent at; now by default. */
  at?: number;
}

/** POST `body` to the Slack door, signed as Slack signs: HMAC-SHA256 of
 *  `v0:<timestamp>:<body>`, keyed by the signing secret. */
export async function deliver(serving: Served, body: string, contentType: string, signing: Signing = {}): Promise<{ status: number; body: string }> {
  const timestamp = String(signing.at ?? Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac('sha256', signing.secret ?? SIGNING_SECRET).update(`v0:${timestamp}:${body}`).digest('hex')}`;
  const response = await fetch(await slackDoor(serving), {
    method: 'POST',
    headers: { 'content-type': contentType, 'x-slack-request-timestamp': timestamp, 'x-slack-signature': signature },
    body,
  });
  return { status: response.status, body: await response.text() };
}

/** Slack's `block_actions` payload for a press of the button valued `value`
 *  on the message `ts` in `channel`, form-encoded as Slack posts it. */
export function press(channel: string, ts: string, value: string, trigger = `trigger-${value}-${ts}`): string {
  const payload = {
    type: 'block_actions',
    trigger_id: trigger,
    user: { id: 'U001', username: 'ada', name: 'ada', team_id: 'T001' },
    api_app_id: 'A001',
    container: { type: 'message', message_ts: ts, channel_id: channel, is_ephemeral: false },
    channel: { id: channel, name: 'general' },
    message: { type: 'message', ts, text: 'Pursue?' },
    actions: [{ type: 'button', action_id: 'lf_button_0', block_id: 'b', value, text: { type: 'plain_text', text: value }, action_ts: `${Date.now() / 1000}` }],
  };
  return new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
}

/** Slack's `block_actions` payload for a press, by `user`, of the button
 *  valued `value` on the message `ts` the fake holds in `channel`, as Slack
 *  posts it: the message pressed comes with it, its blocks included. */
export async function pressOn(channels: Fake, input: { channel: string; ts: string; value: string; user?: string; trigger?: string }): Promise<string> {
  const answer = await fetch(`${channels.url}/slack/control/press`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  const pressed = (await answer.json()) as { ok: boolean; error?: string; payload?: unknown };
  assert.ok(pressed.ok, pressed.error);
  return new URLSearchParams({ payload: JSON.stringify(pressed.payload) }).toString();
}

/** Rows the fake Slack holds, added as a workspace would have them. */
export async function seedSlack(channels: Fake, entities: Array<{ entity_type: string; id: string; data: Record<string, unknown> }>): Promise<void> {
  const answer = await fetch(`${channels.url}/admin/slack/seed`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entities }) });
  assert.equal(answer.status, 200, await answer.text());
}

/** The Web API methods the module called, in order, since the log was last forgotten. */
export async function slackCalls(channels: Fake): Promise<string[]> {
  const rows = (await (await fetch(`${channels.url}/admin/slack/request_log/state`)).json()) as Array<{ method: string }>;
  return rows.map((row) => row.method);
}

export async function forgetSlackCalls(channels: Fake): Promise<void> {
  await fetch(`${channels.url}/admin/slack/request_log/state`, { method: 'DELETE' });
}

/** An Events API delivery of `event`. */
export function eventCallback(event: Record<string, unknown>): string {
  return JSON.stringify({ type: 'event_callback', team_id: 'T001', event_id: `Ev-${Math.random().toString(36).slice(2)}`, event });
}

/** The parked run `name` starts, once `listen-fire run` has parked it. */
export function parkedRun(dir: string, name: string): void {
  const fired = lfSync(dir, 'run', name);
  assert.equal(fired.code, 0, fired.out);
  assert.match(fired.out, new RegExp(`${name} parked`), fired.out);
}


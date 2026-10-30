// `@lf/slack`'s presses and replies, end to end. A project connects the bundled
// Slack module against the fake in packages/fake-channels (as github.test.ts
// does), with the signing secret its deliveries are signed with. A run posts a
// message with Buttons and parks on `await msg-[:Interactions]->`; Slack's
// press arrives at `listen-fire serve`'s door form-encoded (`payload=<json>`)
// and signed with Slack's own scheme (`v0:<timestamp>:<body>`, keyed by the
// signing secret), and the run resumes with the button's value. A thread
// reply, an Events API delivery, resumes `await msg-[:Replies]->`; a deleted
// message settles a wait on it empty. `listen-fire check` types the press's
// value by the Values the write offered.

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { lf as lfSync, served, type Served } from './example';
import { fakeChannels, type Fake } from './gmail_fixture';
import { lf, ok } from './interactive';

// A workspace-built listen-fire finds its bundled modules beside its own
// (canonical) path; a worktree's listen-fire may be the main checkout's, so the
// modules and serve-module this tree holds are named.
const REPO = resolve(__dirname, '../../../..');
process.env.LF_MODULES_DIR ??= join(REPO, 'modules');
process.env.LF_SERVE_MODULE ??= join(REPO, 'apps/cli/node_modules/.bin/serve-module');

const SIGNING_SECRET = 'slack-signing-secret';

const HEADER = `import { \`@lf/slack\` as slack } from adapters
import { team_slack } from credentials

chat = connect slack using team_slack
`;

const PRESS = `${HEADER}
function decide(run: <manual-[:Invocation]->>) {
  general = only(chat-[ch:Channels WHERE ch.Name == "general"]->)
  if (general == null) { fail("no #general channel") }
  msg = write general-[:Messages]-> {
    Message: "Pursue?"
    Buttons: [{ Text: "Pursue", Value: "pursue" }, { Text: "Pass", Value: "pass" }]
  }
  press = await msg-[:Interactions]->
  if (press == null) { return "the message was deleted" }
  choice = only(press-[:Actions]->).Value
  if (choice == "pursue") {
    write general-[:Messages]-> { Message: "chose \${choice}" }
  } else {
    write general-[:Messages]-> { Message: "passed" }
  }
}

listen to manual fire decide
`;

const REPLY = `${HEADER}
function ask(run: <manual-[:Invocation]->>) {
  general = only(chat-[ch:Channels WHERE ch.Name == "general"]->)
  if (general == null) { fail("no #general channel") }
  msg = write general-[:Messages]-> { Message: "Anyone?" }
  reply = await msg-[:Replies]->
  if (reply == null) { return "the message was deleted" }
  write general-[:Messages]-> { Message: "heard \${reply.Message}" }
}

listen to manual fire ask
`;

interface World {
  dir: string;
  channels: Fake;
  close(): Promise<void>;
}

/** A project with Slack connected to the fake, its deliveries signed with
 *  SIGNING_SECRET, and `program` as its one movement. */
async function slackWorld(program: string): Promise<World> {
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

interface FakeMessage {
  channel: string;
  text: string;
  ts: string;
  user: string;
  blocks: unknown[] | null;
}

async function botMessages(channels: Fake): Promise<FakeMessage[]> {
  const rows = (await (await fetch(`${channels.url}/admin/slack/message/state`)).json()) as FakeMessage[];
  return rows.filter((m) => m.user === 'bot');
}

/** POST `body` to the Slack door, signed as Slack signs: HMAC-SHA256 of
 *  `v0:<timestamp>:<body>`, keyed by the signing secret. The door is the
 *  install's (`slack`), which holds the secret `listen-fire connect` was given. */
async function deliver(serving: Served, body: string, contentType: string, secret = SIGNING_SECRET): Promise<{ status: number; body: string }> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`;
  const response = await fetch(`http://127.0.0.1:${serving.port}/hooks/slack/slack`, {
    method: 'POST',
    headers: { 'content-type': contentType, 'x-slack-request-timestamp': timestamp, 'x-slack-signature': signature },
    body,
  });
  return { status: response.status, body: await response.text() };
}

/** Slack's `block_actions` payload for a press of the button valued `value`
 *  on the message `ts` in `channel`, form-encoded as Slack posts it. */
function press(channel: string, ts: string, value: string): string {
  const payload = {
    type: 'block_actions',
    trigger_id: `trigger-${value}-${ts}`,
    user: { id: 'U001', username: 'ada', name: 'ada', team_id: 'T001' },
    api_app_id: 'A001',
    container: { type: 'message', message_ts: ts, channel_id: channel, is_ephemeral: false },
    channel: { id: channel, name: 'general' },
    message: { type: 'message', ts, text: 'Pursue?' },
    actions: [{ type: 'button', action_id: 'lf_button_0', block_id: 'b', value, text: { type: 'plain_text', text: value }, action_ts: `${Date.now() / 1000}` }],
  };
  return new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
}

/** An Events API delivery of `event`. */
function eventCallback(event: Record<string, unknown>): string {
  return JSON.stringify({ type: 'event_callback', team_id: 'T001', event_id: `Ev-${Math.random().toString(36).slice(2)}`, event });
}

/** The parked run `name` starts, once `listen-fire run` has parked it. */
function parkedRun(dir: string, name: string): void {
  const fired = lfSync(dir, 'run', name);
  assert.equal(fired.code, 0, fired.out);
  assert.match(fired.out, new RegExp(`${name} parked`), fired.out);
}

test('a press resumes the run with the button\'s literal value', async () => {
  const world = await slackWorld(PRESS);
  const serving = await served(world.dir);
  try {
    parkedRun(world.dir, 'decide');
    const [posted] = await botMessages(world.channels);
    assert.ok(posted, 'the message was posted');
    assert.deepEqual(posted.blocks?.[1], {
      type: 'actions',
      elements: [
        { type: 'button', text: { type: 'plain_text', text: 'Pursue' }, value: 'pursue', action_id: 'lf_button_0' },
        { type: 'button', text: { type: 'plain_text', text: 'Pass' }, value: 'pass', action_id: 'lf_button_1' },
      ],
    });

    const forged = await deliver(serving, press(posted.channel, posted.ts, 'pursue'), 'application/x-www-form-urlencoded', 'not-the-secret');
    assert.equal(forged.status, 401, forged.body);

    const pressed = await deliver(serving, press(posted.channel, posted.ts, 'pursue'), 'application/x-www-form-urlencoded');
    assert.ok(pressed.status >= 200 && pressed.status < 300, pressed.body);
    await serving.waitFor(/resumed .* slack:decide completed/);
    assert.deepEqual((await botMessages(world.channels)).map((m) => m.text), ['Pursue?', 'chose pursue']);
  } finally {
    await serving.stop();
    await world.close();
  }
});

test('listen-fire check refuses a typo against the written Values', async () => {
  const world = await slackWorld(PRESS.replace('choice == "pursue"', 'choice == "pursu"'));
  try {
    const checked = await lf(world.dir, ['check']).done;
    assert.equal(checked.code, 1, checked.out);
    assert.match(checked.out, /MOV_ENUM_UNKNOWN_VALUE/);
    assert.match(checked.out, /Did you mean "pursue"\?/);
  } finally {
    await world.close();
  }
});

test('a deleted Slack message settles its Interactions wait empty', async () => {
  const world = await slackWorld(PRESS);
  const serving = await served(world.dir);
  try {
    parkedRun(world.dir, 'decide');
    const [posted] = await botMessages(world.channels);
    assert.ok(posted);
    const deleted = await deliver(
      serving,
      eventCallback({ type: 'message', subtype: 'message_deleted', hidden: true, channel: posted.channel, ts: `${Date.now() / 1000}`, deleted_ts: posted.ts }),
      'application/json',
    );
    assert.ok(deleted.status >= 200 && deleted.status < 300, deleted.body);
    await serving.waitFor(/resumed .* slack:decide completed/);
    assert.equal(serving.lines.filter((line) => /slack:decide failed/.test(line)).length, 0, serving.lines.join('\n'));
    // The writes after the wait ran zero times.
    assert.deepEqual((await botMessages(world.channels)).map((m) => m.text), ['Pursue?']);
  } finally {
    await serving.stop();
    await world.close();
  }
});

test('a thread reply resumes await msg-[:Replies]->', async () => {
  const world = await slackWorld(REPLY);
  const serving = await served(world.dir);
  try {
    parkedRun(world.dir, 'ask');
    const [posted] = await botMessages(world.channels);
    assert.ok(posted);
    const reply = { type: 'message', channel: posted.channel, user: 'U001', text: 'me', ts: `${Number(posted.ts) + 1}`, thread_ts: posted.ts };
    const delivered = await deliver(serving, eventCallback(reply), 'application/json');
    assert.ok(delivered.status >= 200 && delivered.status < 300, delivered.body);
    await serving.waitFor(/resumed .* slack:ask completed/);
    assert.deepEqual((await botMessages(world.channels)).map((m) => m.text), ['Anyone?', 'heard me']);
  } finally {
    await serving.stop();
    await world.close();
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { EntityStore } from '../../store';
import { seedDefaults } from '../../seed';
import { FAKE_SLACK_BOT_USER, slackRoutes } from '../slack';
import { adminRoutes } from '../admin';

/**
 * Route-level tests for the fake Slack: a press is built as Slack posts it,
 * the message pressed and its blocks included, and every Web API method the
 * module calls is logged, so a test can say one was never called.
 */

async function bootApp(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'slack-test-')), 'fake-channels.db');
  const store = new EntityStore(dbPath);
  seedDefaults(store);
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use('/slack', slackRoutes(store));
  app.use('/admin', adminRoutes(store));
  const server = await new Promise<import('http').Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://localhost:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

const post = (baseUrl: string, method: string, body: Record<string, unknown>) =>
  fetch(`${baseUrl}/slack/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

test('slack: a press carries the message pressed with its blocks, and the action as its button was posted', async () => {
  const { baseUrl, close } = await bootApp();
  try {
    const blocks = [
      { type: 'section', text: { type: 'mrkdwn', text: 'Lunch?' } },
      { type: 'actions', block_id: 'lf:lunch-poll', elements: [{ type: 'button', text: { type: 'plain_text', text: 'In' }, value: 'in', action_id: 'lf_button_0' }] },
    ];
    const posted = await post(baseUrl, 'chat.postMessage', { channel: 'C001', text: 'Lunch?', blocks });
    const pressed = await post(baseUrl, 'control/press', { channel: 'C001', ts: posted.ts, value: 'in', user: 'U002', trigger: 't-1' });
    assert.equal(pressed.ok, true);
    assert.deepEqual(pressed.payload.message, { type: 'message', ts: posted.ts, text: 'Lunch?', user: 'bot', blocks });
    assert.deepEqual(pressed.payload.actions[0].block_id, 'lf:lunch-poll');
    assert.deepEqual(pressed.payload.actions[0].action_id, 'lf_button_0');
    assert.deepEqual(pressed.payload.user, { id: 'U002', username: 'priya', name: 'priya', team_id: 'T001' });
    assert.deepEqual(pressed.payload.container, { type: 'message', message_ts: posted.ts, channel_id: 'C001', is_ephemeral: false });
    assert.equal(pressed.payload.trigger_id, 't-1');
    // A value no button offers, or a message in another channel, is no press.
    assert.equal((await post(baseUrl, 'control/press', { channel: 'C001', ts: posted.ts, value: 'out' })).error, 'no_such_button');
    assert.equal((await post(baseUrl, 'control/press', { channel: 'C002', ts: posted.ts, value: 'in' })).error, 'message_not_found');
  } finally {
    await close();
  }
});

test('slack: auth.test names the bot user, and every Web API method called is logged in order', async () => {
  const { baseUrl, close } = await bootApp();
  try {
    assert.equal((await post(baseUrl, 'auth.test', {})).user_id, FAKE_SLACK_BOT_USER);
    await post(baseUrl, 'conversations.info', { channel: 'C001' });
    await post(baseUrl, 'control/press', { channel: 'C001', ts: 'x', value: 'in' });
    const log = (await (await fetch(`${baseUrl}/admin/slack/request_log/state`)).json()) as Array<{ method: string }>;
    assert.deepEqual(log.map((row) => row.method), ['auth.test', 'conversations.info']);
  } finally {
    await close();
  }
});

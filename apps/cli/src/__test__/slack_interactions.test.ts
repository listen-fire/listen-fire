// `@lf/slack`'s presses and replies, end to end. A project connects the bundled
// Slack module against the fake in packages/fake-channels (as github.test.ts
// does), with the signing secret its deliveries are signed with. A run posts a
// message with Buttons and parks on `await msg-[:Interactions]->`; Slack's
// press (the fake's, carrying the message pressed with its blocks, as
// Slack's does) arrives at `listen-fire serve`'s door form-encoded (`payload=<json>`)
// and signed with Slack's own scheme (`v0:<timestamp>:<body>`, keyed by the
// signing secret), and the run resumes with the button's value. A thread
// reply, an Events API delivery, resumes `await msg-[:Replies]->` (a deleted
// message: deleted_heads.test.ts). `listen-fire check` types the press's
// value by the Values the write offered. Every delivery goes to the door
// `listen-fire serve` prints for the project's Slack connection, which no
// listen names: the credential's, verified with the signing secret
// `listen-fire connect` put on the install.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { served } from './example';
import { lf } from './interactive';
import { HEADER, botMessages, deliver, eventCallback, parkedRun, press, pressOn, slackWorld } from './slack_world';

const PRESS = `${HEADER}
function decide(run: <manual-[:Invocations]->>) {
  general = only(chat-[ch:Channels WHERE ch.Name == "general"]->)
  if (general == null) { fail("no #general channel") }
  msg = write general-[:Messages]-> {
    Message: "Pursue?"
    Buttons: [{ Text: "Pursue", Value: "pursue" }, { Text: "Pass", Value: "pass" }]
  }
  press = await msg-[:Interactions]->
  choice = only(press-[:Actions]->)?.Value
  if (choice == "pursue") {
    write general-[:Messages]-> { Message: "chose \${choice}" }
  } else {
    write general-[:Messages]-> { Message: "passed" }
  }
}

listen to manual-[:Invocations]-> fire decide
`;

const REPLY = `${HEADER}
function ask(run: <manual-[:Invocations]->>) {
  general = only(chat-[ch:Channels WHERE ch.Name == "general"]->)
  if (general == null) { fail("no #general channel") }
  msg = write general-[:Messages]-> { Message: "Anyone?" }
  reply = await msg-[:Replies]->
  write general-[:Messages]-> { Message: "heard \${reply.Message}" }
}

listen to manual-[:Invocations]-> fire ask
`;

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

    const pursue = await pressOn(world.channels, { channel: posted.channel, ts: posted.ts, value: 'pursue' });
    const forged = await deliver(serving, pursue, 'application/x-www-form-urlencoded', { secret: 'not-the-secret' });
    assert.equal(forged.status, 401, forged.body);
    const replayed = await deliver(serving, pursue, 'application/x-www-form-urlencoded', { at: Math.floor(Date.now() / 1000) - 6 * 60 });
    assert.equal(replayed.status, 401, replayed.body);

    const pressed = await deliver(serving, pursue, 'application/x-www-form-urlencoded');
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

// The expense approval's shape: the press awaited in a race arm and walked
// off where it is read, the receipt read after the race. An awaited record is
// present where it is read, so nothing guards it.
const APPROVAL = `${HEADER}
function review(run: <manual-[:Invocations]->>) {
  finance = only(chat-[ch:Channels WHERE ch.Name == "general"]->)
  if (finance == null) { fail("no #general channel") }
  msg = write finance-[:Messages]-> {
    Message: "Ada spent £600 on a monitor"
    Buttons: [{ Text: "Approve", Value: "approve" }, { Text: "Reject", Value: "reject" }]
  }
  r = race(
    () => {
      press = await msg-[:Interactions]->
      return { choice: only(press-[:Actions]->)?.Value, by: press-[:By]->.Name }
    },
    () => { await sleep(1d) },
  )
  if (r[0] == null) {
    write msg { Message: "\${msg.Message} (expired: nobody answered within a day)" }
    return "expired"
  }
  write msg { Message: "\${msg.Message} (\${r[0].choice}d by \${r[0].by})" }
}

listen to manual-[:Invocations]-> fire review
`;

test('the expense approval checks clean: an awaited press is walked off unguarded', async () => {
  const world = await slackWorld(APPROVAL);
  try {
    const checked = await lf(world.dir, ['check']).done;
    assert.equal(checked.code, 0, checked.out);
  } finally {
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

test('two presses at once resume the run once', async () => {
  const world = await slackWorld(PRESS);
  const serving = await served(world.dir);
  try {
    parkedRun(world.dir, 'decide');
    const [posted] = await botMessages(world.channels);
    assert.ok(posted);
    const form = 'application/x-www-form-urlencoded';
    const presses = await Promise.all([
      pressOn(world.channels, { channel: posted.channel, ts: posted.ts, value: 'pursue', trigger: 'trigger-a' }),
      pressOn(world.channels, { channel: posted.channel, ts: posted.ts, value: 'pass', trigger: 'trigger-b' }),
    ]);
    const answers = await Promise.all(presses.map((pressed) => deliver(serving, pressed, form)));
    for (const answer of answers) assert.ok(answer.status >= 200 && answer.status < 300, answer.body);
    await serving.waitFor(/resumed .* slack:decide completed/);
    // Long enough for a second resume to have written, had there been one.
    await new Promise((settle) => setTimeout(settle, 1500));
    const after = (await botMessages(world.channels)).map((m) => m.text);
    assert.equal(after.length, 2, after.join(' | '));
    assert.ok(after[1] === 'chose pursue' || after[1] === 'passed', after[1]);
    assert.equal(serving.lines.filter((line) => /slack:decide (completed|failed)/.test(line)).length, 1, serving.lines.join('\n'));
  } finally {
    await serving.stop();
    await world.close();
  }
});

test('a press on a message no run waits for is answered and resumes nothing', async () => {
  const world = await slackWorld(PRESS);
  const serving = await served(world.dir);
  try {
    parkedRun(world.dir, 'decide');
    const [posted] = await botMessages(world.channels);
    assert.ok(posted);
    const form = 'application/x-www-form-urlencoded';
    const elsewhere = await deliver(serving, press(posted.channel, '1600000000.000100', 'pursue'), form);
    assert.ok(elsewhere.status >= 200 && elsewhere.status < 300, elsewhere.body);
    await new Promise((settle) => setTimeout(settle, 1500));
    assert.equal(serving.lines.filter((line) => /resumed/.test(line)).length, 0, serving.lines.join('\n'));
    assert.deepEqual((await botMessages(world.channels)).map((m) => m.text), ['Pursue?']);
    // The run still waits on its own message.
    await deliver(serving, await pressOn(world.channels, { channel: posted.channel, ts: posted.ts, value: 'pursue' }), form);
    await serving.waitFor(/resumed .* slack:decide completed/);
    assert.deepEqual((await botMessages(world.channels)).map((m) => m.text), ['Pursue?', 'chose pursue']);
  } finally {
    await serving.stop();
    await world.close();
  }
});

// Telegram with listen-fire, end to end: a listen on the bot's `Messages`
// narrowed to one chat by the message's own `Chat Id`, a message delivered
// through the door the bot's webhook points at, and `listen-fire upgrade`
// rewriting a 0.12 `listen to tg {}`. Telegram cannot list chats, so the
// chat is a field of the message, not a hop before it.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { until } from './attio_fixture';
import { lf, served } from './example';
import { lf as interactive, ok } from './interactive';

const SECRET = 'tok';

const HEARD = `import { telegram } from adapters
import { tg } from credentials

bot = connect telegram using tg

function heard(m: <bot-[:Messages]->>) {
  return "\${m.Text} from \${m.\`Sender First Name\`} in chat \${m.\`Chat Id\`}"
}

listen to bot-[m:Messages WHERE m.\`Chat Id\` == "42"]-> fire heard
`;

/** A project with the Telegram module connected as a person connects it: the
 *  bot's token entered, the webhook's secret token the one Telegram echoes. */
async function telegramProject(movement: string): Promise<string> {
  const dir = join(mkdtempSync(join(tmpdir(), 'lf-telegram-')), 'tg-project');
  assert.equal(lf(join(dir, '..'), 'init', 'tg-project').code, 0);
  await ok(interactive(dir, ['connect', '@lf/telegram', '--yes', '--webhook-secret', SECRET], { answers: [] }));
  await ok(interactive(dir, ['credential', 'add', '--module', 'telegram', 'tg', '--credential', 'telegram'], { answers: ['123:BOT', ''] }));
  // The door finds the install by the secret the credential holds.
  const secrets = join(dir, '.lf/secrets.yaml');
  writeFileSync(secrets, readFileSync(secrets, 'utf8').replace(/^tg:\n/m, `tg:\n  webhook_secret: ${SECRET}\n`));
  writeFileSync(join(dir, 'movements/heard.mvt'), movement);
  return dir;
}

const update = (id: number, chat: number, text: string, message = id) => ({
  update_id: id,
  message: { message_id: message, date: 1_760_000_000 + id, chat: { id: chat, type: 'private' }, from: { id: chat, is_bot: false, first_name: chat === 42 ? 'Ada' : 'Bob' }, text },
});

async function deliver(url: string, body: unknown, token = SECRET): Promise<{ status: number; text: string }> {
  const answer = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': token }, body: JSON.stringify(body) });
  return { status: answer.status, text: await answer.text() };
}

test('a listen on Messages narrowed by Chat Id runs on that chat\'s messages once, and on no other chat\'s', async () => {
  const dir = await telegramProject(HEARD);
  const checked = lf(dir, 'check');
  assert.equal(checked.code, 0, checked.out);
  // Telegram has no `Chat` to hop through, and a field the message lacks is refused where it is written.
  writeFileSync(join(dir, 'movements/heard.mvt'), HEARD.replace('m.`Chat Id`', 'm.Chat'));
  const refused = lf(dir, 'check');
  assert.notEqual(refused.code, 0, refused.out);
  assert.match(refused.out, /MOV_UNKNOWN_PROPERTY .*no field 'Chat'/);
  writeFileSync(join(dir, 'movements/heard.mvt'), HEARD);

  const serving = await served(dir);
  try {
    const url = (await serving.waitFor(/^telegram tg: /)).replace(/^telegram tg: /, '');
    const runs = () => serving.lines.filter((l) => /^run \S+ heard:heard completed$/.test(l)).length;

    const first = await deliver(url, update(1, 42, 'hello'));
    assert.equal(first.status, 202, first.text);
    await until(() => runs() === 1, serving.lines);

    // Telegram resends an update it saw no 2xx for: the same message is the same arrival.
    const again = await deliver(url, update(1, 42, 'hello'));
    assert.ok(again.status < 300, again.text);
    // Another chat's message with the same id is another message, in a chat the listen does not take.
    const other = await deliver(url, update(2, 43, 'psst', 1));
    assert.equal(other.status, 202, other.text);
    // Telegram numbers a message within its chat: this is the chat's second, not a repeat.
    const second = await deliver(url, update(3, 42, 'again', 2));
    assert.equal(second.status, 202, second.text);
    // An update that carries no message, and one the bot's secret does not sign, run nothing.
    await deliver(url, { update_id: 4, edited_message: { message_id: 1, chat: { id: 42 }, text: 'edit' } });
    assert.equal((await deliver(url, update(5, 42, 'forged'), 'nope')).status, 401);

    await until(() => runs() === 2, serving.lines);
    await new Promise((done) => setTimeout(done, 500));
    assert.equal(runs(), 2, serving.lines.join('\n'));
  } finally {
    await serving.stop();
  }
  const listed = JSON.parse(lf(dir, 'runs', '--json').out) as { runs: Array<{ runId: string }> };
  const returned = listed.runs.map((r) => lf(dir, 'runs', 'show', r.runId, '--json').out);
  assert.ok(returned.some((out) => out.includes('hello from Ada in chat 42')), returned.join('\n'));
  assert.ok(returned.some((out) => out.includes('again from Ada in chat 42')), returned.join('\n'));
  assert.ok(!returned.some((out) => out.includes('psst')), returned.join('\n'));
});

test('upgrade rewrites a 0.12 listen to tg {} onto Messages and retypes its parameter, and the result checks clean', async () => {
  const old = `import { telegram } from adapters
import { tg } from credentials

bot = connect telegram using tg

function heard(m: <bot-[:Message]->>) {
  return m.Text
}

listen to bot {} fire heard
`;
  const dir = await telegramProject(old);
  const lfYaml = join(dir, 'lf.yaml');
  writeFileSync(lfYaml, readFileSync(lfYaml, 'utf8').replace(/^engine: .*$/m, 'engine: 0.12.13'));
  const upgraded = lf(dir, 'upgrade');
  assert.equal(upgraded.code, 0, upgraded.out);
  assert.equal(
    readFileSync(join(dir, 'movements/heard.mvt'), 'utf8'),
    old.replace('<bot-[:Message]->>', '<bot-[:Messages]->>').replace('listen to bot {} fire heard', 'listen to bot-[:Messages]-> fire heard'),
  );
  const checked = lf(dir, 'check');
  assert.equal(checked.code, 0, checked.out);
  assert.doesNotMatch(checked.out, /MOV_LISTEN_SETTINGS_RETIRED/);
});

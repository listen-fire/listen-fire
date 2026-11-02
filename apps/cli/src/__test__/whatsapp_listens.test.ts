// WhatsApp with listen-fire, end to end: a message, a reaction and a location
// each arrive on an edge of their own (`Messages`, `Reactions`, `Locations`),
// so a reaction runs a listen on `Reactions` and never one on `Messages`. A
// delivery goes through the door Meta's webhook points at, signed with the
// Meta app's secret. WhatsApp cannot list conversations, so a listen narrows
// to one by the sender's number on the record itself. `listen-fire upgrade`
// rewrites a 0.12 `listen to wa { events }` onto the edge its events arrive on.

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { until } from './attio_fixture';
import { lf, served } from './example';
import { lf as interactive, ok } from './interactive';

const APP_SECRET = 'meta-app-secret';

const LISTENS = `import { whatsapp } from adapters
import { wa } from credentials

number = connect whatsapp using wa

function heard(m: <number-[:Messages]->>) {
  return "message \${m.Body} from \${m.From}"
}

function reacted(r: <number-[:Reactions]->>) {
  return "reaction \${r.Emoji} to \${r.\`Reacted Message Id\`}"
}

function shared(l: <number-[:Locations]->>) {
  return "location \${l.Name}"
}

listen to number-[m:Messages WHERE m.From == "447700900001"]-> fire heard
listen to number-[r:Reactions]-> fire reacted
listen to number-[l:Locations]-> fire shared
`;

/** A project with the WhatsApp module connected as a person connects it: the
 *  Meta access token and the number's id entered, the app's secret what the
 *  door verifies a delivery with. */
async function whatsappProject(movement: string): Promise<string> {
  const dir = join(mkdtempSync(join(tmpdir(), 'lf-whatsapp-')), 'wa-project');
  assert.equal(lf(join(dir, '..'), 'init', 'wa-project').code, 0);
  await ok(interactive(dir, ['connect', '@lf/whatsapp', '--yes', '--webhook-secret', APP_SECRET], { answers: [] }));
  await ok(
    interactive(dir, ['credential', 'add', '--module', 'whatsapp', 'wa', '--credential', 'whatsapp'], {
      answers: ['EAAtoken', 'PN-1', '', '', '', ''],
    }),
  );
  const secrets = join(dir, '.lf/secrets.yaml');
  writeFileSync(secrets, readFileSync(secrets, 'utf8').replace(/^wa:\n/m, `wa:\n  webhook_secret: ${APP_SECRET}\n`));
  writeFileSync(join(dir, 'movements/whatsapp.mvt'), movement);
  return dir;
}

type Message = Record<string, unknown>;

const envelope = (messages: Message[]) => ({
  object: 'whatsapp_business_account',
  entry: [{ changes: [{ field: 'messages', value: { metadata: { display_phone_number: '+447700900000' }, contacts: [{ profile: { name: 'Ada' } }], messages } }] }],
});

const text = (id: string, body: string, from = '447700900001'): Message => ({ from, id, timestamp: '1760000000', type: 'text', text: { body } });
const reaction = (id: string, on: string, emoji: string, from = '447700900001'): Message => ({ from, id, timestamp: '1760000050', type: 'reaction', reaction: { message_id: on, emoji } });
const location = (id: string, name: string, from = '447700900001'): Message => ({ from, id, timestamp: '1760000100', type: 'location', location: { latitude: 51.5, longitude: -0.12, name } });

async function deliver(url: string, messages: Message[], secret = APP_SECRET): Promise<{ status: number; text: string }> {
  const body = JSON.stringify(envelope(messages));
  const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  const answer = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature }, body });
  return { status: answer.status, text: await answer.text() };
}

test('a reaction runs a listen on Reactions and never one on Messages; a message and a location likewise run only their own', async () => {
  const dir = await whatsappProject(LISTENS);
  const checked = lf(dir, 'check');
  assert.equal(checked.code, 0, checked.out);
  // A reaction is not the message it is on: it has no Body.
  writeFileSync(join(dir, 'movements/whatsapp.mvt'), LISTENS.replace('r.Emoji', 'r.Body'));
  const refused = lf(dir, 'check');
  assert.notEqual(refused.code, 0, refused.out);
  assert.match(refused.out, /MOV_UNKNOWN_PROPERTY .*no field 'Body'/);
  writeFileSync(join(dir, 'movements/whatsapp.mvt'), LISTENS);

  const serving = await served(dir);
  try {
    const url = (await serving.waitFor(/^whatsapp wa: /)).replace(/^whatsapp wa: /, '');
    const ran = (movement: string) => serving.lines.filter((l) => new RegExp(`^run \\S+ whatsapp:${movement} completed$`).test(l)).length;

    // Only a reaction arrives: the Reactions listen runs, the Messages one does not.
    assert.equal((await deliver(url, [reaction('wamid.R1', 'wamid.T1', '👍')])).status, 202);
    await until(() => ran('reacted') === 1, serving.lines);
    await new Promise((done) => setTimeout(done, 500));
    assert.deepEqual([ran('heard'), ran('reacted'), ran('shared')], [0, 1, 0], serving.lines.join('\n'));

    // A message runs only the Messages listen, and only for the sender it names.
    assert.equal((await deliver(url, [text('wamid.T1', 'hello')])).status, 202);
    assert.equal((await deliver(url, [text('wamid.T2', 'psst', '447700900002')])).status, 202);
    await until(() => ran('heard') === 1, serving.lines);
    // Meta resends a delivery it saw no 2xx for: the same wamid is the same arrival.
    assert.ok((await deliver(url, [text('wamid.T1', 'hello')])).status < 300);

    // A location runs only the Locations listen.
    assert.equal((await deliver(url, [location('wamid.L1', 'Home')])).status, 202);
    await until(() => ran('shared') === 1, serving.lines);

    // A delivery Meta's app did not sign runs nothing.
    assert.equal((await deliver(url, [text('wamid.T3', 'forged')], 'other')).status, 401);
    await new Promise((done) => setTimeout(done, 500));
    assert.deepEqual([ran('heard'), ran('reacted'), ran('shared')], [1, 1, 1], serving.lines.join('\n'));
  } finally {
    await serving.stop();
  }
  const listed = JSON.parse(lf(dir, 'runs', '--json').out) as { runs: Array<{ runId: string }> };
  const returned = listed.runs.map((r) => lf(dir, 'runs', 'show', r.runId, '--json').out).join('\n');
  assert.match(returned, /message hello from 447700900001/);
  assert.match(returned, /reaction 👍 to wamid\.T1/);
  assert.match(returned, /location Home/);
  assert.doesNotMatch(returned, /psst|forged/);
});

test('upgrade rewrites a 0.12 listen to wa { events } onto the edge its events arrive on, and holds the pin on one naming two kinds', async () => {
  const old = (events: string) => `import { whatsapp } from adapters
import { wa } from credentials

number = connect whatsapp using wa

function got(x: <number-[:${events === '["reaction"]' ? 'Reaction' : events === '["location"]' ? 'Location' : 'Message'}]->>) {
  return "got it"
}

listen to number ${events === '' ? '' : `{ events: ${events} } `}fire got
`;
  const dir = await whatsappProject(old('["reaction"]'));
  const file = join(dir, 'movements/whatsapp.mvt');
  const lfYaml = join(dir, 'lf.yaml');
  const pinned = () => writeFileSync(lfYaml, readFileSync(lfYaml, 'utf8').replace(/^engine: .*$/m, 'engine: 0.12.13'));

  for (const [events, edge, type] of [
    ['["reaction"]', 'Reactions', 'Reaction'],
    ['["location"]', 'Locations', 'Location'],
    ['["message"]', 'Messages', 'Message'],
    // It heard messages only when it named no events.
    ['', 'Messages', 'Message'],
  ] as const) {
    writeFileSync(file, old(events));
    pinned();
    const upgraded = lf(dir, 'upgrade');
    assert.equal(upgraded.code, 0, upgraded.out);
    assert.equal(
      readFileSync(file, 'utf8'),
      old(events).replace(`<number-[:${type}]->>`, `<number-[:${edge}]->>`).replace(/listen to number [^\n]*fire got/, `listen to number-[:${edge}]-> fire got`),
    );
    const checked = lf(dir, 'check');
    assert.equal(checked.code, 0, checked.out);
    assert.doesNotMatch(checked.out, /MOV_LISTEN_SETTINGS_RETIRED/);
  }

  // A message and a reaction arrive on two edges, so there is no one listen to rewrite it to.
  const both = old('["message", "reaction"]');
  writeFileSync(file, both);
  pinned();
  const held = lf(dir, 'upgrade');
  assert.equal(held.code, 1, held.out);
  assert.match(held.out, /its events arrive on `Messages` and `Reactions`, so write one listen for each/);
  assert.equal(readFileSync(file, 'utf8'), both);
});

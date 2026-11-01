// `@lf/slack`'s standing listens, end to end, against the fake Slack in
// packages/fake-channels. Each listen ends on the edge a record arrives on —
// a channel's `Messages`, a message's `Reactions` or `Interactions` — and what
// arrives carries the records above it: a message its channel, a press its
// channel and the message pressed. So a filter on those hops is judged on the
// arrival itself. The lunch poll is the standing replacement for a callback
// that answered more than once: every press on a message written with the
// poll's `Topic` is its own run, its vote kept in an Airtable table one row
// per poll and member (by the member's id: two members may share a name).

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { until } from './attio_fixture';
import { lf as lfSync, served, type Served } from './example';
import { lf, ok } from './interactive';
import { HEADER, botMessages, deliver, eventCallback, forgetSlackCalls, pressOn, seedSlack, slackCalls, slackWorld, type World } from './slack_world';

const LUNCH_POLL = readFileSync(join(__dirname, 'movements/lunch_poll/lunch_poll.mvt'), 'utf8');
const FORM = 'application/x-www-form-urlencoded';

const OFFICE = 'C0OFFICE';
const POLL_BLOCKS = (topic: string) => [
  { type: 'section', text: { type: 'mrkdwn', text: 'Lunch on Friday?' } },
  {
    type: 'actions',
    block_id: topic,
    elements: [
      { type: 'button', text: { type: 'plain_text', text: 'In' }, value: 'in', action_id: 'lf_button_0' },
      { type: 'button', text: { type: 'plain_text', text: 'Out' }, value: 'out', action_id: 'lf_button_1' },
    ],
  },
];
const DAY = 86_400;

/** A message the bot posted in #office at `ts`, its buttons under the block
 *  id `blockId`. */
function posted(ts: number, blockId: string) {
  const id = ts.toFixed(6);
  return { entity_type: 'message', id, data: { channel: OFFICE, ts: id, text: 'Lunch on Friday?', user: 'bot', blocks: POLL_BLOCKS(blockId) } };
}

interface Vote {
  Poll: unknown;
  PersonId: unknown;
  Person: unknown;
  Answer: unknown;
}

interface LunchWorld extends World {
  votes(): Promise<Vote[]>;
}

/** The lunch poll's project: Slack and Airtable connected to the fake, an
 *  #office channel, and an Office base whose Lunch table holds the votes. */
async function lunchWorld(): Promise<LunchWorld> {
  const world = await slackWorld(LUNCH_POLL);
  try {
    const url = world.channels.url;
    await seedSlack(world.channels, [{ entity_type: 'channel', id: OFFICE, data: { id: OFFICE, name: 'office', is_private: false, is_member: true } }]);
    const seeded = await fetch(`${url}/admin/airtable/seed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        entities: [
          { entity_type: 'base', id: 'appOFFICE', data: { id: 'appOFFICE', name: 'Office' } },
          {
            entity_type: 'table:appOFFICE',
            id: 'tblLUNCH',
            data: {
              id: 'tblLUNCH',
              name: 'Lunch',
              primaryFieldId: 'fldPoll',
              fields: [
                { id: 'fldPoll', name: 'Poll', type: 'singleLineText' },
                { id: 'fldPersonId', name: 'Person Id', type: 'singleLineText' },
                { id: 'fldPerson', name: 'Person', type: 'singleLineText' },
                { id: 'fldAnswer', name: 'Answer', type: 'singleLineText' },
              ],
            },
          },
        ],
      }),
    });
    assert.equal(seeded.status, 200, await seeded.text());
    await ok(lf(world.dir, ['connect', '@lf/airtable', '--yes', '--base-url', `${url}/airtable`, '--oauth-authorize-url', `${url}/oauth/authorize`, '--oauth-token-url', `${url}/oauth/token`, '--client-id', 'lf-airtable-app', '--client-secret', 'lf-airtable-secret', '--redirect-port', '8984']));
    const adding = lf(world.dir, ['credential', 'add', '--module', '@lf/airtable', 'team_airtable', '--credential', 'airtable', '--headless'], { answers: ['', ''] });
    const authorize = (await adding.line(/^\s+http:\/\/127\.0\.0\.1:\d+\/oauth\/authorize\?/)).trim();
    const location = (await fetch(authorize, { redirect: 'manual' })).headers.get('location');
    assert.ok(location !== null);
    await adding.line(/paste the URL your browser was sent back to/);
    adding.answer(location);
    await ok(adding);
    return {
      ...world,
      // The module writes a row's cells by their field ids.
      votes: async () => {
        const rows = (await (await fetch(`${url}/admin/airtable/record:appOFFICE:tblLUNCH/state`)).json()) as Array<{ fields: Record<string, unknown> }>;
        return rows.map(({ fields }) => ({ Poll: fields.fldPoll, PersonId: fields.fldPersonId, Person: fields.fldPerson, Answer: fields.fldAnswer }));
      },
    };
  } catch (error) {
    await world.close();
    throw error;
  }
}

/** How many of `serving`'s runs of `fn` completed. */
const completed = (serving: Served, fn: string) => serving.lines.filter((line) => new RegExp(`^run \\S+ slack:${fn} completed$`).test(line)).length;

/** Wednesday's tick at 10:00 London, as the cron unit hands it to `ask_lunch`. */
const LUNCH_TICK = JSON.stringify({
  external: 'cron',
  event: {
    arrivals: [
      {
        edge: 'Ticks',
        identity: 'tick:0 10 * * 3:Europe/London:2026-10-28T10:00:00.000Z',
        landing: { recordType: 'Tick', fields: { 'Fired at': '2026-10-28T10:00:00.000Z', Schedule: '0 10 * * 3', Zone: 'Europe/London' } },
        occurredAt: '2026-10-28T10:00:00.000Z',
      },
    ],
  },
});

test('every press on a lunch poll is its own run, judged on arrival with no listing of messages', async () => {
  const world = await lunchWorld();
  try {
    // The program is the whole lunch poll, and it checks clean.
    const checked = lfSync(world.dir, 'check');
    assert.equal(checked.code, 0, checked.out);

    // The tick posts the poll, its Topic on its buttons' block.
    writeFileSync(join(world.dir, 'tick.json'), LUNCH_TICK);
    const asked = lfSync(world.dir, 'run', '--event', 'tick.json');
    assert.equal(asked.code, 0, asked.out);
    assert.match(asked.out, /ask_lunch completed/);
    const [poll, ...others] = await botMessages(world.channels);
    assert.equal(others.length, 0);
    assert.equal(poll.channel, OFFICE);
    assert.deepEqual(
      (poll.blocks ?? []).map((block) => Reflect.get(Object(block), 'block_id')).filter((id) => id !== undefined),
      ['lf:lunch-poll'],
    );

    const serving = await served(world.dir);
    try {
      await forgetSlackCalls(world.channels);

      const vote = async (user: string, value: string) => {
        const delivered = await deliver(serving, await pressOn(world.channels, { channel: OFFICE, ts: poll.ts, value, user }), FORM);
        assert.ok(delivered.status >= 200 && delivered.status < 300, delivered.body);
      };
      await vote('U001', 'in');
      await until(() => completed(serving, 'count_vote') === 1, serving.lines);
      await vote('U002', 'out');
      await until(() => completed(serving, 'count_vote') === 2, serving.lines);
      // Ada changes her mind: a third run, and her row on this poll is replaced.
      await vote('U001', 'out');
      await until(() => completed(serving, 'count_vote') === 3, serving.lines);

      const votes = await world.votes();
      assert.deepEqual(
        votes.map((v) => [v.Poll, v.PersonId, v.Person, v.Answer]).sort(),
        [
          [`${OFFICE}:${poll.ts}`, 'U001', 'ada', 'out'],
          [`${OFFICE}:${poll.ts}`, 'U002', 'priya', 'out'],
        ],
      );
      // The poll's Topic and age were judged off each press: its channel's history was never listed.
      const calls = await slackCalls(world.channels);
      assert.ok(!calls.includes('conversations.history'), calls.join(', '));
    } finally {
      await serving.stop();
    }
  } finally {
    await world.close();
  }
});

test('a press on a message without the topic, or on a poll older than 3d, runs nothing', async () => {
  const world = await lunchWorld();
  try {
    const serving = await served(world.dir);
    try {
      const now = Date.now() / 1000;
      const other = posted(now - 120, 'b');
      const stale = posted(now - 4 * DAY, 'lf:lunch-poll');
      const fresh = posted(now - 60, 'lf:lunch-poll');
      await seedSlack(world.channels, [other, stale, fresh]);

      for (const ts of [other.id, stale.id]) {
        const delivered = await deliver(serving, await pressOn(world.channels, { channel: OFFICE, ts, value: 'in', user: 'U001' }), FORM);
        assert.ok(delivered.status >= 200 && delivered.status < 300, delivered.body);
      }
      // The press on this week's poll runs, after both of those were taken.
      await deliver(serving, await pressOn(world.channels, { channel: OFFICE, ts: fresh.id, value: 'in', user: 'U001' }), FORM);
      await until(() => completed(serving, 'count_vote') === 1, serving.lines);
      await new Promise((settle) => setTimeout(settle, 500));
      assert.equal(completed(serving, 'count_vote'), 1, serving.lines.join('\n'));
      assert.deepEqual((await world.votes()).map((vote) => vote.Poll), [`${OFFICE}:${fresh.id}`]);
    } finally {
      await serving.stop();
    }
  } finally {
    await world.close();
  }
});

const DEALS = `${HEADER}
function heard(m: <chat-[:Message]->>) {
  return "heard \${m.Message} in \${m.Channel}"
}

listen to chat-[ch:Channels WHERE ch.Name IN ["deals"]]->-[:Messages]-> fire heard
`;

test('a message in #deals fires a channel-filtered listen; one in #random does not', async () => {
  const world = await slackWorld(DEALS);
  try {
    await seedSlack(world.channels, [
      { entity_type: 'channel', id: 'C0DEALS', data: { id: 'C0DEALS', name: 'deals', is_private: false, is_member: true } },
      { entity_type: 'channel', id: 'C0RANDOM', data: { id: 'C0RANDOM', name: 'random', is_private: false, is_member: true } },
    ]);
    const checked = lfSync(world.dir, 'check');
    assert.equal(checked.code, 0, checked.out);
    const serving = await served(world.dir);
    try {
      const ts = (Date.now() / 1000).toFixed(6);
      const message = (channel: string, text: string, extra: Record<string, unknown> = {}) =>
        eventCallback({ type: 'message', channel, user: 'U001', text, ts, ...extra });
      for (const body of [
        message('C0RANDOM', 'lunch?'),
        // A reply in a #deals thread is its thread's, not one of the channel's Messages.
        message('C0DEALS', 'in the thread', { ts: `${Number(ts) + 1}`, thread_ts: ts }),
        message('C0DEALS', 'Acme wants a term sheet'),
      ]) {
        const delivered = await deliver(serving, body, 'application/json');
        assert.ok(delivered.status >= 200 && delivered.status < 300, delivered.body);
      }
      // Slack retries a delivery it saw no answer to: the same message, the same arrival.
      await deliver(serving, message('C0DEALS', 'Acme wants a term sheet'), 'application/json');
      await until(() => completed(serving, 'heard') === 1, serving.lines);
      await new Promise((settle) => setTimeout(settle, 500));
      assert.equal(completed(serving, 'heard'), 1, serving.lines.join('\n'));
    } finally {
      await serving.stop();
    }
    const listed = JSON.parse(lfSync(world.dir, 'runs', '--json').out) as { runs: Array<{ runId: string }> };
    const returned = listed.runs.map((r) => lfSync(world.dir, 'runs', 'show', r.runId).out).join('\n');
    assert.match(returned, /heard Acme wants a term sheet in C0DEALS/);
    assert.doesNotMatch(returned, /lunch\?|in the thread/);
  } finally {
    await world.close();
  }
});

test('in a Slack outage a message is still taken: a listen filtering its channel cannot be judged and is noted once, one that does not runs', async () => {
  const world = await slackWorld(`${HEADER}
function heard(m: <chat-[:Message]->>) {
  return "heard \${m.Message}"
}

function every(m: <chat-[:Message]->>) {
  return "every \${m.Message}"
}

listen to chat-[ch:Channels WHERE ch.Name IN ["deals"]]->-[:Messages]-> fire heard
listen to chat-[:Channels]->-[:Messages]-> fire every
`);
  try {
    await seedSlack(world.channels, [{ entity_type: 'channel', id: 'C0DEALS', data: { id: 'C0DEALS', name: 'deals', is_private: false, is_member: true } }]);
    await fetch(`${world.channels.url}/slack/control/outage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ methods: ['conversations.info'] }) });
    const serving = await served(world.dir);
    try {
      const ts = (Date.now() / 1000).toFixed(6);
      const started = Date.now();
      const delivered = await deliver(serving, eventCallback({ type: 'message', channel: 'C0DEALS', user: 'U001', text: 'Acme', ts }), 'application/json');
      // Taken within Slack's three seconds: the lookup is not retried.
      assert.ok(delivered.status >= 200 && delivered.status < 300, delivered.body);
      assert.ok(Date.now() - started < 3000, `${Date.now() - started}ms`);
      await until(() => completed(serving, 'every') === 1, serving.lines);
      await serving.waitFor(/slack:heard: an arrival on Messages cannot be judged \(slack could not read Name of the Channels record the arrival carries, which this listen's filter reads\): it runs nothing/);
      await new Promise((settle) => setTimeout(settle, 500));
      assert.equal(completed(serving, 'heard'), 0, serving.lines.join('\n'));
      // Kept once, for the listen that could not judge it (`Arrival Not Judged`), naming the kept delivery.
      const db = new DatabaseSync(join(world.dir, '.lf', 'state.db'));
      try {
        const facts = db.prepare('select pipeline, delivery_id as deliveryId, edge, record_id as recordId from arrival_unjudged').all().map((row) => ({ ...row }));
        assert.equal(facts.length, 1, JSON.stringify(facts));
        assert.match(String(facts[0]?.pipeline), /^listen:slack:heard:[0-9a-f]{8}$/);
        assert.deepEqual([facts[0]?.edge, facts[0]?.recordId], ['Messages', `C0DEALS:${ts}`]);
        assert.equal(db.prepare('select id from delivery where id = ?').all(String(facts[0]?.deliveryId)).length, 1);
      } finally {
        db.close();
      }
    } finally {
      await serving.stop();
    }
  } finally {
    await world.close();
  }
});

test('after a Slack outage, `listens replay` puts the kept delivery through the listen that could not judge it, and that listen alone', async () => {
  const world = await slackWorld(`${HEADER}
function heard(m: <chat-[:Message]->>) {
  return "heard \${m.Message}"
}

function every(m: <chat-[:Message]->>) {
  return "every \${m.Message}"
}

listen to chat-[ch:Channels WHERE ch.Name IN ["deals"]]->-[:Messages]-> fire heard
listen to chat-[:Channels]->-[:Messages]-> fire every
`);
  const outage = (methods: string[]) =>
    fetch(`${world.channels.url}/slack/control/outage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ methods }) });
  const ran = (fn: string) => (JSON.parse(lfSync(world.dir, 'runs', '--json').out) as { runs: Array<{ movement: string; status: string }> }).runs.filter((r) => r.movement === fn && r.status === 'completed').length;
  const facts = () => {
    const db = new DatabaseSync(join(world.dir, '.lf', 'state.db'));
    try {
      return db.prepare('select pipeline, arrival, attempt, delivery_id as deliveryId from arrival_unjudged order by attempt').all().map((row) => ({ ...row }));
    } finally {
      db.close();
    }
  };
  try {
    await seedSlack(world.channels, [{ entity_type: 'channel', id: 'C0DEALS', data: { id: 'C0DEALS', name: 'deals', is_private: false, is_member: true } }]);
    await outage(['conversations.info']);
    const serving = await served(world.dir);
    const text = 'Acme wants a term sheet';
    try {
      const ts = (Date.now() / 1000).toFixed(6);
      const delivered = await deliver(serving, eventCallback({ type: 'message', channel: 'C0DEALS', user: 'U001', text, ts }), 'application/json');
      assert.ok(delivered.status >= 200 && delivered.status < 300, delivered.body);
      await until(() => completed(serving, 'every') === 1, serving.lines);
      await serving.waitFor(/slack:heard: an arrival on Messages cannot be judged/);
    } finally {
      await serving.stop();
    }
    const [first] = facts();
    assert.ok(first, 'the listen that could not judge it is noted');
    const deliveryId = String(first.deliveryId);

    // The request is kept, and printed only when asked for.
    const shown = lfSync(world.dir, 'deliveries', 'show', deliveryId);
    assert.equal(shown.code, 0, shown.out);
    const delivery = (JSON.parse(shown.out) as { delivery: Record<string, unknown> }).delivery;
    assert.equal(delivery.requestKept, true);
    assert.equal('request' in delivery, false, shown.out);
    const asked = (JSON.parse(lfSync(world.dir, 'deliveries', 'show', deliveryId, '--request').out) as { delivery: { request: { body: string; headers: Record<string, string> } } }).delivery.request;
    assert.match(Buffer.from(asked.body, 'base64').toString('utf8'), new RegExp(text));
    assert.deepEqual(Object.keys(asked.headers).filter((h) => h.startsWith('x-slack')), [], 'no signature is kept');

    // Still down: the replay cannot judge it either, and is reported again as attempt 1.
    const stillDown = lfSync(world.dir, 'listens', 'replay', 'slack:heard', '--delivery', deliveryId);
    assert.equal(stillDown.code, 0, stillDown.out);
    assert.match(stillDown.out, /slack:heard: the arrival \S+ on Messages still cannot be judged \(slack could not read Name of the Channels record the arrival carries, which this listen's filter reads\): reported again, attempt 1/);
    assert.deepEqual(facts().map((f) => [f.attempt, f.deliveryId]), [[0, deliveryId], [1, deliveryId]], 'each failed attempt is its own fact, naming the delivery that keeps the request');
    assert.equal(ran('heard'), 0);

    // Slack answers again: the replay runs `heard` once, and `every` is not run again.
    await outage([]);
    const recovered = lfSync(world.dir, 'listens', 'replay', 'slack:heard', '--delivery', deliveryId);
    assert.equal(recovered.code, 0, recovered.out);
    assert.match(recovered.out, /slack:heard completed/, recovered.out);
    assert.match(recovered.out, new RegExp(`heard ${text}`), recovered.out);
    assert.deepEqual([ran('heard'), ran('every')], [1, 1]);

    // Again, by the event Arrival Not Judged reported: it ran the arrival already, so nothing runs.
    const eventId = `arrival_not_judged:${String(first.pipeline)}:${String(first.arrival)}:0`;
    const again = lfSync(world.dir, 'listens', 'replay', 'slack:heard', '--event', eventId);
    assert.equal(again.code, 0, again.out);
    assert.match(again.out, /slack:heard: nothing replayed \(--force runs it again\)/);
    assert.equal(ran('heard'), 1);

    // --force runs it again: a new run.
    const forced = lfSync(world.dir, 'listens', 'replay', 'slack:heard', '--delivery', deliveryId, '--force');
    assert.equal(forced.code, 0, forced.out);
    assert.match(forced.out, /slack:heard completed/, forced.out);
    assert.deepEqual([ran('heard'), ran('every')], [2, 1]);

    // A delivery past deliveries.retainDays is refused by name.
    const db = new DatabaseSync(join(world.dir, '.lf', 'state.db'));
    try {
      db.prepare('update delivery set received_at = ? where id = ?').run(new Date(Date.now() - 30 * 86_400_000).toISOString(), deliveryId);
    } finally {
      db.close();
    }
    const expired = lfSync(world.dir, 'listens', 'replay', 'slack:heard', '--delivery', deliveryId);
    assert.equal(expired.code, 1, expired.out);
    assert.match(expired.out, new RegExp(`delivery ${deliveryId} was received \\S+, more than 14 days ago \\(deliveries.retainDays\\): its request is no longer kept, and it cannot be replayed`));
    assert.equal(ran('heard'), 2);
  } finally {
    await world.close();
  }
});

test('a reaction listen filtered on its message is refused: arrivals do not carry the message and messages are not cheap to list', async () => {
  const program = `${HEADER}
function seen(r: <chat-[:Reaction]->>) {
  return r.Emoji
}

listen to chat-[:Channels]->-[m:Messages WHERE m.Topic == "lunch-poll"]->-[:Reactions]-> fire seen
`;
  const world = await slackWorld(program);
  try {
    const refused = lfSync(world.dir, 'check');
    assert.equal(refused.code, 1, refused.out);
    assert.match(
      refused.out,
      /MOV_LISTEN_UNWATCHABLE .*this listen filters '-\[:Messages\]->' with `m\.Topic == "lunch-poll"`, but \S+'s arrivals on '-\[:Reactions\]->' don't carry the Message they are under, and listing every Message to re-check it isn't cheap — filter on what arrives, or wait on one record in a run: `await m-\[:Reactions\]->`/,
    );
    // Filtered on the channel a reaction does carry, it checks clean.
    writeFileSync(join(world.dir, 'movements/slack.mvt'), program.replace('-[:Channels]->-[m:Messages WHERE m.Topic == "lunch-poll"]->', '-[ch:Channels WHERE ch.Name == "deals"]->-[:Messages]->'));
    const checked = lfSync(world.dir, 'check');
    assert.equal(checked.code, 0, checked.out);
  } finally {
    await world.close();
  }
});

test('upgrade rewrites a 0.12 Slack listen onto the edge its events name; one naming none heard two edges and holds the pin', async () => {
  const old = (settings: string, param = 'Message') => `${HEADER}
function heard(m: <chat-[:${param}]->>) {
  return "heard"
}

listen to chat ${settings} fire heard
`;
  const world = await slackWorld(old('{ channels: ["deals"] }'));
  try {
    const file = join(world.dir, 'movements/slack.mvt');
    const lfYaml = join(world.dir, 'lf.yaml');
    const pinned = () => writeFileSync(lfYaml, readFileSync(lfYaml, 'utf8').replace(/^engine: .*$/m, 'engine: 0.12.13'));

    for (const [settings, param, listen] of [
      ['{ events: ["message"], channels: ["deals"] }', 'Message', 'chat-[ch:Channels WHERE ch.Name IN ["deals"]]->-[:Messages]->'],
      // A mention is a message, so both are every message.
      ['{ events: ["message", "app_mention"], channels: ["deals"] }', 'Message', 'chat-[ch:Channels WHERE ch.Name IN ["deals"]]->-[:Messages]->'],
      ['{ events: ["app_mention"], channels: ["deals"] }', 'Message', 'chat-[ch:Channels WHERE ch.Name IN ["deals"]]->-[m:Messages WHERE m.`Mentions App` == true]->'],
      ['{ events: ["reaction_added"] }', 'Reaction', 'chat-[:Channels]->-[:Messages]->-[:Reactions]->'],
    ] as const) {
      writeFileSync(file, old(settings, param));
      pinned();
      const upgraded = lfSync(world.dir, 'upgrade');
      assert.equal(upgraded.code, 0, upgraded.out);
      assert.equal(readFileSync(file, 'utf8'), old(settings, param).replace(`listen to chat ${settings} fire heard`, `listen to ${listen} fire heard`));
      const checked = lfSync(world.dir, 'check');
      assert.equal(checked.code, 0, checked.out);
      assert.doesNotMatch(checked.out, /MOV_LISTEN_SETTINGS_RETIRED/);
    }

    // A message and a reaction arrive on two edges: no one listen to rewrite
    // it to. Naming no events, a 0.12 listen heard both.
    for (const settings of ['{ events: ["message", "reaction_added"] }', '{ channels: ["deals"] }']) {
      const both = old(settings);
      writeFileSync(file, both);
      pinned();
      const held = lfSync(world.dir, 'upgrade');
      assert.equal(held.code, 1, held.out);
      assert.match(held.out, /its events arrive on `-\[:Channels\]->-\[:Messages\]->` and `-\[:Channels\]->-\[:Messages\]->-\[:Reactions\]->`, so write one listen for each/);
      assert.equal(readFileSync(file, 'utf8'), both);
    }
  } finally {
    await world.close();
  }
});

/** The probes of the claims a module's handbook section says run. */
function runnableProbes(section: unknown): string[] {
  const claims: unknown = typeof section === 'object' && section !== null ? Reflect.get(section, 'engineClaims') : undefined;
  if (!Array.isArray(claims)) return [];
  return claims.flatMap((claim: unknown) => {
    if (typeof claim !== 'object' || claim === null || Reflect.get(claim, 'status') !== 'runs') return [];
    const probe: unknown = Reflect.get(claim, 'probe');
    return typeof probe === 'string' ? [probe] : [];
  });
}

test('the Slack handbook section\'s runnable probes check clean against the module', async () => {
  // The module's own source, as serve-module loads it.
  const section: unknown = Reflect.get(require(join(__dirname, '../../../../modules/slack/handbook_section.ts')), 'SLACK_HANDBOOK_SECTION');
  const probes = runnableProbes(section);
  assert.ok(probes.length >= 3, `${probes.length} probes`);
  const world = await slackWorld('');
  try {
    for (const probe of probes) {
      writeFileSync(join(world.dir, 'movements/slack.mvt'), probe.replace(/team_workspace/g, 'team_slack'));
      const checked = lfSync(world.dir, 'check');
      assert.equal(checked.code, 0, `${probe}\n${checked.out}`);
    }
  } finally {
    await world.close();
  }
});

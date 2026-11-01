// `@lf/slack`'s standing listens, end to end, against the fake Slack in
// packages/fake-channels. Each listen ends on the edge a record arrives on —
// a channel's `Messages`, a message's `Reactions` or `Interactions` — and what
// arrives carries the records above it: a message its channel, a press its
// channel and the message pressed. So a filter on those hops is judged on the
// arrival itself. The lunch poll is the standing replacement for a callback
// that answered more than once: every press on a message written with the
// poll's `Topic` is its own run, its vote kept in an Airtable table one row
// per poll and person.

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { until } from './attio_fixture';
import { lf as lfSync, served, type Served } from './example';
import { lf, ok } from './interactive';
import { HEADER, deliver, eventCallback, forgetSlackCalls, pressOn, seedSlack, slackCalls, slackWorld, type World } from './slack_world';

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
        return rows.map(({ fields }) => ({ Poll: fields.fldPoll, Person: fields.fldPerson, Answer: fields.fldAnswer }));
      },
    };
  } catch (error) {
    await world.close();
    throw error;
  }
}

/** How many of `serving`'s runs of `fn` completed. */
const completed = (serving: Served, fn: string) => serving.lines.filter((line) => new RegExp(`^run \\S+ slack:${fn} completed$`).test(line)).length;

test('every press on a lunch poll is its own run, judged on arrival with no listing of messages', async () => {
  const world = await lunchWorld();
  try {
    // The program is the whole lunch poll, and it checks clean.
    const checked = lfSync(world.dir, 'check');
    assert.equal(checked.code, 0, checked.out);

    const serving = await served(world.dir);
    try {
      const now = Date.now() / 1000;
      const poll = posted(now - 60, 'lf:lunch-poll');
      await seedSlack(world.channels, [poll]);
      await forgetSlackCalls(world.channels);

      const vote = async (user: string, value: string) => {
        const delivered = await deliver(serving, await pressOn(world.channels, { channel: OFFICE, ts: poll.id, value, user }), FORM);
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
        votes.map((v) => [v.Poll, v.Person, v.Answer]).sort(),
        [
          [`${OFFICE}:${poll.id}`, 'ada', 'out'],
          [`${OFFICE}:${poll.id}`, 'priya', 'out'],
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

test('upgrade rewrites `listen to chat { channels: ["deals"] }`', async () => {
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
      ['{ channels: ["deals"] }', 'Message', 'chat-[ch:Channels WHERE ch.Name IN ["deals"]]->-[:Messages]->'],
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

    // A message and a reaction arrive on two edges: no one listen to rewrite it to.
    const both = old('{ events: ["message", "reaction_added"] }');
    writeFileSync(file, both);
    pinned();
    const held = lfSync(world.dir, 'upgrade');
    assert.equal(held.code, 1, held.out);
    assert.match(held.out, /its events arrive on `-\[:Channels\]->-\[:Messages\]->` and `-\[:Channels\]->-\[:Messages\]->-\[:Reactions\]->`, so write one listen for each/);
    assert.equal(readFileSync(file, 'utf8'), both);
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

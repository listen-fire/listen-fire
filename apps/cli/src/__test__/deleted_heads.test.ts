// A record a run waits on, deleted while it waits: the wait keeps waiting,
// on every module, so the run stays parked, and a `race` with a `sleep` is
// the way out. The acme external reports a deleted company as gone on its
// edges; Slack reports a deleted message the same way. Neither answers the
// wait, wakes the run, or ends it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { companies, externalPort, lf as lfSync, project, served } from './example';
import { HEADER, botMessages, deliver, eventCallback, parkedRun, slackWorld } from './slack_world';

const DAY_MS = 24 * 60 * 60_000;

/** One row off the project's state file. */
function row<T>(dir: string, sql: string, ...params: string[]): T {
  const db = new DatabaseSync(join(dir, '.lf', 'state.db'));
  try {
    return db.prepare(sql).get(...params) as T;
  } finally {
    db.close();
  }
}

/** The status of the one run of `movement`, as the store keeps it. */
const runStatus = (dir: string, movement: string) => row<{ status: string }>(dir, 'select status from run where movement = ?', movement).status;

/** The `wake_await` rows queued or dead. */
const wakeRows = (dir: string) => row<{ n: number }>(dir, "select count(*) as n from work where kind = 'wake_await'").n;

test("a deleted company leaves its wait parked; the race's sleep wins", async () => {
  const dir = project('deleted_heads');
  const before = await served(dir);
  try {
    const crm = `http://127.0.0.1:${externalPort(dir)}`;
    const post = async (route: string, body: unknown) => {
      const response = await fetch(`${crm}${route}`, { method: 'POST', body: JSON.stringify(body) });
      assert.equal(response.status, 200, `${route}: ${await response.clone().text()}`);
    };
    await post('/dev/companies', { Name: 'Osprey' });
    await before.waitFor(/run .* decide:decide parked/);
    // The run's own write made company-2, the record its wait hangs off.
    await post('/dev/companies/delete', { company: 'company-2' });
    // Long enough for a wake to have run, had the deletion queued one.
    await sleep(1500);
    assert.deepEqual(before.lines.filter((line) => /resumed .* decide:decide|failed/.test(line)), [], before.lines.join('\n'));
    assert.equal(wakeRows(dir), 0, 'the deletion woke nothing');
    assert.equal(runStatus(dir, 'decide'), 'parked');
  } finally {
    await before.stop();
  }
  // A day on, the sleep comes due and takes the race.
  const after = await served(dir, [], { LF_CLOCK_AHEAD_MS: String(DAY_MS + 60_000) });
  try {
    await after.waitFor(/resumed .* decide:decide completed/);
    assert.equal(after.lines.filter((line) => /decide:decide failed/.test(line)).length, 0, after.lines.join('\n'));
    assert.deepEqual(companies(dir), ['Osprey', 'Decide Osprey', 'Timed out']);
    const runId = row<{ id: string }>(dir, "select id from run where movement = 'decide'").id;
    const shown = JSON.parse(lfSync(dir, 'runs', 'show', runId, '--json').out) as { run: { writeRecords: Array<{ values: { Name: string } }> } };
    assert.deepEqual(shown.run.writeRecords.map((w) => w.values.Name), ['Decide Osprey', 'Timed out']);
  } finally {
    await after.stop();
  }
});

const PRESS = `${HEADER}
function decide(run: <manual-[:Invocation]->>) {
  general = only(chat-[ch:Channels WHERE ch.Name == "general"]->)
  if (general == null) { fail("no #general channel") }
  msg = write general-[:Messages]-> {
    Message: "Pursue?"
    Buttons: [{ Text: "Pursue", Value: "pursue" }, { Text: "Pass", Value: "pass" }]
  }
  press = await msg-[:Interactions]->
  write general-[:Messages]-> { Message: "chose \${only(press-[:Actions]->).Value}" }
}

listen to manual fire decide
`;

test('a deleted Slack message leaves its Interactions wait parked and the run parked', async () => {
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
    // Long enough for a wake to have run, had the deletion queued one.
    await sleep(1500);
    assert.deepEqual(serving.lines.filter((line) => /slack:decide/.test(line)), [], serving.lines.join('\n'));
    assert.equal(wakeRows(world.dir), 0, 'the deletion woke nothing');
    assert.equal(runStatus(world.dir, 'decide'), 'parked');
    // The write after the wait never ran.
    assert.deepEqual((await botMessages(world.channels)).map((m) => m.text), ['Pursue?']);
  } finally {
    await serving.stop();
    await world.close();
  }
});

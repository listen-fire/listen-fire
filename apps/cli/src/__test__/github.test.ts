// `@lf/github` in listen-fire, end to end: the morning triage. A project connects the
// bundled GitHub module against the fake GitHub
// (modules/github/__test__/fake_github.ts) and Slack against the fake in
// packages/fake-channels, each with a credential added as a person adds it.
// `listen-fire check` types the program against GitHub's fields and reasons, and
// refuses a wrong one by name; `listen-fire run --poll` arms, then fires once per new
// notification its listen selects, posting to Slack and labelling the pull
// request; an unchanged feed is a 304 that fires nothing; `listen-fire runs show`
// shows each run.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { lf as lfSync } from './example';
import { fakeChannels, type Fake } from './gmail_fixture';
import { lf, ok } from './interactive';
import { startFakeGithub, type FakeGithub } from '../../../../modules/github/__test__/fake_github';

const TOKEN = 'ghp_e2e_token';

const TRIAGE = `import { \`@lf/github\` as github, \`@lf/slack\` as slack } from adapters
import { henry_github, team_slack } from credentials

gh   = connect github using henry_github
chat = connect slack using team_slack

function triage(n: <gh-[:Notifications]->>) {
  general = only(chat-[ch:Channels WHERE ch.Name == "general"]->)
  if (general == null) { fail("no #general channel") }
  pr = only(n-[:\`Pull Request\`]->)
  if (pr != null) {
    write general-[:Messages]-> { Message: "Review requested by \${pr.Author}: \${pr.Title} \${pr.\`HTML URL\`}" }
    write pr-[:Labels]-> { Name: "triaged" }
  } else {
    write general-[:Messages]-> { Message: "\${n.Reason} in \${n-[:Repository]->.\`Full Name\`}: \${n.Title}" }
  }
}

listen to gh-[n:Notifications WHERE n.Reason IN ["review_requested", "mention", "assign"]]-> fire triage
`;

function run(dir: string, ...args: string[]): Promise<{ code: number; out: string }> {
  return lf(dir, args).done;
}

/** A project with GitHub and Slack connected to the fakes, and the triage
 *  movement in place. */
async function triageProject(github: FakeGithub, channels: Fake): Promise<string> {
  const dir = join(mkdtempSync(join(tmpdir(), 'lf-github-')), 'triage');
  assert.equal(lfSync(join(dir, '..'), 'init', 'triage').code, 0);
  console.log((await ok(lf(dir, ['connect', '@lf/github', '--yes'], { answers: [] }))).trim());
  const added = await ok(lf(dir, ['credential', 'add', '--module', '@lf/github', 'henry_github'], { answers: [TOKEN, github.url] }));
  assert.match(added, /x = connect `@lf\/github` using henry_github/);
  await ok(lf(dir, ['connect', '@lf/slack', '--yes']));
  await ok(lf(dir, ['credential', 'add', '--module', '@lf/slack', 'team_slack'], { answers: ['xoxb-test', '', '', `${channels.url}/slack/`] }));
  writeFileSync(join(dir, 'movements/triage.mvt'), TRIAGE);
  return dir;
}

async function slackMessages(channels: Fake): Promise<string[]> {
  const rows = (await (await fetch(`${channels.url}/admin/slack/message/state`)).json()) as Array<{ channel: string; text: string; user: string }>;
  return rows.filter((m) => m.user === 'bot').map((m) => `${m.channel} ${m.text}`);
}

async function checkWith(dir: string, from: string, to: string): Promise<{ code: number; out: string }> {
  assert.ok(TRIAGE.includes(from), from);
  writeFileSync(join(dir, 'movements/triage.mvt'), TRIAGE.replace(from, to));
  const checked = await run(dir, 'check');
  writeFileSync(join(dir, 'movements/triage.mvt'), TRIAGE);
  return checked;
}

test('listen-fire check types the triage against GitHub: a field GitHub lacks, a reason it never sends, an edge it does not have', async () => {
  const github = await startFakeGithub({ token: TOKEN });
  const channels = await fakeChannels();
  try {
    const dir = await triageProject(github, channels);
    const check = await run(dir, 'check');
    assert.equal(check.code, 0, check.out);

    const wrongField = await checkWith(dir, '${pr.Author}', '${pr.login}');
    assert.equal(wrongField.code, 1, wrongField.out);
    assert.match(wrongField.out, /login/);

    // A reason GitHub never sends is one the listen can never hear: said, by name.
    const wrongReason = await checkWith(dir, '"review_requested", "mention"', '"review_request", "mention"');
    assert.match(wrongReason.out, /warning MOV_ENUM_UNKNOWN_VALUE "review_request" isn't a value of enum .*Did you mean "review_requested"\?/);

    const wrongEdge = await checkWith(dir, 'n-[:`Pull Request`]->', 'n-[:Subject]->');
    assert.equal(wrongEdge.code, 1, wrongEdge.out);
    assert.match(wrongEdge.out, /Subject/);
    console.log([wrongField, wrongReason, wrongEdge].map((c) => c.out.trim()).join('\n---\n'));
    assert.deepEqual(github.requests.filter((r) => r.path.startsWith('/notifications')), [], 'checking polls nothing');
  } finally {
    await github.close();
    await channels.stop();
  }
});

test('upgrade rewrites participating: true as a comparison, and participating: false, which heard every thread, as none', async () => {
  const github = await startFakeGithub({ token: TOKEN });
  const channels = await fakeChannels();
  try {
    const dir = await triageProject(github, channels);
    const file = join(dir, 'movements/triage.mvt');
    const lfYaml = join(dir, 'lf.yaml');
    const old = (settings: string) =>
      `import { \`@lf/github\` as github } from adapters\nimport { henry_github } from credentials\n\ngh = connect github using henry_github\n\nfunction triage(n: <gh-[:Notification]->>) {\n  return n.Title\n}\n\nlisten to gh ${settings} fire triage\n`;
    for (const [participating, where] of [
      ['false', 'n.Reason IN ["mention"]'],
      ['true', 'n.Reason IN ["mention"] AND n.Participating == true'],
    ] as const) {
      const settings = `{ events: ["mention"], participating: ${participating} }`;
      writeFileSync(file, old(settings));
      writeFileSync(lfYaml, readFileSync(lfYaml, 'utf8').replace(/^engine: .*$/m, 'engine: 0.12.13'));
      const upgraded = await run(dir, 'upgrade');
      assert.equal(upgraded.code, 0, upgraded.out);
      assert.equal(
        readFileSync(file, 'utf8'),
        old(settings).replace('<gh-[:Notification]->>', '<gh-[:Notifications]->>').replace(`listen to gh ${settings} fire triage`, `listen to gh-[n:Notifications WHERE ${where}]-> fire triage`),
      );
      const checked = await run(dir, 'check');
      assert.equal(checked.code, 0, checked.out);
    }
  } finally {
    await github.close();
    await channels.stop();
  }
});

test('listen-fire run --poll arms, fires once per new notification the listen selects, and nothing on an unchanged feed', async () => {
  const github = await startFakeGithub({ token: TOKEN, pollIntervalSeconds: 0 });
  const channels = await fakeChannels();
  try {
    github.repo({ owner: 'acme', name: 'api' });
    github.pull('acme/api', { number: 42, title: 'Add retries', author: 'ada', reviewers: ['henry'] });
    github.issue('acme/api', { number: 7, title: 'Crash on boot' });
    github.notify({ id: 'backlog', reason: 'mention', repo: 'acme/api', type: 'Issue', number: 7, title: 'Old news', updated_at: '2026-10-01T00:00:00Z' });
    const dir = await triageProject(github, channels);

    const armed = await run(dir, 'run', '--poll', 'triage');
    assert.equal(armed.code, 0, armed.out);
    assert.match(armed.out, /github: triage:triage armed; it fires on changes from now/);
    assert.deepEqual(await slackMessages(channels), []);

    // Three threads move after the mark; the listen selects two of their reasons.
    const later = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    github.notify({ id: 't-review', reason: 'review_requested', repo: 'acme/api', type: 'PullRequest', number: 42, title: 'Add retries', updated_at: later(1) });
    github.notify({ id: 't-mention', reason: 'mention', repo: 'acme/api', type: 'Issue', number: 7, title: 'Crash on boot', updated_at: later(2) });
    const newest = later(3);
    github.notify({ id: 't-watch', reason: 'subscribed', repo: 'acme/api', type: 'Release', title: 'v1.2.0', updated_at: newest });

    const fired = await run(dir, 'run', '--poll', 'triage');
    assert.equal(fired.code, 0, fired.out);
    console.log(fired.out.trim());
    assert.deepEqual((await slackMessages(channels)).sort(), [
      'C001 Review requested by ada: Add retries https://github.com/acme/api/pull/42',
      'C001 mention in acme/api: Crash on boot',
    ]);
    assert.deepEqual(github.labelsOn('acme/api', 42), ['triaged']);

    const again = await run(dir, 'run', '--poll', 'triage');
    assert.equal(again.code, 0, again.out);
    const polls = github.requests.filter((r) => r.path.startsWith('/notifications'));
    assert.equal(polls.at(-1)?.ifModifiedSince, new Date(newest).toUTCString(), 'the poll was conditional');
    assert.equal((await slackMessages(channels)).length, 2, 'an unchanged feed fires nothing');

    const runs = await run(dir, 'runs');
    const ids = runs.out.trim().split('\n').filter((l) => l.includes('triage:triage')).map((l) => l.split(' ')[0] ?? '');
    assert.equal(ids.length, 2, runs.out);
    for (const id of ids) {
      const shown = await run(dir, 'runs', 'show', id, '--json');
      assert.equal(shown.code, 0, shown.out);
      const record = JSON.parse(shown.out) as { run?: { status?: string; writeRecords?: Array<{ adapter: string; recordType: string }> } };
      assert.equal(record.run?.status, 'completed', shown.out);
      assert.ok(record.run?.writeRecords?.some((w) => w.adapter === 'slack' && w.recordType === 'Message'), shown.out);
    }
    console.log(runs.out.trim());
  } finally {
    await github.close();
    await channels.stop();
  }
});

test('a listen that reads Participating beside another field hears a participating thread of any reason', async () => {
  const github = await startFakeGithub({ token: TOKEN, pollIntervalSeconds: 0 });
  const channels = await fakeChannels();
  try {
    github.repo({ owner: 'acme', name: 'api' });
    const dir = await triageProject(github, channels);
    const hearing = TRIAGE.replace(
      'WHERE n.Reason IN ["review_requested", "mention", "assign"]',
      'WHERE n.Reason == "mention" OR n.Participating == true',
    );
    assert.notEqual(hearing, TRIAGE);
    writeFileSync(join(dir, 'movements/triage.mvt'), hearing);
    const checked = await run(dir, 'check');
    assert.equal(checked.code, 0, checked.out);

    const armed = await run(dir, 'run', '--poll', 'triage');
    assert.equal(armed.code, 0, armed.out);

    const later = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    github.notify({ id: 't-mention', reason: 'mention', repo: 'acme/api', type: 'Issue', number: 7, title: 'Mentioned', updated_at: later(1) });
    github.notify({ id: 't-mine', reason: 'author', repo: 'acme/api', type: 'Issue', number: 8, title: 'Mine', updated_at: later(2), participating: true });
    github.notify({ id: 't-watch', reason: 'subscribed', repo: 'acme/api', type: 'Issue', number: 9, title: 'Only watched', updated_at: later(3) });

    const fired = await run(dir, 'run', '--poll', 'triage');
    assert.equal(fired.code, 0, fired.out);
    assert.deepEqual((await slackMessages(channels)).sort(), ['C001 author in acme/api: Mine', 'C001 mention in acme/api: Mentioned']);
  } finally {
    await github.close();
    await channels.stop();
  }
});

test('a walk that reads Participating inside an OR sees every thread carrying it', async () => {
  const github = await startFakeGithub({ token: TOKEN });
  const channels = await fakeChannels();
  try {
    github.repo({ owner: 'acme', name: 'api' });
    github.notify({ id: 't-mine', reason: 'author', repo: 'acme/api', type: 'Issue', number: 8, title: 'Mine', updated_at: '2026-10-28T09:02:00Z', participating: true });
    github.notify({ id: 't-watch', reason: 'subscribed', repo: 'acme/api', type: 'Issue', number: 9, title: 'Only watched', updated_at: '2026-10-28T09:03:00Z' });
    const dir = await triageProject(github, channels);
    writeFileSync(join(dir, 'movements/peek.mvt'), `import { \`@lf/github\` as github } from adapters
import { henry_github } from credentials

gh = connect github using henry_github

function peek(run: <manual-[:Invocations]->>) {
  n = only(gh-[n:Notifications WHERE n.Reason == "mention" OR n.Participating == true]->)
  if (n == null) { fail("no participating thread") }
  return "\${n.Id} \${n.Reason} \${n.Participating}"
}

listen to manual-[:Invocations]-> fire peek
`);
    const checked = await run(dir, 'check');
    assert.equal(checked.code, 0, checked.out);
    const walked = await run(dir, 'run', 'peek');
    assert.equal(walked.code, 0, walked.out);
    assert.match(walked.out, /returned "t-mine author true"/, walked.out);
  } finally {
    await github.close();
    await channels.stop();
  }
});

// The notifications poll against the fake GitHub: the arming first poll, one
// event per new or changed thread, the conditional request that makes an
// unchanged feed a 304, and the poll interval GitHub asks for.

import { GithubClient } from '../api_client';
import { pollGithub } from '../poll';
import { GITHUB_NOTIFICATION_EVENT_TAG, type GithubCheckpoint, type GithubNotificationPayload } from '../types';
import { startFakeGithub, type FakeGithub } from './fake_github';

const log = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };

let fake: FakeGithub;
let client: GithubClient;
let clock: number;
const now = (): number => clock;

beforeEach(async () => {
  fake = await startFakeGithub({ token: 'ghp_test' });
  fake.repo({ owner: 'acme', name: 'api' });
  client = new GithubClient({ token: 'ghp_test', baseUrl: fake.url, fetch, log });
  clock = Date.UTC(2026, 9, 28, 9, 0, 0);
});

afterEach(async () => {
  await fake.close();
});

/** A poll as the host makes it: the checkpoint the last one returned. */
async function poll(checkpoint?: unknown, config: unknown = {}) {
  return pollGithub(client, { config, ...(checkpoint !== undefined ? { checkpoint } : {}) }, now);
}

function notifiedAt(minute: number): string {
  return new Date(Date.UTC(2026, 9, 28, 9, minute, 0)).toISOString().replace('.000', '');
}

describe('pollGithub', () => {
  it('arms on the first poll: sets the mark past the backlog and delivers nothing', async () => {
    fake.notify({ id: 'old', reason: 'mention', repo: 'acme/api', type: 'Issue', number: 1, title: 'Backlog', updated_at: '2026-10-01T00:00:00Z' });
    const armed = await poll();
    expect(armed.events).toEqual([]);
    const checkpoint = armed.checkpoint as GithubCheckpoint;
    expect(checkpoint.updatedAfter > '2026-10-01T00:00:00Z').toBe(true);
    expect(checkpoint.lastModified).toBe(new Date('2026-10-01T00:00:00Z').toUTCString());
    expect(checkpoint.pollAfter).toBe(clock + 60_000);
  });

  it('fires once per new thread, oldest first, typed and labelled with its reason', async () => {
    const armed = { updatedAfter: notifiedAt(0) } satisfies GithubCheckpoint;
    fake.notify({ id: 't2', reason: 'mention', repo: 'acme/api', type: 'Issue', number: 7, title: 'Crash on boot', updated_at: notifiedAt(5) });
    fake.notify({ id: 't1', reason: 'review_requested', repo: 'acme/api', type: 'PullRequest', number: 42, title: 'Add retries', updated_at: notifiedAt(2) });
    const answer = await poll(armed);
    expect(answer.events.map((e) => [e.externalId, e.eventType, e.idempotencyKey, e.tag])).toEqual([
      ['t1', 'review_requested', `t1@${notifiedAt(2)}`, GITHUB_NOTIFICATION_EVENT_TAG],
      ['t2', 'mention', `t2@${notifiedAt(5)}`, GITHUB_NOTIFICATION_EVENT_TAG],
    ]);
    const payload = answer.events[0]?.payload as GithubNotificationPayload;
    expect(payload).toMatchObject({
      id: 't1',
      reason: 'review_requested',
      title: 'Add retries',
      subject_type: 'PullRequest',
      subject_url: `${fake.url}/repos/acme/api/pulls/42`,
      repository: { owner: 'acme', repo: 'api', full_name: 'acme/api' },
    });
    expect((answer.checkpoint as GithubCheckpoint).updatedAfter).toBe(notifiedAt(5));
    expect(fake.requests.at(-1)?.path).toBe(`/notifications?per_page=50&page=1&since=${encodeURIComponent(notifiedAt(0))}`);
  });

  it('asks conditionally next time, and an unchanged feed is a 304 that fires nothing', async () => {
    fake.notify({ id: 't1', reason: 'assign', repo: 'acme/api', type: 'Issue', number: 3, title: 'Triage me', updated_at: notifiedAt(2) });
    const first = await poll({ updatedAfter: notifiedAt(0) });
    expect(first.events).toHaveLength(1);
    clock += 61_000;
    const second = await poll(first.checkpoint);
    expect(second.events).toEqual([]);
    expect(fake.requests.at(-1)?.ifModifiedSince).toBe(new Date(notifiedAt(2)).toUTCString());
    expect((second.checkpoint as GithubCheckpoint).updatedAfter).toBe(notifiedAt(2));
    expect((second.checkpoint as GithubCheckpoint).lastModified).toBe((first.checkpoint as GithubCheckpoint).lastModified);
  });

  it('fires a thread again when it changes (a new comment), under a new idempotency key', async () => {
    fake.notify({ id: 't1', reason: 'mention', repo: 'acme/api', type: 'Issue', number: 3, title: 'Triage me', updated_at: notifiedAt(2) });
    const first = await poll({ updatedAfter: notifiedAt(0) });
    clock += 61_000;
    fake.notify({ id: 't1', reason: 'comment', repo: 'acme/api', type: 'Issue', number: 3, title: 'Triage me', updated_at: notifiedAt(9) });
    const second = await poll(first.checkpoint);
    expect(second.events.map((e) => [e.externalId, e.eventType, e.idempotencyKey])).toEqual([['t1', 'comment', `t1@${notifiedAt(9)}`]]);
  });

  it('never polls sooner than X-Poll-Interval asks: an early poll calls nothing', async () => {
    fake.pollInterval(120);
    const first = await poll({ updatedAfter: notifiedAt(0) });
    expect((first.checkpoint as GithubCheckpoint).pollAfter).toBe(clock + 120_000);
    const calls = fake.requests.length;
    clock += 60_000;
    const early = await poll(first.checkpoint);
    expect(early).toEqual({ events: [], checkpoint: first.checkpoint });
    expect(fake.requests).toHaveLength(calls);
    clock += 61_000;
    await poll(first.checkpoint);
    expect(fake.requests).toHaveLength(calls + 1);
  });

  it('keeps to threads you take part in when the listen says `participating: true`', async () => {
    fake.notify({ id: 'watching', reason: 'subscribed', repo: 'acme/api', type: 'Issue', number: 1, title: 'Watched', updated_at: notifiedAt(1) });
    fake.notify({ id: 'mine', reason: 'mention', repo: 'acme/api', type: 'Issue', number: 2, title: 'Mentioned', updated_at: notifiedAt(2), participating: true });
    const answer = await poll({ updatedAfter: notifiedAt(0) }, { participating: true });
    expect(answer.events.map((e) => e.externalId)).toEqual(['mine']);
    expect(fake.requests.at(-1)?.path).toContain('participating=true');
  });

  it('pages through a feed longer than one page', async () => {
    for (let i = 1; i <= 55; i++) {
      fake.notify({ id: `n${i}`, reason: 'subscribed', repo: 'acme/api', type: 'Release', title: `v${i}`, updated_at: new Date(Date.UTC(2026, 9, 28, 10, 0, i)).toISOString() });
    }
    const answer = await poll({ updatedAfter: notifiedAt(0) });
    expect(answer.events).toHaveLength(55);
    expect(fake.requests.filter((r) => r.path.startsWith('/notifications'))).toHaveLength(2);
  });

  it('names the credential when GitHub refuses the token', async () => {
    const wrong = new GithubClient({ token: 'nope', baseUrl: fake.url, fetch, log });
    await expect(pollGithub(wrong, { config: {}, checkpoint: { updatedAfter: notifiedAt(0) } }, now)).rejects.toThrow(
      /GitHub refused the token \(401\): check the token of the @lf\/github credential\. Bad credentials/,
    );
  });
});

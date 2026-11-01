// The poll of `Notifications` (adapter protocol 2.6) against the fake GitHub:
// the arming first poll, one arrival per new or changed thread, the taken
// `Reason` and `Participating`, the conditional request that makes an
// unchanged feed a 304, and the poll interval GitHub asks for.

import { GithubClient } from '../api_client';
import { pollGithub } from '../poll';
import { type GithubCheckpoint } from '../types';
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

/** A poll as the host makes it: the cursor the last one returned, and the
 *  part of the listens' WHERE the module takes. */
async function poll(cursor?: unknown, filter?: unknown) {
  return pollGithub(client, { edge: 'Notifications', ...(filter !== undefined ? { filter } : {}), ...(cursor !== undefined ? { cursor } : {}) }, now);
}

const field = (name: string) => ({ type: 'property', propertyTypeId: name, fieldOnly: true });
const reasonIn = (...reasons: string[]) => ({ type: 'compare', op: 'in', left: field('Reason'), right: { type: 'list', elements: reasons.map((value) => ({ type: 'static', value })) } });
const participating = (value: boolean) => ({ type: 'compare', op: 'eq', left: field('Participating'), right: { type: 'static', value } });

function notifiedAt(minute: number): string {
  return new Date(Date.UTC(2026, 9, 28, 9, minute, 0)).toISOString().replace('.000', '');
}

describe('pollGithub', () => {
  it('arms on the first poll: sets the mark past the backlog and delivers nothing', async () => {
    fake.notify({ id: 'old', reason: 'mention', repo: 'acme/api', type: 'Issue', number: 1, title: 'Backlog', updated_at: '2026-10-01T00:00:00Z' });
    const armed = await poll();
    expect(armed.arrivals).toEqual([]);
    const checkpoint = armed.cursor as GithubCheckpoint;
    expect(checkpoint.updatedAfter > '2026-10-01T00:00:00Z').toBe(true);
    expect(checkpoint.lastModified).toBe(new Date('2026-10-01T00:00:00Z').toUTCString());
    expect(checkpoint.pollAfter).toBe(clock + 60_000);
  });

  it('answers one arrival per new thread on Notifications, oldest first, versioned by when it moved', async () => {
    const armed = { updatedAfter: notifiedAt(0) } satisfies GithubCheckpoint;
    fake.notify({ id: 't2', reason: 'mention', repo: 'acme/api', type: 'Issue', number: 7, title: 'Crash on boot', updated_at: notifiedAt(5) });
    fake.notify({ id: 't1', reason: 'review_requested', repo: 'acme/api', type: 'PullRequest', number: 42, title: 'Add retries', updated_at: notifiedAt(2) });
    const answer = await poll(armed);
    expect(answer.arrivals.map((a) => 'identity' in a && [a.edge, a.identity, a.version, a.occurredAt, a.takenApplied])).toEqual([
      ['Notifications', 't1', notifiedAt(2), notifiedAt(2), true],
      ['Notifications', 't2', notifiedAt(5), notifiedAt(5), true],
    ]);
    const first = answer.arrivals[0];
    expect(first !== undefined && 'landing' in first && first.landing).toMatchObject({
      recordId: 't1',
      recordType: 'Notification',
      fields: {
        id: 't1',
        Reason: 'review_requested',
        Title: 'Add retries',
        'Subject Type': 'PullRequest',
        subject_url: `${fake.url}/repos/acme/api/pulls/42`,
        repository: { owner: 'acme', repo: 'api', full_name: 'acme/api' },
      },
    });
    expect((answer.cursor as GithubCheckpoint).updatedAfter).toBe(notifiedAt(5));
    const since = encodeURIComponent(notifiedAt(0));
    expect(fake.requests.map((r) => r.path)).toEqual([`/notifications?per_page=50&page=1&since=${since}`, `/notifications?per_page=50&page=1&since=${since}&participating=true`]);
  });

  it('stamps `Participating` on every arrival, from a second call that names the threads you take part in', async () => {
    fake.notify({ id: 'watching', reason: 'subscribed', repo: 'acme/api', type: 'Issue', number: 1, title: 'Watched', updated_at: notifiedAt(1) });
    fake.notify({ id: 'mine', reason: 'author', repo: 'acme/api', type: 'Issue', number: 2, title: 'Mine', updated_at: notifiedAt(2), participating: true });
    const answer = await poll({ updatedAfter: notifiedAt(0) });
    expect(answer.arrivals.map((a) => 'landing' in a && [a.identity, a.landing.fields['Participating']])).toEqual([['watching', false], ['mine', true]]);
    const reasoned = await poll({ updatedAfter: notifiedAt(0) }, reasonIn('subscribed'));
    expect(reasoned.arrivals.map((a) => 'landing' in a && [a.identity, a.landing.fields['Participating'], a.takenApplied])).toEqual([['watching', false, true]]);
  });

  it('pays the second call only when there is something to deliver', async () => {
    fake.notify({ id: 'watching', reason: 'subscribed', repo: 'acme/api', type: 'Issue', number: 1, title: 'Watched', updated_at: notifiedAt(1) });
    const none = await poll({ updatedAfter: notifiedAt(0) }, reasonIn('mention'));
    expect(none.arrivals).toEqual([]);
    expect(fake.requests.filter((r) => r.path.includes('participating'))).toEqual([]);
    clock += 61_000;
    const quiet = await poll({ updatedAfter: notifiedAt(1), lastModified: new Date(notifiedAt(1)).toUTCString() });
    expect(quiet.arrivals).toEqual([]);
    expect(fake.requests.filter((r) => r.path.includes('participating'))).toEqual([]);
  });

  it('asks conditionally next time, and an unchanged feed is a 304 that fires nothing', async () => {
    fake.notify({ id: 't1', reason: 'assign', repo: 'acme/api', type: 'Issue', number: 3, title: 'Triage me', updated_at: notifiedAt(2) });
    const first = await poll({ updatedAfter: notifiedAt(0) });
    expect(first.arrivals).toHaveLength(1);
    clock += 61_000;
    const second = await poll(first.cursor);
    expect(second.arrivals).toEqual([]);
    expect(fake.requests.at(-1)?.ifModifiedSince).toBe(new Date(notifiedAt(2)).toUTCString());
    expect((second.cursor as GithubCheckpoint).updatedAfter).toBe(notifiedAt(2));
    expect((second.cursor as GithubCheckpoint).lastModified).toBe((first.cursor as GithubCheckpoint).lastModified);
  });

  it('answers a thread again when it changes (a new comment), under a new version', async () => {
    fake.notify({ id: 't1', reason: 'mention', repo: 'acme/api', type: 'Issue', number: 3, title: 'Triage me', updated_at: notifiedAt(2) });
    const first = await poll({ updatedAfter: notifiedAt(0) });
    clock += 61_000;
    fake.notify({ id: 't1', reason: 'comment', repo: 'acme/api', type: 'Issue', number: 3, title: 'Triage me', updated_at: notifiedAt(9) });
    const second = await poll(first.cursor);
    expect(second.arrivals.map((a) => 'landing' in a && [a.identity, a.landing.fields['Reason'], a.version])).toEqual([['t1', 'comment', notifiedAt(9)]]);
  });

  it('never polls sooner than X-Poll-Interval asks: an early poll calls nothing', async () => {
    fake.pollInterval(120);
    const first = await poll({ updatedAfter: notifiedAt(0) });
    expect((first.cursor as GithubCheckpoint).pollAfter).toBe(clock + 120_000);
    const calls = fake.requests.length;
    clock += 60_000;
    const early = await poll(first.cursor);
    expect(early).toEqual({ arrivals: [], cursor: first.cursor });
    expect(fake.requests).toHaveLength(calls);
    clock += 61_000;
    await poll(first.cursor);
    expect(fake.requests).toHaveLength(calls + 1);
  });

  it('takes Reason IN over what GitHub answers, and says it applied it', async () => {
    fake.notify({ id: 'watching', reason: 'subscribed', repo: 'acme/api', type: 'Issue', number: 1, title: 'Watched', updated_at: notifiedAt(1) });
    fake.notify({ id: 'mentioned', reason: 'mention', repo: 'acme/api', type: 'Issue', number: 2, title: 'Mentioned', updated_at: notifiedAt(2) });
    fake.notify({ id: 'assigned', reason: 'assign', repo: 'acme/api', type: 'Issue', number: 3, title: 'Assigned', updated_at: notifiedAt(3) });
    const answer = await poll({ updatedAfter: notifiedAt(0) }, reasonIn('mention', 'assign'));
    expect(answer.arrivals.map((a) => 'identity' in a && [a.identity, a.takenApplied])).toEqual([['mentioned', true], ['assigned', true]]);
    expect((answer.cursor as GithubCheckpoint).updatedAfter).toBe(notifiedAt(3));
  });

  it('keeps to threads you take part in when the listen says `Participating == true`, asking GitHub', async () => {
    fake.notify({ id: 'watching', reason: 'subscribed', repo: 'acme/api', type: 'Issue', number: 1, title: 'Watched', updated_at: notifiedAt(1) });
    fake.notify({ id: 'mine', reason: 'mention', repo: 'acme/api', type: 'Issue', number: 2, title: 'Mentioned', updated_at: notifiedAt(2), participating: true });
    const answer = await poll({ updatedAfter: notifiedAt(0) }, { type: 'logical', op: 'and', operands: [reasonIn('mention', 'subscribed'), participating(true)] });
    expect(answer.arrivals.map((a) => 'landing' in a && [a.identity, a.landing.fields['Participating']])).toEqual([['mine', true]]);
    expect(fake.requests.at(-1)?.path).toContain('participating=true');
  });

  it('`Participating == false` is the threads GitHub’s participating filter leaves out', async () => {
    fake.notify({ id: 'watching', reason: 'subscribed', repo: 'acme/api', type: 'Issue', number: 1, title: 'Watched', updated_at: notifiedAt(1) });
    fake.notify({ id: 'mine', reason: 'mention', repo: 'acme/api', type: 'Issue', number: 2, title: 'Mentioned', updated_at: notifiedAt(2), participating: true });
    const answer = await poll({ updatedAfter: notifiedAt(0) }, participating(false));
    expect(answer.arrivals.map((a) => 'landing' in a && [a.identity, a.landing.fields['Participating']])).toEqual([['watching', false]]);
  });

  it('pages through a feed longer than one page', async () => {
    for (let i = 1; i <= 55; i++) {
      fake.notify({ id: `n${i}`, reason: 'subscribed', repo: 'acme/api', type: 'Release', title: `v${i}`, updated_at: new Date(Date.UTC(2026, 9, 28, 10, 0, i)).toISOString() });
    }
    const answer = await poll({ updatedAfter: notifiedAt(0) });
    expect(answer.arrivals).toHaveLength(55);
    expect(fake.requests.filter((r) => r.path.startsWith('/notifications') && !r.path.includes('participating'))).toHaveLength(2);
  });

  it('refuses an edge it does not have, by name', async () => {
    await expect(pollGithub(client, { edge: 'Repositories' }, now)).rejects.toThrow('@lf/github: no edge Repositories to poll (its listenable edge is Notifications)');
  });

  it('names the credential when GitHub refuses the token', async () => {
    const wrong = new GithubClient({ token: 'nope', baseUrl: fake.url, fetch, log });
    await expect(pollGithub(wrong, { edge: 'Notifications', cursor: { updatedAfter: notifiedAt(0) } }, now)).rejects.toThrow(
      /GitHub refused the token \(401\): check the token of the @lf\/github credential\. Bad credentials/,
    );
  });
});

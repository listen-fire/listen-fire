// GitHub's poll of `Notifications` (adapter protocol 2.6): the feed has no
// webhook, so the host polls the edge once for every listen sharing a
// connection, a taken filter and a scope. It honours GitHub's polling
// contract:
//
//   - a conditional request (`If-Modified-Since` with the last
//     `Last-Modified`), so an unchanged feed is a 304 that costs no quota;
//   - never sooner than `X-Poll-Interval` asks: a poll that comes early
//     answers nothing and calls nothing.
//
// Each thread new or changed since the high-water `updated_at` arrives once;
// its version is that `updated_at`, so a new comment on a thread already
// delivered arrives again. The module applies the taken filter itself:
// `Reason` over what came back, `Participating == true` as GitHub's own
// filter, so every arrival says `takenApplied`.

import { holds, takenComparisons, type PollEdgeAnswer, type PollEdgeInput, type TakenComparison } from 'module-kit';

import { normalizeNotification, type GithubClient, type GithubThread } from './api_client';
import { GITHUB_NOTIFICATIONS_COLLECTION, GITHUB_NOTIFICATION_DISPLAY_NAME, GITHUB_PARTICIPATING_FIELD, GITHUB_POLL_EVERY_SECONDS, type GithubCheckpoint } from './types';
import { notificationFields } from './schema';

type Arrival = PollEdgeAnswer['arrivals'][number];

function parseCheckpoint(checkpoint: unknown): GithubCheckpoint | undefined {
  if (typeof checkpoint !== 'object' || checkpoint === null) return undefined;
  const updatedAfter: unknown = Reflect.get(checkpoint, 'updatedAfter');
  const lastModified: unknown = Reflect.get(checkpoint, 'lastModified');
  const pollAfter: unknown = Reflect.get(checkpoint, 'pollAfter');
  if (typeof updatedAfter !== 'string') return undefined;
  return {
    updatedAfter,
    ...(typeof lastModified === 'string' ? { lastModified } : {}),
    ...(typeof pollAfter === 'number' ? { pollAfter } : {}),
  };
}

function nextPollAfter(now: number, seconds: number | undefined): number {
  return now + (seconds ?? GITHUB_POLL_EVERY_SECONDS) * 1000;
}

/** What `Participating` is pinned to by the taken filter, if anything. */
function participatingOf(taken: readonly TakenComparison[]): boolean | undefined {
  const pinned = taken.find((c) => c.field === GITHUB_PARTICIPATING_FIELD && c.op === 'eq' && typeof c.value === 'boolean');
  return typeof pinned?.value === 'boolean' ? pinned.value : undefined;
}

function arrival(thread: GithubThread, participating: boolean | undefined, applied: boolean): Arrival {
  const record = normalizeNotification(thread, participating !== undefined ? { participating } : {});
  return {
    edge: GITHUB_NOTIFICATIONS_COLLECTION,
    identity: thread.id,
    version: thread.updated_at,
    landing: { recordId: thread.id, recordType: GITHUB_NOTIFICATION_DISPLAY_NAME, fields: { ...record, ...notificationFields(record) } },
    occurredAt: thread.updated_at,
    ...(applied ? { takenApplied: true } : {}),
  };
}

async function participatingIds(client: GithubClient, since: string): Promise<Set<string>> {
  const answer = await client.listNotifications({ since, participating: true });
  return new Set(answer.modified ? answer.threads.map((t) => t.id) : []);
}

export async function pollGithub(client: GithubClient, input: PollEdgeInput, now: () => number = Date.now): Promise<PollEdgeAnswer> {
  if (input.edge !== GITHUB_NOTIFICATIONS_COLLECTION) {
    throw new Error(`@lf/github: no edge ${input.edge} to poll (its listenable edge is ${GITHUB_NOTIFICATIONS_COLLECTION})`);
  }
  const checkpoint = parseCheckpoint(input.cursor);
  const taken = takenComparisons(input.filter);
  const participating = participatingOf(taken ?? []);
  const asked = participating === true;

  // First poll: set the mark at GitHub's clock and deliver nothing. A live
  // listen is told about notifications from go-live on; the unread backlog
  // stays reachable by walking `Notifications`.
  if (checkpoint === undefined) {
    const answer = await client.listNotifications({ participating: asked, limit: 1 });
    const mark = answer.modified && answer.date !== undefined ? new Date(answer.date) : new Date(now());
    const newest = answer.modified ? answer.threads.map((t) => t.updated_at).sort().at(-1) : undefined;
    const updatedAfter = newest !== undefined && newest > mark.toISOString() ? newest : mark.toISOString();
    return {
      arrivals: [],
      cursor: {
        updatedAfter,
        ...(answer.modified && answer.lastModified !== undefined ? { lastModified: answer.lastModified } : {}),
        pollAfter: nextPollAfter(now(), answer.pollIntervalSeconds),
      } satisfies GithubCheckpoint,
    };
  }

  if (checkpoint.pollAfter !== undefined && now() < checkpoint.pollAfter) {
    return { arrivals: [], cursor: checkpoint };
  }

  const answer = await client.listNotifications({
    since: checkpoint.updatedAfter,
    participating: asked,
    ...(checkpoint.lastModified !== undefined ? { ifModifiedSince: checkpoint.lastModified } : {}),
  });
  if (!answer.modified) {
    return { arrivals: [], cursor: { ...checkpoint, pollAfter: nextPollAfter(now(), answer.pollIntervalSeconds) } };
  }

  // `since` is GitHub's boundary to draw; the mark is ours, so a thread at
  // exactly the mark (already delivered) is not delivered twice.
  const fresh = answer.threads.filter((t) => t.updated_at > checkpoint.updatedAfter);
  // `Participating == false` is the threads GitHub's own filter leaves out.
  const theirs = participating === false && fresh.length > 0 ? await participatingIds(client, checkpoint.updatedAfter) : undefined;
  const others = (taken ?? []).filter((c) => c.field !== GITHUB_PARTICIPATING_FIELD);
  // Oldest first: a movement handles threads in the order they moved.
  const arrivals = [...fresh]
    .sort((a, b) => a.updated_at.localeCompare(b.updated_at))
    .filter((thread) => theirs === undefined || !theirs.has(thread.id))
    .map((thread) => ({ thread, fields: notificationFields(normalizeNotification(thread)) }))
    .filter(({ fields }) => others.every((c) => holds(fields[c.field], c)))
    .map(({ thread }) => arrival(thread, participating, taken !== undefined));

  const newest = fresh.map((t) => t.updated_at).sort().at(-1);
  const next: GithubCheckpoint = {
    updatedAfter: newest !== undefined && newest > checkpoint.updatedAfter ? newest : checkpoint.updatedAfter,
    ...(answer.lastModified !== undefined ? { lastModified: answer.lastModified } : {}),
    pollAfter: nextPollAfter(now(), answer.pollIntervalSeconds),
  };
  return { arrivals, cursor: next };
}

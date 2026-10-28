// GitHub's poll — the notifications feed has no webhook, so the host calls
// this per listen on its interval. It honours GitHub's polling contract:
//
//   - a conditional request (`If-Modified-Since` with the last
//     `Last-Modified`), so an unchanged feed is a 304 that costs no quota;
//   - never sooner than `X-Poll-Interval` asks: a poll that comes early (a
//     short `every:`, `lf run --poll`) answers nothing and calls nothing.
//
// It fires once per thread that is new or changed since the high-water
// `updated_at`, labelled with the thread's reason (`eventType`), so a listen's
// `events` narrows by reason. The idempotency key is the thread and its
// `updated_at` together: a new comment on a thread already delivered is a new
// event; the same thread handed back unchanged is not.

import type { DiscriminableEvent } from 'movement-engine/public/adapter';
import type { PollAnswer, PollInput } from 'module-kit';

import { normalizeNotification, type GithubClient } from './api_client';
import { GITHUB_NOTIFICATION_EVENT_TAG, type GithubCheckpoint } from './types';

/** GitHub's own poll interval for notifications, as it usually answers it. */
export const GITHUB_POLL_INTERVAL_SECONDS = 60;

interface GithubPollConfig {
  participating?: unknown;
}

function parseCheckpoint(checkpoint: unknown): GithubCheckpoint | undefined {
  if (typeof checkpoint !== 'object' || checkpoint === null) return undefined;
  const { updatedAfter, lastModified, pollAfter } = checkpoint as Record<string, unknown>;
  if (typeof updatedAfter !== 'string') return undefined;
  return {
    updatedAfter,
    ...(typeof lastModified === 'string' ? { lastModified } : {}),
    ...(typeof pollAfter === 'number' ? { pollAfter } : {}),
  };
}

function participatingOnly(config: unknown): boolean {
  const value = (config as GithubPollConfig | null | undefined)?.participating;
  return value === true || value === 'true';
}

function nextPollAfter(now: number, seconds: number | undefined): number {
  return now + (seconds ?? GITHUB_POLL_INTERVAL_SECONDS) * 1000;
}

export async function pollGithub(client: GithubClient, input: PollInput, now: () => number = Date.now): Promise<PollAnswer> {
  const checkpoint = parseCheckpoint(input.checkpoint);
  const participating = participatingOnly(input.config);

  // First poll: set the mark at GitHub's clock and deliver nothing. A live
  // listen is told about notifications from go-live on; the unread backlog
  // stays reachable through the `Notifications` collection.
  if (checkpoint === undefined) {
    const answer = await client.listNotifications({ participating, limit: 1 });
    const mark = answer.modified && answer.date !== undefined ? new Date(answer.date) : new Date(now());
    const newest = answer.modified ? answer.threads.map((t) => t.updated_at).sort().at(-1) : undefined;
    const updatedAfter = newest !== undefined && newest > mark.toISOString() ? newest : mark.toISOString();
    return {
      events: [],
      checkpoint: {
        updatedAfter,
        ...(answer.modified && answer.lastModified !== undefined ? { lastModified: answer.lastModified } : {}),
        pollAfter: nextPollAfter(now(), answer.pollIntervalSeconds),
      } satisfies GithubCheckpoint,
    };
  }

  if (checkpoint.pollAfter !== undefined && now() < checkpoint.pollAfter) {
    return { events: [], checkpoint };
  }

  const answer = await client.listNotifications({
    since: checkpoint.updatedAfter,
    participating,
    ...(checkpoint.lastModified !== undefined ? { ifModifiedSince: checkpoint.lastModified } : {}),
  });
  if (!answer.modified) {
    return { events: [], checkpoint: { ...checkpoint, pollAfter: nextPollAfter(now(), answer.pollIntervalSeconds) } };
  }

  // `since` is GitHub's boundary to draw; the mark is ours, so a thread at
  // exactly the mark (already delivered) is not delivered twice.
  const fresh = answer.threads.filter((t) => t.updated_at > checkpoint.updatedAfter);
  const events: DiscriminableEvent[] = fresh
    .map((thread) => ({
      payload: normalizeNotification(thread),
      externalId: thread.id,
      idempotencyKey: `${thread.id}@${thread.updated_at}`,
      tag: GITHUB_NOTIFICATION_EVENT_TAG,
      eventType: thread.reason,
      occurredAt: thread.updated_at,
    }))
    // Oldest first — a movement handles threads in the order they moved.
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));

  const newest = fresh.map((t) => t.updated_at).sort().at(-1);
  const next: GithubCheckpoint = {
    updatedAfter: newest !== undefined && newest > checkpoint.updatedAfter ? newest : checkpoint.updatedAfter,
    ...(answer.lastModified !== undefined ? { lastModified: answer.lastModified } : {}),
    pollAfter: nextPollAfter(now(), answer.pollIntervalSeconds),
  };
  return { events, checkpoint: next };
}

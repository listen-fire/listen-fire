// Gmail PollSource — the solicited event seam.
//
// Push was available and deliberately not taken: a Pub/Sub topic, a public push
// endpoint and a watch that must be renewed every week are a lot of moving parts
// to buy a minute of latency nobody needs. So the poll-source worker drives
// event production: it asks Gmail what has arrived since the persisted change
// marker, emits one event per message, and returns the new mark.
//
// The marker is PERISHABLE — Gmail drops it after about a week of inactivity —
// so the checkpoint carries a second mark, the last seen time, and an expired
// marker resyncs from that rather than leaving the listener dead forever.

import type { DiscriminableEvent } from '../../adapter';
import type { PollSource } from '../../poll_source';
import type { TeamId } from '../../../../generated/kysely/core/Team';
import { GmailApiError, type GmailMessageRef } from '../../../../adapters/gmail/apiClient';
import { decodeGmailMessage, type GmailMessageRecord } from '../../../../adapters/gmail/mime';
import { resolveGmailClient, type GmailApiClient } from './client';
import { combineGmailQueries } from './filter';
import { GMAIL_MESSAGE_EVENT_TAG, type GmailCheckpoint } from './types';

/** Gmail's default cadence — overridable per automation via the `listen` option
 *  `pollIntervalSeconds`. A minute of delay on arriving mail is what the ruling
 *  traded the push machinery away for. */
const DEFAULT_POLL_INTERVAL_SECONDS = 60;

/** The label a listener watches. Mail that never reaches the inbox — filtered,
 *  archived on arrival, spam — is mail the mailbox's owner chose not to see, and
 *  a listener should not see it either. */
const INBOX_LABEL = 'INBOX';

/** How many messages one tick will deliver. A tick that meets more than this
 *  advances the mark over what it took, so the rest arrives on the next tick
 *  rather than being lost. */
const MAX_PER_TICK = 100;

/** How far back a resync reaches when the checkpoint carries no last seen time
 *  — which can only happen to a row written before both marks existed. */
const RESYNC_FALLBACK_MS = 24 * 60 * 60 * 1000;

function checkpointOf(value: unknown): GmailCheckpoint {
  if (typeof value !== 'object' || value === null) return {};
  const historyId = Reflect.get(value, 'historyId');
  const lastSeenAt = Reflect.get(value, 'lastSeenAt');
  return {
    ...(typeof historyId === 'string' && historyId !== '' ? { historyId } : {}),
    ...(typeof lastSeenAt === 'string' && lastSeenAt !== '' ? { lastSeenAt } : {}),
  };
}

/** The author's own narrowing. A listen without one is a listener on every
 *  message that reaches the inbox. */
export function listenQuery(config: unknown): string | undefined {
  if (typeof config !== 'object' || config === null) return undefined;
  const query = Reflect.get(config, 'query');
  return typeof query === 'string' && query.trim() !== '' ? query.trim() : undefined;
}

/** Gmail's `after:` takes whole epoch SECONDS, and is inclusive — so a resync
 *  asks from the last seen second and the caller drops what it already
 *  delivered. */
function afterTerm(sinceMs: number): string {
  return `after:${Math.floor(sinceMs / 1000)}`;
}

export class GmailPollSource implements PollSource {
  readonly pollIntervalSeconds = DEFAULT_POLL_INTERVAL_SECONDS;

  constructor(
    private readonly teamId: TeamId,
    private readonly credentialsId: string | undefined,
    /** Injectable for tests; production resolves a credentialed client. */
    private readonly clientOverride?: GmailApiClient,
  ) {}

  async getEvents(input: {
    config: unknown;
    checkpoint?: unknown;
  }): Promise<{ events: DiscriminableEvent[]; checkpoint?: unknown }> {
    const client =
      this.clientOverride ??
      (await resolveGmailClient({ teamId: this.teamId, credentialsId: this.credentialsId }));
    if (!client) {
      throw new Error(
        `GmailPollSource: no usable Gmail mailbox for team ${this.teamId} ` +
          `(credentialsId=${this.credentialsId ?? 'unset'}). Connect Gmail.`,
      );
    }

    const now = Date.now();
    const mark = checkpointOf(input.checkpoint);
    const query = listenQuery(input.config);

    // First poll: take the mailbox's current marker and emit nothing. A live
    // listener watches from go-live onward — it never backfills the mailbox
    // (which would flood the run on connect). Past mail stays reachable through
    // the root's `Messages` collection.
    if (mark.historyId === undefined) {
      const profile = await client.getProfile();
      return {
        events: [],
        checkpoint: { historyId: profile.historyId, lastSeenAt: new Date(now).toISOString() },
      };
    }

    const { refs, historyId, resynced } = await this.arrivals({
      client,
      historyId: mark.historyId,
      lastSeenAt: mark.lastSeenAt,
      query,
      now,
    });

    const messages = await this.fetchMessages({ client, refs, query });

    const events: DiscriminableEvent[] = messages.map((message) => ({
      payload: { ...message, ...(resynced ? { resynced: true } : {}) },
      externalId: message.id,
      // Gmail delivers the same message id on a resync overlap as on a normal
      // tick, so the delivery key is the message — a resync that re-sees a
      // message the engine already ran is a no-op rather than a second run.
      idempotencyKey: `gmail:${message.id}`,
      tag: GMAIL_MESSAGE_EVENT_TAG,
      ...(message.date !== null ? { occurredAt: message.date } : {}),
    }));

    // Oldest first — a run processes the mail in the order it arrived.
    events.sort((a, b) => (a.occurredAt ?? '').localeCompare(b.occurredAt ?? ''));

    // `lastSeenAt` is the moment this poll LOOKED, not the newest message's own
    // date: a resync from it asks Gmail for everything since the last look,
    // which is the question the missing marker left unanswered. Anything the
    // overlap re-delivers is dropped on the event's idempotency key.
    const checkpoint: GmailCheckpoint = {
      historyId: historyId ?? mark.historyId,
      lastSeenAt: new Date(now).toISOString(),
    };
    return { events, checkpoint };
  }

  /**
   * What has arrived since the mark.
   *
   * The normal path is Gmail's own history, which is cheap and exact. When
   * Gmail has DROPPED the marker — the 404 it gives after about a week of
   * inactivity — the answer is a search from the last seen time instead, and
   * every message it yields is flagged `resynced` so a run can tell that the
   * "since" was approximate rather than exact.
   */
  private async arrivals(input: {
    client: GmailApiClient;
    historyId: string;
    lastSeenAt: string | undefined;
    query: string | undefined;
    now: number;
  }): Promise<{ refs: GmailMessageRef[]; historyId?: string; resynced: boolean }> {
    const { client } = input;
    try {
      const page = await client.listHistory({
        startHistoryId: input.historyId,
        labelId: INBOX_LABEL,
      });
      return {
        refs: dedupe(page.added),
        ...(page.historyId !== undefined ? { historyId: page.historyId } : {}),
        resynced: false,
      };
    } catch (error) {
      if (!(error instanceof GmailApiError) || error.failure !== 'history_expired') throw error;
    }

    const sinceMs = input.lastSeenAt ? Date.parse(input.lastSeenAt) : NaN;
    const since = Number.isNaN(sinceMs) ? input.now - RESYNC_FALLBACK_MS : sinceMs;
    const profile = await client.getProfile();
    const { messages } = await client.listMessages({
      query: combineGmailQueries(`label:${INBOX_LABEL}`, afterTerm(since), input.query) ?? '',
      maxResults: MAX_PER_TICK,
    });
    return { refs: dedupe(messages), historyId: profile.historyId, resynced: true };
  }

  /**
   * The messages behind the refs, narrowed to the author's filter.
   *
   * History does not take a query, so a listener with one narrows HERE — one
   * `messages.list` restricted to the ids in hand, which is a single request
   * rather than a fetch per message that is then thrown away.
   */
  private async fetchMessages(input: {
    client: GmailApiClient;
    refs: GmailMessageRef[];
    query: string | undefined;
  }): Promise<GmailMessageRecord[]> {
    const wanted = input.refs.slice(0, MAX_PER_TICK);
    if (wanted.length === 0) return [];

    const allowed = await this.narrow(input.client, wanted, input.query);
    const messages: GmailMessageRecord[] = [];
    for (const ref of wanted) {
      if (!allowed.has(ref.id)) continue;
      messages.push(decodeGmailMessage(await input.client.getMessage(ref.id)));
    }
    return messages;
  }

  /** The subset of ids the listen's own query admits. No query ⇒ all of them,
   *  and no request. */
  private async narrow(
    client: GmailApiClient,
    refs: GmailMessageRef[],
    query: string | undefined,
  ): Promise<Set<string>> {
    if (query === undefined) return new Set(refs.map((ref) => ref.id));
    const { messages } = await client.listMessages({
      query: combineGmailQueries(`label:${INBOX_LABEL}`, query) ?? query,
      maxResults: MAX_PER_TICK,
    });
    const matching = new Set(messages.map((message) => message.id));
    return new Set(refs.map((ref) => ref.id).filter((id) => matching.has(id)));
  }
}

/** One event per message per tick. Gmail's history records a message once per
 *  CHANGE, so a message that arrived and was then labelled appears twice. */
function dedupe(refs: GmailMessageRef[]): GmailMessageRef[] {
  const seen = new Set<string>();
  const out: GmailMessageRef[] = [];
  for (const ref of refs) {
    if (seen.has(ref.id)) continue;
    seen.add(ref.id);
    out.push(ref);
  }
  return out;
}

/** Factory matching the PollSource registry signature. */
export function createGmailPollSource(input: {
  teamId: TeamId;
  credentialsId?: string;
}): GmailPollSource {
  return new GmailPollSource(input.teamId, input.credentialsId);
}
